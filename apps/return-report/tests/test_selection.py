"""月度收益选值（需求 10.2）：同月多条、正式与估算并存、未标注是否估算。"""
import copy
import unittest

from report.checks import run_checks
from report.engine import compute
from report.finance_source import dataset_from_snapshot, select_returns
from report.trace import build_trace, check_outputs, verify
from tests.test_finance_source import E1, S1, S2, SNAPSHOT


def ret(d, v, label, cls=S1):
    return {"share_class_id": cls, "return_date": d, "mtd_return": v, "estimate_label": label}


def pick(rows):
    return {m: next((c["date"] for c in cs if c["used"]), None) for m, cs in select_returns(rows).items()}


class SelectReturnsTest(unittest.TestCase):
    def test_formal_beats_later_estimate_in_month(self):
        cs = select_returns([ret("2026-02-28", "0.02", "否"), ret("2026-02-20", "0.05", "是")])[(2026, 2)]
        self.assertEqual([(c["date"], c["used"]) for c in cs], [("2026-02-20", False), ("2026-02-28", True)])
        self.assertEqual(cs[1]["reason"], "当月正式值")

    def test_formal_preferred_even_if_estimate_is_later_but_after_latest_formal(self):
        cs = select_returns([ret("2026-02-15", "0.01", "否"), ret("2026-02-28", "0.03", "是")])[(2026, 2)]
        self.assertTrue(cs[0]["used"])
        self.assertEqual(cs[1]["reason"], "当月已有正式值")

    def test_estimates_before_latest_formal_are_dropped(self):
        sel = select_returns([ret("2026-01-31", "0.04", "是"), ret("2026-02-28", "0.02", "否")])
        self.assertEqual(pick([ret("2026-01-31", "0.04", "是"), ret("2026-02-28", "0.02", "否")]),
                         {(2026, 1): None, (2026, 2): "2026-02-28"})
        self.assertEqual(sel[(2026, 1)][0]["reason"], "已有 2026-02-28 的正式值，此前的估算值不再使用")

    def test_latest_estimate_in_month_without_formal(self):
        rows = [ret("2026-03-10", "0.01", "是"), ret("2026-03-31", "0.02", "是"), ret("2026-02-28", "0.02", "否")]
        cs = select_returns(rows)[(2026, 3)]
        self.assertEqual([c["used"] for c in cs], [False, True])
        self.assertEqual(cs[0]["reason"], "当月有更晚的估算值")
        self.assertEqual(cs[1]["reason"], "当月最新估算值")

    def test_unlabelled_never_used(self):
        rows = [ret("2026-03-31", "0.09", None), ret("2026-03-15", "0.01", "是")]
        cs = select_returns(rows)[(2026, 3)]
        self.assertEqual([c["used"] for c in cs], [True, False])
        self.assertEqual(cs[1]["reason"], "未标注是否估算，补填后才参与计算")
        self.assertEqual(pick([ret("2026-03-31", "0.09", None)]), {(2026, 3): None})


class SelectionPipelineTest(unittest.TestCase):
    def snapshot(self, rows):
        snap = copy.deepcopy(SNAPSHOT)
        snap["fund_returns"] = rows
        return snap

    def test_dataset_trace_and_checks(self):
        snap = self.snapshot([ret("2026-02-20", "0.05", "是"), ret("2026-02-27", "0.02", "否"),
                              ret("2026-03-31", "0.07", None), ret("2026-03-31", "-0.01", "是", S2)])
        ds = dataset_from_snapshot(snap, E1)
        self.assertAlmostEqual(ds.returns["Alpha A"][(2026, 2)].value, 0.02)
        self.assertFalse(ds.returns["Alpha A"][(2026, 2)].estimate)
        self.assertNotIn((2026, 3), ds.returns["Alpha A"], "未标注的记录不进入计算")

        res = compute(ds)
        g = build_trace(ds, res)
        self.assertEqual(verify(g), [])
        self.assertEqual(check_outputs(g, ds, res), [])
        node = g.nodes["ret|Alpha A|2026-02"]
        self.assertEqual(node.op, "select")
        self.assertEqual([r.split("：")[0] for r, _ in node.inputs], ["未采用", "采用"])
        self.assertIn("未采用", g.nodes["ret.cand|Alpha A|2026-02|0"].flags)

        findings, _ = run_checks(ds, res)
        sel = [(f.level, f.title) for f in findings if f.category == "收益选值"]
        self.assertIn(("错误", "Alpha A 2026年3月：收益率未标注是否估算"), sel)
        self.assertIn(("提示", "Alpha A 2026年2月：正式收益率日期不在月末"), sel)


if __name__ == "__main__":
    unittest.main()
