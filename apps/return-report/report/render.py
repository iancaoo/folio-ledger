from __future__ import annotations

from html import escape

from .checks import Finding
from .engine import FundYtd, Result
from .model import Dataset, Month, month_end

CSS = """
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
td.stmt { font-weight: 700; }
td.calc { background: #fce4d6; font-weight: 700; }
tr.total td { font-weight: 700; border-top: 1.5px solid #555; }
tr.total td.red { color: #c00000; }
tr.ret td { background: #fff2cc; color: #c00000; font-weight: 700; }
tr.ret td.l { color: #c00000; }
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
@media print { body { background: #fff; } .page { box-shadow: none; margin: 0; page-break-after: always; } }
"""


def _pct(v: float | None, d: int = 2) -> str:
    return "" if v is None else f"{v:.{d}%}"


def _money(v: float | None) -> str:
    return "" if v is None else f"{v:,.0f}"


def _flow(v: float) -> str:
    if not v:
        return "-"
    return f"({abs(v):,.0f})" if v < 0 else f"{v:,.0f}"


def _date(d) -> str:
    return f"{d.day}/{d.month}/{d.year}"


def _ytd_text(y: FundYtd) -> str:
    if y.lo is not None:
        return f"{y.lo:.0%}~{y.hi:.0%}"
    return _pct(y.value)


def _ret_text(r) -> str:
    if r.is_range:
        return f"{r.lo:.0%}~{r.hi:.0%}"
    return _pct(r.value)


def _name(n: str) -> str:
    for sep in ("（", "("):
        if sep in n:
            head, tail = n.split(sep, 1)
            return f"{escape(head)}<small>{sep}{escape(tail)}</small>"
    return escape(n)


def table1(ds: Dataset, res: Result) -> str:
    ms = res.report_months
    head = "".join(f"<th>{_date(month_end(m))}</th>" for m in ms)
    rows = []
    for k in ds.fund_keys:
        first = res.first_invest.get(k)
        cells = []
        for m in ms:
            r = ds.returns.get(k, {}).get(m)
            cls = ["v"]
            if r and r.estimate:
                cls.append("est")
            if first and (m[0], m[1]) < (first.year, first.month):
                cls.append("pre")
            cells.append(f'<td class="{" ".join(cls)}">{_ret_text(r) if r else ""}</td>')
        y = res.fund_ytd[k]
        cells.append(f'<td class="ytd{" est" if y.estimate else ""}">{_ytd_text(y)}</td>')
        rows.append(f'<tr class="fund"><td class="l name">{_name(ds.funds[k].name_t1)}</td>{"".join(cells)}</tr>')
    for b in ds.benchmarks:
        cells = "".join(f"<td>{_ret_text(r) if (r := ds.returns.get(b, {}).get(m)) else ''}</td>" for m in ms)
        rows.append(f'<tr class="bench"><td class="l">{escape(b)}</td>{cells}'
                    f'<td class="ytd">{_ytd_text(res.fund_ytd[b])}</td></tr>')
    return (f'<table><thead><tr><th class="l">Table-1: 基金表现</th>{head}<th>YTD {ds.as_of[0]}</th></tr></thead>'
            f'<tbody>{"".join(rows)}</tbody></table>')


