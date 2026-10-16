import { createHash, randomUUID } from 'node:crypto';
import { Op, QueryTypes } from 'sequelize';
import { findingKey, noteRequired, reviewCounts, reviewGate, type ReviewStatus } from '../shared/report-review';
import { canonical, FinanceError } from '../shared/values';
import { FinanceService, uuid } from './service';
import { FinanceReportSnapshot } from './report-snapshot';
import { FinanceOptions } from './options';
import { domainWrite, writeOptions } from './write-scope';
import { pagination } from './queries';
import { datasetFromSnapshot } from './report/dataset';
import { compute, Orders } from './report/engine';
import { Allowed, LEVELS, TAG_SOURCES, runChecks } from './report/checks';
import { renderChecks, renderReport, reportCurrency, withDraftMark, withoutTraceMarks } from './report/render';
import { fundKeys, monthEnd } from './report/model';
import { findingTargets } from './report/targets';
import { attachFindings, buildTrace, checkOutputs, verifyTrace } from './report/trace';
import { reviewWorkbook } from './report/workbook';
import { compareReports } from './report/compare';

export const REPORT_ENGINE_VERSION = 'finance-report/2';
const CLAIM_MS = 5 * 60000;
const STATUSES = ['queued', 'running', 'ready', 'failed', 'published', 'superseded'];
const DOCUMENT_STATUSES = ['ready', 'published', 'superseded'];
const LIST_COLUMNS = `r.id,r.entity_id,r.report_month,r.report_date::text,r.status,r.attempts,r.error,r.owner_id,r.published_by,r.published_at,
  r.snapshot_at,r.snapshot_sha256,r.engine_version,r.review_note,r.benchmark_ids,r.technical_revision,r.created_at,r.updated_at,r.summary,
  e.legal_name,e.common_name,g.client_code`;
const LIST_JOINS = ' JOIN finance_investment_entities e ON e.id=r.entity_id JOIN finance_client_groups g ON g.id=e.client_group_id';
const NEWER_FINAL = `EXISTS (SELECT 1 FROM finance_report_runs n WHERE n.entity_id=r.entity_id AND n.report_month=r.report_month AND n.status IN ('ready','published','superseded') AND (n.created_at>r.created_at OR (n.created_at=r.created_at AND n.id>r.id)))`;
const LIST_ORDER = {
  newest: 'r.created_at DESC,r.id',
  oldest: 'r.created_at ASC,r.id',
  errors: `COALESCE((r.summary->'counts'->>'错误')::int,0) DESC, COALESCE((r.summary->'counts'->>'警告')::int,0) DESC, r.created_at ASC, r.id`,
  published: 'r.published_at DESC NULLS LAST, r.id',
};

const plain = (row: any) => row?.get ? row.get({ plain: true }) : row;
function recordRefs(snapshot: any) {
  const day = (value: any) => String(value || '').slice(0, 10);
  const share_classes = Object.fromEntries((snapshot?.share_classes || []).filter((row: any) => row?.id).map((row: any) => [row.id, { fund_id: row.fund_id }]));
  const index = (rows: any[] | undefined, pick: (row: any) => any) => Object.fromEntries((rows || []).filter(row => row?.id).map(row => [row.id, pick(row)]));
  return {
    share_classes,
    fund_navs: index(snapshot?.fund_navs, row => ({ share_class_id: row.share_class_id, fund_id: share_classes[row.share_class_id]?.fund_id, date: day(row.nav_date) })),
    fund_returns: index(snapshot?.fund_returns, row => ({ share_class_id: row.share_class_id, date: day(row.return_date) })),
    benchmark_values: index(snapshot?.benchmark_values, row => ({ benchmark_id: row.benchmark_id, date: day(row.value_date) })),
  };
}
function reviewerIds(raw: any) {
  const ids: any[] = [];
  for (const item of Object.values(raw?.items || {}) as any[]) ids.push(item?.by, ...(item?.history || []).map((entry: any) => entry.by));
  return ids;
}
function namedReview(item: any, names: Record<string, string>) {
  if (!item) return item;
  return { ...item, by_name: names[item.by] ?? null, history: (item.history || []).map((entry: any) => ({ ...entry, by_name: names[entry.by] ?? null })) };
}
function presentReviews(raw: any, names: Record<string, string>) {
  return {
    items: Object.fromEntries(Object.entries(raw?.items || {}).map(([key, item]) => [key, namedReview(item, names)])),
    counts: raw?.counts || { open_errors: 0, needs_fix: 0, handled: 0 },
  };
}
function onlyKeys(payload: any, keys: string[]) {
  const extra = Object.keys(payload || {}).find(key => !keys.includes(key));
  if (extra) throw new FinanceError('FIELD_NOT_WRITABLE', '此月报字段不可直接写入', extra);
}

