import { Result } from './engine';
import { Dataset, Month, Return, fundKeys, money, monthLabel, pct, signed } from './model';

export const THRESHOLDS = { reconWarn: 0.003, reconFitTol: 0.005, reconError: 0.01, bigMove: 0.15 };
export const LEVELS = ['错误', '警告', '提示'] as const;
export type Level = typeof LEVELS[number];
export type Finding = { level: Level; category: string; title: string; detail: string; suggestion: string; fund: string; month: string };
export type Allowed = { risk: Record<string, string[]>; region: Record<string, string[]>; strategy: Record<string, string[]> };

const finding = (level: Level, category: string, title: string, detail: string, suggestion = '', fund = '', month = ''): Finding => ({ level, category, title, detail, suggestion, fund, month });
const previousMonth = (res: Result, m: Month) => { const i = res.months.indexOf(m); return i > 0 ? res.months[i - 1] : undefined; };

/** Least squares: client implied return = alpha + beta × published return. */
function fit(pairs: Array<[number, number]>): [number, number] {
  const n = pairs.length;
  const mx = pairs.reduce((s, [r]) => s + r, 0) / n;
  const my = pairs.reduce((s, [, i]) => s + i, 0) / n;
  const sxx = pairs.reduce((s, [r]) => s + (r - mx) ** 2, 0);
  const beta = sxx ? pairs.reduce((s, [r, i]) => s + (r - mx) * (i - my), 0) / sxx : 1;
  return [my - beta * mx, beta];
}
type ReconRow = { m: Month; r: Return; nav: number; prev: number; flow: number; implied: number };
function reconRows(ds: Dataset, res: Result, k: string): ReconRow[] {
  const rows: ReconRow[] = [];
  for (const m of res.reportMonths) {
    const cell = res.nav[k][m]; const r = ds.returns[k]?.[m];
    if (!cell || cell.source !== '对账单' || !r) continue;
    const pm = previousMonth(res, m);
    const prev = pm && res.nav[k][pm] ? res.nav[k][pm].value : 0;
    const flow = ds.flows[k]?.[m] ?? 0;
    if (prev + flow > 0) rows.push({ m, r, nav: cell.value, prev, flow, implied: cell.value / (prev + flow) - 1 });
  }
  return rows;
}
/** A stable ratio between the client's share class and the published class (class or fee accrual differences). */
function systematic(rows: ReconRow[]): { alpha: number; beta: number; months: Month[] } | null {
  const pairs = new Map<Month, [number, number]>();
  for (const x of rows) if (x.flow === 0 && x.prev > 0 && !x.r.isRange) pairs.set(x.m, [x.r.value!, x.implied]);
  if (pairs.size < 4) return null;
  let [alpha, beta] = fit([...pairs.values()]);
  const residual = (m: Month) => Math.abs(pairs.get(m)![1] - alpha - beta * pairs.get(m)![0]);
  const worst = [...pairs.keys()].reduce((a, b) => residual(b) > residual(a) ? b : a);
  if (residual(worst) >= THRESHOLDS.reconFitTol) { pairs.delete(worst); [alpha, beta] = fit([...pairs.values()]); }
  const fitted = [...pairs.values()].every(([r, i]) => Math.abs(i - alpha - beta * r) < THRESHOLDS.reconFitTol);
  const rawOff = [...pairs.values()].filter(([r, i]) => Math.abs(i - r) >= THRESHOLDS.reconWarn).length;
  return fitted && rawOff >= 2 ? { alpha, beta, months: [...pairs.keys()].sort() } : null;
}

