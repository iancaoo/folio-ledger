import { FinanceError } from '../../shared/values';
import { findingFingerprint, findingKey } from '../../shared/report-review';
import { monthEnd } from './model';
import { traceLeafTarget } from '../../shared/trace-source';

const DOCUMENT_STATUSES = new Set(['ready', 'published', 'superseded']);
const METRICS = ['ytd', 'irr', 'total_nav', 'total_invested'] as const;
const FUND_FIELDS = ['weight', 'nav', 'nav_source', 'invested', 'ytd', 'first_invest', 'risk', 'region', 'strategy'];

function close(left: unknown, right: unknown) {
  if (left === right) return true;
  if (typeof left !== 'number' || typeof right !== 'number' || Number.isNaN(left) || Number.isNaN(right)) return JSON.stringify(left) === JSON.stringify(right);
  const scale = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) <= scale * 1e-9;
}
function delta(left: unknown, right: unknown) {
  return typeof left === 'number' && typeof right === 'number' ? right - left : null;
}
function rulesOf(summary: any) {
  const rules = summary?.trace?.rules;
  return rules ? { id: rules.id, text: rules.range_value_text } : null;
}
function metaOf(run: any) {
  return {
    id: run.id, status: run.status, created_at: run.created_at, published_at: run.published_at || null,
    engine_version: run.engine_version, rules: rulesOf(run.summary), has_trace: !!run.trace,
    benchmark_ids: run.benchmark_ids || null, currency: run.summary?.currency || null, snapshot_sha256: run.snapshot_sha256,
  };
}
function leafIdentity(node: any) {
  const src = node?.src;
  if (!src?.table) return null;
  if (src.id || src.share_class_id) return [src.table, src.id || '', src.share_class_id || '', String(src.date || '').slice(0, 10), src.col || ''].join('|');
  return null;
}
function outputIds(outputs: any) {
  const ids = new Set<string>();
  const walk = (value: any) => {
    if (!value) return;
    if (typeof value === 'string') ids.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(outputs);
  return [...ids];
}
function take<T>(rows: T[], limit: number, truncated: { value: boolean }) {
  if (rows.length > limit) truncated.value = true;
  return rows.slice(0, limit);
}
function dated(value: unknown) {
  return String(value || '').slice(0, 10);
}
function snapshotRows(snapshot: any, reportMonth: string) {
  const end = monthEnd(reportMonth);
  const keep = (date: unknown) => dated(date) && dated(date) <= end;
  const rows: Array<{ key: string; label: string; src: any; value: any }> = [];
  for (const row of snapshot?.transactions || []) if (keep(row.confirmation_date)) rows.push({ key: `transactions|${row.id}`, label: '申赎', src: { table: 'finance_transactions', id: row.id }, value: publicFields(row) });
  for (const row of snapshot?.fund_navs || []) if (keep(row.nav_date)) rows.push({ key: `nav|${row.share_class_id}|${dated(row.nav_date)}`, label: '净值', src: { table: 'finance_fund_navs', id: row.id, share_class_id: row.share_class_id, date: dated(row.nav_date) }, value: publicFields(row) });
  for (const row of snapshot?.fund_returns || []) if (keep(row.return_date)) rows.push({ key: `return|${row.share_class_id}|${dated(row.return_date)}`, label: '收益率', src: { table: 'finance_fund_returns', id: row.id, share_class_id: row.share_class_id, date: dated(row.return_date) }, value: publicFields(row) });
  for (const row of snapshot?.benchmark_values || []) if (keep(row.value_date)) rows.push({ key: `benchmark|${row.benchmark_id}|${dated(row.value_date)}`, label: '基准点位', src: { table: 'finance_benchmark_values', id: row.benchmark_id, date: dated(row.value_date) }, value: publicFields(row) });
  return rows;
}
function publicFields(row: any) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('source_')));
}
function recordRefs(snapshot: any) {
  const share_classes = Object.fromEntries((snapshot?.share_classes || []).filter((row: any) => row?.id).map((row: any) => [row.id, { fund_id: row.fund_id }]));
  const fund_navs = Object.fromEntries((snapshot?.fund_navs || []).filter((row: any) => row?.id).map((row: any) => [row.id, { share_class_id: row.share_class_id, fund_id: share_classes[row.share_class_id]?.fund_id, date: dated(row.nav_date) }]));
  const fund_returns = Object.fromEntries((snapshot?.fund_returns || []).filter((row: any) => row?.id).map((row: any) => [row.id, { share_class_id: row.share_class_id, date: dated(row.return_date) }]));
  return { share_classes, fund_navs, fund_returns };
}
function withTarget(row: any, entityId: string, refs: any) {
  return { ...row, target: traceLeafTarget(row.src, entityId, refs) };
}