export class FinanceReports {
  queue: Promise<unknown> = Promise.resolve();
  pending = new Map<string, Promise<unknown>>();
  stopping = false;
  constructor(public service: FinanceService, public snapshot: FinanceReportSnapshot, public options: FinanceOptions,
    public brand = process.env.FINANCE_REPORT_BRAND || 'Amrita', public now = () => new Date()) {}

  month(value: any) {
    if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new FinanceError('INVALID_REPORT_MONTH', '报告月份格式应为 YYYY-MM', 'report_month');
    if (value > this.now().toISOString().slice(0, 7)) throw new FinanceError('INVALID_REPORT_MONTH', '报告月份不能晚于当前月份', 'report_month');
    return value;
  }
  async sql(text: string, replacements: any, transaction?: any): Promise<any[]> {
    return this.service.db.sequelize.query(text, { replacements, transaction, type: QueryTypes.SELECT });
  }

  async request(payload: any, actor: string, transaction: any) {
    onlyKeys(payload, ['report_month', 'entity_ids', 'client_code', 'benchmark_ids']);
    const month = this.month(payload.report_month);
    const benchmarks = payload.benchmark_ids === undefined ? [] : payload.benchmark_ids;
    if (!Array.isArray(benchmarks) || benchmarks.length > 20) throw new FinanceError('INVALID_ID', '一次最多选择 20 个基准', 'benchmark_ids');
    const benchmarkIds = [...new Set(benchmarks.map((id: any) => uuid(id, 'benchmark_ids')))];
    if (benchmarkIds.length && await this.service.model('benchmarks').count({ where: { id: { [Op.in]: benchmarkIds } }, transaction }) !== benchmarkIds.length) throw new FinanceError('NOT_FOUND', '所选基准不存在', 'benchmark_ids', 404);
    const ids = payload.entity_ids === undefined ? [] : payload.entity_ids;
    if (!Array.isArray(ids) || ids.length > 50) throw new FinanceError('INVALID_ID', '一次最多选择 50 个投资主体', 'entity_ids');
    const entityIds = ids.map((id: any) => uuid(id, 'entity_ids'));
    const clientCode = payload.client_code;
    if (clientCode !== undefined && (typeof clientCode !== 'string' || !clientCode.trim() || clientCode.length > 30)) throw new FinanceError('INVALID_FILTER', '客户编号无效', 'client_code');
    if (!entityIds.length && !clientCode) throw new FinanceError('REQUIRED', '请选择投资主体或客户编号', 'entity_ids');
    const where = ['NOT e.is_deleted', entityIds.length ? 'e.id IN (:entityIds)' : null, clientCode ? 'g.client_code=:clientCode' : null].filter(Boolean).join(' AND ');
    const entities = await this.sql(`SELECT e.id FROM finance_investment_entities e JOIN finance_client_groups g ON g.id=e.client_group_id
      WHERE ${where} ORDER BY g.client_code,e.created_at,e.id`, { entityIds, clientCode: clientCode?.trim() }, transaction);
    if (!entities.length || entityIds.length && entities.length !== new Set(entityIds).size) throw new FinanceError('NOT_FOUND', '没有找到对应的有效投资主体', 'entity_ids', 404);
    await this.service.lock(entities.map(row => `entity:${row.id}`), transaction);
    const runIds: string[] = [];
    for (const { id: entityId } of entities) {
      const run = await this.service.model('report_runs').create({ id: randomUUID(), entity_id: entityId, report_month: month, report_date: monthEnd(month), status: 'queued', owner_id: actor, attempts: 0, benchmark_ids: benchmarkIds.length ? benchmarkIds : null }, writeOptions(transaction));
      runIds.push(run.id);
    }
    return { run_ids: runIds };
  }

