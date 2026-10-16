import { FinanceError } from '../shared/values';
import { BOARD_STAGES, BoardStage, isBoardStage } from '../shared/report-center';
import { FinanceService, uuid } from './service';
import { FinanceReportSnapshot } from './report-snapshot';
import { FinanceReports } from './reports';
import { pagination } from './queries';
import { monthEnd } from './report/model';
import { checkReadiness, readinessCounts, readinessStatus, sortReadinessItems } from './report/readiness';

const ACTIVE = new Set(['queued', 'running', 'ready', 'failed']);
const SCOPE_SQL = `WITH balances AS (
  SELECT entity_id, share_class_id,
    sum(CASE WHEN transaction_type='赎回' THEN -confirmed_units ELSE confirmed_units END) AS units,
    bool_or(confirmation_date>=:month_start) AS flow_in_month
  FROM finance_transactions WHERE NOT is_void AND confirmation_date<=:report_date
  GROUP BY entity_id, share_class_id),
scope AS (SELECT entity_id, bool_or(units>0) AS holding, bool_or(flow_in_month) AS flow FROM balances GROUP BY entity_id)
SELECT e.id, e.legal_name, e.common_name, e.account_status, e.is_deleted, e.created_at, g.client_code,
  COALESCE(s.holding,false) AS holding, COALESCE(s.flow,false) AS flow
FROM finance_investment_entities e JOIN finance_client_groups g ON g.id=e.client_group_id
LEFT JOIN scope s ON s.entity_id=e.id
WHERE (NOT e.is_deleted AND (s.holding OR s.flow))
   OR EXISTS (SELECT 1 FROM finance_report_runs r WHERE r.entity_id=e.id AND r.report_month=:month)
ORDER BY g.client_code, e.created_at, e.id`;
const RUNS_SQL = `SELECT r.id,r.entity_id,r.status,r.created_at,r.published_at,r.published_by,r.owner_id,r.technical_revision,r.error,r.benchmark_ids,
  r.summary->'counts' AS counts
FROM finance_report_runs r WHERE r.report_month=:month ORDER BY r.entity_id, r.created_at DESC, r.id DESC`;

const truthy = (value: any) => value === true || value === 't' || value === 'true' || value === 1;
const stamp = (row: any) => new Date(row.created_at).getTime();
function parseCounts(value: any) {
  if (value == null) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' ? parsed : null;
}
function runBrief(run: any) {
  if (!run) return null;
  return {
    id: run.id, status: run.status, created_at: run.created_at, technical_revision: run.technical_revision,
    counts: parseCounts(run.counts), error: run.error ?? null, benchmark_ids: run.benchmark_ids ?? null,
  };
}

export class FinanceReportCenter {
  constructor(public service: FinanceService, public snapshot: FinanceReportSnapshot, public reports: FinanceReports) {}

  benchmarkIds(value: any): string[] | null {
    if (value === undefined || value === null || value === '') return null;
    const ids = typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : value;
    if (!Array.isArray(ids) || ids.length > 20) throw new FinanceError('INVALID_ID', '一次最多选择 20 个基准', 'benchmark_ids');
    if (!ids.length) return null;
    return [...new Set(ids.map((id: any) => uuid(id, 'benchmark_ids')))];
  }