function diffTrace(base: any, head: any, limit: number, truncated: { value: boolean }) {
  const baseNodes = base.trace.nodes || {};
  const headNodes = head.trace.nodes || {};
  const baseByLeaf = new Map<string, string>();
  const headByLeaf = new Map<string, string>();
  for (const [id, node] of Object.entries<any>(baseNodes)) { const key = node.op === 'leaf' ? leafIdentity(node) : null; if (key) baseByLeaf.set(key, id); }
  for (const [id, node] of Object.entries<any>(headNodes)) { const key = node.op === 'leaf' ? leafIdentity(node) : null; if (key) headByLeaf.set(key, id); }
  const leaves: any[] = [];
  const seen = new Set<string>();
  for (const [key, id] of baseByLeaf) {
    seen.add(key);
    const other = headByLeaf.get(key);
    const left = baseNodes[id];
    const right = other ? headNodes[other] : undefined;
    if (!right) leaves.push({ id: key, label: left.label, change: 'removed', base: left.value ?? null, head: null, src: left.src });
    else if (!close(left.value, right.value)) leaves.push({ id: key, label: right.label || left.label, change: 'value', base: left.value ?? null, head: right.value ?? null, src: right.src });
    else if ((left.src?.batch || null) !== (right.src?.batch || null) || (left.src?.row || null) !== (right.src?.row || null)) leaves.push({ id: key, label: right.label || left.label, change: 'source', base: left.value ?? null, head: right.value ?? null, src: right.src });
  }
  for (const [key, id] of headByLeaf) if (!seen.has(key)) { const node = headNodes[id]; leaves.push({ id: key, label: node.label, change: 'added', base: null, head: node.value ?? null, src: node.src }); }
  const results: any[] = [];
  for (const id of outputIds(head.trace.outputs)) {
    const left = baseNodes[id];
    const right = headNodes[id];
    if (!left || !right || close(left.value, right.value)) continue;
    results.push({ id, label: right.label, base: left.value ?? null, head: right.value ?? null, delta: delta(left.value, right.value) });
  }
  const refs = recordRefs(head.snapshot);
  return {
    source: 'trace' as const,
    leaves: take(leaves, limit, truncated).map(row => withTarget(row, head.entity_id, refs)),
    results: take(results, limit, truncated),
    counts: { leaves: leaves.length, results: results.length, all_nodes: Object.keys(headNodes).length },
  };
}
function diffSnapshot(base: any, head: any, reason: string, limit: number, truncated: { value: boolean }) {
  const left = new Map(snapshotRows(base.snapshot, base.report_month).map(row => [row.key, row]));
  const right = new Map(snapshotRows(head.snapshot, head.report_month).map(row => [row.key, row]));
  const leaves: any[] = [];
  for (const [key, row] of left) {
    const other = right.get(key);
    if (!other) leaves.push({ id: key, label: row.label, change: 'removed', base: row.value, head: null, src: row.src });
    else if (!close(row.value, other.value)) leaves.push({ id: key, label: other.label, change: 'value', base: row.value, head: other.value, src: other.src });
  }
  for (const [key, row] of right) if (!left.has(key)) leaves.push({ id: key, label: row.label, change: 'added', base: null, head: row.value, src: row.src });
  const refs = recordRefs(head.snapshot);
  return {
    source: 'snapshot' as const, reason,
    leaves: take(leaves, limit, truncated).map(row => withTarget(row, head.entity_id, refs)),
    results: [],
    counts: { leaves: leaves.length, results: 0, all_nodes: 0 },
  };
}

