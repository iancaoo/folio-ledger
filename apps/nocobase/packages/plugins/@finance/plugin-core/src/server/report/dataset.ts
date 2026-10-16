import { FinanceError } from '../../shared/values';
import { Dataset, Fund, Lineage, Month, Nav, Return, Src, toMonth } from './model';
import { ReturnRow, selectReturns } from './select';

const SNAPSHOT_TABLES = [['transactions', 'confirmation_date'], ['fund_navs', 'nav_date'], ['fund_returns', 'return_date'], ['benchmark_values', 'value_date']] as const;
const TAG_FIELDS = [['配置策略', 'allocation_role'], ['投资地区', 'investment_region'], ['基金策略', 'strategy']] as const;

function record(table: string, row: any, col: string): Src {
  const key = 'id' in row ? { id: row.id } : { share_class_id: row.share_class_id ?? null, date: row.nav_date || row.return_date || null };
  return { table, ...key, col, batch: row.source_batch_id ?? null, sheet: row.source_sheet ?? null, row: row.source_row ?? null };
}

/**
 * Assemble the calculation input for one entity from a report snapshot.
 * Several classes of one fund held by the same entity are reported separately.
 */
export function datasetFromSnapshot(snap: any, entityId: string, asOf: Month, benchmarkIds?: string[] | null): Dataset {
  const entity = snap.entities.find((row: any) => row.id === entityId);
  if (!entity) throw new FinanceError('NOT_FOUND', '快照中没有该投资主体', 'entity_id', 404);
  if (asOf > toMonth(snap.report_date)) throw new FinanceError('INVALID_REPORT_MONTH', '报告月份晚于快照日期', 'report_month');

  const txns = snap.transactions.filter((t: any) => t.entity_id === entityId && toMonth(t.confirmation_date) <= asOf);
  const classes = new Map<string, any>(snap.share_classes.map((s: any) => [s.id, s]));
  const held = [...new Set<string>(txns.map((t: any) => t.share_class_id))].map(id => classes.get(id));
  const perFund = new Map<string, number>();
  for (const s of held) perFund.set(s.fund_id, (perFund.get(s.fund_id) ?? 0) + 1);

  const funds: Record<string, Fund> = {}; const keyOf = new Map<string, string>();
  const byCodePoint = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const sorted = [...held].sort((a, b) => byCodePoint(a.short_name, b.short_name) || byCodePoint(a.class_label || '', b.class_label || ''));
  sorted.forEach((s, order) => {
    const key = perFund.get(s.fund_id) === 1 ? s.short_name : `${s.short_name} ${s.class_label || s.isin}`;
    keyOf.set(s.id, key);
    const role = (s.allocation_role || '').trim();
    funds[key] = { key, nameT1: s.strategy_detail ? `${s.short_name}（${s.strategy_detail}）` : s.short_name,
      nameT3: s.class_label ? `${s.short_name} - ${s.class_label}` : s.short_name,
      risk: !role || role.endsWith('型') ? role : `${role}型`, region: (s.investment_region || '').trim(), strategy: (s.strategy || '').trim(),
      kind: s.fund_kind, currency: s.currency, order };
  });

  const lineage: Lineage = { trades: {}, prices: {}, returns: {}, bench_levels: {}, tags: {} };
  for (const s of held) lineage.tags[keyOf.get(s.id)!] = Object.fromEntries(TAG_FIELDS.map(([col, field]) =>
    [col, { table: 'finance_funds', id: s.fund_id, col: field, value: s[field] ?? null }]));

  const flows: Dataset['flows'] = {}; const unitMoves: Record<string, Array<[Month, number]>> = {};
  for (const k of Object.keys(funds)) { flows[k] = {}; unitMoves[k] = []; lineage.trades[k] = []; lineage.prices[k] = {}; lineage.returns[k] = {}; }
  for (const t of txns) {
    const k = keyOf.get(t.share_class_id)!; const m = toMonth(t.confirmation_date);
    const sign = t.transaction_type === '赎回' ? -1 : 1;
    flows[k][m] = (flows[k][m] ?? 0) + sign * Number(t.amount);
    unitMoves[k].push([m, sign * Number(t.confirmed_units)]);
    lineage.trades[k].push({ month: m, sign, kind: t.transaction_type, amount: Number(t.amount), units: Number(t.confirmed_units), date: t.confirmation_date.slice(0, 10),
      src_amount: record('finance_transactions', t, 'amount'), src_units: record('finance_transactions', t, 'confirmed_units') });
  }
  const navs: Dataset['navs'] = Object.fromEntries(Object.keys(funds).map(k => [k, {} as Record<Month, Nav>]));
  for (const n of snap.fund_navs) {
    const k = keyOf.get(n.share_class_id); const m = toMonth(n.nav_date);
    if (!k || m > asOf) continue;
    const units = unitMoves[k].filter(([mm]) => mm <= m).reduce((s, [, q]) => s + q, 0);
    if (units > 1e-9) navs[k][m] = { value: units * Number(n.nav_per_unit), source: '对账单' };
    lineage.prices[k][m] = { value: Number(n.nav_per_unit), src: record('finance_fund_navs', n, 'nav_per_unit') };
  }
  const returns: Dataset['returns'] = Object.fromEntries(Object.keys(funds).map(k => [k, {} as Record<Month, Return>]));
  const returnRows: Record<string, ReturnRow[]> = {};
  for (const r of snap.fund_returns) {
    const k = keyOf.get(r.share_class_id);
    if (!k || toMonth(r.return_date) > asOf) continue;
    (returnRows[k] = returnRows[k] || []).push({ date: r.return_date.slice(0, 10), value: Number(r.mtd_return), label: r.estimate_label ?? null, row: r });
  }
  const returnSelections: Dataset['returnSelections'] = {};
  for (const [k, rows] of Object.entries(returnRows)) {
    returnSelections[k] = {};
    for (const s of selectReturns(rows)) {
      returnSelections[k][s.month] = s.candidates.map(({ date, value, kind, used, reason, row }) => ({ date, value, kind, used, reason, src: record('finance_fund_returns', row, 'mtd_return') }));
      if (s.chosen === null) continue;
      const c = s.candidates[s.chosen];
      returns[k][s.month] = new Return({ value: c.value, estimate: c.kind === '估算', source: '基金收益率' });
      lineage.returns[k][s.month] = { MTD收益率: record('finance_fund_returns', c.row, 'mtd_return') };
    }
  }
  // Without an explicit choice, a benchmark is reported only when it has a level in the report month.
  const chosen = benchmarkIds?.length ? snap.benchmarks.filter((b: any) => benchmarkIds.includes(b.id))
    : snap.benchmarks.filter((b: any) => snap.benchmark_values.some((v: any) => v.benchmark_id === b.id && toMonth(v.value_date) === asOf));
  if (benchmarkIds?.length && chosen.length !== new Set(benchmarkIds).size) throw new FinanceError('NOT_FOUND', '所选基准不存在', 'benchmark_ids', 404);
  const names = new Map<string, string>(chosen.map((b: any) => [b.id, b.name]));
  // The latest level within a month is that month's closing level; snapshot rows are date ordered.
  const levels = new Map<string, Map<Month, number>>([...names.values()].map(name => [name, new Map()]));
  const levelRows = new Map<string, Map<Month, any>>([...names.values()].map(name => [name, new Map()]));
  for (const v of snap.benchmark_values) if (toMonth(v.value_date) <= asOf && names.has(v.benchmark_id)) {
    levels.get(names.get(v.benchmark_id)!)!.set(toMonth(v.value_date), Number(v.index_value));
    levelRows.get(names.get(v.benchmark_id)!)!.set(toMonth(v.value_date), v);
  }
  const benchmarks = [...names.values()];
  for (const b of benchmarks) {
    const points = [...levels.get(b)!.entries()].sort(([a], [c]) => byCodePoint(a, c));
    lineage.bench_levels[b] = points.map(([m, level]) => { const v = levelRows.get(b)!.get(m);
      return [m, level, { table: 'finance_benchmark_values', id: v.benchmark_id, date: v.value_date, col: 'index_value' }]; });
    returns[b] = {};
    for (let i = 1; i < points.length; i++) returns[b][points[i][0]] = new Return({ value: points[i][1] / points[i - 1][1] - 1, source: '基准净值' });
  }

  const classIds = new Set(keyOf.keys());
  const provenance: Dataset['provenance'] = [];
  if (snap.demo_mode) for (const [table, column] of SNAPSHOT_TABLES) {
    const count = snap[table].filter((row: any) => toMonth(row[column]) <= asOf
      && (table !== 'transactions' || row.entity_id === entityId)
      && (!['fund_navs', 'fund_returns'].includes(table) || classIds.has(row.share_class_id))
      && (table !== 'benchmark_values' || names.has(row.benchmark_id))).length;
    if (count) provenance.push(['Finance', table, '模拟', count]);
  }
  const currencies = [...new Set<string>([...held.map(s => s.currency), ...txns.map((t: any) => t.currency)].filter(Boolean))].sort();
  return { client: entity.common_name || entity.legal_name, clientCode: entity.client_code, entityId, asOf, funds, benchmarks, returns, navs, flows, provenance, currencies, lineage, returnSelections };
}
