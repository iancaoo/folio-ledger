"""计算图：报告上的每个数字都是一个节点，可以逐层回溯到录入表的单元格或 Finance 的记录。

节点分两类：
  原始数据（op = "leaf"）：一个录入值，带来源（工作表 / 行号 / 列名 / 单元格标注，或 Finance 记录与导入批次）；
  计算结果：带运算 op、按角色命名的输入、使用的口径规则和标记（估算、推算、结转……）。
同一个中间值会被多处引用（如期末市值同时进入总净值、持仓比例和 IRR），因此是有向无环图，界面上从任意节点按树展开。

节点 ID 带业务含义（如 nav|Echo|2026-08），口径变化前后两张图可以按 ID 直接比较。
build_trace 按 engine.compute 的同一口径建图；check_outputs 核对图与引擎结果一致，verify 只用节点自身记录的
运算和输入值逐个重算，两者都通过才说明图既忠实于引擎、又可以被独立复核。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from math import prod

from .engine import Result, xirr
from .model import Dataset, Month, month_end, month_label, month_start
from .rules import FORMULAS, RANGE_VALUE

SCHEMA = "return-report.trace/v1"
TOL = 1e-9


def mk(m: Month) -> str:
    return f"{m[0]}-{m[1]:02d}"


@dataclass
class Node:
    id: str
    label: str
    value: object
    unit: str                      # money / pct / units / price / index / text
    op: str = "leaf"
    inputs: list[tuple[str, str]] = field(default_factory=list)   # (角色, 节点 ID)
    params: dict = field(default_factory=dict)
    rule: str | None = None
    flags: list[str] = field(default_factory=list)
    src: dict | None = None
    refs: list[str] = field(default_factory=list)                 # 不参与运算的佐证，如基金分类标签


class Graph:
    def __init__(self, ds: Dataset, res: Result):
        self.nodes: dict[str, Node] = {}
        self.outputs: dict = {}
        self.findings: list[dict] = []
        self.meta = {"client": ds.client, "client_code": ds.client_code, "as_of": mk(ds.as_of),
                     "rules": res.rules.describe()}

    def add(self, node: Node) -> str:
        if node.id in self.nodes:
            raise ValueError(f"重复的节点 {node.id}")
        self.nodes[node.id] = node
        return node.id

    def leaf(self, id, label, value, unit, src=None, flags=()) -> str:
        return self.add(Node(id, label, value, unit, src=src, flags=list(flags)))

    def calc(self, id, label, value, unit, op, inputs, rule, params=None, flags=(), refs=()) -> str:
        return self.add(Node(id, label, value, unit, op, list(inputs), params or {}, rule, list(flags), refs=list(refs)))

    def value(self, id: str):
        return self.nodes[id].value

    def leaves_under(self, id: str) -> list[str]:
        seen, out, stack = set(), [], [id]
        while stack:
            n = self.nodes[stack.pop()]
            if n.id in seen:
                continue
            seen.add(n.id)
            if n.op == "leaf":
                out.append(n.id)
            stack += [i for _, i in n.inputs] + n.refs
        return out

    def to_dict(self) -> dict:
        return {"schema": SCHEMA, "meta": self.meta, "formulas": FORMULAS, "range_rules": RANGE_VALUE,
                "outputs": self.outputs, "findings": self.findings,
                "nodes": {i: {k: v for k, v in n.__dict__.items() if v not in (None, [], {}) or k == "value"}
                          for i, n in self.nodes.items()}}


# ---------------------------------------------------------------- 建图

def build_trace(ds: Dataset, res: Result) -> Graph:
    g = Graph(ds, res)
    L = ds.lineage or {}
    rules = res.rules
    out = g.outputs
    for key in ("fund_ret", "ret_cell", "nav", "flow"):
        out[key] = {}

    # 申赎：每笔交易的金额是原始数据，当月申赎为带符号求和
    trade_units: dict[str, list[tuple[Month, int, str]]] = {}
    flow_id: dict[str, dict[Month, str]] = {}
    for k in ds.fund_keys:
        flow_id[k], trade_units[k] = {}, []
        trades = L.get("trades", {}).get(k)
        by_month: dict[Month, list[tuple[str, int]]] = {}
        for i, t in enumerate(trades or []):
            tag = f"{t['date']} {t['kind']}"
            a = g.leaf(f"trade.amount|{k}|{i}", f"{k} {tag} 金额", t["amount"], "money", t["src_amount"],
                       _flags(t["src_amount"]))
            u = g.leaf(f"trade.units|{k}|{i}", f"{k} {tag} 确认份额", t["units"], "units", t["src_units"],
                       _flags(t["src_units"]))
            by_month.setdefault(t["month"], []).append((a, t["sign"]))
            trade_units[k].append((t["month"], t["sign"], u))
        for m, v in sorted(ds.flows[k].items()):
            fid = f"flow|{k}|{mk(m)}"
            label = f"{k} {month_label(m)} 申赎"
            if trades is None:
                g.leaf(fid, label, v, "money", flags=["无原始交易明细"])
            else:
                items = by_month.get(m, [])
                g.calc(fid, label, v, "money", "sum", [("交易", a) for a, _ in items], "flow",
                       {"coeffs": [s for _, s in items]})
            flow_id[k][m] = fid
        out["flow"][k] = {mk(m): i for m, i in flow_id[k].items()}

    # 收益率：实际值直接是原始数据；只有区间时由口径规则选出用于推算的值
    used_id: dict[str, dict[Month, str]] = {}
    for k in ds.fund_keys:
        used_id[k], out["fund_ret"][k] = {}, {}
        srcs = L.get("returns", {}).get(k, {})
        for m, r in sorted(ds.returns.get(k, {}).items()):
            s = srcs.get(m, {})
            est = ["估算"] if r.estimate else []
            label = f"{k} {month_label(m)} 收益率"
            cands = ds.return_selections.get(k, {}).get(m)
            if r.value is not None and cands and len(cands) > 1:
                ins = [(f"{'采用' if c['used'] else '未采用'}：{c['reason']}",
                        g.leaf(f"ret.cand|{k}|{mk(m)}|{i}", f"{k} {c['date']} 收益率（{c['kind']}）", c["value"], "pct", c["src"],
                               ([] if c["kind"] == "正式" else [c["kind"]]) + ([] if c["used"] else ["未采用"])))
                       for i, c in enumerate(cands)]
                rid = g.calc(f"ret|{k}|{mk(m)}", label, r.value, "pct", "select", ins, "select",
                             {"chosen": next(i for i, c in enumerate(cands) if c["used"])}, est)
                used_id[k][m] = rid
                out["fund_ret"][k][mk(m)] = rid
                continue
            if r.value is not None:
                rid = g.leaf(f"ret|{k}|{mk(m)}", label, r.value, "pct", s.get("MTD收益率"), est + _flags(s.get("MTD收益率")))
                used_id[k][m] = rid
                out["fund_ret"][k][mk(m)] = rid
                continue
            parts = [("下限", g.leaf(f"ret.lo|{k}|{mk(m)}", f"{label}（区间下限）", r.lo, "pct", s.get("区间下限"), est)),
                     ("上限", g.leaf(f"ret.hi|{k}|{mk(m)}", f"{label}（区间上限）", r.hi, "pct", s.get("区间上限"), est))]
            if r.point is not None:
                parts.append(("估算点值", g.leaf(f"ret.point|{k}|{mk(m)}", f"{label}（估算点值）", r.point, "pct",
                                                s.get("估算点值"), est)))
            used_id[k][m] = g.calc(f"ret.used|{k}|{mk(m)}", f"{label}（用于推算）", rules.used_return(r), "pct", "pick",
                                   parts, "range_value", {"mode": rules.range_value}, est + ["区间估算"])
            out["fund_ret"][k][mk(m)] = [p for _, p in parts[:2]]
    out["ret_cell"] = {k: {mk(m): i for m, i in ms.items()} for k, ms in used_id.items()}

    # 市值：有单位净值时 = 份额 × 单位净值；否则按收益率推算或结转
    prices = L.get("prices", {})
    for k in ds.fund_keys:
        out["nav"][k], prev = {}, None
        for m in res.months:
            cell = res.nav[k].get(m)
            if cell is None:
                prev = None
                continue
            nid, label = f"nav|{k}|{mk(m)}", f"{k} {month_label(m)} 市值"
            fl = [("本月申赎", flow_id[k][m])] if m in flow_id[k] else []
            if m in ds.navs[k]:
                px = prices.get(k, {}).get(m)
                if px is None:
                    g.leaf(nid, label, cell.value, "money", flags=[f"来源：{cell.source}"])
                else:
                    moves = [(s, u) for mm, s, u in trade_units[k] if mm <= m]
                    uid = g.calc(f"units|{k}|{mk(m)}", f"{k} {month_label(m)} 持有份额", sum(s * g.value(u) for s, u in moves),
                                 "units", "sum", [("交易份额", u) for _, u in moves], "units", {"coeffs": [s for s, _ in moves]})
                    pid = g.leaf(f"price|{k}|{mk(m)}", f"{k} {month_label(m)} 单位净值", px["value"], "price", px["src"],
                                 _flags(px["src"]))
                    g.calc(nid, label, cell.value, "money", "mul", [("持有份额", uid), ("单位净值", pid)], "nav_statement")
            elif cell.source == "推算":
                ins = ([("上月市值", prev)] if prev else []) + fl + [("本月收益率", used_id[k][m])]
                g.calc(nid, label, cell.value, "money", "nav_roll", ins, "nav_roll", flags=["推算"] + (["估算"] if cell.estimate else []))
            else:
                g.calc(nid, label, cell.value, "money", "carry", ([("上月市值", prev)] if prev else []) + fl, "nav_carry",
                       flags=["缺失", "结转"])
            out["nav"][k][mk(m)] = nid
            prev = nid

    # 组合合计、月度收益、YTD、IRR
    out["total_nav"], out["total_flow"], out["port_ret"] = {}, {}, {}
    prev = None
    for m in res.months:
        tn = g.calc(f"total_nav|{mk(m)}", f"组合 {month_label(m)} 总净值", res.total_nav[m], "money", "sum",
                    [("基金市值", out["nav"][k][mk(m)]) for k in ds.fund_keys if mk(m) in out["nav"][k]], "total")
        tf = g.calc(f"total_flow|{mk(m)}", f"组合 {month_label(m)} 申赎", res.total_flow[m], "money", "sum",
                    [("基金申赎", flow_id[k][m]) for k in ds.fund_keys if m in flow_id[k]], "total")
        if m in res.port_ret:
            g.calc(f"port_ret|{mk(m)}", f"组合 {month_label(m)} 月度收益", res.port_ret[m], "pct", "dietz",
                   ([("上月总净值", prev)] if prev else []) + [("本月总净值", tn), ("本月申赎", tf)], "dietz")
            out["port_ret"][mk(m)] = f"port_ret|{mk(m)}"
        out["total_nav"][mk(m)], out["total_flow"][mk(m)] = tn, tf
        prev = tn
    rm = [m for m in res.report_months if mk(m) in out["port_ret"]]
    out["ytd"] = g.calc("ytd", f"组合 {ds.as_of[0]} YTD", res.ytd, "pct", "chain",
                        [("月度收益", out["port_ret"][mk(m)]) for m in rm], "chain")
    cf = [m for m in res.months if res.total_flow[m]]
    out["irr"] = g.calc("irr", "组合 IRR（投资以来）", res.irr, "pct", "xirr",
                        [("申赎", out["total_flow"][mk(m)]) for m in cf] + [("期末总净值", out["total_nav"][mk(ds.as_of)])],
                        "xirr", {"dates": [month_start(m).isoformat() for m in cf] + [month_end(ds.as_of).isoformat()]})

    # 基金与基准 YTD
    out["fund_ytd"], out["bench_ret"] = {}, {}
    _benchmarks(g, ds, L, out)
    for k in ds.fund_keys + ds.benchmarks:
        rs = [(m, ds.returns.get(k, {})[m]) for m in res.report_months if m in ds.returns.get(k, {})]
        if not rs:
            continue
        y = res.fund_ytd[k]
        src = out["fund_ret"].get(k) or out["bench_ret"].get(k, {})
        est = ["估算"] if y.estimate else []
        if y.lo is None:
            out["fund_ytd"][k] = g.calc(f"fund_ytd|{k}", f"{k} {ds.as_of[0]} YTD", y.value, "pct", "chain",
                                        [("月度收益", src[mk(m)]) for m, _ in rs], "chain", flags=est)
            continue
        ids = []
        for side, val in (("lo", y.lo), ("hi", y.hi)):
            pick = (lambda e: e[0] if side == "lo" else e[1])
            ins = [("月度收益", pick(src[mk(m)]) if isinstance(src[mk(m)], list) else src[mk(m)]) for m, _ in rs]
            ids.append(g.calc(f"fund_ytd.{side}|{k}", f"{k} {ds.as_of[0]} YTD（区间{'下' if side == 'lo' else '上'}限）",
                              val, "pct", "chain", ins, "chain", flags=est + ["区间估算"]))
        out["fund_ytd"][k] = ids

    # 持仓比例、分类分布、投资金额
    total = out["total_nav"][mk(ds.as_of)]
    out["weight"], out["invested"], out["alloc"] = {}, {}, {}
    tags = L.get("tags", {})
    for k in ds.fund_keys:
        nid = out["nav"][k].get(mk(ds.as_of))
        out["weight"][k] = (g.calc(f"weight|{k}", f"{k} 持仓比例", res.weights[k], "pct", "ratio",
                                   [("基金期末市值", nid), ("组合期末总净值", total)], "weight") if nid
                            else g.leaf(f"weight|{k}", f"{k} 持仓比例", 0.0, "pct", flags=["期末无持仓"]))
        out["invested"][k] = g.calc(f"invested|{k}", f"{k} 总计投资金额", res.invested[k], "money", "sum",
                                    [("申赎", i) for i in flow_id[k].values()], "invested")
    for dim, attr, col in (("风险", "risk", "配置策略"), ("地域", "region", "投资地区"), ("策略", "strategy", "基金策略")):
        out["alloc"][dim] = {}
        for tag, w in res.alloc[dim].items():
            members = [k for k in ds.fund_keys if res.weights[k] and getattr(ds.funds[k], attr) == tag]
            refs = []
            for k in members:
                s = tags.get(k, {}).get(col)
                if s:
                    refs.append(g.leaf(f"tag|{k}|{col}", f"{k} {col}", s.get("value"), "text",
                                       {kk: vv for kk, vv in s.items() if kk != "value"}, _flags(s)))
            out["alloc"][dim][tag] = g.calc(f"alloc|{dim}|{tag}", f"{dim}分布：{tag}", w, "pct", "sum",
                                            [("持仓比例", out["weight"][k]) for k in members], "alloc", refs=refs)
    return g


def _benchmarks(g: Graph, ds: Dataset, L: dict, out: dict):
    levels = L.get("bench_levels", {})
    for b in ds.benchmarks:
        out["bench_ret"][b] = {}
        pts = sorted(levels.get(b, []), key=lambda p: (p[0], p[1]))
        if not pts:
            for m, r in sorted(ds.returns.get(b, {}).items()):
                out["bench_ret"][b][mk(m)] = g.leaf(f"ret|{b}|{mk(m)}", f"{b} {month_label(m)} 收益率", r.value, "pct",
                                                    flags=["无点位明细"])
            continue
        ids = [g.leaf(f"bench.level|{b}|{i}", f"{b} {m[0]}-{m[1]:02d} 点位", v, "index", s, _flags(s))
               for i, (m, v, s) in enumerate(pts)]
        for i in range(1, len(pts)):
            m = pts[i][0]
            nid = f"ret|{b}|{mk(m)}"
            g.nodes.pop(nid, None)
            g.calc(nid, f"{b} {month_label(m)} 收益率", ds.returns[b][m].value, "pct", "growth",
                   [("本月末点位", ids[i]), ("上月末点位", ids[i - 1])], "bench")
            out["bench_ret"][b][mk(m)] = nid


def _flags(src: dict | None) -> list[str]:
    tag = (src or {}).get("tag")
    return [tag] if tag else []


# ---------------------------------------------------------------- 校验结果挂到节点

def attach_findings(g: Graph, findings, ds: Dataset) -> None:
    by_label = {(k, month_label((int(m[:4]), int(m[5:])))): i for k, ms in g.outputs["nav"].items() for m, i in ms.items()}
    for f in findings:
        node = by_label.get((f.fund, f.month)) if f.fund and f.month else None
        if node is None and f.fund:
            node = g.outputs["fund_ytd"].get(f.fund) or g.outputs["weight"].get(f.fund)
            node = node[0] if isinstance(node, list) else node
        g.findings.append({"level": f.level, "category": f.category, "title": f.title, "detail": f.detail,
                           "suggestion": f.suggestion, "node": node})


# ---------------------------------------------------------------- 复核

def evaluate(g: Graph, n: Node):
    v = {}
    for role, i in n.inputs:
        v.setdefault(role, []).append(g.value(i))
    xs = [g.value(i) for _, i in n.inputs]
    one = lambda role: v.get(role, [0.0])[0]
    if n.op == "sum":
        return sum(c * x for c, x in zip(n.params.get("coeffs", [1] * len(xs)), xs))
    if n.op == "mul":
        return prod(xs)
    if n.op == "nav_roll":
        return (one("上月市值") + one("本月申赎")) * (1 + one("本月收益率"))
    if n.op == "carry":
        return one("上月市值") + one("本月申赎")
    if n.op == "dietz":
        base = one("上月总净值") + one("本月申赎")
        return (one("本月总净值") - one("上月总净值") - one("本月申赎")) / base
    if n.op == "chain":
        return prod(1 + x for x in xs) - 1
    if n.op == "ratio":
        return xs[0] / xs[1]
    if n.op == "growth":
        return one("本月末点位") / one("上月末点位") - 1
    if n.op == "select":
        return xs[n.params["chosen"]]
    if n.op == "pick":
        if n.params["mode"] == "point" and "估算点值" in v:
            return one("估算点值")
        return (one("下限") + one("上限")) / 2
    if n.op == "xirr":
        from datetime import date
        dates = [date.fromisoformat(d) for d in n.params["dates"]]
        return xirr([(d, -x) for d, x in zip(dates[:-1], xs[:-1])] + [(dates[-1], xs[-1])])
    raise ValueError(f"未知运算 {n.op}")


def _close(a, b) -> bool:
    return abs(a - b) <= TOL * max(1.0, abs(a), abs(b))


def verify(g: Graph) -> list[str]:
    """只用每个节点记录的运算和输入值逐个重算。"""
    bad = []
    for n in g.nodes.values():
        if n.op == "leaf":
            continue
        got = evaluate(g, n)
        tol = 1e-7 if n.op == "xirr" else TOL
        if abs(got - n.value) > tol * max(1.0, abs(got)):
            bad.append(f"{n.id}: 记录 {n.value} / 重算 {got}")
    return bad


def check_outputs(g: Graph, ds: Dataset, res: Result) -> list[str]:
    """图上的输出节点与引擎结果逐项一致。"""
    o, bad = g.outputs, []

    def eq(label, nid, want):
        if not _close(g.value(nid), want):
            bad.append(f"{label}: 图 {g.value(nid)} / 引擎 {want}")

    for m in res.months:
        eq(f"总净值 {mk(m)}", o["total_nav"][mk(m)], res.total_nav[m])
        eq(f"申赎 {mk(m)}", o["total_flow"][mk(m)], res.total_flow[m])
        if m in res.port_ret:
            eq(f"组合收益 {mk(m)}", o["port_ret"][mk(m)], res.port_ret[m])
        for k in ds.fund_keys:
            if m in res.nav[k]:
                eq(f"{k} 市值 {mk(m)}", o["nav"][k][mk(m)], res.nav[k][m].value)
    eq("YTD", o["ytd"], res.ytd)
    if abs(g.value(o["irr"]) - res.irr) > 1e-9:
        bad.append(f"IRR: 图 {g.value(o['irr'])} / 引擎 {res.irr}")
    for k in ds.fund_keys:
        eq(f"{k} 持仓比例", o["weight"][k], res.weights[k])
        eq(f"{k} 投资金额", o["invested"][k], res.invested[k])
    for k, nid in o["fund_ytd"].items():
        y = res.fund_ytd[k]
        if isinstance(nid, list):
            eq(f"{k} YTD 下限", nid[0], y.lo)
            eq(f"{k} YTD 上限", nid[1], y.hi)
        else:
            eq(f"{k} YTD", nid, y.value)
    for dim, gs in res.alloc.items():
        for tag, w in gs.items():
            eq(f"{dim}/{tag}", o["alloc"][dim][tag], w)
    return bad


def diff(a: Graph, b: Graph, tol: float = 1e-9) -> list[tuple[str, object, object]]:
    """两张图（如两套口径）按节点 ID 比较，返回值发生变化的节点。"""
    out = []
    for i in sorted(set(a.nodes) | set(b.nodes)):
        va, vb = (a.nodes[i].value if i in a.nodes else None), (b.nodes[i].value if i in b.nodes else None)
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
            if abs(va - vb) > tol * max(1.0, abs(va)):
                out.append((i, va, vb))
        elif va != vb:
            out.append((i, va, vb))
    return out