export function compareReports(base: any, head: any, limit = 200) {
  if (base.entity_id !== head.entity_id || base.report_month !== head.report_month) throw new FinanceError('COMPARE_SCOPE', '只能对比同一主体同一月份的月报', 'base_id');
  if (!DOCUMENT_STATUSES.has(base.status) || !DOCUMENT_STATUSES.has(head.status)) throw new FinanceError('REPORT_NOT_READY', '月报尚未生成完成', 'id', 409);
  const truncated = { value: false };
  const metrics = METRICS.map(key => ({ key, base: base.summary?.[key] ?? null, head: head.summary?.[key] ?? null, delta: delta(base.summary?.[key], head.summary?.[key]) })).filter(item => !close(item.base, item.head));
  const baseMonths = new Map((base.summary?.months || []).map((row: any) => [row.month, row]));
  const headMonths = new Map((head.summary?.months || []).map((row: any) => [row.month, row]));
  const months: any[] = [];
  for (const month of new Set([...baseMonths.keys(), ...headMonths.keys()])) for (const field of ['nav', 'flow', 'return']) {
    const left = baseMonths.get(month)?.[field] ?? null;
    const right = headMonths.get(month)?.[field] ?? null;
    if (!close(left, right)) months.push({ month, field, base: left, head: right, delta: delta(left, right) });
  }
  const baseFunds = new Map((base.summary?.funds || []).map((row: any) => [row.key, row]));
  const headFunds = new Map((head.summary?.funds || []).map((row: any) => [row.key, row]));
  const funds: any[] = [];
  for (const [key, row] of baseFunds) {
    const other = headFunds.get(key);
    if (!other) funds.push({ key, change: 'removed', base: row, fields: [] });
    else {
      const fields = FUND_FIELDS.filter(field => !close(row[field], other[field]));
      if (fields.length) funds.push({ key, change: 'changed', base: row, head: other, fields });
    }
  }
  for (const [key, row] of headFunds) if (!baseFunds.has(key)) funds.push({ key, change: 'added', head: row, fields: [] });
  const baseFindings = (base.findings || []).map((finding: any, index: number) => ({ ...finding, key: finding.key || findingKey(index, finding), fingerprint: findingFingerprint(finding) }));
  const headFindings = (head.findings || []).map((finding: any, index: number) => ({ ...finding, key: finding.key || findingKey(index, finding), fingerprint: findingFingerprint(finding) }));
  const used = new Set<number>();
  const added: any[] = [];
  const removed: any[] = [];
  const levelChanged: any[] = [];
  let unchanged = 0;
  const baseReviews: Record<string, any> = {};
  const baseItems = base.finding_reviews?.items || {};
  for (const finding of headFindings) {
    const index = baseFindings.findIndex((item, itemIndex) => !used.has(itemIndex) && item.fingerprint === finding.fingerprint);
    if (index < 0) { added.push(brief(finding)); continue; }
    used.add(index);
    const previous = baseFindings[index];
    const review = baseItems[previous.key];
    if (review?.status) baseReviews[finding.fingerprint] = { status: review.status, by: review.by, at: review.at, note: review.note || '' };
    if (previous.level !== finding.level) levelChanged.push({ base: brief(previous), head: brief(finding) });
    else unchanged += 1;
  }
  baseFindings.forEach((finding, index) => { if (!used.has(index)) removed.push(brief(finding)); });
  const baseRules = rulesOf(base.summary);
  const headRules = rulesOf(head.summary);
  const metaChanges: any[] = [];
  if (base.engine_version !== head.engine_version) metaChanges.push({ field: 'engine_version', base: base.engine_version, head: head.engine_version });
  if (JSON.stringify(baseRules) !== JSON.stringify(headRules)) metaChanges.push({ field: 'rules', base: baseRules, head: headRules });
  if (JSON.stringify(base.benchmark_ids || null) !== JSON.stringify(head.benchmark_ids || null)) metaChanges.push({ field: 'benchmarks', base: base.benchmark_ids || null, head: head.benchmark_ids || null });
  if ((base.summary?.currency || null) !== (head.summary?.currency || null)) metaChanges.push({ field: 'currency', base: base.summary?.currency || null, head: head.summary?.currency || null });
  let data: any;
  if (base.trace && head.trace && base.trace.schema === head.trace.schema) data = diffTrace(base, head, limit, truncated);
  else if (base.trace && head.trace) data = { source: 'none', reason: 'schema_mismatch', leaves: [], results: [], counts: { leaves: 0, results: 0, all_nodes: 0 } };
  else data = diffSnapshot(base, head, !base.trace && !head.trace ? 'both_no_trace' : !base.trace ? 'base_no_trace' : 'head_no_trace', limit, truncated);
  return {
    base: metaOf(base), head: metaOf(head), same_snapshot: base.snapshot_sha256 === head.snapshot_sha256, meta_changes: metaChanges,
    metrics: take(metrics, limit, truncated), months: take(months, limit, truncated), funds: take(funds, limit, truncated),
    findings: { added: take(added, limit, truncated), removed: take(removed, limit, truncated), level_changed: take(levelChanged, limit, truncated), unchanged, base_reviews: baseReviews },
    data: { ...data, truncated: truncated.value },
  };
}
function brief(finding: any) {
  return { level: finding.level, category: finding.category, title: finding.title, fund: finding.fund, month: finding.month, fingerprint: finding.fingerprint };
}
