"""把模拟录入表写入本地 Finance（仅限 FINANCE_DEMO_MODE=true 的演示环境）。

走 Finance 的正式写接口（saveFund / saveEntity / saveTrade / saveSeries / saveBenchmark），
请求标识固定，重复运行不会重复写入。字段清单要求、但录入表里没有的必填项用「模拟值」补齐。

用法：
  python seed_finance.py                       默认读 examples/示例数据_模拟.xlsx
  python seed_finance.py --data 其他录入表.xlsx
"""
from __future__ import annotations

import argparse
import json
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

from report.finance_source import FinanceClient
from report.system_loader import SystemData

ROOT = Path(__file__).parent
REPO = ROOT.parent.parent
CATALOG = json.loads((REPO / "schema" / "field-catalog.json").read_text(encoding="utf-8"))["fields"]
TECHNICAL = {"id", "technical_revision", "business_version", "saved_at", "is_deleted", "is_void"}
KEY_PREFIX = "return-report-mock-v1"


def required_samples(table: str, sheet: str | None = None, user_id: str = "1") -> dict:
    """与 tests/fixtures.ts 的 sampleValues 相同：给字段清单中的必填项填上明确标注的模拟值。"""
    out = {}
    for src in CATALOG:
        if src["logical_table"] != table or not src["required"]:
            continue
        if sheet and src["source_sheet"] in ("三方基金页面", "自营基金页面") and src["source_sheet"] != sheet:
            continue
        for part in src["mapping"].split("；")[0].split(" + "):
            owner, _, name = part.rpartition(".")
            if owner and owner != table or name in TECHNICAL:
                continue
            kind = src["source_type"]
            out[name] = (user_id if name.endswith("_user_id") else {"value": "10", "unit": "模拟单位"} if name == "gate_raw"
                         else "1" if kind.startswith("数值") else "2026-01-01" if kind == "日期" else "模拟值")
    return out


def dec(v) -> str:
    return format(Decimal(str(v)).normalize(), "f")


def day(v) -> str:
    return (v.date() if isinstance(v, datetime) else v).isoformat() if isinstance(v, (date, datetime)) else str(v)[:10]


def credentials() -> tuple[str, str]:
    c = json.loads((REPO / ".runtime" / "dev-credentials.json").read_text())
    return c["admin_email"], c["admin_password"]


