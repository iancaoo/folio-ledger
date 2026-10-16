/**
 * Calculation trace: every number in the report is a node that can be followed back to Finance records.
 *
 * Leaves (op = "leaf") carry a record locator; computed nodes carry the operation, role-named inputs,
 * the rule applied and flags (estimate, rolled forward, carried ...). Intermediate values are shared, so this
 * is a DAG that the UI expands as a tree. Node ids are business keys (nav|Echo|2026-08), so two traces can be
 * compared node by node. Mirrors apps/return-report/report/trace.py; both build the same graph from the same snapshot.
 */
import { Finding } from './checks';
import { Result, chain, xirr } from './engine';
import { Dataset, Month, Return, Src, fundKeys, monthEnd, monthLabel, monthStart } from './model';
import { FORMULAS, RANGE_VALUE, describeRules, usedReturn } from './rules';

export const TRACE_SCHEMA = 'return-report.trace/v1';
const TOL = 1e-9;

export type Unit = 'money' | 'pct' | 'units' | 'price' | 'index' | 'text';
export type TraceNode = {
  id: string; label: string; value: number | string | null; unit: Unit; op: string;
  inputs?: Array<[string, string]>; params?: Record<string, any>; rule?: string; flags?: string[]; src?: Src; refs?: string[];
};
export type TraceFinding = { level: string; category: string; title: string; detail: string; suggestion: string; node: string | null };
export type Trace = {
  schema: string; meta: { client: string; client_code: string; as_of: Month; rules: ReturnType<typeof describeRules> };
  formulas: Record<string, string>; range_rules: Record<string, string>;
  outputs: Record<string, any>; findings: TraceFinding[]; nodes: Record<string, TraceNode>;
};

class Graph {
  nodes: Record<string, TraceNode> = {};
  add(node: TraceNode) {
    if (node.id in this.nodes) throw new Error(`duplicate trace node ${node.id}`);
    for (const key of ['inputs', 'params', 'flags', 'refs', 'rule', 'src'] as const) {
      const v: any = node[key];
      if (v === undefined || v === null || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) delete node[key];
    }
    this.nodes[node.id] = node;
    return node.id;
  }
  leaf(id: string, label: string, value: any, unit: Unit, src?: Src | null, flags: string[] = []) {
    return this.add({ id, label, value, unit, op: 'leaf', src: src ?? undefined, flags });
  }
  calc(id: string, label: string, value: number, unit: Unit, op: string, inputs: Array<[string, string]>, rule: string,
    params: Record<string, any> = {}, flags: string[] = [], refs: string[] = []) {
    return this.add({ id, label, value, unit, op, inputs, params, rule, flags, refs });
  }
  value(id: string) { return this.nodes[id].value as number; }
}

const tagFlags = (src?: Src | null) => src?.tag ? [String(src.tag)] : [];
const sortedMonths = (o: Record<Month, unknown> | undefined) => Object.keys(o || {}).sort();

