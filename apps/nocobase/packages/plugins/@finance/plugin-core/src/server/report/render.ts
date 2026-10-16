import { Finding, LEVELS } from './checks';
import { FundYtd, Result } from './engine';
import { Dataset, Month, Return, fundKeys, money, monthEnd, monthParts, pct } from './model';

const CSS = `
* { box-sizing: border-box; }
body { font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif; color: #222; margin: 0; background: #eef1f5; }
.page { width: 1180px; margin: 24px auto; background: #fff; padding: 28px 36px 24px; box-shadow: 0 2px 10px rgba(0,0,0,.08); position: relative; }
.logo { position: absolute; right: 36px; top: 30px; color: #1f4e79; font-weight: 700; font-size: 18px; letter-spacing: .5px; }
.logo span { color: #70ad47; }
h1 { margin: 0 0 6px; font-size: 30px; color: #1f3864; font-weight: 700; border-bottom: 3px solid #1f3864; padding-bottom: 6px; width: 85%; }
.sub { font-size: 17px; margin: 10px 0 14px; }
.sub b { font-weight: 700; }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; margin-bottom: 12px; }
th, td { padding: 3px 7px; white-space: nowrap; }
thead th { background: #5b9bd5; color: #fff; font-weight: 700; text-align: right; }
thead th.l { text-align: left; }
thead th.c { text-align: center; }
td { text-align: right; border-bottom: 1px solid #d9d9d9; }
td.l { text-align: left; }
td.c { text-align: center; }
.fund td { background: #ddebf7; }
.fund td.v { color: #c00000; font-weight: 700; }
.fund td.name { font-weight: 700; }
.fund td.name small { font-weight: 400; }
td.pre { color: #a6a6a6 !important; font-weight: 400 !important; }
td.est { background: #fce4d6 !important; }
td.ytd { font-weight: 700; color: #222 !important; }
.bench td { background: #fff; }
.bench td.ytd { font-weight: 700; }
td.calc { background: #fce4d6; font-weight: 700; }
tr.total td { font-weight: 700; border-top: 1.5px solid #555; }
tr.total td.red { color: #c00000; }
tr.ret td { background: #fff2cc; color: #c00000; font-weight: 700; }
td.pct { font-style: italic; color: #555; }
td.irr { color: #c00000; font-weight: 700; }
.notes { font-size: 11.5px; color: #555; line-height: 1.6; }
.alloc { width: 560px; font-size: 13px; margin-bottom: 18px; }
.alloc caption { background: #5b9bd5; color: #fff; text-align: left; padding: 3px 7px; font-weight: 700; }
.alloc td { border: none; text-align: center; padding: 2px 8px; }
.alloc td.dim { text-align: right; font-weight: 700; }
.holdings { width: 960px; font-size: 14px; }
.holdings th { background: #5b9bd5; color: #fff; border: 1px solid #333; text-align: center; padding: 5px 8px; white-space: normal; }
.holdings td { border: 1px solid #333; padding: 3px 8px; }
.holdings tr.total td { border-top: 2px solid #333; }
.draft { position: fixed; top: 40%; left: 0; right: 0; text-align: center; font-size: 96px; color: rgba(192,0,0,.08); transform: rotate(-20deg); pointer-events: none; }
@media print { body { background: #fff; } .page { box-shadow: none; margin: 0; page-break-after: always; } }
`;
const CHECK_CSS = `${CSS}
.cards { display: flex; gap: 14px; margin: 14px 0 18px; }
.card { flex: 1; border-radius: 8px; padding: 12px 16px; color: #fff; }
.card b { font-size: 28px; display: block; }
.finding { border-left: 5px solid; padding: 8px 14px; margin-bottom: 10px; background: #fafafa; }
.finding .t { font-weight: 700; font-size: 14.5px; }
.finding .tag { display: inline-block; font-size: 12px; color: #fff; border-radius: 3px; padding: 0 6px; margin-right: 6px; }
.finding .d { font-size: 13px; margin-top: 4px; line-height: 1.6; }
.finding .s { font-size: 13px; color: #375623; margin-top: 2px; }
.sum td { text-align: left; }
`;
const LEVEL_STYLE: Record<string, string> = { 错误: '#c00000', 警告: '#e46c0a', 提示: '#2e75b6' };
const CURRENCY_NAMES: Record<string, string> = { USD: '美元', HKD: '港币', CNY: '人民币', JPY: '日元', EUR: '欧元', Euro: '欧元' };

