from __future__ import annotations

import copy
from dataclasses import asdict, dataclass

from .config import (ALLOWED_REGIONS, ALLOWED_ROLES, ALLOWED_STRATEGIES, BIG_MOVE,
                     RECON_ERROR, RECON_FIT_TOL, RECON_WARN)
from .engine import Result, compute
from .model import Dataset, Month, month_label

LEVELS = {"错误": 0, "警告": 1, "提示": 2}


@dataclass
class Finding:
    level: str
    category: str
    title: str
    detail: str
    suggestion: str = ""
    fund: str = ""
    month: str = ""


def _money(v: float) -> str:
    return f"{v:,.0f}"


def _impact(ds: Dataset, res: Result, alt: Dataset, month: Month) -> str:
    a = compute(alt)
    return (f"按原值计算：{month_label(month)}组合收益 {a.port_ret[month]:.2%}（现 {res.port_ret[month]:.2%}），"
            f"YTD {a.ytd:.2%}（现 {res.ytd:.2%}），IRR {a.irr:.2%}（现 {res.irr:.2%}）。")


def _fit(pairs: list[tuple[float, float]]) -> tuple[float, float]:
    """最小二乘拟合 客户实际收益 = alpha + beta × 基金公布收益。"""
    n = len(pairs)
    mx = sum(r for r, _ in pairs) / n
    my = sum(i for _, i in pairs) / n
    sxx = sum((r - mx) ** 2 for r, _ in pairs)
    beta = sum((r - mx) * (i - my) for r, i in pairs) / sxx if sxx else 1.0
    return my - beta * mx, beta


def _recon_rows(ds: Dataset, res: Result, k: str):
    for m in res.report_months:
        cell = res.nav[k].get(m)
        r = ds.returns.get(k, {}).get(m)
        if not cell or cell.source in ("推算", "缺失") or not r:
            continue
        prev_m = res.months[res.months.index(m) - 1]
        prev = res.nav[k][prev_m].value if prev_m in res.nav[k] else 0.0
        flow = ds.flows[k].get(m, 0.0)
        if prev + flow > 0:
            yield m, r, cell.value, prev, flow, cell.value / (prev + flow) - 1


def _systematic(rows) -> tuple[float, float, list[Month]] | None:
    """客户份额与基金公布收益之间稳定的比例/固定差（份额类别、业绩费计提口径不同）。"""
    pairs = {m: (r.value, i) for m, r, _, prev, flow, i in rows if flow == 0 and prev > 0 and not r.is_range}
    if len(pairs) < 4:
        return None
    alpha, beta = _fit(list(pairs.values()))
    worst = max(pairs, key=lambda m: abs(pairs[m][1] - alpha - beta * pairs[m][0]))
    if abs(pairs[worst][1] - alpha - beta * pairs[worst][0]) >= RECON_FIT_TOL:
        del pairs[worst]
        alpha, beta = _fit(list(pairs.values()))
    fitted = all(abs(i - alpha - beta * r) < RECON_FIT_TOL for r, i in pairs.values())
    raw_off = sum(abs(i - r) >= RECON_WARN for r, i in pairs.values())
    if fitted and raw_off >= 2:
        return alpha, beta, sorted(pairs)
    return None