export function buildTrace(ds: Dataset, res: Result): Trace {
  const g = new Graph(); const L = ds.lineage; const keys = fundKeys(ds);
  const out: Record<string, any> = { fund_ret: {}, ret_cell: {}, nav: {}, flow: {} };

  // Flows: each trade amount is a leaf; the month's flow is a signed sum.
  const tradeUnits: Record<string, Array<[Month, number, string]>> = {}; const flowId: Record<string, Record<Month, string>> = {};
  for (const k of keys) {
    flowId[k] = {}; tradeUnits[k] = [];
    const trades = L?.trades[k]; const byMonth: Record<Month, Array<[string, number]>> = {};
    (trades || []).forEach((t, i) => {
      const tag = `${t.date} ${t.kind}`;
      const a = g.leaf(`trade.amount|${k}|${i}`, `${k} ${tag} 金额`, t.amount, 'money', t.src_amount, tagFlags(t.src_amount));
      const u = g.leaf(`trade.units|${k}|${i}`, `${k} ${tag} 确认份额`, t.units, 'units', t.src_units, tagFlags(t.src_units));
      (byMonth[t.month] = byMonth[t.month] || []).push([a, t.sign]);
      tradeUnits[k].push([t.month, t.sign, u]);
    });
    for (const m of sortedMonths(ds.flows[k])) {
      const id = `flow|${k}|${m}`; const label = `${k} ${monthLabel(m)} 申赎`;
      if (!trades) g.leaf(id, label, ds.flows[k][m], 'money', null, ['无原始交易明细']);
      else { const items = byMonth[m] || []; g.calc(id, label, ds.flows[k][m], 'money', 'sum', items.map(([a]) => ['交易', a]), 'flow', { coeffs: items.map(([, s]) => s) }); }
      flowId[k][m] = id;
    }
    out.flow[k] = { ...flowId[k] };
  }

  // Returns: actual values are leaves; for a range the rule picks the rate used to roll NAV forward.
  const usedId: Record<string, Record<Month, string>> = {};
  for (const k of keys) {
    usedId[k] = {}; out.fund_ret[k] = {};
    const srcs = L?.returns[k] || {};
    for (const m of sortedMonths(ds.returns[k])) {
      const r: Return = ds.returns[k][m]; const s = srcs[m] || {};
      const est = r.estimate ? ['估算'] : []; const label = `${k} ${monthLabel(m)} 收益率`;
      const cands = ds.returnSelections?.[k]?.[m];
      if (r.value !== null && cands && cands.length > 1) {
        const ins = cands.map((c, i): [string, string] => [`${c.used ? '采用' : '未采用'}：${c.reason}`,
          g.leaf(`ret.cand|${k}|${m}|${i}`, `${k} ${c.date} 收益率（${c.kind}）`, c.value, 'pct', c.src, [...(c.kind === '正式' ? [] : [c.kind]), ...(c.used ? [] : ['未采用'])])]);
        usedId[k][m] = out.fund_ret[k][m] = g.calc(`ret|${k}|${m}`, label, r.value, 'pct', 'select', ins, 'select', { chosen: cands.findIndex(c => c.used) }, est);
        continue;
      }
      if (r.value !== null) {
        usedId[k][m] = out.fund_ret[k][m] = g.leaf(`ret|${k}|${m}`, label, r.value, 'pct', s['MTD收益率'], [...est, ...tagFlags(s['MTD收益率'])]);
        continue;
      }
      const parts: Array<[string, string]> = [
        ['下限', g.leaf(`ret.lo|${k}|${m}`, `${label}（区间下限）`, r.lo, 'pct', s['区间下限'], est)],
        ['上限', g.leaf(`ret.hi|${k}|${m}`, `${label}（区间上限）`, r.hi, 'pct', s['区间上限'], est)]];
      if (r.point !== null) parts.push(['估算点值', g.leaf(`ret.point|${k}|${m}`, `${label}（估算点值）`, r.point, 'pct', s['估算点值'], est)]);
      usedId[k][m] = g.calc(`ret.used|${k}|${m}`, `${label}（用于推算）`, usedReturn(res.rules, r), 'pct', 'pick', parts, 'range_value', { mode: res.rules.range_value }, [...est, '区间估算']);
      out.fund_ret[k][m] = parts.slice(0, 2).map(([, id]) => id);
    }
    out.ret_cell[k] = { ...usedId[k] };
  }

  // NAV: units × unit price when a statement price exists, otherwise rolled forward or carried.
  for (const k of keys) {
    out.nav[k] = {}; let prev: string | null = null;
    for (const m of res.months) {
      const cell = res.nav[k][m];
      if (!cell) { prev = null; continue; }
      const id = `nav|${k}|${m}`; const label = `${k} ${monthLabel(m)} 市值`;
      const fl: Array<[string, string]> = flowId[k][m] ? [['本月申赎', flowId[k][m]]] : [];
      const before: Array<[string, string]> = prev ? [['上月市值', prev]] : [];
      if (ds.navs[k]?.[m]) {
        const px = L?.prices[k]?.[m];
        if (!px) g.leaf(id, label, cell.value, 'money', null, [`来源：${cell.source}`]);
        else {
          const moves = tradeUnits[k].filter(([mm]) => mm <= m);
          const uid = g.calc(`units|${k}|${m}`, `${k} ${monthLabel(m)} 持有份额`, moves.reduce((s, [, sign, u]) => s + sign * g.value(u), 0), 'units', 'sum',
            moves.map(([, , u]) => ['交易份额', u]), 'units', { coeffs: moves.map(([, s]) => s) });
          const pid = g.leaf(`price|${k}|${m}`, `${k} ${monthLabel(m)} 单位净值`, px.value, 'price', px.src, tagFlags(px.src));
          g.calc(id, label, cell.value, 'money', 'mul', [['持有份额', uid], ['单位净值', pid]], 'nav_statement');
        }
      } else if (cell.source === '推算') {
        g.calc(id, label, cell.value, 'money', 'nav_roll', [...before, ...fl, ['本月收益率', usedId[k][m]]], 'nav_roll', {}, ['推算', ...(cell.estimate ? ['估算'] : [])]);
      } else {
        g.calc(id, label, cell.value, 'money', 'carry', [...before, ...fl], 'nav_carry', {}, ['缺失', '结转']);
      }
      out.nav[k][m] = id; prev = id;
    }
  }

  // Portfolio totals, monthly return, YTD, IRR.
  out.total_nav = {}; out.total_flow = {}; out.port_ret = {};
  let prev: string | null = null;
  for (const m of res.months) {
    const tn = g.calc(`total_nav|${m}`, `组合 ${monthLabel(m)} 总净值`, res.totalNav[m], 'money', 'sum', keys.filter(k => out.nav[k][m]).map(k => ['基金市值', out.nav[k][m]]), 'total');
    const tf = g.calc(`total_flow|${m}`, `组合 ${monthLabel(m)} 申赎`, res.totalFlow[m], 'money', 'sum', keys.filter(k => flowId[k][m]).map(k => ['基金申赎', flowId[k][m]]), 'total');
    if (m in res.portRet) {
      out.port_ret[m] = g.calc(`port_ret|${m}`, `组合 ${monthLabel(m)} 月度收益`, res.portRet[m], 'pct', 'dietz',
        [...(prev ? [['上月总净值', prev] as [string, string]] : []), ['本月总净值', tn], ['本月申赎', tf]], 'dietz');
    }
    out.total_nav[m] = tn; out.total_flow[m] = tf; prev = tn;
  }
  const year = ds.asOf.slice(0, 4);
  out.ytd = g.calc('ytd', `组合 ${year} YTD`, res.ytd, 'pct', 'chain', res.reportMonths.filter(m => out.port_ret[m]).map(m => ['月度收益', out.port_ret[m]]), 'chain');
  const cf = res.months.filter(m => res.totalFlow[m]);
  out.irr = g.calc('irr', '组合 IRR（投资以来）', res.irr, 'pct', 'xirr', [...cf.map(m => ['申赎', out.total_flow[m]] as [string, string]), ['期末总净值', out.total_nav[ds.asOf]]],
    'xirr', { dates: [...cf.map(monthStart), monthEnd(ds.asOf)] });

  // Fund and benchmark YTD.
  out.fund_ytd = {}; out.bench_ret = {};
  for (const b of ds.benchmarks) {
    out.bench_ret[b] = {};
    const pts = [...(L?.bench_levels[b] || [])].sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]);
    if (!pts.length) {
      for (const m of sortedMonths(ds.returns[b])) out.bench_ret[b][m] = g.leaf(`ret|${b}|${m}`, `${b} ${monthLabel(m)} 收益率`, ds.returns[b][m].value, 'pct', null, ['无点位明细']);
      continue;
    }
    const ids = pts.map(([m, v, s], i) => g.leaf(`bench.level|${b}|${i}`, `${b} ${m} 点位`, v, 'index', s, tagFlags(s)));
    for (let i = 1; i < pts.length; i++) {
      const m = pts[i][0]; const id = `ret|${b}|${m}`;
      delete g.nodes[id];
      g.calc(id, `${b} ${monthLabel(m)} 收益率`, ds.returns[b][m].value!, 'pct', 'growth', [['本月末点位', ids[i]], ['上月末点位', ids[i - 1]]], 'bench');
      out.bench_ret[b][m] = id;
    }
  }
  for (const k of [...keys, ...ds.benchmarks]) {
    const rs = res.reportMonths.filter(m => ds.returns[k]?.[m]);
    if (!rs.length) continue;
    const y = res.fundYtd[k]; const src = out.fund_ret[k] || out.bench_ret[k] || {}; const est = y.estimate ? ['估算'] : [];
    if (y.lo === null) { out.fund_ytd[k] = g.calc(`fund_ytd|${k}`, `${k} ${year} YTD`, y.value!, 'pct', 'chain', rs.map(m => ['月度收益', src[m]]), 'chain', {}, est); continue; }
    out.fund_ytd[k] = (['lo', 'hi'] as const).map(side => g.calc(`fund_ytd.${side}|${k}`, `${k} ${year} YTD（区间${side === 'lo' ? '下' : '上'}限）`, y[side]!, 'pct', 'chain',
      rs.map(m => ['月度收益', Array.isArray(src[m]) ? src[m][side === 'lo' ? 0 : 1] : src[m]]), 'chain', {}, [...est, '区间估算']));
  }

  // Weights, allocation, invested.
  const total = out.total_nav[ds.asOf];
  out.weight = {}; out.invested = {}; out.alloc = {};
  for (const k of keys) {
    const nid = out.nav[k][ds.asOf];
    out.weight[k] = nid ? g.calc(`weight|${k}`, `${k} 持仓比例`, res.weights[k], 'pct', 'ratio', [['基金期末市值', nid], ['组合期末总净值', total]], 'weight')
      : g.leaf(`weight|${k}`, `${k} 持仓比例`, 0, 'pct', null, ['期末无持仓']);
    out.invested[k] = g.calc(`invested|${k}`, `${k} 总计投资金额`, res.invested[k], 'money', 'sum', Object.values(flowId[k]).map(i => ['申赎', i]), 'invested');
  }
  for (const [dim, attr, col] of [['风险', 'risk', '配置策略'], ['地域', 'region', '投资地区'], ['策略', 'strategy', '基金策略']] as const) {
    out.alloc[dim] = {};
    for (const [tag, w] of res.alloc[dim]) {
      const members = keys.filter(k => res.weights[k] && ds.funds[k][attr] === tag);
      const refs = members.flatMap(k => {
        const s = L?.tags[k]?.[col];
        if (!s) return [];
        const { value, ...src } = s;
        return [g.leaf(`tag|${k}|${col}`, `${k} ${col}`, value, 'text', src, tagFlags(s))];
      });
      out.alloc[dim][tag] = g.calc(`alloc|${dim}|${tag}`, `${dim}分布：${tag}`, w, 'pct', 'sum', members.map(k => ['持仓比例', out.weight[k]]), 'alloc', {}, [], refs);
    }
  }
  return { schema: TRACE_SCHEMA, meta: { client: ds.client, client_code: ds.clientCode, as_of: ds.asOf, rules: describeRules(res.rules) },
    formulas: FORMULAS, range_rules: RANGE_VALUE, outputs: out, findings: [], nodes: g.nodes };
}

