import type { ReportTarget } from './report-center';

const TAG_COLUMNS = new Set(['allocation_role', 'investment_region', 'strategy']);
export const TRACE_TABLE_NAMES: Record<string, string> = {
  finance_transactions: '申赎记录', finance_fund_navs: '基金净值', finance_fund_returns: '基金收益率', finance_benchmark_values: '基准点位', finance_funds: '基金资料',
};

/** The rule a computed trace node applied, in reviewer wording. */
export function traceFormulaText(trace: any, n: any) {
  if (n.op === 'pick') return `${trace.range_rules[n.params.mode]}（口径 ${n.params.mode}）`;
  const text = trace.formulas[n.rule] || n.op;
  return n.op === 'sum' && n.params?.coeffs?.some((c: number) => c < 0) ? `${text}（赎回取负）` : text;
}

/** Where a trace leaf came from, in reviewer wording. */
export function traceSourceText(s: any) {
  if (!s) return null;
  if (s.sheet && !s.table) return `录入表「${s.sheet}」第 ${s.row} 行 · ${s.col}`;
  const head = `${TRACE_TABLE_NAMES[s.table] || s.table} · ${s.date ? `${s.date} · ` : ''}${s.col}`;
  return s.batch ? `${head}（导入批次 ${String(s.batch).slice(0, 8)}${s.sheet ? `，「${s.sheet}」第 ${s.row} 行` : ''}）` : `${head}（手工录入）`;
}

function dated(value: unknown) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}

/** Map a trace leaf back to a Finance record. Old leaves often store only the row id, so record_refs fills in the rest. */
export function traceLeafTarget(src: any, entityId: string, refs: any): ReportTarget | null {
  if (!src?.table) return null;
  if (src.table === 'finance_fund_returns') {
    const extra = refs?.fund_returns?.[src.id] || {};
    const share = src.share_class_id || extra.share_class_id;
    const date = dated(src.date) || dated(extra.date);
    return share && date ? { kind: 'return', share_class_id: share, date } : null;
  }
  if (src.table === 'finance_fund_navs') {
    const extra = refs?.fund_navs?.[src.id] || {};
    const share = src.share_class_id || extra.share_class_id;
    const date = dated(src.date) || dated(extra.date);
    const fund = extra.fund_id || refs?.share_classes?.[share]?.fund_id;
    return share && date && fund ? { kind: 'nav', fund_id: fund, share_class_id: share, date } : null;
  }
  if (src.table === 'finance_transactions') return { kind: 'trades', entity_id: entityId };
  if (src.table === 'finance_benchmark_values') {
    const extra = refs?.benchmark_values?.[src.id] || {};
    const date = dated(src.date) || dated(extra.date);
    const benchmark = src.date ? src.id : extra.benchmark_id || src.id;
    return date ? { kind: 'benchmark', benchmark_id: benchmark || null, date } : null;
  }
  if (src.table === 'finance_funds' && TAG_COLUMNS.has(src.col) && src.id) return { kind: 'fund', fund_id: src.id, field: src.col };
  return null;
}
