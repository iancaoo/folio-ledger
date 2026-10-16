"""计算图：与引擎结果一致、可独立复核、能回溯到录入单元格，口径变化可按节点比较。"""
import html
import json
import re
import tempfile
import unittest
from pathlib import Path

import make_mock_data
from report.checks import run_checks
from report.engine import compute
from report.finance_source import dataset_from_snapshot
from report.render import render_report
from report.rules import Rules
from report.schema import write_workbook
from report.system_loader import SystemData, load_client
from report.trace import attach_findings, build_trace, check_outputs, diff, verify
from tests.test_finance_source import E1, SNAPSHOT


class TraceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        path = Path(cls.tmp.name) / "mock.xlsx"
        write_workbook(str(path), make_mock_data.build_rows(), make_mock_data.NOTES)
        cls.sd = SystemData(str(path))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def graph(self, code, rules=Rules(), edit=None):
        ds = load_client(self.sd, code)
        if edit:
            edit(ds)
        res = compute(ds, rules)
        return ds, res, build_trace(ds, res)

    def test_graph_matches_engine_and_recomputes(self):
        for code in self.sd.clients_for_report():
            ds, res, g = self.graph(code)
            self.assertEqual(check_outputs(g, ds, res), [], code)
            self.assertEqual(verify(g), [], code)

    def test_leaves_point_to_sheet_cells(self):
        ds, res, g = self.graph("AM9001")
        trades = [n for n in g.nodes.values() if n.id.startswith("trade.amount|")]
        self.assertTrue(trades)
        for n in trades:
            self.assertEqual(n.src["sheet"], "申赎记录")
            self.assertIsInstance(n.src["row"], int)
            self.assertGreater(n.src["row"], 1, "行号是 Excel 实际行号，表头之后")
        leaves = g.leaves_under(g.outputs["irr"])
        self.assertTrue(any(i.startswith("trade.amount|") for i in leaves))
        self.assertTrue(all(g.nodes[i].op == "leaf" for i in leaves))

    def test_range_estimate_uses_rule_and_midpoint_changes_values(self):
        def off_center(ds):
            for r in ds.returns["Echo"].values():
                if r.value is None:
                    r.point = r.hi - (r.hi - r.lo) / 4

        _, _, point = self.graph("AM9001", edit=off_center)
        picks = [n for n in point.nodes.values() if n.op == "pick"]
        self.assertTrue(picks, "模拟数据含区间估算")
        self.assertTrue(all(n.params["mode"] == "point" and n.rule == "range_value" for n in picks))

        ds, res, mid = self.graph("AM9001", Rules(range_value="midpoint"), off_center)
        self.assertEqual(verify(mid), [])
        self.assertEqual(check_outputs(mid, ds, res), [])
        changed = {i for i, _, _ in diff(point, mid)}
        self.assertTrue(any(i.startswith("ret.used|") for i in changed))
        self.assertIn("ytd", changed, "推算市值变化会传导到组合收益")
        self.assertNotEqual(point.meta["rules"], mid.meta["rules"])

    def test_findings_attach_to_nodes_and_graph_serializes(self):
        ds, res, g = self.graph("AM9001")
        attach_findings(g, run_checks(ds, res)[0], ds)
        attached = [f for f in g.findings if f["node"]]
        self.assertTrue(attached)
        self.assertTrue(all(f["node"] in g.nodes for f in attached))
        self.assertIn('"schema": "return-report.trace/v1"', json.dumps(g.to_dict(), ensure_ascii=False))

    def test_report_cells_link_to_nodes(self):
        ds, res, g = self.graph("AM9001")
        plain, linked = render_report(ds, res), render_report(ds, res, g)
        self.assertNotIn("data-n=", plain, "不带计算图时输出与原报告一致")
        ids = [i for v in re.findall(r'data-n="([^"]+)"', linked) for i in json.loads(html.unescape(v))]
        self.assertGreater(len(ids), 50)
        self.assertEqual([i for i in ids if i not in g.nodes], [])
        for key in ("ytd", "irr", f"total_nav|{ds.as_of[0]}-{ds.as_of[1]:02d}"):
            self.assertIn(key, ids)

    def test_snapshot_source_points_to_finance_records(self):
        snap = json.loads(json.dumps(SNAPSHOT))
        for i, t in enumerate(snap["transactions"]):
            t.update(id=f"t{i}", source_batch_id="batch-1", source_sheet="交易流水", source_row=i + 2)
        ds = dataset_from_snapshot(snap, E1)
        res = compute(ds)
        g = build_trace(ds, res)
        self.assertEqual(check_outputs(g, ds, res), [])
        self.assertEqual(verify(g), [])
        src = g.nodes["trade.amount|Alpha A|0"].src
        self.assertEqual((src["table"], src["id"], src["batch"], src["row"]), ("finance_transactions", "t0", "batch-1", 2))
        self.assertEqual(g.nodes["price|Alpha A|2026-03"].src["table"], "finance_fund_navs")
        ids = [i for v in re.findall(r'data-n="([^"]+)"', render_report(ds, res, g)) for i in json.loads(html.unescape(v))]
        self.assertIn("nav|Alpha A|2026-03", ids, "基金名含空格时单元格仍指向完整节点")
        self.assertEqual([i for i in ids if i not in g.nodes], [])


if __name__ == "__main__":
    unittest.main()