def check_reconciliation(ds: Dataset, res: Result) -> list[Finding]:
    """对账单净值、当月收益率、资金流三者是否勾稽：净值 ≈ (上月净值 + 申赎) × (1 + 收益率)。"""
    out = []
    flow_overrides = {(o.key, o.month): o for o in ds.overrides if o.kind == "申赎"}
    for k in ds.fund_keys:
        rows = list(_recon_rows(ds, res, k))
        sysm = _systematic(rows)
        alpha, beta = (sysm[0], sysm[1]) if sysm else (0.0, 1.0)
        if sysm:
            ex = max((x for x in rows if x[0] in sysm[2]), key=lambda x: abs(x[1].value))
            out.append(Finding(
                "提示", "净值勾稽", f"{k}：客户实际收益与基金公布收益存在稳定差异",
                f"{len(sysm[2])} 个月的数据显示，客户持仓净值的月度变动 ≈ {beta:.2f} × 基金公布收益"
                f"{alpha * 100:+.2f} 个百分点。例如 {month_label(ex[0])} 基金公布 {ex[1].value:.2%}，"
                f"客户实际 {ex[5]:.2%}。因此报告 Table-1 的单基金收益与客户实际收益口径不同。",
                "常见原因是客户持有的份额类别与公布业绩的份额类别不同，或业绩报酬的计提方式不同；"
                "建议向基金或行政管理人确认，并决定 Table-1 用哪个口径。", k))
        for m, r, nav, prev, flow, implied in rows:
            expected = alpha + beta * r.used
            if r.is_range:
                if r.lo - RECON_WARN <= implied <= r.hi + RECON_WARN:
                    continue
                diff, shown = implied - r.used, r.describe()
            else:
                diff, shown = implied - expected, f"{r.value:.2%}"
            if abs(diff) < (RECON_FIT_TOL if sysm else RECON_WARN):
                continue
            level = "错误" if abs(diff) >= RECON_ERROR else "警告"
            need_flow = nav / (1 + expected) - prev
            basis = f"按上述稳定关系应为 {expected:.2%}，" if sysm else ""
            detail = (f"对账单净值 {_money(nav)}，上月净值 {_money(prev)}，本月申赎 {_money(flow)}，"
                      f"反推当月收益 {implied:.2%}；录入的基金收益率为 {shown}，{basis}相差 {diff * 100:+.2f} 个百分点。"
                      f"若收益率无误，本月申赎应约为 {_money(need_flow)}。")
            suggestion = "核对对账单、申赎记录和收益率三者中哪一项录错。"
            o = flow_overrides.get((k, m))
            if o:
                detail += f" 该月申赎在 tracker 中原记录为 {_money(o.old)}，本期被改为 {_money(o.new)}（{o.note}）。"
                alt = copy.deepcopy(ds)
                alt.flows[k][m] = o.old
                detail += " " + _impact(ds, res, alt, m)
                suggestion = "赎回应按实际到账金额记账；建议恢复 tracker 原值，或向运营确认口径后统一。"
            elif prev == 0:
                suggestion = "首次申购当月，差异常见于申购费、均衡化调整或申购日不在月初，确认后可忽略。"
            out.append(Finding(level, "净值勾稽", f"{k} {month_label(m)}：净值与收益率、资金流不一致",
                               detail, suggestion, k, month_label(m)))
    return out


def check_estimates(ds: Dataset, res: Result) -> list[Finding]:
    out = []
    for m in res.report_months:
        est = [k for k in ds.fund_keys if (r := ds.returns.get(k, {}).get(m)) and r.estimate]
        if not est:
            continue
        stale = m < ds.as_of
        out.append(Finding(
            "错误" if stale else "提示", "估算数据",
            f"{month_label(m)}有 {len(est)} 只基金仍为估算值",
            "、".join(est) + "。报告中这些单元格会标红，相关净值为推算值。",
            "截止日之前月份的估算值应在出报告前替换为实际值。" if stale else "实际值出来后在增量文件中更新即可。",
            month=month_label(m)))
        for k in est:
            r = ds.returns[k][m]
            if r.is_range and r.point is not None and abs(r.point - r.midpoint) > 1e-9:
                prev_m = res.months[res.months.index(m) - 1]
                prev = res.nav[k].get(prev_m)
                base = (prev.value if prev else 0.0) + ds.flows[k].get(m, 0.0)
                delta = base * (r.point - r.midpoint)
                out.append(Finding(
                    "提示", "估算数据", f"{k} {month_label(m)}：估算点值不在区间中点",
                    f"区间 {r.describe()}，中点 {r.midpoint:.2%}，实际用于推算的点值为 {r.point:.2%}，"
                    f"净值相差约 {_money(delta)}，影响组合当月收益约 "
                    f"{delta / (res.total_nav[prev_m] + res.total_flow[m]) * 100:+.2f} 个百分点。",
                    "确认点值来源（基金经理口头估计或内部判断）并在备注中写明。", k, month_label(m)))
    for k in ds.fund_keys:
        rs = ds.returns.get(k, {})
        actual = [m for m, r in rs.items() if not r.estimate]
        if actual:
            for m, r in rs.items():
                if r.estimate and m < max(actual):
                    out.append(Finding("错误", "估算数据", f"{k} {month_label(m)}：过期的估算值",
                                       f"已有 {month_label(max(actual))} 的实际值，但 {month_label(m)} 仍是估算值。",
                                       "补录该月实际值。", k, month_label(m)))
    return out


