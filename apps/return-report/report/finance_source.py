"""从 Finance（NocoBase 插件）读取报告快照，组装成与录入表相同的 Dataset。

快照由 `GET /api/finance:reportSnapshot` 在同一个只读事务中返回，计算、校验和渲染沿用原有代码。
只读：本模块不调用任何 Finance 写接口。
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date

from .model import Dataset, Fund, Month, Nav, Return, month_end, to_month

SNAPSHOT_SCHEMA = "finance.report-snapshot/v1"
SNAPSHOT_TABLES = ("transactions", "fund_navs", "fund_returns", "benchmark_values")


class FinanceClient:
    def __init__(self, base_url: str, account: str, password: str, role: str | None = None, timeout: float = 60):
        self.base = base_url.rstrip("/") + "/"
        self.role, self.timeout = role, timeout
        body = self._call("POST", "auth:signIn", {"account": account, "password": password})
        self.token = body["data"]["token"]

    def _call(self, method: str, action: str, payload: dict | None = None, query: dict | None = None) -> dict:
        url = self.base + action + ("?" + urllib.parse.urlencode(query) if query else "")
        headers = {"Content-Type": "application/json", "X-Authenticator": "basic"}
        if getattr(self, "token", None):
            headers["Authorization"] = f"Bearer {self.token}"
        if self.role:
            headers["X-Role"] = self.role
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            try:
                err = json.load(e).get("errors", [{}])[0]
            except Exception:
                err = {}
            raise FinanceApiError(e.code, err.get("code", ""), err.get("message") or str(e), err) from None

    def get(self, action: str, **query) -> dict:
        return self._call("GET", action, query=query)["data"]

    def post(self, action: str, values: dict) -> dict:
        return self._call("POST", action, values)["data"]

    def snapshot(self, report_date: date, client_code: str | None = None, entity_ids: list[str] | None = None) -> dict:
        query = {"report_date": report_date.isoformat()}
        if client_code:
            query["client_code"] = client_code
        if entity_ids:
            query["entity_ids"] = ",".join(entity_ids)
        snap = self.get("finance:reportSnapshot", **query)
        if snap.get("schema") != SNAPSHOT_SCHEMA:
            raise ValueError(f"不支持的快照版本：{snap.get('schema')}")
        return snap


class FinanceApiError(RuntimeError):
    def __init__(self, status: int, code: str, message: str, raw: dict):
        super().__init__(f"Finance {status} {code}: {message}")
        self.status, self.code, self.raw = status, code, raw


def _month(s: str) -> Month:
    return to_month(date.fromisoformat(s[:10]))


def _fund_key(share: dict, siblings: int) -> str:
    """同一主体持有同一基金的多个份额类别时，按份额区分，否则沿用基金简称。"""
    return share["short_name"] if siblings == 1 else f"{share['short_name']} {share['class_label'] or share['isin']}"


def dataset_from_snapshot(snap: dict, entity_id: str, as_of: Month | None = None,
                          benchmark_ids: list[str] | None = None) -> Dataset:
    entity = next((e for e in snap["entities"] if e["id"] == entity_id), None)
    if entity is None:
        raise ValueError(f"快照中没有投资主体 {entity_id}")
    as_of = as_of or _month(snap["report_date"])
    if month_end(as_of) > date.fromisoformat(snap["report_date"]):
        raise ValueError("报告截止月晚于快照日期")

    txns = [t for t in snap["transactions"] if t["entity_id"] == entity_id and _month(t["confirmation_date"]) <= as_of]
    classes = {s["id"]: s for s in snap["share_classes"]}
    held = [classes[i] for i in dict.fromkeys(t["share_class_id"] for t in txns)]
    per_fund = defaultdict(int)
    for s in held:
        per_fund[s["fund_id"]] += 1

    funds, key_of = {}, {}
    for order, s in enumerate(sorted(held, key=lambda s: (s["short_name"], s["class_label"] or ""))):
        k = _fund_key(s, per_fund[s["fund_id"]])
        key_of[s["id"]] = k
        role = (s.get("allocation_role") or "").strip()
        detail, label = s.get("strategy_detail"), s.get("class_label")
        funds[k] = Fund(k, f"{s['short_name']}（{detail}）" if detail else s["short_name"],
                        f"{s['short_name']} - {label}" if label else s["short_name"],
                        role if not role or role.endswith("型") else role + "型",
                        (s.get("investment_region") or "").strip(), (s.get("strategy") or "").strip(), order)

    lineage = {"trades": defaultdict(list), "prices": defaultdict(dict), "returns": defaultdict(dict),
               "bench_levels": defaultdict(list),
               "tags": {key_of[s["id"]]: {col: {"table": "finance_funds", "id": s["fund_id"], "col": field, "value": s.get(field)}
                                          for col, field in (("配置策略", "allocation_role"), ("投资地区", "investment_region"),
                                                             ("基金策略", "strategy"))} for s in held}}

    flows: dict[str, dict[Month, float]] = {k: defaultdict(float) for k in funds}
    unit_moves: dict[str, list[tuple[Month, float]]] = {k: [] for k in funds}
    for t in txns:
        k, m = key_of[t["share_class_id"]], _month(t["confirmation_date"])
        sign = -1 if t["transaction_type"] == "赎回" else 1
        flows[k][m] += sign * float(t["amount"])
        unit_moves[k].append((m, sign * float(t["confirmed_units"])))
        lineage["trades"][k].append({
            "month": m, "sign": sign, "kind": t["transaction_type"], "amount": float(t["amount"]),
            "units": float(t["confirmed_units"]), "date": t["confirmation_date"][:10], "note": t.get("remarks") or "",
            "src_amount": _record("finance_transactions", t, "amount"), "src_units": _record("finance_transactions", t, "confirmed_units")})

    navs: dict[str, dict[Month, Nav]] = {k: {} for k in funds}
    for n in snap["fund_navs"]:
        k, m = key_of.get(n["share_class_id"]), _month(n["nav_date"])
        if k is None or m > as_of:
            continue
        units = sum(q for mm, q in unit_moves[k] if mm <= m)
        if units > 1e-9:
            navs[k][m] = Nav(units * float(n["nav_per_unit"]), "对账单")
        lineage["prices"][k][m] = {"value": float(n["nav_per_unit"]), "src": _record("finance_fund_navs", n, "nav_per_unit")}

    returns: dict[str, dict[Month, Return]] = {k: {} for k in funds}
    rows_by_fund: dict[str, list[dict]] = defaultdict(list)
    for r in snap["fund_returns"]:
        k = key_of.get(r["share_class_id"])
        if k is not None and _month(r["return_date"]) <= as_of:
            rows_by_fund[k].append(r)
    selections: dict[str, dict[Month, list[dict]]] = {}
    for k, rows in rows_by_fund.items():
        selections[k] = {}
        for m, cands in select_returns(rows).items():
            selections[k][m] = [{key: c[key] for key in ("date", "value", "kind", "used", "reason")}
                                | {"src": _record("finance_fund_returns", c["row"], "mtd_return")} for c in cands]
            used = next((c for c in cands if c["used"]), None)
            if used:
                returns[k][m] = Return(value=used["value"], estimate=used["kind"] == "估算", source="基金收益率")
                lineage["returns"][k][m] = {"MTD收益率": _record("finance_fund_returns", used["row"], "mtd_return")}

    # 与 Finance 插件一致：未指定时，只报告在报告月有点位的基准；同月多个点位取最后一个。
    if benchmark_ids:
        chosen = [b for b in snap["benchmarks"] if b["id"] in benchmark_ids]
    else:
        current = {v["benchmark_id"] for v in snap["benchmark_values"] if _month(v["value_date"]) == as_of}
        chosen = [b for b in snap["benchmarks"] if b["id"] in current]
    names = {b["id"]: b["name"] for b in chosen}
    levels: dict[str, dict[Month, float]] = defaultdict(dict)
    level_rows: dict[str, dict[Month, dict]] = defaultdict(dict)
    for v in snap["benchmark_values"]:
        if _month(v["value_date"]) <= as_of and v["benchmark_id"] in names:
            levels[names[v["benchmark_id"]]][_month(v["value_date"])] = float(v["index_value"])
            level_rows[names[v["benchmark_id"]]][_month(v["value_date"])] = v
    benchmarks = list(names.values())
    for b in benchmarks:
        pts = sorted(levels[b].items())
        lineage["bench_levels"][b] = [(m, lv, {"table": "finance_benchmark_values", "id": level_rows[b][m]["benchmark_id"],
                                               "date": level_rows[b][m]["value_date"], "col": "index_value"})
                                      for m, lv in pts]
        returns[b] = {m: Return(value=v / pv - 1, source="基准净值") for (pm, pv), (m, v) in zip(pts, pts[1:])}

    name = entity.get("common_name") or entity["legal_name"]
    ds = Dataset(name, as_of, funds, benchmarks, returns, navs, {k: dict(v) for k, v in flows.items()},
                 client_code=entity["client_code"])
    ds.lineage = {key: dict(v) for key, v in lineage.items()}
    ds.return_selections = selections
    if snap.get("demo_mode"):
        ds.provenance = {("Finance", t, "模拟"): n for t in SNAPSHOT_TABLES
                         if (n := len([r for r in _scoped(snap, t, entity_id, set(key_of), as_of, set(names))]))}
    return ds


def _kind(label) -> str:
    return "正式" if label == "否" else "估算" if label == "是" else "未标注"


def select_returns(rows: list[dict]) -> dict[Month, list[dict]]:
    """月度收益选值（需求 10.2、D06），与插件 report/select.ts 相同：未标注是否估算的记录不用；
    最新正式值日期 D 及之前的估算值不再使用；同月正式值优先，同类取日期最新的一条；不把月内多条连乘。"""
    formal = sorted(r["return_date"][:10] for r in rows if _kind(r.get("estimate_label")) == "正式")
    latest = formal[-1] if formal else None
    by_month: dict[Month, list[dict]] = {}
    for r in sorted(rows, key=lambda r: r["return_date"][:10]):
        d, kind = r["return_date"][:10], _kind(r.get("estimate_label"))
        reason = ""
        if kind == "未标注":
            reason = "未标注是否估算，补填后才参与计算"
        elif kind == "估算" and latest and d <= latest:
            reason = f"已有 {latest} 的正式值，此前的估算值不再使用"
        by_month.setdefault(_month(d), []).append(
            {"date": d, "value": float(r["mtd_return"]), "kind": kind, "used": False, "reason": reason, "row": r})
    for m, cs in by_month.items():
        eligible = [i for i, c in enumerate(cs) if not c["reason"]]
        pool = [i for i in eligible if cs[i]["kind"] == "正式"] or eligible
        chosen = pool[-1] if pool else None
        for i, c in enumerate(cs):
            if i == chosen:
                c["used"], c["reason"] = True, "当月正式值" if c["kind"] == "正式" else "当月最新估算值"
            elif not c["reason"]:
                c["reason"] = "当月已有正式值" if cs[chosen]["kind"] == "正式" and c["kind"] == "估算" else f"当月有更晚的{c['kind']}值"
    return dict(sorted(by_month.items()))


def _record(table: str, row: dict, col: str) -> dict:
    """Finance 记录定位：记录 ID（或业务键），以及导入时的批次、工作表和原文件行号。"""
    key = {"id": row["id"]} if "id" in row else {"share_class_id": row.get("share_class_id"),
                                                 "date": row.get("nav_date") or row.get("return_date")}
    return {"table": table, **key, "col": col, "batch": row.get("source_batch_id"),
            "sheet": row.get("source_sheet"), "row": row.get("source_row")}


def _scoped(snap: dict, table: str, entity_id: str, class_ids: set[str], as_of: Month, benchmark_ids: set[str]):
    date_col = {"transactions": "confirmation_date", "fund_navs": "nav_date",
                "fund_returns": "return_date", "benchmark_values": "value_date"}[table]
    for row in snap[table]:
        if _month(row[date_col]) > as_of:
            continue
        if table == "transactions" and row["entity_id"] != entity_id:
            continue
        if table in ("fund_navs", "fund_returns") and row["share_class_id"] not in class_ids:
            continue
        if table == "benchmark_values" and row["benchmark_id"] not in benchmark_ids:
            continue
        yield row
