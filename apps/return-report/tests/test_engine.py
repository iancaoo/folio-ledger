"""用一个手算得出结果的小数据集验证计算口径。"""
import unittest
from datetime import date

from report.engine import chain, compute, xirr
from report.loader import parse_return
from report.model import Dataset, Fund, Nav, Return


def dataset() -> Dataset:
    funds = {
        "A": Fund("A", "A（多策略）", "A - Class A", "均衡型", "全球", "多策略", 0),
        "B": Fund("B", "B（股票多空）", "B - Class A", "进攻型", "美国", "股票多空", 1),
    }
    returns = {
        "A": {(2026, 1): Return(0.10), (2026, 2): Return(0.05, estimate=True)},
        "B": {(2026, 1): Return(0.10), (2026, 2): Return(lo=0.0, hi=0.04, estimate=True)},
        "IDX": {(2026, 1): Return(0.01), (2026, 2): Return(-0.02)},
    }
    navs = {
        "A": {(2025, 12): Nav(1100, "对账单"), (2026, 1): Nav(1210, "对账单")},
        "B": {(2026, 1): Nav(550, "对账单")},
    }
    flows = {"A": {(2025, 12): 1000.0}, "B": {(2026, 1): 500.0, (2026, 2): -100.0}}
    return Dataset("测试客户", (2026, 2), funds, ["IDX"], returns, navs, flows)


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.res = compute(dataset())

    def test_estimated_nav(self):
        # 没有对账单净值的月份：(上月净值 + 申赎) × (1 + 收益率)，区间无点值时取中点
        self.assertAlmostEqual(self.res.nav["A"][(2026, 2)].value, 1210 * 1.05)
        self.assertAlmostEqual(self.res.nav["B"][(2026, 2)].value, (550 - 100) * 1.02)
        self.assertEqual(self.res.nav["B"][(2026, 2)].source, "推算")

    def test_portfolio_return(self):
        # Modified Dietz（资金视为月初投入）：(NAVt − NAVt-1 − F) / (NAVt-1 + F)
        r = self.res.port_ret
        self.assertAlmostEqual(r[(2025, 12)], 0.10)
        self.assertAlmostEqual(r[(2026, 1)], (1760 - 1100 - 500) / 1600)
        self.assertAlmostEqual(r[(2026, 2)], (1729.5 - 1760 + 100) / 1660)
        self.assertAlmostEqual(self.res.ytd, (1 + r[(2026, 1)]) * (1 + r[(2026, 2)]) - 1)

    def test_fund_ytd(self):
        self.assertAlmostEqual(self.res.fund_ytd["A"].value, 1.10 * 1.05 - 1)
        self.assertTrue(self.res.fund_ytd["A"].estimate)
        self.assertAlmostEqual(self.res.fund_ytd["B"].lo, 0.10)
        self.assertAlmostEqual(self.res.fund_ytd["B"].hi, 1.10 * 1.04 - 1)
        self.assertAlmostEqual(self.res.fund_ytd["IDX"].value, 1.01 * 0.98 - 1)

    def test_irr_discounts_to_zero(self):
        cfs = [(date(2025, 12, 1), -1000), (date(2026, 1, 1), -500), (date(2026, 2, 1), 100),
               (date(2026, 2, 28), 1729.5)]
        npv = sum(c / (1 + self.res.irr) ** ((d - cfs[0][0]).days / 365) for d, c in cfs)
        self.assertAlmostEqual(npv, 0, places=6)

    def test_allocation(self):
        total = 1270.5 + 459
        self.assertAlmostEqual(self.res.weights["A"], 1270.5 / total)
        self.assertEqual(list(self.res.alloc["风险"]), ["均衡型", "进攻型"])
        self.assertAlmostEqual(sum(self.res.alloc["地域"].values()), 1)

    def test_helpers(self):
        self.assertAlmostEqual(xirr([(date(2025, 1, 1), -100), (date(2026, 1, 1), 110)]), 0.10, places=6)
        self.assertAlmostEqual(chain([0.1, -0.1]), -0.01)

    def test_parse_return(self):
        self.assertAlmostEqual(parse_return(-0.015).value, -0.015)
        r = parse_return("2.00%-5.00%")
        self.assertEqual((round(r.lo, 4), round(r.hi, 4)), (0.02, 0.05))
        self.assertAlmostEqual(parse_return("-1.50%").value, -0.015)


if __name__ == "__main__":
    unittest.main()