export const escape = (text: unknown) => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' })[c]!);
const shortDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return `${d}/${m}/${y}`; };
const flowText = (v: number) => !v ? '-' : v < 0 ? `(${money(Math.abs(v))})` : money(v);
const ytdText = (y: FundYtd) => y.lo !== null ? `${pct(y.lo, 0)}~${pct(y.hi, 0)}` : pct(y.value);
const retText = (r: Return) => r.isRange ? `${pct(r.lo, 0)}~${pct(r.hi, 0)}` : pct(r.value);
function nameCell(name: string) {
  for (const sep of ['（', '(']) {
    const i = name.indexOf(sep);
    if (i >= 0) return `${escape(name.slice(0, i))}<small>${sep}${escape(name.slice(i + 1))}</small>`;
  }
  return escape(name);
}
type Outputs = Record<string, any>;
/** Trace node ids behind a cell, as a JSON array (fund keys contain spaces); empty without a trace. */
function at(o: Outputs, ...path: string[]) {
  let v: any = o;
  for (const p of path) { if (!v || typeof v !== 'object' || Array.isArray(v) || !(p in v)) return ''; v = v[p]; }
  return ` data-n="${escape(JSON.stringify(Array.isArray(v) ? v : [v]))}"`;
}
/** Customer downloads carry no trace markers. */
export const withoutTraceMarks = (html: string) => html.replace(/ data-n="[^"]*"/g, '');
export const reportCurrency = (ds: Dataset) => ds.currencies.length === 1 ? CURRENCY_NAMES[ds.currencies[0]] || ds.currencies[0] : '多币种，未换算';

