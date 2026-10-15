"""用模拟录入表跑完整流程：读表 → 计算 → 校验 → 生成 HTML。"""
import tempfile
import unittest
from pathlib import Path

import make_mock_data
from report.checks import run_checks
from report.engine import compute
from report.render import render_checks, render_report
from report.schema import SHEETS, write_workbook
from report.system_loader import SystemData, load_client


class MockPipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        path = Path(cls.tmp.name) / "mock.xlsx"
        write_workbook(str(path), make_mock_data.build_rows(), make_mock_data.NOTES)
        cls.sd = SystemData(str(path))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_client(self, code):
        ds = load_client(self.sd, code)
        res = compute(ds)
        findings, summary = run_checks(ds, res)
        return ds, res, findings, summary

    def test_clients_and_as_of(self):
        self.assertEqual(self.sd.clients_for_report(), ["AM9001", "AM9002"])
        self.assertEqual(self.sd.latest_month(), (2026, 8))
        self.assertEqual(set(self.sd.sheets), set(SHEETS))

    def test_totals_are_consistent(self):
        ds, res, _, _ = self.run_client("AM9001")
        self.assertEqual(len(ds.funds), 7)
        for m in res.months:
            self.assertAlmostEqual(res.total_nav[m], sum(res.nav[k][m].value for k in ds.fund_keys if m in res.nav[k]))
        self.assertAlmostEqual(sum(res.weights.values()), 1)
        for dim in res.alloc.values():
            self.assertAlmostEqual(sum(dim.values()), 1)

    def test_planted_issues_are_found(self):
        _, _, findings, _ = self.run_client("AM9001")

        def has(category, fund=None, level=None):
            return any(f.category == category and (fund is None or f.fund == fund) and (level is None or f.level == level)
                       for f in findings)

        self.assertTrue(has("净值勾稽", "Alpha", "错误"), "赎回金额与份额不一致应报错")
        self.assertTrue(has("净值勾稽", "Bravo"), "客户份额与公布收益的系统性差异应被识别")
        self.assertTrue(has("基金标签", "Gamma"), "配置策略「混合」不在字段清单枚举中")
        self.assertTrue(has("必填字段"), "Gamma 缺少 ISIN code")
        self.assertTrue(has("估算数据"))

    def test_clean_client_has_no_errors(self):
        _, _, findings, _ = self.run_client("AM9002")
        self.assertEqual([f.title for f in findings if f.level == "错误"], [])

    def test_render(self):
        ds, res, findings, summary = self.run_client("AM9001")
        self.assertIn("示例客户甲", render_report(ds, res))
        self.assertIn("校验", render_checks(ds, res, findings, summary))


if __name__ == "__main__":
    unittest.main()