def check_overrides(ds: Dataset, res: Result) -> list[Finding]:
    out, revised = [], []
    for o in ds.overrides:
        if o.kind == "收益率":
            if o.old.estimate:
                revised.append(o)
            else:
                out.append(Finding("警告", "历史数据修改", f"{o.key} {month_label(o.month)}：已确认的收益率被修改",
                                   f"原值 {o.old.describe()}，新值 {o.new.describe()}。",
                                   "确认是否为基金方更正，并保留更正依据。", o.key, month_label(o.month)))
        elif o.kind == "净值" and o.old.source != "tracker估算":
            out.append(Finding("警告", "历史数据修改", f"{o.key} {month_label(o.month)}：历史净值被修改",
                               f"原值 {_money(o.old.value)}，新值 {_money(o.new.value)}。",
                               "确认对账单是否重新出具。", o.key, month_label(o.month)))
    if revised:
        big = sorted(revised, key=lambda o: -abs(o.new.used - o.old.used))[:3]
        out.append(Finding(
            "提示", "历史数据修改", f"{len(revised)} 个估算收益率已更新为实际值",
            "差异最大的是：" + "；".join(f"{o.key} {month_label(o.month)} {o.old.describe()} → {o.new.describe()}"
                                         for o in big) + "。",
            "属于正常更新，无需处理。"))
    nav_est = [o for o in ds.overrides if o.kind == "净值" and o.old.source == "tracker估算"]
    if nav_est:
        months = sorted({o.month for o in nav_est})
        diff = sum(o.new.value - o.old.value for o in nav_est)
        out.append(Finding("提示", "历史数据修改",
                           f"{'、'.join(month_label(m) for m in months)} {len(nav_est)} 只基金的估算净值已替换为对账单净值",
                           f"合计净值较 tracker 估算变动 {_money(diff)}。", "属于正常更新，无需处理。"))
    reconciled = {(f.fund, f.month) for f in check_reconciliation(ds, res)}
    for o in ds.overrides:
        if o.kind == "申赎" and (o.key, month_label(o.month)) not in reconciled:
            alt = copy.deepcopy(ds)
            alt.flows[o.key][o.month] = o.old
            out.append(Finding("警告", "历史数据修改", f"{o.key} {month_label(o.month)}：申赎金额被修改",
                               f"原值 {_money(o.old)}，新值 {_money(o.new)}。" + _impact(ds, res, alt, o.month),
                               "确认修改依据。", o.key, month_label(o.month)))
    return out


def check_tags(ds: Dataset, res: Result) -> list[Finding]:
    out = []
    for k in ds.fund_keys:
        f = ds.funds[k]
        for label, val, allowed in (("风险分类", f.risk.removesuffix("型"), ALLOWED_ROLES),
                                    ("投资地区", f.region, ALLOWED_REGIONS),
                                    ("基金策略", f.strategy, ALLOWED_STRATEGIES)):
            if not val:
                out.append(Finding("错误", "基金标签", f"{k}：缺少{label}", "持仓分类无法计算。", f"补充{label}。", k))
            elif val not in allowed:
                out.append(Finding("警告", "基金标签", f"{k}：{label}「{val}」不在字段清单的枚举值中",
                                   f"允许值：{'/'.join(allowed)}。", "补充枚举值或改用已有分类。", k))
    return out