/** Attach check findings to the NAV node of the fund-month, or to the fund's YTD / weight node. */
export function attachFindings(t: Trace, findings: Finding[]) {
  const byLabel = new Map<string, string>();
  for (const [k, ms] of Object.entries<Record<Month, string>>(t.outputs.nav)) for (const [m, id] of Object.entries(ms)) byLabel.set(`${k}\u0000${monthLabel(m)}`, id);
  t.findings = findings.map(f => {
    let node: any = f.fund && f.month ? byLabel.get(`${f.fund}\u0000${f.month}`) ?? null : null;
    if (!node && f.fund) node = t.outputs.fund_ytd[f.fund] ?? t.outputs.weight[f.fund] ?? null;
    if (Array.isArray(node)) node = node[0];
    return { level: f.level, category: f.category, title: f.title, detail: f.detail, suggestion: f.suggestion, node };
  });
}

export function evaluate(t: Trace, n: TraceNode): number {
  const value = (id: string) => t.nodes[id].value as number;
  const inputs = n.inputs || []; const xs = inputs.map(([, id]) => value(id));
  const one = (role: string) => { const hit = inputs.find(([r]) => r === role); return hit ? value(hit[1]) : 0; };
  switch (n.op) {
    case 'sum': { const c = n.params?.coeffs || xs.map(() => 1); return xs.reduce((s, x, i) => s + c[i] * x, 0); }
    case 'mul': return xs.reduce((p, x) => p * x, 1);
    case 'nav_roll': return (one('上月市值') + one('本月申赎')) * (1 + one('本月收益率'));
    case 'carry': return one('上月市值') + one('本月申赎');
    case 'dietz': return (one('本月总净值') - one('上月总净值') - one('本月申赎')) / (one('上月总净值') + one('本月申赎'));
    case 'chain': return chain(xs);
    case 'ratio': return xs[0] / xs[1];
    case 'growth': return one('本月末点位') / one('上月末点位') - 1;
    case 'select': return xs[n.params!.chosen];
    case 'pick': return n.params!.mode === 'point' && inputs.some(([r]) => r === '估算点值') ? one('估算点值') : (one('下限') + one('上限')) / 2;
    case 'xirr': { const d: string[] = n.params!.dates; return xirr([...xs.slice(0, -1).map((x, i) => [d[i], -x] as [string, number]), [d[d.length - 1], xs[xs.length - 1]]]); }
    default: throw new Error(`unknown trace op ${n.op}`);
  }
}