class Seeder:
    def __init__(self, api: FinanceClient):
        self.api = api
        self.notes: list[str] = []

    def save(self, action: str, key: str, values: dict) -> dict:
        return self.api.post(f"finance:{action}", {**values, "request_key": f"{KEY_PREFIX}-{key}"})

    def run(self, sd: SystemData) -> dict:
        meta = self.api.get("finance:metadata")
        if not meta.get("demo_mode"):
            raise SystemExit("目标 Finance 不是演示环境（FINANCE_DEMO_MODE=true），拒绝写入模拟数据。")
        user = str(meta["current_user_id"])

        bench = {}
        for r, _ in sd.sheets["基准"]:
            name = str(r["基准名称"]).strip()
            row = self.save("saveBenchmark", f"benchmark-{name}",
                            {"values": {"name": name, "category": r.get("基准分类"), "remarks": r.get("备注")}})
            bench[name] = row["id"]

        classes = {}
        for r, _ in sd.sheets["三方基金"]:
            k = str(r["基金简称"]).strip()
            isin = r.get("ISIN code")
            if not isin:
                isin = f"MOCK-NO-ISIN-{k}"
                self.notes.append(f"{k} 在录入表中缺少 ISIN；Finance 要求 ISIN 唯一且必填，已用 {isin} 代替。")
            fund = {**required_samples("funds", "三方基金页面", user), "short_name": k,
                    "full_name": r.get("基金全称") or k, "lei": r.get("LEI code") or f"MOCK-LEI-{k}",
                    "strategy": r.get("基金策略"), "strategy_detail": r.get("基金策略详情"),
                    "allocation_role": r.get("配置策略"), "investment_region": r.get("投资地区")}
            share = {**required_samples("share_classes", "三方基金页面", user), "isin": isin,
                     "class_label": r.get("股份类别"), "currency": r.get("币种") or "USD"}
            saved = self.save("saveFund", f"fund-{k}", {
                "fund_kind": "third_party", "fund": fund,
                "details": required_samples("third_party_fund_details", "三方基金页面", user),
                "share_classes": [{"values": share, "terms": required_samples("third_party_class_terms", "三方基金页面", user)}]})
            classes[k] = self.api.get("finance:fund", id=saved["fund_id"])["share_classes"][0]["id"]

        entities = {}
        for r, _ in sd.sheets["客户"]:
            code = str(r["客户编号"]).strip()
            entity = {**required_samples("investment_entities", user_id=user),
                      "legal_name": r["投资主体名称"], "common_name": r.get("常用名")}
            if r.get("最近 CDD 批准日期"):
                entity["latest_cdd_approval_date"] = day(r["最近 CDD 批准日期"])
            entities[code] = self.save("saveEntity", f"entity-{code}",
                                       {"client_code": code, "entity": entity, "agreements": ["n/a"], "products": []})["id"]

        for r, _ in sd.sheets["基准净值"]:
            name = str(r["基准名称"]).strip()
            self.series("benchmark", f"bv-{name}-{day(r['日期'])}",
                        {"benchmark_id": bench[name], "value_date": day(r["日期"]), "index_value": dec(r["净值"])})
        for r, _ in sd.sheets["基金净值"]:
            k = str(r["基金简称"]).strip()
            self.series("nav", f"nav-{k}-{day(r['日期'])}",
                        {"share_class_id": classes[k], "nav_date": day(r["日期"]), "nav_per_unit": dec(r["单位净值"])})
        for r, _ in sd.sheets["基金收益率"]:
            k, d = str(r["基金简称"]).strip(), day(r["日期"])
            value = r.get("MTD收益率")
            if value in (None, ""):
                value = r.get("估算点值")
                if value in (None, "") and r.get("区间下限") not in (None, ""):
                    value = (float(r["区间下限"]) + float(r["区间上限"])) / 2
                self.notes.append(f"{k} {d[:7]} 只有区间估算 {r.get('区间下限')}~{r.get('区间上限')}；"
                                  f"Finance 没有区间字段，已按点值 {value} 写入 MTD 收益率。")
            self.series("returns", f"ret-{k}-{d}", {"share_class_id": classes[k], "return_date": d,
                                                    "mtd_return": dec(value), "estimate_label": r.get("是否预估值") or None})

        txns = sorted(sd.sheets["申赎记录"], key=lambda rt: (day(rt[0]["确认日期"]), rt[0]["交易类型"] == "赎回"))
        for i, (r, _) in enumerate(txns):
            code, k = str(r["客户编号"]).strip(), str(r["基金"]).strip()
            values = {"entity_id": entities[code], "share_class_id": classes[k], "transaction_type": r["交易类型"],
                      "confirmation_date": day(r["确认日期"]), "amount": dec(r["金额"]), "currency": r.get("币种") or "USD",
                      "confirmed_units": dec(r["确认份额"]), "remarks": r.get("备注")}
            if r.get("确认净值") not in (None, ""):
                values["confirmed_nav"] = dec(round(float(r["确认净值"]), 4))
            self.save("saveTrade", f"trade-{code}-{k}-{day(r['确认日期'])}-{i}", {"values": values})
        return {"benchmarks": bench, "share_classes": classes, "entities": entities}

    def series(self, data_type: str, key: str, values: dict) -> None:
        self.save("saveSeries", key, {"data_type": data_type, "values": values, "expected_revision": None})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "examples" / "示例数据_模拟.xlsx"))
    ap.add_argument("--api", default="http://127.0.0.1:13000/api/")
    args = ap.parse_args()
    account, password = credentials()
    seeder = Seeder(FinanceClient(args.api, account, password, role="root"))
    ids = seeder.run(SystemData(args.data))
    print(f"已写入：{len(ids['share_classes'])} 只基金、{len(ids['entities'])} 个投资主体、{len(ids['benchmarks'])} 个基准。")
    for note in seeder.notes:
        print("说明：", note)


if __name__ == "__main__":
    main()
