"""按《数据字段清单》格式的录入表生成客户月报。

用法：
  python run.py                          给「客户」表中「是否出月报 = 是」的所有客户生成报告
  python run.py --client AM9001          只生成一个客户
  python run.py --as-of 2026-08          指定报告截止月份（默认取基金收益率中最新的月份）
  python run.py --data 其他录入表.xlsx
"""
import argparse
import json
from pathlib import Path

from report.checks import run_checks, to_dicts
from report.engine import compute
from report.model import month_end
from report.render import render_checks, render_report
from report.system_loader import SystemData, _month, load_client

ROOT = Path(__file__).parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(ROOT / "examples" / "示例数据_模拟.xlsx"))
    ap.add_argument("--client", action="append")
    ap.add_argument("--as-of")
    args = ap.parse_args()

    sd = SystemData(args.data)
    as_of = _month(args.as_of) if args.as_of else None
    out = ROOT / "output"
    out.mkdir(exist_ok=True)

    for code in args.client or sd.clients_for_report():
        ds = load_client(sd, code, as_of)
        res = compute(ds)
        findings, summary = run_checks(ds, res)
        tag = f"{code}_{month_end(ds.as_of):%Y%m%d}"
        (out / f"投资组合回顾_{tag}.html").write_text(render_report(ds, res), encoding="utf-8")
        (out / f"校验报告_{tag}.html").write_text(render_checks(ds, res, findings, summary), encoding="utf-8")
        (out / f"校验结果_{tag}.json").write_text(json.dumps(to_dicts(findings), ensure_ascii=False, indent=2),
                                               encoding="utf-8")
        counts = {lv: sum(f.level == lv for f in findings) for lv in ("错误", "警告", "提示")}
        print(f"{code} {ds.client}: YTD {res.ytd:.2%}  IRR {res.irr:.2%}  总净值 {res.total_nav[ds.as_of]:,.0f}  "
              f"校验 错误{counts['错误']} 警告{counts['警告']} 提示{counts['提示']}")
    print("输出目录：", out)


if __name__ == "__main__":
    main()