function table1(ds: Dataset, res: Result, o: Outputs) {
  const ms = res.reportMonths;
  const head = ms.map(m => `<th>${shortDate(monthEnd(m))}</th>`).join('');
  const rows: string[] = [];
  for (const k of fundKeys(ds)) {
    const first = res.firstInvest[k];
    const cells = ms.map(m => {
      const r = ds.returns[k]?.[m];
      const cls = ['v', ...(r?.estimate ? ['est'] : []), ...(first && m < first.slice(0, 7) ? ['pre'] : [])];
      return `<td class="${cls.join(' ')}"${at(o, 'ret_cell', k, m)}>${r ? retText(r) : ''}</td>`;
    });
    const y = res.fundYtd[k];
    cells.push(`<td class="ytd${y.estimate ? ' est' : ''}"${at(o, 'fund_ytd', k)}>${ytdText(y)}</td>`);
    rows.push(`<tr class="fund"><td class="l name">${nameCell(ds.funds[k].nameT1)}</td>${cells.join('')}</tr>`);
  }
  for (const b of ds.benchmarks) {
    const cells = ms.map(m => `<td${at(o, 'bench_ret', b, m)}>${ds.returns[b]?.[m] ? retText(ds.returns[b][m]) : ''}</td>`).join('');
    rows.push(`<tr class="bench"><td class="l">${escape(b)}</td>${cells}<td class="ytd"${at(o, 'fund_ytd', b)}>${ytdText(res.fundYtd[b])}</td></tr>`);
  }
  return `<table><thead><tr><th class="l">Table-1: 基金表现</th>${head}<th>YTD ${monthParts(ds.asOf)[0]}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
function table3(ds: Dataset, res: Result, o: Outputs) {
  const ms = res.reportMonths; const keys = fundKeys(ds);
  const head = ms.map(m => `<th>${shortDate(monthEnd(m))}</th>`).join('');
  const rows = keys.map(k => {
    const cells = ms.map(m => { const n = res.nav[k][m]; return `<td class="${n && n.source !== '对账单' ? 'calc' : ''}"${at(o, 'nav', k, m)}>${n ? money(n.value) : ''}</td>`; }).join('');
    return `<tr><td class="l">${escape(ds.funds[k].nameT3)}</td><td class="c">${escape(ds.funds[k].risk)}</td><td class="pct c"${at(o, 'weight', k)}>${pct(res.weights[k], 0)}</td>${cells}<td></td><td${at(o, 'invested', k)}>${money(res.invested[k])}</td></tr>`;
  });
  const invested = keys.reduce((s, k) => s + res.invested[k], 0);
  rows.push(`<tr class="total"><td class="l">总计</td><td></td><td class="pct c">100%</td>${ms.map(m => `<td class="red"${at(o, 'total_nav', m)}>${money(res.totalNav[m])}</td>`).join('')}<td></td><td>${money(invested)}</td></tr>`);
  rows.push(`<tr class="ret"><td class="l">组合月度收益</td><td></td><td></td>${ms.map(m => `<td${at(o, 'port_ret', m)}>${pct(res.portRet[m])}</td>`).join('')}<td${at(o, 'ytd')}>${pct(res.ytd)}</td><td></td></tr>`);
  return `<table><thead><tr><th class="l">Table-3: 投资组合净值（${escape(reportCurrency(ds))}）</th><th class="c">风险分类</th><th class="c">持仓比例</th>${head}<th>YTD ${monthParts(ds.asOf)[0]}</th><th>总计投资金额</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
function table4(ds: Dataset, res: Result, o: Outputs) {
  const ms = res.reportMonths; const [year, month] = monthParts(ds.asOf);
  return `<table><thead><tr><th class="l">Table-4: 组合IRR计算（假设${String(year).slice(2)}年${month}月底全部赎回）</th>${ms.map(() => '<th></th>').join('')}<th>投资以来（IRR）</th></tr></thead><tbody>`
    + `<tr><td class="l">资金流</td>${ms.map(m => `<td${at(o, 'total_flow', m)}>${flowText(-res.totalFlow[m])}</td>`).join('')}<td class="irr est"${at(o, 'total_nav', ds.asOf)}>${money(res.totalNav[ds.asOf])}</td></tr>`
    + `<tr><td class="l"><b>年化收益率</b></td>${ms.map(() => '<td></td>').join('')}<td class="irr"${at(o, 'irr')}>${pct(res.irr)}</td></tr></tbody></table>`;
}
function page2(ds: Dataset, res: Result, o: Outputs) {
  const alloc = (['风险', '地域', '策略'] as const).flatMap(dim => [
    `<tr><td class="dim">${dim}：</td>${res.alloc[dim].map(([t]) => `<td>${escape(t)}</td>`).join('')}</tr>`,
    `<tr><td></td>${res.alloc[dim].map(([t, v]) => `<td${at(o, 'alloc', dim, t)}>${pct(v, 0)}</td>`).join('')}</tr>`,
  ]).join('');
  const [, month, day] = monthEnd(ds.asOf).split('-');
  const md = `${month}/${day}`; const keys = fundKeys(ds);
  const rows = keys.map(k => {
    const f = ds.funds[k]; const n = res.nav[k][ds.asOf]; const first = res.firstInvest[k];
    return `<tr><td class="l"><b>${escape(k)}</b></td><td class="l">${escape(f.risk)}</td><td class="l">${escape(f.region)}</td><td class="l">${escape(f.strategy)}</td><td${at(o, 'invested', k)}>${money(res.invested[k])}</td><td${at(o, 'nav', k, ds.asOf)}>${money(n?.value)}</td><td${at(o, 'weight', k)}>${pct(res.weights[k], 0)}</td><td>${first ? shortDate(first) : ''}</td></tr>`;
  });
  rows.push(`<tr class="total"><td class="l">Total</td><td></td><td></td><td></td><td>${money(keys.reduce((s, k) => s + res.invested[k], 0))}</td><td${at(o, 'total_nav', ds.asOf)}>${money(res.totalNav[ds.asOf])}</td><td>100%</td><td></td></tr>`);
  return `<table class="alloc"><caption>持仓分类</caption>${alloc}</table><table class="holdings"><thead><tr><th>当前基金</th><th>风险</th><th>地区</th><th>策略</th><th>总计<br>投资金额</th><th>${md}<br>NAV</th><th>${md}<br>持仓比例</th><th>首次投资日期</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
const endText = (m: Month) => { const [y, mo, d] = monthEnd(m).split('-').map(Number); return { y, mo, d }; };

/** Unpublished reports are served with a watermark; the stored document never contains it. */
export const withDraftMark = (html: string) => html.replace('<body>', '<body><div class="draft">草稿 · 未发布</div>');

export function renderReport(ds: Dataset, res: Result, options: { brand: string; outputs?: Outputs }) {
  const o = options.outputs || {};
  const { y, mo, d } = endText(ds.asOf);
  const estimateNow = fundKeys(ds).some(k => ds.returns[k]?.[ds.asOf]?.estimate);
  const notes = ['注：1. 上述回报中基金表现部分，单只基金月度及全年回报均使用底层基金报告数据；组合月度收益基于客户实际净值计算。'];
  if (estimateNow) notes.push(`&emsp;&emsp;2. ${mo}月各基金业绩暂未披露完全，数据底色标红意为估算数据。`);
  const title = `${escape(ds.client)} 投资组合回顾（截至${y}年${mo}月${d}日）`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><style>${CSS}</style></head><body>
<div class="page"><div class="logo">${escape(options.brand)}<span>.</span></div>
<h1>${title}</h1>
<div class="sub">➢ 按月度的复利计算，<b>${y} YTD</b>回报共计约为<b${at(o, 'ytd')}>${pct(res.ytd, 1)}</b></div>
${table1(ds, res, o)}${table3(ds, res, o)}${table4(ds, res, o)}
<div class="notes">${notes.join('<br>')}</div></div>
<div class="page">${page2(ds, res, o)}</div>
</body></html>`;
}

export function renderChecks(ds: Dataset, res: Result, findings: Finding[], summary: Array<[string, number]>) {
  const { y, mo, d } = endText(ds.asOf);
  const cards = LEVELS.map(level => `<div class="card" style="background:${LEVEL_STYLE[level]}"><b>${findings.filter(f => f.level === level).length}</b>${level}</div>`).join('');
  const sm = summary.map(([n, c]) => `<tr><td>${escape(n)}</td><td>${c === 0 ? '✅ 通过' : `发现 ${c} 项`}</td></tr>`).join('');
  const items = findings.map(f => `<div class="finding" style="border-color:${LEVEL_STYLE[f.level]}"><div class="t"><span class="tag" style="background:${LEVEL_STYLE[f.level]}">${f.level}</span><span class="tag" style="background:#7f7f7f">${escape(f.category)}</span>${escape(f.title)}</div><div class="d">${escape(f.detail)}</div>${f.suggestion ? `<div class="s">建议：${escape(f.suggestion)}</div>` : ''}</div>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>数据校验报告</title><style>${CHECK_CSS}</style></head><body>
<div class="page"><h1>数据校验报告（截至${y}年${mo}月${d}日）</h1>
<div class="sub">客户：${escape(ds.client)}　|　组合 YTD ${pct(res.ytd)}　|　IRR ${pct(res.irr)}　|　总净值 ${money(res.totalNav[ds.asOf])}</div>
<div class="cards">${cards}</div>
<table class="sum" style="width:420px"><thead><tr><th class="l">检查项</th><th class="l">结果</th></tr></thead><tbody>${sm}</tbody></table>
${items}</div></body></html>`;
}