/** Recompute every node from only its recorded operation and input values. */
export function verifyTrace(t: Trace) {
  const bad: string[] = [];
  for (const n of Object.values(t.nodes)) {
    if (n.op === 'leaf') continue;
    const got = evaluate(t, n); const tol = n.op === 'xirr' ? 1e-7 : TOL;
    if (!(Math.abs(got - (n.value as number)) <= tol * Math.max(1, Math.abs(got)))) bad.push(`${n.id}: ${n.value} / ${got}`);
  }
  return bad;
}

/** Output nodes equal the engine result. */
export function checkOutputs(t: Trace, ds: Dataset, res: Result) {
  const o = t.outputs; const bad: string[] = [];
  const eq = (label: string, id: string, want: number | null) => {
    const got = t.nodes[id]?.value as number;
    if (want === null || !(Math.abs(got - want) <= TOL * Math.max(1, Math.abs(got), Math.abs(want)))) bad.push(`${label}: ${got} / ${want}`);
  };
  for (const m of res.months) {
    eq(`total_nav ${m}`, o.total_nav[m], res.totalNav[m]); eq(`total_flow ${m}`, o.total_flow[m], res.totalFlow[m]);
    if (m in res.portRet) eq(`port_ret ${m}`, o.port_ret[m], res.portRet[m]);
    for (const k of fundKeys(ds)) if (res.nav[k][m]) eq(`nav ${k} ${m}`, o.nav[k][m], res.nav[k][m].value);
  }
  eq('ytd', o.ytd, res.ytd);
  if (!(Math.abs((t.nodes[o.irr].value as number) - res.irr) <= 1e-9)) bad.push(`irr: ${t.nodes[o.irr].value} / ${res.irr}`);
  for (const k of fundKeys(ds)) { eq(`weight ${k}`, o.weight[k], res.weights[k]); eq(`invested ${k}`, o.invested[k], res.invested[k]); }
  for (const [k, id] of Object.entries<any>(o.fund_ytd)) {
    const y = res.fundYtd[k];
    if (Array.isArray(id)) { eq(`fund_ytd.lo ${k}`, id[0], y.lo); eq(`fund_ytd.hi ${k}`, id[1], y.hi); } else eq(`fund_ytd ${k}`, id, y.value);
  }
  for (const [dim, groups] of Object.entries(res.alloc)) for (const [tag, w] of groups) eq(`alloc ${dim}/${tag}`, o.alloc[dim][tag], w);
  return bad;
}