def table3(ds: Dataset, res: Result) -> str:
    ms = res.report_months
    head = "".join(f"<th>{_date(month_end(m))}</th>" for m in ms)
    rows = []
    for k in ds.fund_keys:
        cells = []
        for m in ms:
            n = res.nav[k].get(m)
            cls = "calc" if n and n.source in ("推算", "缺失") else ""
            cells.append(f'<td class="{cls}">{_money(n.value) if n else ""}</td>')
        rows.append(f'<tr><td class="l">{escape(ds.funds[k].name_t3)}</td><td class="c">{escape(ds.funds[k].risk)}</td>'
                    f'<td class="pct c">{res.weights[k]:.0%}</td>{"".join(cells)}<td></td>'
                    f'<td>{_money(res.invested[k])}</td></tr>')
    totals = "".join(f'<td class="red">{_money(res.total_nav[m])}</td>' for m in ms)
    rows.append(f'<tr class="total"><td class="l">总计</td><td></td><td class="pct c">100%</td>{totals}<td></td>'
                f'<td>{_money(sum(res.invested.values()))}</td></tr>')
    rets = "".join(f"<td>{_pct(res.port_ret.get(m))}</td>" for m in ms)
    rows.append(f'<tr class="ret"><td class="l">组合月度收益</td><td></td><td></td>{rets}<td>{_pct(res.ytd)}</td><td></td></tr>')
    return (f'<table><thead><tr><th class="l">Table-3: 投资组合净值（美元）</th><th class="c">风险分类</th>'
            f'<th class="c">持仓比例</th>{head}<th>YTD {ds.as_of[0]}</th><th>总计投资金额</th></tr></thead>'
            f'<tbody>{"".join(rows)}</tbody></table>')


def table4(ds: Dataset, res: Result) -> str:
    ms = res.report_months
    head = "".join("<th></th>" for _ in ms)
    flows = "".join(f"<td>{_flow(-res.total_flow[m])}</td>" for m in ms)
    blanks = "".join("<td></td>" for _ in ms)
    return (f'<table><thead><tr><th class="l">Table-4: 组合IRR计算（假设{str(ds.as_of[0])[2:]}年{ds.as_of[1]}月底全部赎回）</th>'
            f'{head}<th>投资以来（IRR）</th></tr></thead><tbody>'
            f'<tr><td class="l">资金流</td>{flows}<td class="irr est">{_money(res.total_nav[ds.as_of])}</td></tr>'
            f'<tr><td class="l"><b>年化收益率</b></td>{blanks}<td class="irr">{_pct(res.irr)}</td></tr>'
            f'</tbody></table>')


def page2(ds: Dataset, res: Result) -> str:
    alloc_rows = []
    for dim, label in (("风险", "风险："), ("地域", "地域："), ("策略", "策略：")):
        g = res.alloc[dim]
        alloc_rows.append(f'<tr><td class="dim">{label}</td>' + "".join(f"<td>{escape(t)}</td>" for t in g) + "</tr>")
        alloc_rows.append("<tr><td></td>" + "".join(f"<td>{v:.0%}</td>" for v in g.values()) + "</tr>")
    d = month_end(ds.as_of)
    md = f"{d.month:02d}/{d.day:02d}"
    rows = []
    for k in ds.fund_keys:
        f = ds.funds[k]
        n = res.nav[k].get(ds.as_of)
        fi = res.first_invest.get(k)
        rows.append(f'<tr><td class="l"><b>{escape(k)}</b></td><td class="l">{escape(f.risk)}</td>'
                    f'<td class="l">{escape(f.region)}</td><td class="l">{escape(f.strategy)}</td>'
                    f'<td>{_money(res.invested[k])}</td><td>{_money(n.value if n else None)}</td>'
                    f'<td>{res.weights[k]:.0%}</td><td>{_date(fi) if fi else ""}</td></tr>')
    rows.append(f'<tr class="total"><td class="l">Total</td><td></td><td></td><td></td>'
                f'<td>{_money(sum(res.invested.values()))}</td><td>{_money(res.total_nav[ds.as_of])}</td>'
                f'<td>100%</td><td></td></tr>')
    return (f'<table class="alloc"><caption>持仓分类</caption>{"".join(alloc_rows)}</table>'
            f'<table class="holdings"><thead><tr><th>当前基金</th><th>风险</th><th>地区</th><th>策略</th>'
            f'<th>总计<br>投资金额</th><th>{md}<br>NAV</th><th>{md}<br>持仓比例</th><th>首次投资日期</th></tr></thead>'
            f'<tbody>{"".join(rows)}</tbody></table>')


