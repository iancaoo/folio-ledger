"""Finance 报告快照 → Dataset 的转换。

离线测试用手写的小快照；在线测试（FINANCE_LIVE=1）把模拟录入表写入本地 Finance 后，
比对两种数据源算出的每个数字。
"""
import os
import tempfile
import unittest
from pathlib import Path

import make_mock_data
from report.engine import compute
from report.finance_source import dataset_from_snapshot
from report.model import month_end
from report.schema import write_workbook
from report.system_loader import SystemData, load_client

E1, E2 = "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
S1, S2, S3 = ("00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2",
              "00000000-0000-4000-8000-0000000000b1")
B1 = "00000000-0000-4000-8000-0000000000c1"


def share(id, fund, short, label, role="进攻", region="美国", strategy="股票多空"):
    return {"id": id, "fund_id": fund, "isin": f"ISIN-{id[-2:]}", "class_label": label, "currency": "USD",
            "short_name": short, "strategy": strategy, "strategy_detail": "科技", "allocation_role": role,
            "investment_region": region}


def trade(entity, cls, kind, d, amount, units):
    return {"entity_id": entity, "share_class_id": cls, "transaction_type": kind, "confirmation_date": d,
            "amount": amount, "confirmed_units": units}


SNAPSHOT = {
    "schema": "finance.report-snapshot/v1", "report_date": "2026-03-31", "demo_mode": True,
    "entities": [{"id": E1, "legal_name": "主体甲", "common_name": None, "client_code": "AM0001"},
                 {"id": E2, "legal_name": "主体乙", "common_name": "乙", "client_code": "AM0001"}],
    "share_classes": [share(S1, "f1", "Alpha", "A"), share(S2, "f1", "Alpha", "B"),
                      share(S3, "f2", "Bravo", "A", "均衡", "全球", "多策略")],
    "transactions": [trade(E1, S1, "初次申购", "2026-01-01", "1000", "10"),
                     trade(E1, S2, "初次申购", "2026-02-01", "500", "5"),
                     trade(E1, S1, "赎回", "2026-03-01", "220", "2"),
                     trade(E2, S3, "初次申购", "2026-01-01", "300", "3")],
    "fund_navs": [{"share_class_id": S1, "nav_date": "2026-01-31", "nav_per_unit": "105"},
                  {"share_class_id": S1, "nav_date": "2026-03-31", "nav_per_unit": "112"},
                  {"share_class_id": S2, "nav_date": "2026-02-28", "nav_per_unit": "101"}],
    "fund_returns": [{"share_class_id": S1, "return_date": "2026-02-28", "mtd_return": "0.02", "estimate_label": "否"},
                     {"share_class_id": S2, "return_date": "2026-03-31", "mtd_return": "-0.01", "estimate_label": "是"}],
    "benchmarks": [{"id": B1, "name": "指数", "category": "股票"}],
    "benchmark_values": [{"benchmark_id": B1, "value_date": "2025-12-31", "index_value": "100"},
                         {"benchmark_id": B1, "value_date": "2026-01-31", "index_value": "103"}],
}


class SnapshotConversionTest(unittest.TestCase):
    def test_entity_scope_and_share_class_keys(self):
        ds = dataset_from_snapshot(SNAPSHOT, E1)
        self.assertEqual(ds.client, "主体甲")
        self.assertEqual(ds.client_code, "AM0001")
        self.assertEqual(ds.fund_keys, ["Alpha A", "Alpha B"], "同一基金的两个份额类别应分开计算，且不含其他主体的持仓")
        self.assertEqual(ds.funds["Alpha A"].name_t3, "Alpha - A")
        self.assertEqual(ds.funds["Alpha A"].risk, "进攻型")

    def test_units_flows_and_returns(self):
        ds = dataset_from_snapshot(SNAPSHOT, E1)
        self.assertEqual(ds.flows["Alpha A"], {(2026, 1): 1000.0, (2026, 3): -220.0})
        self.assertAlmostEqual(ds.navs["Alpha A"][(2026, 1)].value, 10 * 105)
        self.assertAlmostEqual(ds.navs["Alpha A"][(2026, 3)].value, 8 * 112, msg="市值 = 截至当月的份额 × 单位净值")
        self.assertTrue(ds.returns["Alpha B"][(2026, 3)].estimate)
        self.assertAlmostEqual(ds.returns["指数"][(2026, 1)].value, 0.03)

    def test_as_of_and_demo_provenance(self):
        ds = dataset_from_snapshot(SNAPSHOT, E1, (2026, 2))
        self.assertNotIn((2026, 3), ds.flows["Alpha A"])
        self.assertEqual(ds.provenance[("Finance", "transactions", "模拟")], 2)
        with self.assertRaises(ValueError):
            dataset_from_snapshot(SNAPSHOT, E1, (2026, 4))

    def test_engine_runs_on_snapshot(self):
        res = compute(dataset_from_snapshot(SNAPSHOT, E2))
        self.assertAlmostEqual(res.weights["Bravo"], 1.0)
        self.assertEqual(list(res.alloc["风险"]), ["均衡型"])


@unittest.skipUnless(os.environ.get("FINANCE_LIVE") == "1", "需要本地 Finance（FINANCE_LIVE=1）")
class LiveFinanceTest(unittest.TestCase):
    """模拟录入表 → seed_finance → finance:reportSnapshot，与直接读录入表的结果逐项一致。"""

    AS_OF = (2026, 8)

    @classmethod
    def setUpClass(cls):
        import seed_finance
        from report.finance_source import FinanceClient

        cls.tmp = tempfile.TemporaryDirectory()
        path = Path(cls.tmp.name) / "mock.xlsx"
        write_workbook(str(path), make_mock_data.build_rows(), make_mock_data.NOTES)
        cls.sd = SystemData(str(path))
        account, password = seed_finance.credentials()
        api = FinanceClient(os.environ.get("FINANCE_API", "http://127.0.0.1:13000/api/"), account, password, role="root")
        seeder = seed_finance.Seeder(api)
        cls.ids = seeder.run(cls.sd)
        cls.api = api

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def pair(self, code):
        excel = load_client(self.sd, code, self.AS_OF)
        snap = self.api.snapshot(month_end(self.AS_OF), entity_ids=[self.ids["entities"][code]])
        return excel, dataset_from_snapshot(snap, self.ids["entities"][code], self.AS_OF)

    def test_same_numbers_from_both_sources(self):
        for code in ("AM9001", "AM9002"):
            excel, finance = self.pair(code)
            a, b = compute(excel), compute(finance)
            self.assertEqual(a.months, b.months)
            for m in a.months:
                self.assertAlmostEqual(a.total_nav[m], b.total_nav[m], places=4, msg=f"{code} {m} 总净值")
                self.assertAlmostEqual(a.total_flow[m], b.total_flow[m], places=4)
                if m in a.port_ret:
                    self.assertAlmostEqual(a.port_ret[m], b.port_ret[m], places=10)
            self.assertAlmostEqual(a.ytd, b.ytd, places=10)
            self.assertAlmostEqual(a.irr, b.irr, places=8)
            self.assertEqual(a.alloc, b.alloc)
            for k in excel.fund_keys:
                ya, yb = a.fund_ytd[k], b.fund_ytd[k]
                if ya.lo is not None:
                    self.assertIsNone(yb.lo, "Finance 没有区间字段，区间估算只能以点值保存")
                    continue
                self.assertAlmostEqual(ya.value, yb.value, places=10, msg=f"{code} {k} YTD")


if __name__ == "__main__":
    unittest.main()