  async readiness(input: any) {
    const entityId = uuid(input.entity_id, 'entity_id');
    const month = this.reports.month(input.report_month);
    const explicit = this.benchmarkIds(input.benchmark_ids);
    const reportDate = monthEnd(month);
    const snap = await this.snapshot.read({ entity_ids: [entityId], report_date: reportDate });
    const rules = await this.reports.tagRules();
    const checked = checkReadiness(snap, entityId, month, explicit, rules);
    const runs = await this.reports.sql(`SELECT id,status,created_at,summary->'counts' AS counts
      FROM finance_report_runs WHERE entity_id=:id AND report_month=:month ORDER BY created_at DESC, id DESC LIMIT 5`, { id: entityId, month });
    const items = [...checked.items];
    const notable = runs.filter(row => row.status === 'ready' || row.status === 'published');
    if (notable.length) {
      const published = notable.some(row => row.status === 'published');
      const ready = notable.some(row => row.status === 'ready');
      const which = published && ready ? '待复核和已发布' : published ? '已发布' : '待复核';
      items.push({
        code: 'EXISTING_RUN', level: '提示', category: '月报状态', target: null,
        title: `本月已有${which}月报，重新生成会产生新版本`,
        detail: '新版本进入复核队列；发布后会替代当前已发布版本。',
      });
    }
    const sorted = sortReadinessItems(items);
    const entity = snap.entities.find((row: any) => row.id === entityId);
    return {
      entity: { id: entity.id, legal_name: entity.legal_name, common_name: entity.common_name ?? null, client_code: entity.client_code, is_deleted: !!entity.is_deleted },
      report_month: month, report_date: reportDate, checked_at: new Date().toISOString(),
      benchmark_basis: explicit ? 'explicit' : 'default',
      benchmark_ids: explicit || checked.benchmark_ids_used,
      status: readinessStatus(sorted), counts: readinessCounts(sorted),
      forecast: checked.forecast, funds: checked.funds, items: sorted,
      runs: runs.map(row => ({ id: row.id, status: row.status, created_at: row.created_at, counts: parseCounts(row.counts) })),
    };
  }