def render_report(ds: Dataset, res: Result) -> str:
    d = month_end(ds.as_of)
    est_now = any((r := ds.returns.get(k, {}).get(ds.as_of)) and r.estimate for k in ds.fund_keys)
    notes = ["注：1. 上述回报中基金表现部分，单只基金月度及全年回报均使用底层基金报告数据；组合月度收益基于客户实际净值计算。"]
    if est_now:
        notes.append(f"&emsp;&emsp;2. {d.month}月各基金业绩暂未披露完全，数据底色标红意为估算数据。")
    title = f"{escape(ds.client)} 投资组合回顾（截至{d.year}年{d.month}月{d.day}日）"
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>{title}</title><style>{CSS}</style></head><body>
<div class="page"><div class="logo">Amrita<span>.</span></div>
<h1>{title}</h1>
<div class="sub">➢ 按月度的复利计算，<b>{d.year} YTD</b>回报共计约为<b>{res.ytd:.1%}</b></div>
{table1(ds, res)}{table3(ds, res)}{table4(ds, res)}
<div class="notes">{"<br>".join(notes)}</div></div>
<div class="page">{page2(ds, res)}</div>
</body></html>"""


LEVEL_STYLE = {"错误": "#c00000", "警告": "#e46c0a", "提示": "#2e75b6"}

CHECK_CSS = CSS + """
.cards { display: flex; gap: 14px; margin: 14px 0 18px; }
.card { flex: 1; border-radius: 8px; padding: 12px 16px; color: #fff; }
.card b { font-size: 28px; display: block; }
.finding { border-left: 5px solid; padding: 8px 14px; margin-bottom: 10px; background: #fafafa; }
.finding .t { font-weight: 700; font-size: 14.5px; }
.finding .tag { display: inline-block; font-size: 12px; color: #fff; border-radius: 3px; padding: 0 6px; margin-right: 6px; }
.finding .d { font-size: 13px; margin-top: 4px; line-height: 1.6; }
.finding .s { font-size: 13px; color: #375623; margin-top: 2px; }
.sum td { text-align: left; }
"""


def render_checks(ds: Dataset, res: Result, findings: list[Finding], summary) -> str:
    d = month_end(ds.as_of)
    counts = {lv: sum(f.level == lv for f in findings) for lv in LEVEL_STYLE}
    cards = "".join(f'<div class="card" style="background:{c}"><b>{counts[lv]}</b>{lv}</div>'
                    for lv, c in LEVEL_STYLE.items())
    sm = "".join(f'<tr><td>{escape(n)}</td><td>{"✅ 通过" if c == 0 else f"发现 {c} 项"}</td></tr>' for n, c in summary)
    items = "".join(
        f'<div class="finding" style="border-color:{LEVEL_STYLE[f.level]}">'
        f'<div class="t"><span class="tag" style="background:{LEVEL_STYLE[f.level]}">{f.level}</span>'
        f'<span class="tag" style="background:#7f7f7f">{escape(f.category)}</span>{escape(f.title)}</div>'
        f'<div class="d">{escape(f.detail)}</div>'
        + (f'<div class="s">建议：{escape(f.suggestion)}</div>' if f.suggestion else "") + "</div>"
        for f in findings)
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>数据校验报告</title><style>{CHECK_CSS}</style></head><body>
<div class="page"><h1>数据校验报告（截至{d.year}年{d.month}月{d.day}日）</h1>
<div class="sub">客户：{escape(ds.client)}　|　组合 YTD {res.ytd:.2%}　|　IRR {res.irr:.2%}　|　总净值 {res.total_nav[ds.as_of]:,.0f}</div>
<div class="cards">{cards}</div>
<table class="sum" style="width:420px"><thead><tr><th class="l">检查项</th><th class="l">结果</th></tr></thead><tbody>{sm}</tbody></table>
{items}</div></body></html>"""
