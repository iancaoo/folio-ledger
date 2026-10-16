"""计算口径。每份报告记录使用的规则集；公式本身由代码和计算版本决定，这里只放业务可选的口径。"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass

RANGE_VALUE = {
    "point": "区间估算推算净值时，优先用估算点值，没有点值用区间中点",
    "midpoint": "区间估算推算净值时，一律用区间中点",
}

# 计算图中各类节点引用的规则说明
FORMULAS = {
    "flow": "当月申赎 = Σ申购金额 − Σ赎回金额（按确认日期所在月份，视为月初发生）",
    "select": "收益选值：同月正式值优先，同类取日期最新的一条；最新正式值日期之前的估算值不再使用；未标注是否估算的记录不参与计算",
    "units": "持有份额 = 截至当月的 Σ申购份额 − Σ赎回份额",
    "nav_statement": "持有市值 = 持有份额 × 当月末单位净值",
    "nav_roll": "推算市值 =（上月市值 + 本月申赎）×（1 + 本月收益率）",
    "nav_carry": "缺少净值和收益率：市值暂按（上月市值 + 本月申赎）结转",
    "total": "合计 = 各基金之和",
    "dietz": "组合月度收益（Modified Dietz，资金视为月初投入）=（本月净值 − 上月净值 − 本月申赎）/（上月净值 + 本月申赎）",
    "chain": "YTD = Π（1 + 月度收益）− 1",
    "xirr": "IRR：申赎记在确认月的月初，期末总净值记在截止日，按 实际天数/365 折现（与 Excel XIRR 相同）",
    "weight": "持仓比例 = 基金期末市值 / 组合期末总净值",
    "alloc": "分类占比 = 该分类下各基金持仓比例之和",
    "bench": "基准月度收益 = 本月末点位 / 上月末点位 − 1",
    "invested": "总计投资金额 = Σ申赎金额",
}


@dataclass(frozen=True)
class Rules:
    range_value: str = "point"

    def __post_init__(self):
        if self.range_value not in RANGE_VALUE:
            raise ValueError(f"未知的区间估算口径：{self.range_value}")

    @property
    def id(self) -> str:
        body = json.dumps(asdict(self), sort_keys=True)
        return f"rules-{hashlib.sha256(body.encode()).hexdigest()[:8]}"

    def describe(self) -> dict:
        return {"id": self.id, "range_value": self.range_value, "range_value_text": RANGE_VALUE[self.range_value]}

    def used_return(self, r) -> float | None:
        if r.value is not None:
            return r.value
        if self.range_value == "point" and r.point is not None:
            return r.point
        return r.midpoint


DEFAULT_RULES = Rules()
