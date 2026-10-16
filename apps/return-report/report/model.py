from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import date

Month = tuple[int, int]


def to_month(d: date) -> Month:
    return (d.year, d.month)


def month_start(m: Month) -> date:
    return date(m[0], m[1], 1)


def month_end(m: Month) -> date:
    return date(m[0], m[1], calendar.monthrange(m[0], m[1])[1])


def next_month(m: Month) -> Month:
    return (m[0] + 1, 1) if m[1] == 12 else (m[0], m[1] + 1)


def month_range(start: Month, end: Month) -> list[Month]:
    out, m = [], start
    while m <= end:
        out.append(m)
        m = next_month(m)
    return out


def month_label(m: Month) -> str:
    return f"{m[0]}年{m[1]}月"


@dataclass
class Return:
    value: float | None = None
    lo: float | None = None
    hi: float | None = None
    point: float | None = None
    estimate: bool = False
    source: str = ""
    note: str = ""

    @property
    def is_range(self) -> bool:
        return self.value is None and self.lo is not None and self.hi is not None

    @property
    def midpoint(self) -> float | None:
        return (self.lo + self.hi) / 2 if self.is_range else None

    @property
    def used(self) -> float:
        """用于推算净值的收益率：实际值 > 估算点值 > 区间中点。"""
        if self.value is not None:
            return self.value
        if self.point is not None:
            return self.point
        return self.midpoint

    def same_as(self, other: Return) -> bool:
        def eq(a, b):
            return (a is None and b is None) or (a is not None and b is not None and abs(a - b) < 1e-9)
        return eq(self.value, other.value) and eq(self.lo, other.lo) and eq(self.hi, other.hi)

    def describe(self) -> str:
        if self.is_range:
            return f"{self.lo:.2%}~{self.hi:.2%}"
        return f"{self.value:.2%}" if self.value is not None else "—"


@dataclass
class Nav:
    value: float
    source: str          # tracker / tracker估算 / 对账单 / 推算
    estimate: bool = False


@dataclass
class Fund:
    key: str
    name_t1: str
    name_t3: str
    risk: str
    region: str
    strategy: str
    order: int


@dataclass
class Override:
    kind: str            # 收益率 / 净值 / 申赎
    key: str
    month: Month
    old: object
    new: object
    note: str = ""


@dataclass
class Dataset:
    client: str
    as_of: Month
    funds: dict[str, Fund]
    benchmarks: list[str]
    returns: dict[str, dict[Month, Return]] = field(default_factory=dict)
    navs: dict[str, dict[Month, Nav]] = field(default_factory=dict)
    flows: dict[str, dict[Month, float]] = field(default_factory=dict)
    overrides: list[Override] = field(default_factory=list)
    tracker_estimate_months: list[Month] = field(default_factory=list)
    client_code: str = ""
    provenance: dict[tuple[str, str, str], int] = field(default_factory=dict)
    missing_required: list[tuple[str, str, str]] = field(default_factory=list)
    # 原始数据定位，供计算图回溯：trades / prices / returns / bench_levels / tags，见 report/trace.py
    lineage: dict = field(default_factory=dict)

    @property
    def fund_keys(self) -> list[str]:
        return sorted(self.funds, key=lambda k: self.funds[k].order)