def check_totals(ds: Dataset, res: Result) -> list[Finding]:
    out = []
    if abs(sum(res.weights.values()) - 1) > 1e-6:
        out.append(Finding("错误", "合计校验", "持仓比例合计不等于 100%", f"合计 {sum(res.weights.values()):.4%}。"))
    for dim, g in res.alloc.items():
        if abs(sum(g.values()) - 1) > 1e-6:
            out.append(Finding("错误", "合计校验", f"{dim}分类合计不等于 100%", f"合计 {sum(g.values()):.4%}。"))
    return out


def check_missing(ds: Dataset, res: Result) -> list[Finding]:
    out = [Finding("错误", "数据缺失", f"{k} {month_label(m)}：缺少收益率和净值",
                   "该基金当月有持仓，但既没有对账单净值也没有收益率，净值暂按上月结转。", "补录数据。", k, month_label(m))
           for k, m in res.missing]
    for b in ds.benchmarks:
        lack = [m for m in res.report_months if m not in ds.returns.get(b, {})]
        if lack:
            out.append(Finding("警告", "数据缺失", f"基准 {b} 缺少数据", "缺少：" + "、".join(map(month_label, lack)),
                               "补录基准收益。", b))
    return out


def check_big_moves(ds: Dataset, res: Result) -> list[Finding]:
    out = []
    for k in ds.fund_keys:
        for m in res.report_months:
            r = ds.returns.get(k, {}).get(m)
            if r and r.value is not None and abs(r.value) >= BIG_MOVE:
                out.append(Finding("提示", "大幅波动", f"{k} {month_label(m)}：单月收益 {r.value:.2%}",
                                   f"超过 ±{BIG_MOVE:.0%}，建议在月报点评中说明原因。", "核对数值并准备点评。",
                                   k, month_label(m)))
    return out


def check_provenance(ds: Dataset, res: Result) -> list[Finding]:
    out = []
    for tag, level, why in (("模拟", "警告", "这些值目前没有真实来源，是为跑通流程临时编造的，正式出报告前必须替换。"),
                            ("推算", "提示", "这些值由真实数据换算得到，结果正确，但应改为对账单或数据源上的原始值。")):
        items = sorted(((s, c), n) for (s, c, t), n in ds.provenance.items() if t == tag)
        if items:
            out.append(Finding(level, "数据来源", f"本报告用到了{tag}数据（{sum(n for _, n in items)} 个单元格）",
                               "；".join(f"{s}.{c} {n} 个" for (s, c), n in items) + "。", why))
    return out


def check_required(ds: Dataset, res: Result) -> list[Finding]:
    by_field: dict[str, list[str]] = {}
    for sheet, key, col in ds.missing_required:
        by_field.setdefault(f"{sheet}.{col}", []).append(key)
    return [Finding("提示", "必填字段", f"{f}：{len(keys)} 只基金未填写",
                    "、".join(keys) + "。字段清单要求必填，不影响本次报告计算。", "补充该字段。")
            for f, keys in by_field.items()]


CHECKS = [
    ("数据来源", check_provenance),
    ("必填字段", check_required),
    ("净值勾稽", check_reconciliation),
    ("估算数据", check_estimates),
    ("历史数据修改", check_overrides),
    ("基金标签", check_tags),
    ("合计校验", check_totals),
    ("数据缺失", check_missing),
    ("大幅波动", check_big_moves),
]


def run_checks(ds: Dataset, res: Result) -> tuple[list[Finding], list[tuple[str, int]]]:
    findings, summary = [], []
    for name, fn in CHECKS:
        fs = fn(ds, res)
        findings += fs
        summary.append((name, len(fs)))
    findings.sort(key=lambda f: LEVELS[f.level])
    return findings, summary


def to_dicts(findings: list[Finding]) -> list[dict]:
    return [asdict(f) for f in findings]
