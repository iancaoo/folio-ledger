from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from math import prod

from .config import REGION_ORDER, RISK_ORDER, STRATEGY_ORDER
from .model import Dataset, Month, Nav, Return, month_end, month_range, month_start


@dataclass
class FundYtd:
    value: float | None = None
    lo: float | None = None
    hi: float | None = None
    estimate: bool = False


@dataclass
class Result:
    months: list[Month]
    report_months: list[Month]
    nav: dict[str, dict[Month, Nav]]
    total_nav: dict[Month, float]
    total_flow: dict[Month, float]
    port_ret: dict[Month, float]
    ytd: float
    irr: float
    fund_ytd: dict[str, FundYtd]
    invested: dict[str, float]
    first_invest: dict[str, date]
    weights: dict[str, float]
    alloc: dict[str, dict[str, float]]
    missing: list[tuple[str, Month]] = field(default_factory=list)


def xirr(cashflows: list[tuple[date, float]]) -> float:
    """与 Excel XIRR 相同的口径：按实际天数 / 365 折现。"""
    d0 = min(d for d, _ in cashflows)
    npv = lambda r: sum(c / (1 + r) ** ((d - d0).days / 365) for d, c in cashflows)
    lo, hi = -0.99, 10.0
    for _ in range(300):
        mid = (lo + hi) / 2
        if npv(mid) > 0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def chain(rets: list[float]) -> float:
    return prod(1 + r for r in rets) - 1


def _ytd(rs: list[Return]) -> FundYtd:
    if not rs:
        return FundYtd()
    est = any(r.estimate for r in rs)
    if any(r.is_range for r in rs):
        lo = chain([r.lo if r.is_range else r.value for r in rs])
        hi = chain([r.hi if r.is_range else r.value for r in rs])
        return FundYtd(lo=lo, hi=hi, estimate=est)
    return FundYtd(value=chain([r.value for r in rs]), estimate=est)


def _ordered(groups: dict[str, float], order: list[str]) -> dict[str, float]:
    keys = [k for k in order if k in groups] + [k for k in groups if k not in order]
    return {k: groups[k] for k in keys}


def compute(ds: Dataset) -> Result:
    starts = [m for k in ds.fund_keys for m in list(ds.flows[k]) + list(ds.navs[k])]
    months = month_range(min(starts), ds.as_of)
    report_months = [m for m in months if m[0] == ds.as_of[0]]

    nav: dict[str, dict[Month, Nav]] = {}
    missing = []
    for k in ds.fund_keys:
        nav[k], prev = {}, 0.0
        for m in months:
            flow = ds.flows[k].get(m, 0.0)
            base = prev + flow
            given = ds.navs[k].get(m)
            r = ds.returns.get(k, {}).get(m)
            if given:
                cell = given
            elif base > 0 and r:
                cell = Nav(base * (1 + r.used), "推算", estimate=r.estimate)
            elif base > 0:
                missing.append((k, m))
                cell = Nav(base, "缺失", estimate=True)
            else:
                cell = None
            if cell:
                nav[k][m] = cell
            prev = cell.value if cell else 0.0

    total_nav = {m: sum(nav[k][m].value for k in ds.fund_keys if m in nav[k]) for m in months}
    total_flow = {m: sum(ds.flows[k].get(m, 0.0) for k in ds.fund_keys) for m in months}

    port_ret, prev = {}, 0.0
    for m in months:
        f = total_flow[m]
        if prev + f:
            port_ret[m] = (total_nav[m] - prev - f) / (prev + f)
        prev = total_nav[m]

    ytd = chain([port_ret[m] for m in report_months if m in port_ret])
    cfs = [(month_start(m), -total_flow[m]) for m in months if total_flow[m]]
    cfs.append((month_end(ds.as_of), total_nav[ds.as_of]))

    fund_ytd = {}
    for k in ds.fund_keys + ds.benchmarks:
        rs = [ds.returns.get(k, {})[m] for m in report_months if m in ds.returns.get(k, {})]
        fund_ytd[k] = _ytd(rs)

    invested = {k: sum(ds.flows[k].values()) for k in ds.fund_keys}
    first_invest = {}
    for k in ds.fund_keys:
        pos = sorted(m for m, v in ds.flows[k].items() if v > 0)
        if pos:
            first_invest[k] = month_start(pos[0])

    total = total_nav[ds.as_of]
    weights = {k: (nav[k][ds.as_of].value / total if ds.as_of in nav[k] else 0.0) for k in ds.fund_keys}
    alloc = {}
    for dim, attr, order in (("风险", "risk", RISK_ORDER), ("地域", "region", REGION_ORDER),
                             ("策略", "strategy", STRATEGY_ORDER)):
        g: dict[str, float] = {}
        for k in ds.fund_keys:
            if weights[k]:
                tag = getattr(ds.funds[k], attr)
                g[tag] = g.get(tag, 0.0) + weights[k]
        alloc[dim] = _ordered(g, order)

    return Result(months, report_months, nav, total_nav, total_flow, port_ret, ytd, xirr(cfs),
                  fund_ytd, invested, first_invest, weights, alloc, missing)
