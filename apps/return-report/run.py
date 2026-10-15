"""按《数据字段清单》格式的录入表，或直接从 Finance，生成客户月报。

用法：
  python run.py                          给「客户」表中「是否出月报 = 是」的所有客户生成报告
  python run.py --client AM9001          只生成一个客户
  python run.py --as-of 2026-08          指定报告截止月份（默认取基金收益率中最新的月份）
  python run.py --data 其他录入表.xlsx
  python run.py --source finance --client AM9001 --as-of 2026-08
                                         从本地 Finance 读取报告快照（客户编号下的每个投资主体各出一份）
"""
import argparse
import json
import os
from pathlib import Path

from report.checks import run_checks, to_dicts
from report.engine import compute
from report.model import Dataset, month_end
from report.render import render_checks, render_report
from report.system_loader import SystemData, _month, load_client

ROOT = Path(__file__).parent
REPO = ROOT.parent.parent


def excel_datasets(args) -> list[Dataset]:
    sd = SystemData(args.data)
    as_of = _month(args.as_of) if args.as_of else None
    return [load_client(sd, code, as_of) for code in args.client or sd.clients_for_report()]


def finance_datasets(args) -> list[Dataset]:
    from report.finance_source import FinanceClient, dataset_from_snapshot

    if not args.client or not args.as_of:
        raise SystemExit("--source finance 需要 --client 和 --as-of；Finance 中还没有「是否出月报」字段。")
    account, password = os.environ.get("FINANCE_ACCOUNT"), os.environ.get("FINANCE_PASSWORD")
    if not account:
        creds = json.loads((REPO / ".runtime" / "dev-credentials.json").read_text())
        account, password = creds["admin_email"], creds["admin_password"]
    api = FinanceClient(args.api, account, password, role=os.environ.get("FINANCE_ROLE"))
    as_of = _month(args.as_of)
    out = []
    for code in args.client:
        snap = api.snapshot(month_end(as_of), client_code=code)
        out += [dataset_from_snapshot(snap, e["id"], as_of) for e in snap["entities"]]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["excel", "finance"], default="excel")
    ap.add_argument("--data", default=str(ROOT / "examples" / "示例数据_模拟.xlsx"))
    ap.add_argument("--api", default=os.environ.get("FINANCE_API", "http://127.0.0.1:13000/api/"))
    ap.add_argument("--client", action="append")
    ap.add_argument("--as-of")
    args = ap.parse_args()

    out = ROOT / "output"
    out.mkdir(exist_ok=True)
    for ds in (finance_datasets if args.source == "finance" else excel_datasets)(args):
        res = compute(ds)
        findings, summary = run_checks(ds, res)
        tag = f"{ds.client_code}_{month_end(ds.as_of):%Y%m%d}" + ("_finance" if args.source == "finance" else "")
        (out / f"投资组合回顾_{tag}.html").write_text(render_report(ds, res), encoding="utf-8")
        (out / f"校验报告_{tag}.html").write_text(render_checks(ds, res, findings, summary), encoding="utf-8")
        (out / f"校验结果_{tag}.json").write_text(json.dumps(to_dicts(findings), ensure_ascii=False, indent=2),
                                               encoding="utf-8")
        counts = {lv: sum(f.level == lv for f in findings) for lv in ("错误", "警告", "提示")}
        print(f"{ds.client_code} {ds.client}: YTD {res.ytd:.2%}  IRR {res.irr:.2%}  总净值 {res.total_nav[ds.as_of]:,.0f}  "
              f"校验 错误{counts['错误']} 警告{counts['警告']} 提示{counts['提示']}")
    print("输出目录：", out)


if __name__ == "__main__":
    main()
