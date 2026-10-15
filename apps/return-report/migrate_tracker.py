"""把现有的 Return tracker + 增量表迁移成《数据字段清单》格式的录入表。

tracker 只有客户持仓市值，没有份额，因此按「首次申购单位净值 = 100」反推份额，再用 市值 ÷ 份额 得到
单位净值（黄色=推算）；字段清单要求但 tracker 没有的字段用模拟值补齐（红色=模拟）。

用法：
  python migrate_tracker.py --tracker data/tracker.xlsx --increment data/增量.xlsx
                            --client-code AM0001 --client-name 客户名 --out data/系统数据.xlsx
                            [--overrides local/migration_overrides.json]

overrides（可选，JSON；含真实业务信息，放在已被忽略的 local/ 目录）：
  {
    "share_class": {"基金简称": "股份类别"},
    "bench_category": {"基准名称": "基准分类"},
    "flow_overrides": [{"fund": "基金简称", "month": "2026-06", "amount": -1000000, "note": "说明"}]
  }
flow_overrides 只改变「金额」列（报告口径），确认份额仍按 tracker 中的真实资金流计算。
"""
import argparse
import json
from pathlib import Path

from report.engine import compute
from report.loader import build_dataset
from report.model import month_end, month_start
from report.schema import derived, mock, write_workbook
from report.system_loader import _month

BASE_PRICE = 100.0


def strategy_detail(name_t1: str) -> str:
    for sep in ("（", "("):
        if sep in name_t1:
            return name_t1.split(sep, 1)[1].rstrip("）)")
    return ""


def fund_row(i: int, f, share: str | None) -> dict:
    return {
        "ISIN code": mock(f"KY00MOCK{i:04d}"), "LEI code": mock(f"MOCKLEI{i:013d}"), "基金简称": f.key,
        "基金全称": mock(f"{f.key} Fund Ltd"), "成立日期": mock(month_start((2015 + i % 8, 1 + i % 12))),
        "基金类型": mock("开放式"), "币种": derived("USD"), "股份类别": share, "运行状态": derived("已上架"),
        "基金规模": mock(round(20 + i * 7.5, 1)), "申购开放日": mock("月 / 第一个工作日"),
        "赎回开放日": mock("季 / 最后一个工作日"), "赎回通知期": mock("60 天"),
        "最低初次申购金额": mock("1,000,000 USD"), "最低追加申购金额": mock("100,000 USD"),
        "最低赎回金额": mock("100,000 USD"), "赎回金额限制": mock("25% / 季度 FLG"),
        "追踪负责人": mock("产品组-示例"), "约会、业绩负责人": mock("产品组-示例"), "Amrita Feeder": mock("否"),
        "基金策略": f.strategy, "基金策略详情": strategy_detail(f.name_t1),
        "配置策略": f.risk.removesuffix("型"), "投资地区": f.region,
        "赎回费率": mock("锁定期内赎回 3%"), "管理费率": mock("1.5% / 年"), "业绩费率": mock("20%，高水位"),
        "管理人": mock(f"{f.key} Asset Management"), "基金经理": mock("PM 示例"), "投资者关系": mock("IR 示例"),
        "IR邮箱1": mock(f"ir@{f.key.lower().replace(' ', '').replace('-', '')}.example.com"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tracker", required=True)
    ap.add_argument("--increment", required=True, help="报告参数 + 基金分类 + 新增月份数据，格式见 report/loader.py")
    ap.add_argument("--client-code", required=True)
    ap.add_argument("--client-name", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--overrides")
    args = ap.parse_args()

    ov = json.loads(Path(args.overrides).read_text(encoding="utf-8")) if args.overrides else {}
    share_class = ov.get("share_class", {})
    bench_category = ov.get("bench_category", {})
    flow_ov = {(o["fund"], _month(o["month"])): (o["amount"], o.get("note")) for o in ov.get("flow_overrides", [])}

    ds = build_dataset(args.tracker, args.increment)
    res = compute(ds)

    unit_nav: dict[str, dict] = {}
    txns = []
    for k in ds.fund_keys:
        units, unit_nav[k], seen = 0.0, {}, False
        for idx, m in enumerate(res.months):
            real = ds.flows[k].get(m, 0.0)
            amt, note = flow_ov.get((k, m), (real, None))
            if amt:
                prev = res.months[idx - 1] if idx else None
                price = round(unit_nav[k].get(prev, BASE_PRICE) if units > 0 else BASE_PRICE, 4)
                qty = round(abs(real) / price, 4)
                units += qty if amt > 0 else -qty
                txns.append({
                    "客户编号": args.client_code,
                    "交易类型": "初次申购" if not seen else "追加申购" if amt > 0 else "赎回",
                    "基金": k, "确认日期": derived(month_start(m)), "金额": abs(amt), "币种": derived("USD"),
                    "确认份额": derived(qty), "确认净值": derived(price), "备注": note,
                })
                seen = True
            cell = res.nav[k].get(m)
            if cell and cell.source not in ("推算", "缺失") and units > 0:
                unit_nav[k][m] = round(cell.value / units, 6)

    returns = [{
        "基金简称": k, "日期": month_end(m), "MTD收益率": r.value, "是否预估值": "是" if r.estimate else "否",
        "区间下限": r.lo, "区间上限": r.hi, "估算点值": r.point, "备注": r.note or None,
    } for k in ds.fund_keys for m, r in sorted(ds.returns.get(k, {}).items()) if m <= ds.as_of]

    bench_rows, bench_nav = [], []
    for b in ds.benchmarks:
        bench_rows.append({"基准名称": b, "基准分类": mock(bench_category.get(b, "其他")),
                           "备注": "点位由月度收益反推（起点 100），正式使用时替换为真实收盘价"})
        rs = ds.returns[b]
        start = min(rs)
        level = 100.0
        bench_nav.append({"基准名称": b, "日期": month_end((start[0] - 1, 12) if start[1] == 1 else (start[0], start[1] - 1)),
                          "净值": derived(level)})
        for m in sorted(rs):
            if m <= ds.as_of:
                level *= 1 + rs[m].value
                bench_nav.append({"基准名称": b, "日期": month_end(m), "净值": derived(round(level, 6))})

    client = {
        "客户编号": args.client_code, "投资主体名称": args.client_name, "客户类型": mock("Key Account"),
        "客户类型2": mock("Corporate"), "账户状态": derived("Active"), "签署协议": mock("IAA"),
        "产品": derived("3PFund"), "首次投资日期": derived(month_start(res.months[0])),
        "最近 CDD 批准日期": mock(month_start(res.months[0])), "客户风险评级": mock("Medium"), "是否出月报": "是",
    }
    rows = {
        "三方基金": [fund_row(i + 1, ds.funds[k], share_class.get(k)) for i, k in enumerate(ds.fund_keys)],
        "客户": [client], "申赎记录": txns, "基准": bench_rows, "基准净值": bench_nav,
        "基金净值": [{"基金简称": k, "日期": month_end(m), "单位净值": derived(v)}
                 for k in ds.fund_keys for m, v in sorted(unit_nav[k].items())],
        "基金收益率": returns,
    }
    notes = ["", "份额与单位净值按「首次申购单位净值 = 100」由 tracker 持仓市值反推（黄色），正式使用时请改为对账单上的真实值。"]
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    write_workbook(args.out, rows, notes)
    print("已生成", args.out)


if __name__ == "__main__":
    main()