  async process(id: string) {
    uuid(id, 'id');
    if (this.stopping) return;
    if (this.pending.has(id)) return this.pending.get(id);
    const job = this.queue.then(() => this.stopping ? undefined : this.processOne(id));
    this.pending.set(id, job); this.queue = job.catch(() => {});
    try { return await job; } finally { this.pending.delete(id); }
  }
  private async processOne(id: string) {
    const claim: { token: string; entity_id: string; month: string; report_date: string; benchmark_ids: string[] | null } | null = await domainWrite(() => this.service.db.sequelize.transaction(async (transaction: any) => {
      await this.service.lock([`report-run:${id}`], transaction);
      const run = await this.service.requiredRow('report_runs', id, transaction);
      const status = run.get('status');
      if (status !== 'queued' && !(status === 'running' && Date.parse(run.get('claim')?.expires_at || '') <= Date.now())) return null;
      const token = randomUUID();
      await run.update({ status: 'running', claim: { token, expires_at: new Date(Date.now() + CLAIM_MS).toISOString() }, attempts: run.get('attempts') + 1, error: null }, writeOptions(transaction));
      return { token, entity_id: run.get('entity_id'), month: run.get('report_month'), report_date: run.get('report_date'), benchmark_ids: run.get('benchmark_ids') };
    }));
    if (!claim) return;
    let outcome: any;
    try {
      const snap = await this.snapshot.read({ entity_ids: [claim.entity_id], report_date: claim.report_date });
      const { allowed, orders } = await this.tagRules();
      const ds = datasetFromSnapshot(snap, claim.entity_id, claim.month, claim.benchmark_ids);
      const res = compute(ds, orders);
      const { findings: raw, summary: checks } = runChecks(ds, res, allowed);
      const findings = raw.map(item => ({ ...item, targets: findingTargets(ds, claim.entity_id, item) }));
      const { snapshot_at, ...facts } = snap;
      const counts = Object.fromEntries(LEVELS.map(level => [level, raw.filter(f => f.level === level).length]));
      const keys = fundKeys(ds);
      const trace = buildTrace(ds, res);
      attachFindings(trace, raw);
      // A report whose trace disagrees with the engine, or cannot be recomputed from itself, is not issued.
      const traceErrors = [...checkOutputs(trace, ds, res), ...verifyTrace(trace)];
      if (traceErrors.length) {
        this.service.db.logger?.error?.('Finance report trace mismatch', { run_id: id, errors: traceErrors.slice(0, 20) });
        throw new FinanceError('TRACE_MISMATCH', '计算追溯与计算结果不一致，月报未生成；请联系维护者检查日志');
      }
      const nodes = Object.values(trace.nodes);
      outcome = {
        status: 'ready', engine_version: REPORT_ENGINE_VERSION, snapshot_at, snapshot: facts,
        snapshot_sha256: createHash('sha256').update(canonical(facts)).digest('hex'), findings,
        summary: { client: ds.client, client_code: ds.clientCode, as_of: ds.asOf, currency: reportCurrency(ds), currencies: ds.currencies,
          ytd: res.ytd, irr: res.irr, total_nav: res.totalNav[ds.asOf], total_invested: keys.reduce((s, k) => s + res.invested[k], 0), counts, checks,
          months: res.reportMonths.map(m => ({ month: m, nav: res.totalNav[m], flow: res.totalFlow[m], return: res.portRet[m] ?? null })),
          funds: keys.map(k => ({ key: k, name: ds.funds[k].nameT1, risk: ds.funds[k].risk, region: ds.funds[k].region, strategy: ds.funds[k].strategy,
            weight: res.weights[k], nav: res.nav[k][ds.asOf]?.value ?? null, nav_source: res.nav[k][ds.asOf]?.source ?? null, invested: res.invested[k], ytd: res.fundYtd[k], first_invest: res.firstInvest[k] ?? null })),
          benchmarks: ds.benchmarks.map(b => ({ name: b, ytd: res.fundYtd[b] })), alloc: res.alloc,
          trace: { schema: trace.schema, rules: trace.meta.rules, nodes: nodes.length, leaves: nodes.filter(n => n.op === 'leaf').length, verified: true } },
        trace,
        report_html: renderReport(ds, res, { brand: this.brand, outputs: trace.outputs }), check_html: renderChecks(ds, res, raw, checks), error: null,
      };
    } catch (error: any) {
      if (!(error instanceof FinanceError)) this.service.db.logger?.error?.('Finance report generation failed', { run_id: id, error });
      outcome = { status: 'failed', error: error instanceof FinanceError ? error.message : '月报生成未完成，可重试；如再次失败请联系维护者检查日志' };
    }
    await domainWrite(() => this.service.db.sequelize.transaction(async (transaction: any) => {
      await this.service.lock([`report-run:${id}`], transaction);
      const run = await this.service.requiredRow('report_runs', id, transaction);
      if (run.get('status') !== 'running' || run.get('claim')?.token !== claim.token) return;
      await run.update({ ...outcome, claim: null, technical_revision: run.get('technical_revision') + 1 }, writeOptions(transaction));
    }));
  }
  async tagRules(): Promise<{ allowed: Allowed; orders: Orders }> {
    const configured = await this.options.list();
    const values = (key: string) => configured.find(item => item.source_key === key)?.values.map(value => value.code) || [];
    const allowed = Object.fromEntries(Object.entries(TAG_SOURCES).map(([dim, keys]) => [dim, Object.fromEntries(Object.entries(keys).map(([kind, key]) => [kind, values(key)]))])) as Allowed;
    const union = (dim: keyof Allowed) => [...new Set([...allowed[dim].third_party, ...allowed[dim].proprietary])];
    return { allowed, orders: { risk: union('risk').map(v => `${v}型`), region: union('region'), strategy: union('strategy') } };
  }
  async recover() {
    const rows = await this.service.model('report_runs').findAll({ where: { status: { [Op.in]: ['queued', 'running'] } }, limit: 50, order: [['updated_at', 'ASC'], ['id', 'ASC']] });
    for (const row of rows) { if (this.stopping) return; await this.process(row.id); }
  }

