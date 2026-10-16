import { FinanceError } from '../../shared/values';
import { Dataset, Month, Nav, Return, dayNumber, fundKeys, monthEnd, monthRange, monthStart } from './model';
import { DEFAULT_RULES, Rules, usedReturn } from './rules';

export type FundYtd = { value: number | null; lo: number | null; hi: number | null; estimate: boolean };
export type Allocation = Array<[string, number]>;
export type Result = {
  months: Month[]; reportMonths: Month[];
  nav: Record<string, Record<Month, Nav>>;
  totalNav: Record<Month, number>; totalFlow: Record<Month, number>; portRet: Record<Month, number>;
  ytd: number; irr: number; fundYtd: Record<string, FundYtd>;
  invested: Record<string, number>; firstInvest: Record<string, string>; weights: Record<string, number>;
  alloc: Record<'风险' | '地域' | '策略', Allocation>;
  missing: Array<[string, Month]>;
  rules: Rules;
};
export type Orders = { risk: string[]; region: string[]; strategy: string[] };

/** Same convention as Excel XIRR: discount by actual days / 365. */
export function xirr(cashflows: Array<[string, number]>) {
  const d0 = Math.min(...cashflows.map(([d]) => dayNumber(d)));
  const npv = (r: number) => cashflows.reduce((sum, [d, c]) => sum + c / Math.pow(1 + r, (dayNumber(d) - d0) / 365), 0);
  let lo = -0.99, hi = 10;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (npv(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
export const chain = (rates: number[]) => rates.reduce((p, r) => p * (1 + r), 1) - 1;

function fundYtd(rs: Return[]): FundYtd {
  if (!rs.length) return { value: null, lo: null, hi: null, estimate: false };
  const estimate = rs.some(r => r.estimate);
  if (rs.some(r => r.isRange)) return { value: null, lo: chain(rs.map(r => r.isRange ? r.lo! : r.value!)), hi: chain(rs.map(r => r.isRange ? r.hi! : r.value!)), estimate };
  return { value: chain(rs.map(r => r.value!)), lo: null, hi: null, estimate };
}
function ordered(groups: Map<string, number>, order: string[]): Allocation {
  const keys = [...order.filter(k => groups.has(k)), ...[...groups.keys()].filter(k => !order.includes(k))];
  return keys.map(k => [k, groups.get(k)!]);
}

export function compute(ds: Dataset, orders: Orders, rules: Rules = DEFAULT_RULES): Result {
  const keys = fundKeys(ds);
  const starts = keys.flatMap(k => [...Object.keys(ds.flows[k] || {}), ...Object.keys(ds.navs[k] || {})]);
  if (!starts.length) throw new FinanceError('NO_HOLDINGS', '该投资主体截至报告月没有申赎记录，无法生成月报', 'entity_id');
  const months = monthRange(starts.reduce((a, b) => a < b ? a : b), ds.asOf);
  const reportMonths = months.filter(m => m.slice(0, 4) === ds.asOf.slice(0, 4));

  const nav: Result['nav'] = {}; const missing: Result['missing'] = [];
  for (const k of keys) {
    nav[k] = {}; let prev = 0;
    for (const m of months) {
      const base = prev + (ds.flows[k]?.[m] ?? 0);
      const given = ds.navs[k]?.[m]; const r = ds.returns[k]?.[m];
      let cell: Nav | undefined;
      if (given) cell = given;
      else if (base > 0 && r) cell = { value: base * (1 + usedReturn(rules, r)), source: '推算', estimate: r.estimate };
      else if (base > 0) { missing.push([k, m]); cell = { value: base, source: '缺失', estimate: true }; }
      if (cell) nav[k][m] = cell;
      prev = cell ? cell.value : 0;
    }
  }
  const totalNav: Record<Month, number> = {}; const totalFlow: Record<Month, number> = {};
  for (const m of months) {
    totalNav[m] = keys.reduce((sum, k) => sum + (nav[k][m]?.value ?? 0), 0);
    totalFlow[m] = keys.reduce((sum, k) => sum + (ds.flows[k]?.[m] ?? 0), 0);
  }
  const portRet: Record<Month, number> = {}; let prev = 0;
  for (const m of months) {
    const f = totalFlow[m];
    if (prev + f) portRet[m] = (totalNav[m] - prev - f) / (prev + f);
    prev = totalNav[m];
  }
  const ytd = chain(reportMonths.filter(m => m in portRet).map(m => portRet[m]));
  const cashflows: Array<[string, number]> = months.filter(m => totalFlow[m]).map(m => [monthStart(m), -totalFlow[m]]);
  cashflows.push([monthEnd(ds.asOf), totalNav[ds.asOf]]);

  const fundYtds: Record<string, FundYtd> = {};
  for (const k of [...keys, ...ds.benchmarks]) fundYtds[k] = fundYtd(reportMonths.filter(m => ds.returns[k]?.[m]).map(m => ds.returns[k][m]));
  const invested: Record<string, number> = {}; const firstInvest: Record<string, string> = {};
  for (const k of keys) {
    invested[k] = Object.values(ds.flows[k] || {}).reduce((a, b) => a + b, 0);
    const positive = Object.entries(ds.flows[k] || {}).filter(([, v]) => v > 0).map(([m]) => m).sort();
    if (positive.length) firstInvest[k] = monthStart(positive[0]);
  }
  const total = totalNav[ds.asOf];
  const weights: Record<string, number> = {};
  for (const k of keys) weights[k] = total && nav[k][ds.asOf] ? nav[k][ds.asOf].value / total : 0;
  const alloc = {} as Result['alloc'];
  for (const [dim, attr, order] of [['风险', 'risk', orders.risk], ['地域', 'region', orders.region], ['策略', 'strategy', orders.strategy]] as const) {
    const groups = new Map<string, number>();
    for (const k of keys) if (weights[k]) { const tag = ds.funds[k][attr]; groups.set(tag, (groups.get(tag) ?? 0) + weights[k]); }
    alloc[dim] = ordered(groups, order);
  }
  return { months, reportMonths, nav, totalNav, totalFlow, portRet, ytd, irr: xirr(cashflows), fundYtd: fundYtds, invested, firstInvest, weights, alloc, missing, rules };
}
