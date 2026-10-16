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