  async list(input: any) {
    const paging = pagination(input); const params: any = { ...paging }; const where = ['TRUE'];
    if (input.entity_id) { params.entity_id = uuid(input.entity_id, 'entity_id'); where.push('r.entity_id=:entity_id'); }
    if (input.report_month) { params.report_month = this.month(input.report_month); where.push('r.report_month=:report_month'); }
    if (input.month_from) { params.month_from = this.month(input.month_from); where.push('r.report_month>=:month_from'); }
    if (input.month_to) { params.month_to = this.month(input.month_to); where.push('r.report_month<=:month_to'); }
    if (params.month_from && params.month_to && params.month_from > params.month_to) throw new FinanceError('INVALID_FILTER', '开始月份不能晚于结束月份', 'month_from');
    if (input.status) {
      const statuses = String(input.status).split(',').map(item => item.trim()).filter(Boolean);
      if (!statuses.length || statuses.some(item => !STATUSES.includes(item))) throw new FinanceError('INVALID_FILTER', '月报状态无效', 'status');
      params.statuses = statuses; where.push('r.status IN (:statuses)');
    }
    if (input.client_code !== undefined && input.client_code !== '') {
      if (typeof input.client_code !== 'string') throw new FinanceError('INVALID_FILTER', '客户编号无效', 'client_code');
      const clientCode = input.client_code.trim();
      if (!clientCode || clientCode.length > 30) throw new FinanceError('INVALID_FILTER', '客户编号无效', 'client_code');
      params.client_code = clientCode; where.push('g.client_code=:client_code');
    }
    if (input.latest_only === '1' || input.latest_only === true) where.push(`NOT ${NEWER_FINAL}`);
    const order = input.order || 'newest';
    if (!Object.hasOwn(LIST_ORDER, order)) throw new FinanceError('INVALID_SORT', '月报列表不支持此排序', 'order');
    if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200)) throw new FinanceError('INVALID_SEARCH', '搜索文本最多 200 字');
    if (input.search?.trim()) { params.search = `%${input.search.trim().replace(/[\\%_]/g, '\\$&')}%`; where.push('(e.legal_name ILIKE :search OR e.common_name ILIKE :search OR g.client_code ILIKE :search)'); }
    const [{ count }] = await this.sql(`SELECT count(*)::int AS count FROM finance_report_runs r${LIST_JOINS} WHERE ${where.join(' AND ')}`, params);
    const rows = await this.sql(`SELECT ${LIST_COLUMNS}, r.finding_reviews->'counts' AS review_counts, NOT ${NEWER_FINAL} AS is_latest,
      EXISTS (SELECT 1 FROM finance_report_runs p WHERE p.entity_id=r.entity_id AND p.report_month=r.report_month AND p.status='published' AND p.id<>r.id) AS has_published
      FROM finance_report_runs r${LIST_JOINS} WHERE ${where.join(' AND ')}
      ORDER BY ${LIST_ORDER[order as keyof typeof LIST_ORDER]} LIMIT :page_size OFFSET :offset`, params);
    const users = await this.userNames(rows.flatMap(row => [row.owner_id, row.published_by]));
    return { rows: rows.map(row => this.view(row, users)), count, page: paging.page, page_size: paging.page_size };
  }
  async userNames(ids: any[]) {
    const wanted = [...new Set(ids.filter(id => id && /^\d+$/.test(id)))];
    if (!wanted.length || !this.service.db.hasCollection('users')) return {};
    const rows = await this.service.db.getModel('users').findAll({ where: { id: { [Op.in]: wanted } }, attributes: ['id', 'nickname', 'username'] });
    return Object.fromEntries(rows.map((row: any) => [String(row.id), row.get('nickname') || row.get('username') || `用户 ${row.id}`]));
  }
  view(row: any, users: Record<string, string>) {
    const { summary, is_latest, has_published, review_counts, ...rest } = row;
    const flag = (value: any) => value === true || value === 't' || value === 'true' || value === 1;
    const counts = typeof review_counts === 'string' ? JSON.parse(review_counts) : review_counts;
    return { ...rest,
      review: { open_errors: counts?.open_errors ?? summary?.counts?.错误 ?? 0, needs_fix: counts?.needs_fix ?? 0 },
      ...(is_latest === undefined ? {} : { is_latest: flag(is_latest) }),
      ...(has_published === undefined ? {} : { has_published: flag(has_published) }),
      has_trace: !!summary?.trace, owner_name: users[row.owner_id] ?? null, publisher_name: users[row.published_by] ?? null,
      summary: summary && { client: summary.client, currency: summary.currency, ytd: summary.ytd, irr: summary.irr, total_nav: summary.total_nav, counts: summary.counts } };
  }
  async get(id: string) {
    const [row] = await this.sql(`SELECT ${LIST_COLUMNS},r.findings,r.finding_reviews FROM finance_report_runs r${LIST_JOINS} WHERE r.id=:id`, { id: uuid(id, 'id') });
    if (!row) throw new FinanceError('NOT_FOUND', '月报不存在', 'id', 404);
    const findings = (row.findings || []).map((finding: any, index: number) => ({ ...finding, key: findingKey(index, finding) }));
    const users = await this.userNames([row.owner_id, row.published_by, ...reviewerIds(row.finding_reviews)]);
    row.review_counts = reviewCounts(findings, row.finding_reviews?.items);
    return { ...this.view(row, users), summary: row.summary, findings, finding_reviews: presentReviews(row.finding_reviews, users), review_gate: reviewGate(findings, row.finding_reviews, row.review_note) };
  }
  async document(ctx: any, input: any) {
    const kind = input.kind === undefined ? 'report' : ['report', 'checks', 'snapshot', 'workbook'].includes(input.kind) ? input.kind : null;
    if (!kind) throw new FinanceError('INVALID_FILTER', '请选择月报、校验报告、复核工作簿或数据快照', 'kind');
    const [row] = await this.sql(`SELECT r.status,r.report_month,r.engine_version,r.snapshot_at,r.snapshot_sha256,r.benchmark_ids,g.client_code,
      ${kind === 'workbook' ? 'r.trace,r.findings,r.finding_reviews' : kind === 'snapshot' ? 'r.snapshot' : 'r.report_html,r.check_html'}
      FROM finance_report_runs r${LIST_JOINS} WHERE r.id=:id`, { id: uuid(input.id, 'id') });
    if (!row) throw new FinanceError('NOT_FOUND', '月报不存在', 'id', 404);
    if (!DOCUMENT_STATUSES.includes(row.status)) throw new FinanceError('REPORT_NOT_READY', '月报尚未生成完成', 'id', 409);
    if (kind === 'workbook' && !row.trace) throw new FinanceError('TRACE_UNAVAILABLE', '该月报生成于计算追溯上线之前，重新生成后可下载复核工作簿', 'id', 404);
    ctx.withoutDataWrapping = true; ctx.set('Cache-Control', 'private, no-store'); ctx.set('X-Content-Type-Options', 'nosniff');
    if (kind === 'workbook') {
      const names = await this.userNames(reviewerIds(row.finding_reviews));
      ctx.body = reviewWorkbook(row.trace, { ...row, reviewer_names: names });
      ctx.type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      ctx.attachment(`复核工作簿_${row.client_code}_${row.report_month}${row.status === 'published' ? '' : '_草稿'}.xlsx`);
      return;
    }
    if (kind === 'snapshot') {
      ctx.body = { ...row.snapshot, snapshot_at: row.snapshot_at, snapshot_sha256: row.snapshot_sha256, benchmark_ids: row.benchmark_ids };
      ctx.attachment(`月报数据快照_${row.client_code}_${row.report_month}.json`);
      return;
    }
    const download = input.download === '1' || input.download === true;
    const report = download ? withoutTraceMarks(row.report_html) : row.report_html;
    const html = kind === 'checks' ? row.check_html : row.status === 'published' ? report : withDraftMark(report);
    ctx.body = html; ctx.type = 'text/html; charset=utf-8';
    // Stored documents contain escaped business text only; still never let them run code or load resources.
    ctx.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (download) ctx.attachment(`${kind === 'checks' ? '校验报告' : '投资组合回顾'}_${row.client_code}_${row.report_month}.html`);
  }
  async trace(id: string) {
    const [row] = await this.sql('SELECT r.status,r.trace,r.snapshot FROM finance_report_runs r WHERE r.id=:id', { id: uuid(id, 'id') });
    if (!row) throw new FinanceError('NOT_FOUND', '月报不存在', 'id', 404);
    if (!DOCUMENT_STATUSES.includes(row.status)) throw new FinanceError('REPORT_NOT_READY', '月报尚未生成完成', 'id', 409);
    if (!row.trace) throw new FinanceError('TRACE_UNAVAILABLE', '该月报生成于计算追溯上线之前，重新生成后可追溯', 'id', 404);
    return { ...row.trace, record_refs: recordRefs(row.snapshot) };
  }
  async compare(input: any) {
    const baseId = uuid(input.base_id, 'base_id');
    const headId = uuid(input.head_id, 'head_id');
    if (baseId === headId) throw new FinanceError('INVALID_ID', '请选择两个不同的月报', 'head_id');
    const limit = input.limit === undefined || input.limit === '' ? 200 : Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new FinanceError('INVALID_FILTER', '对比条数须在 1 到 1000 之间', 'limit');
    const rows = await this.sql(`SELECT id,entity_id,report_month,status,created_at,published_at,engine_version,benchmark_ids,snapshot_sha256,summary,findings,finding_reviews,trace,snapshot
      FROM finance_report_runs WHERE id IN (:ids)`, { ids: [baseId, headId] });
    if (rows.length !== 2) throw new FinanceError('NOT_FOUND', '月报不存在', 'id', 404);
    const result = compareReports(rows.find(row => row.id === baseId), rows.find(row => row.id === headId), limit);
    const names = await this.userNames(Object.values(result.findings.base_reviews).map((item: any) => item.by));
    for (const review of Object.values(result.findings.base_reviews) as any[]) review.by_name = names[review.by] ?? null;
    return result;
  }
  async reviewFinding(payload: any, actor: string, transaction: any) {
    onlyKeys(payload, ['id', 'finding_key', 'status', 'note', 'expected_revision']);
    const id = uuid(payload.id, 'id');
    const key = typeof payload.finding_key === 'string' ? payload.finding_key : '';
    if (!/^f\d{1,4}-[0-9a-f]{12}$/.test(key)) throw new FinanceError('INVALID_ID', '校验发现标识无效', 'finding_key');
    const status = payload.status === null ? null : payload.status;
    if (!['confirmed', 'needs_fix', 'not_applicable', null].includes(status)) throw new FinanceError('INVALID_FILTER', '复核结论无效', 'status');
    const note = typeof payload.note === 'string' ? payload.note.trim() : '';
    if ((payload.note !== undefined && payload.note !== null && typeof payload.note !== 'string') || note.length > 500) throw new FinanceError('INVALID_NOTE', '复核说明最多 500 字', 'note');
    const expected = payload.expected_revision === undefined ? 0 : payload.expected_revision;
    if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) throw new FinanceError('STALE_REVISION', '该条复核已被他人修改，请刷新', 'expected_revision', 409);
    await this.service.lock([`report-run:${id}`], transaction);
    const run = await this.service.requiredRow('report_runs', id, transaction);
    if (run.get('status') !== 'ready') throw new FinanceError('REPORT_REVIEW_LOCKED', '已发布或已被替代的月报，复核记录不可修改', 'id', 409);
    const findings = run.get('findings') || [];
    const index = Number(key.slice(1, key.indexOf('-')));
    const finding = findings[index];
    if (!finding || findingKey(index, finding) !== key) throw new FinanceError('FINDING_NOT_FOUND', '这条校验发现已经变化，请刷新', 'finding_key', 409);
    if (noteRequired(finding.level, status) && !note) throw new FinanceError('REVIEW_NOTE_REQUIRED', '请填写这条发现的复核说明', 'note');
    const stored = run.get('finding_reviews') || { items: {}, counts: {} };
    const items = { ...(stored.items || {}) };
    const current = items[key];
    if ((current?.revision || 0) !== expected) throw new FinanceError('STALE_REVISION', '该条复核已被他人修改，请刷新', 'expected_revision', 409);
    const history = [...(current?.history || [])];
    if (current) history.push({ status: current.status, note: current.note || '', by: current.by, at: current.at });
    const review = { status, note, by: actor, at: new Date().toISOString(), revision: (current?.revision || 0) + 1, history: history.slice(-20) };
    items[key] = review;
    const counts = reviewCounts(findings.map((item: any, itemIndex: number) => ({ ...item, key: findingKey(itemIndex, item) })), items);
    await run.update({ finding_reviews: { items, counts }, technical_revision: run.get('technical_revision') + 1 }, writeOptions(transaction));
    return { id, technical_revision: run.get('technical_revision'), finding_key: key, review };
  }
  async publish(payload: any, actor: string, transaction: any) {
    onlyKeys(payload, ['id', 'technical_revision', 'review_note']);
    const id = uuid(payload.id, 'id');
    await this.service.lock([`report-run:${id}`], transaction);
    const run = await this.service.requiredRow('report_runs', id, transaction);
    this.service.revision(run, payload.technical_revision);
    if (run.get('status') !== 'ready') throw new FinanceError('REPORT_NOT_PUBLISHABLE', '只有已生成、未发布的月报可以发布', 'id', 409);
    const note = typeof payload.review_note === 'string' ? payload.review_note.trim() : '';
    if (payload.review_note !== undefined && (typeof payload.review_note !== 'string' || note.length > 2000)) throw new FinanceError('INVALID_NOTE', '复核说明最多 2000 字', 'review_note');
    const findings = (run.get('findings') || []).map((finding: any, index: number) => ({ ...finding, key: findingKey(index, finding) }));
    const gate = reviewGate(findings, run.get('finding_reviews'), note);
    if (!gate.ok) {
      const blocker = gate.blockers[0];
      throw new FinanceError(blocker.code, blocker.message, 'review_note', blocker.code === 'REVIEW_NOTE_REQUIRED' ? 422 : 409);
    }
    await this.service.lock([`entity:${run.get('entity_id')}`], transaction);
    const previous = await this.service.model('report_runs').findAll({ where: { entity_id: run.get('entity_id'), report_month: run.get('report_month'), status: 'published' }, ...writeOptions(transaction) });
    for (const row of previous) await row.update({ status: 'superseded', technical_revision: row.get('technical_revision') + 1 }, writeOptions(transaction));
    await run.update({ status: 'published', published_by: actor, published_at: new Date(), review_note: note || null, technical_revision: run.get('technical_revision') + 1 }, writeOptions(transaction));
    return { id: run.id, technical_revision: run.get('technical_revision') };
  }
  async retry(payload: any, transaction: any) {
    onlyKeys(payload, ['id', 'technical_revision']);
    const id = uuid(payload.id, 'id');
    await this.service.lock([`report-run:${id}`], transaction);
    const run = await this.service.requiredRow('report_runs', id, transaction);
    this.service.revision(run, payload.technical_revision);
    if (run.get('status') !== 'failed') throw new FinanceError('REPORT_NOT_RETRYABLE', '只有生成失败的月报可以重试；数据更新后请重新生成', 'id', 409);
    await run.update({ status: 'queued', error: null, technical_revision: run.get('technical_revision') + 1 }, writeOptions(transaction));
    return plain(run);
  }
}