export function checkReconciliation(ds: Dataset, res: Result): Finding[] {
  const out: Finding[] = [];
  for (const k of fundKeys(ds)) {
    const rows = reconRows(ds, res, k);
    const sys = systematic(rows);
    const [alpha, beta] = sys ? [sys.alpha, sys.beta] : [0, 1];
    if (sys) {
      const ex = rows.filter(x => sys.months.includes(x.m)).reduce((a, b) => Math.abs(b.r.value!) > Math.abs(a.r.value!) ? b : a);
      out.push(finding('提示', '净值勾稽', `${k}：客户实际收益与基金公布收益存在稳定差异`,
        `${sys.months.length} 个月的数据显示，客户持仓净值的月度变动 ≈ ${beta.toFixed(2)} × 基金公布收益${signed(alpha * 100)} 个百分点。例如 ${monthLabel(ex.m)} 基金公布 ${pct(ex.r.value)}，客户实际 ${pct(ex.implied)}。因此报告 Table-1 的单基金收益与客户实际收益口径不同。`,
        '常见原因是客户持有的份额类别与公布业绩的份额类别不同，或业绩报酬的计提方式不同；建议向基金或行政管理人确认，并决定 Table-1 用哪个口径。', k));
    }
    for (const { m, r, nav, prev, flow, implied } of rows) {
      const expected = alpha + beta * r.used;
      let diff: number, shown: string;
      if (r.isRange) {
        if (r.lo! - THRESHOLDS.reconWarn <= implied && implied <= r.hi! + THRESHOLDS.reconWarn) continue;
        diff = implied - r.used; shown = r.describe();
      } else { diff = implied - expected; shown = pct(r.value); }
      if (Math.abs(diff) < (sys ? THRESHOLDS.reconFitTol : THRESHOLDS.reconWarn)) continue;
      const basis = sys ? `按上述稳定关系应为 ${pct(expected)}，` : '';
      out.push(finding(Math.abs(diff) >= THRESHOLDS.reconError ? '错误' : '警告', '净值勾稽', `${k} ${monthLabel(m)}：净值与收益率、资金流不一致`,
        `对账单净值 ${money(nav)}，上月净值 ${money(prev)}，本月申赎 ${money(flow)}，反推当月收益 ${pct(implied)}；录入的基金收益率为 ${shown}，${basis}相差 ${signed(diff * 100)} 个百分点。若收益率无误，本月申赎应约为 ${money(nav / (1 + expected) - prev)}。`,
        prev === 0 ? '首次申购当月，差异常见于申购费、均衡化调整或申购日不在月初，确认后可忽略。' : '核对对账单、申赎记录和收益率三者中哪一项录错。', k, monthLabel(m)));
    }
  }
  return out;
}

export function checkEstimates(ds: Dataset, res: Result): Finding[] {
  const out: Finding[] = []; const keys = fundKeys(ds);
  for (const m of res.reportMonths) {
    const estimated = keys.filter(k => ds.returns[k]?.[m]?.estimate);
    if (!estimated.length) continue;
    const stale = m < ds.asOf;
    out.push(finding(stale ? '错误' : '提示', '估算数据', `${monthLabel(m)}有 ${estimated.length} 只基金仍为估算值`,
      `${estimated.join('、')}。报告中这些单元格会标红，相关净值为推算值。`,
      stale ? '截止日之前月份的估算值应在出报告前替换为实际值。' : '实际值录入 Finance 后重新生成月报即可。', '', monthLabel(m)));
    for (const k of estimated) {
      const r = ds.returns[k][m];
      if (!r.isRange || r.point === null || Math.abs(r.point - r.midpoint!) <= 1e-9) continue;
      const pm = previousMonth(res, m);
      const base = (pm && res.nav[k][pm] ? res.nav[k][pm].value : 0) + (ds.flows[k]?.[m] ?? 0);
      const delta = base * (r.point - r.midpoint!);
      const denominator = (pm ? res.totalNav[pm] : 0) + res.totalFlow[m];
      out.push(finding('提示', '估算数据', `${k} ${monthLabel(m)}：估算点值不在区间中点`,
        `区间 ${r.describe()}，中点 ${pct(r.midpoint)}，实际用于推算的点值为 ${pct(r.point)}，净值相差约 ${money(delta)}，影响组合当月收益约 ${signed(denominator ? delta / denominator * 100 : 0)} 个百分点。`,
        '确认点值来源（基金经理口头估计或内部判断）并在备注中写明。', k, monthLabel(m)));
    }
  }
  for (const k of keys) {
    const rs = ds.returns[k] || {};
    const actual = Object.keys(rs).filter(m => !rs[m].estimate).sort();
    if (!actual.length) continue;
    const latest = actual[actual.length - 1];
    for (const [m, r] of Object.entries(rs)) if (r.estimate && m < latest) {
      out.push(finding('错误', '估算数据', `${k} ${monthLabel(m)}：过期的估算值`, `已有 ${monthLabel(latest)} 的实际值，但 ${monthLabel(m)} 仍是估算值。`, '补录该月实际值。', k, monthLabel(m)));
    }
  }
  return out;
}

export function checkTags(ds: Dataset, allowed: Allowed): Finding[] {
  const out: Finding[] = [];
  for (const k of fundKeys(ds)) {
    const f = ds.funds[k];
    for (const [label, value, choices] of [
      ['风险分类', f.risk.replace(/型$/, ''), allowed.risk[f.kind] || []],
      ['投资地区', f.region, allowed.region[f.kind] || []],
      ['基金策略', f.strategy, allowed.strategy[f.kind] || []],
    ] as Array<[string, string, string[]]>) {
      if (!value) out.push(finding('错误', '基金标签', `${k}：缺少${label}`, '持仓分类无法计算。', `补充${label}。`, k));
      else if (!choices.includes(value)) out.push(finding('警告', '基金标签', `${k}：${label}「${value}」不在字段清单的枚举值中`, `允许值：${choices.join('/') || '尚未配置'}。`, '补充枚举值或改用已有分类。', k));
    }
  }
  return out;
}