  async board(input: any) {
    const month = this.reports.month(input.report_month);
    const reportDate = monthEnd(month);
    if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200)) throw new FinanceError('INVALID_SEARCH', '搜索文本最多 200 字');
    const stageFilter = input.stage ? (Array.isArray(input.stage) ? input.stage : String(input.stage).split(',')).map((item: string) => String(item).trim()).filter(Boolean) : [];
    if (stageFilter.some((item: string) => !isBoardStage(item))) throw new FinanceError('INVALID_FILTER', '月报进度无效', 'stage');
    const withReadiness = !(input.with_readiness === '0' || input.with_readiness === false || input.with_readiness === 0);
    const paging = pagination(input);

    const { entities, runs } = await this.service.db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async (transaction: any) => ({
      entities: await this.reports.sql(SCOPE_SQL, { month, month_start: `${month}-01`, report_date: reportDate }, transaction),
      runs: await this.reports.sql(RUNS_SQL, { month }, transaction),
    }));
    const byEntity = new Map<string, any[]>();
    for (const run of runs) {
      const list = byEntity.get(run.entity_id) || [];
      list.push(run);
      byEntity.set(run.entity_id, list);
    }
    const names = await this.reports.userNames(runs.map(run => run.published_by));

    type Draft = { stage: BoardStage | null; readiness: any; latest_run: any; published_run: any; deleted: boolean };
    const drafts = new Map<string, Draft>();
    for (const entity of entities) {
      const rows = byEntity.get(entity.id) || [];
      const published = rows.find(row => row.status === 'published');
      const active = rows.find(row => ACTIVE.has(row.status) && (!published || stamp(row) > stamp(published)));
      let stage: BoardStage | null = null;
      if (active) stage = active.status === 'failed' ? 'failed' : active.status === 'ready' ? 'review' : 'generating';
      else if (published) stage = 'published';
      else if (truthy(entity.is_deleted)) stage = 'not_ready';
      drafts.set(entity.id, {
        stage, deleted: truthy(entity.is_deleted),
        readiness: stage === 'not_ready' && truthy(entity.is_deleted) ? { status: 'blocked', counts: { 错误: 1, 警告: 0, 提示: 0 }, benchmark_ids: [], benchmark_basis: 'default' } : null,
        latest_run: runBrief(active || rows[0]),
        published_run: published ? { id: published.id, published_at: published.published_at, publisher_name: names[String(published.published_by)] ?? null } : null,
      });
    }

    const pending = entities.filter(entity => drafts.get(entity.id)!.stage === null);
    let readinessTruncated = false;
    if (!withReadiness) {
      for (const entity of pending) drafts.get(entity.id)!.stage = 'not_checked';
    } else {
      readinessTruncated = pending.length > 300;
      for (const entity of pending.slice(300)) drafts.get(entity.id)!.stage = 'not_checked';
      const todo = pending.slice(0, 300);
      const rules = todo.length ? await this.reports.tagRules() : null;
      for (let index = 0; index < todo.length; index += 50) {
        const chunk = todo.slice(index, index + 50);
        let snap: any;
        try { snap = await this.snapshot.read({ entity_ids: chunk.map(entity => entity.id), report_date: reportDate }); }
        catch (error) {
          if (error instanceof FinanceError) throw error;
          this.service.db.logger?.error?.('Finance report readiness failed', { entity_id: chunk.map(entity => entity.id), error });
          for (const entity of chunk) drafts.get(entity.id)!.stage = 'not_checked';
          continue;
        }
        for (const entity of chunk) {
          try {
            const result = checkReadiness(snap, entity.id, month, null, rules!);
            const draft = drafts.get(entity.id)!;
            draft.stage = result.status === 'blocked' ? 'not_ready' : 'ready_to_generate';
            draft.readiness = { status: result.status, counts: result.counts, benchmark_ids: result.benchmark_ids_used, benchmark_basis: 'default' };
          } catch (error) {
            if (error instanceof FinanceError) throw error;
            this.service.db.logger?.error?.('Finance report readiness failed', { entity_id: entity.id, error });
            drafts.get(entity.id)!.stage = 'not_checked';
          }
        }
      }
    }

    const rows = entities.map(entity => {
      const draft = drafts.get(entity.id)!;
      const holding = truthy(entity.holding);
      const flow = truthy(entity.flow);
      return {
        entity_id: entity.id, legal_name: entity.legal_name, common_name: entity.common_name ?? null, client_code: entity.client_code,
        account_status: entity.account_status ?? null, entity_deleted: draft.deleted,
        scope_reason: holding ? 'holding' : flow ? 'flow' : 'run_only',
        stage: draft.stage, readiness: draft.readiness, latest_run: draft.latest_run, published_run: draft.published_run,
      };
    });
    const counts = { scope: rows.length, not_ready: 0, ready_to_generate: 0, ready_with_warnings: 0, not_checked: 0, generating: 0, failed: 0, review: 0, review_with_errors: 0, published: 0 };
    for (const row of rows) {
      if (row.stage) counts[row.stage] += 1;
      if (row.stage === 'ready_to_generate' && row.readiness?.status === 'warning') counts.ready_with_warnings += 1;
      if (row.stage === 'review' && Number(row.latest_run?.counts?.错误 || 0) > 0) counts.review_with_errors += 1;
    }
    const needle = typeof input.search === 'string' ? input.search.trim().toLowerCase() : '';
    const stageSet = new Set(stageFilter);
    const filtered = rows.filter(row => (!needle || [row.legal_name, row.common_name, row.client_code].some(value => String(value || '').toLowerCase().includes(needle)))
      && (!stageSet.size || stageSet.has(row.stage as string)));
    const rank = new Map<string, number>(BOARD_STAGES.map((stage, index) => [stage, index]));
    filtered.sort((a, b) => (rank.get(a.stage!) ?? 99) - (rank.get(b.stage!) ?? 99) || String(a.client_code).localeCompare(String(b.client_code)) || String(a.entity_id).localeCompare(String(b.entity_id)));
    return {
      report_month: month, report_date: reportDate, readiness_truncated: readinessTruncated, counts,
      rows: filtered.slice(paging.offset, paging.offset + paging.page_size),
      count: filtered.length, page: paging.page, page_size: paging.page_size,
    };
  }
}