export function checkTotals(res: Result): Finding[] {
  const out: Finding[] = [];
  const total = Object.values(res.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-6) out.push(finding('错误', '合计校验', '持仓比例合计不等于 100%', `合计 ${pct(total, 4)}。`));
  for (const [dim, groups] of Object.entries(res.alloc)) {
    const sum = groups.reduce((a, [, v]) => a + v, 0);
    if (Math.abs(sum - 1) > 1e-6) out.push(finding('错误', '合计校验', `${dim}分类合计不等于 100%`, `合计 ${pct(sum, 4)}。`));
  }
  return out;
}

export function checkMissing(ds: Dataset, res: Result): Finding[] {
  const out = res.missing.map(([k, m]) => finding('错误', '数据缺失', `${k} ${monthLabel(m)}：缺少收益率和净值`, '该基金当月有持仓，但既没有对账单净值也没有收益率，净值暂按上月结转。', '补录数据。', k, monthLabel(m)));
  for (const b of ds.benchmarks) {
    const lack = res.reportMonths.filter(m => !ds.returns[b]?.[m]);
    if (lack.length) out.push(finding('警告', '数据缺失', `基准 ${b} 缺少数据`, `缺少：${lack.map(monthLabel).join('、')}`, '补录基准收益。', b));
  }
  return out;
}

export function checkBigMoves(ds: Dataset, res: Result): Finding[] {
  const out: Finding[] = [];
  for (const k of fundKeys(ds)) for (const m of res.reportMonths) {
    const r = ds.returns[k]?.[m];
    if (r && r.value !== null && Math.abs(r.value) >= THRESHOLDS.bigMove) out.push(finding('提示', '大幅波动', `${k} ${monthLabel(m)}：单月收益 ${pct(r.value)}`, `超过 ±${pct(THRESHOLDS.bigMove, 0)}，建议在月报点评中说明原因。`, '核对数值并准备点评。', k, monthLabel(m)));
  }
  return out;
}

export function checkProvenance(ds: Dataset): Finding[] {
  const out: Finding[] = [];
  for (const [tag, level, why] of [['模拟', '警告', '这些值目前没有真实来源，是为跑通流程临时编造的，正式出报告前必须替换。'], ['推算', '提示', '这些值由真实数据换算得到，结果正确，但应改为对账单或数据源上的原始值。']] as Array<[string, Level, string]>) {
    const items = ds.provenance.filter(([, , t]) => t === tag).sort(([a, b], [c, d]) => a === c ? (b < d ? -1 : b > d ? 1 : 0) : a < c ? -1 : 1);
    if (items.length) out.push(finding(level, '数据来源', `本报告用到了${tag}数据（${items.reduce((s, [, , , n]) => s + n, 0)} 个单元格）`, `${items.map(([s, c, , n]) => `${s}.${c} ${n} 个`).join('；')}。`, why));
  }
  return out;
}

/** Amounts in different currencies are never added without FX; the report is blocked instead. */
export function checkCurrency(ds: Dataset): Finding[] {
  if (ds.currencies.length <= 1) return [];
  return [finding('错误', '币种', `持仓和交易涉及多个币种：${ds.currencies.join('、')}`, '月报按单一币种汇总净值和资金流，目前不做汇率换算，合计、组合收益和 IRR 都不可靠。', '确认报告币种和汇率来源后再出报告；或拆分为单一币种的投资主体。')];
}

export function runChecks(ds: Dataset, res: Result, allowed: Allowed) {
  const groups: Array<[string, Finding[]]> = [
    ['数据来源', checkProvenance(ds)], ['币种', checkCurrency(ds)], ['净值勾稽', checkReconciliation(ds, res)],
    ['估算数据', checkEstimates(ds, res)], ['基金标签', checkTags(ds, allowed)], ['合计校验', checkTotals(res)],
    ['数据缺失', checkMissing(ds, res)], ['大幅波动', checkBigMoves(ds, res)],
  ];
  const findings = groups.flatMap(([, fs]) => fs).sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level));
  return { findings, summary: groups.map(([name, fs]) => [name, fs.length] as [string, number]) };
}
