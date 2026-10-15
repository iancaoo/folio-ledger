"""生成完全模拟的示例录入表：examples/示例数据_模拟.xlsx

基金、客户、收益率、净值、申赎均为随机生成，与任何真实资料无关。数据中特意放入几处问题，
用于演示校验规则：金额与份额不一致的赎回、客户份额与公布收益的系统性差异、不在枚举中的配置策略、
缺失的必填字段、区间估算。
"""
import random
from pathlib import Path

from report.model import month_end, month_range, month_start
from report.schema import write_workbook

ROOT = Path(__file__).parent
SEED = 20260831
START, AS_OF = (2025, 1), (2026, 8)

# 简称, 策略详情, 股份类别, 配置策略, 投资地区, 基金策略, 月均收益, 月波动, 客户份额相对公布收益的倍数
FUNDS = [
    ("Alpha", "平台型多策略", "Class A", "均衡", "全球", "多策略", 0.010, 0.012, 1.00),
    ("Bravo", "亚洲股票多空", "Class B", "进攻", "泛亚洲", "股票多空", 0.015, 0.045, 1.15),
    ("Cedar", "欧洲股票多空", "Class A", "进攻", "欧洲", "股票多空", 0.014, 0.040, 1.00),
    ("Delta", "科技股票多空", "Class A", "机会", "美国", "股票多空", 0.016, 0.060, 1.00),
    ("Echo", "商品天然气", "Class A", "机会", "美国", "商品", 0.008, 0.050, 1.00),
    ("Fjord", "日本股票多空", "Class A", "进攻", "日本", "股票多空", 0.011, 0.030, 1.00),
    ("Gamma", "混合型母基金", "Class A", "混合", "全球", "多策略", 0.006, 0.015, 1.00),
]
ESTIMATED = {"Alpha", "Delta", "Echo", "Gamma"}
RANGE_ESTIMATE = {"Echo": (0.03, 0.06, 0.045)}
FEE_DRAG = 0.0008

CLIENTS = [("AM9001", "示例客户甲"), ("AM9002", "示例客户乙")]
# 客户编号, 基金, 月份, 金额（赎回为负）, 实际到账金额（用于演示金额与份额不一致）, 备注
TXNS = [
    ("AM9001", "Alpha", (2025, 1), 3_000_000, None, None),
    ("AM9001", "Bravo", (2025, 3), 1_000_000, None, None),
    ("AM9001", "Cedar", (2025, 6), 2_000_000, None, None),
    ("AM9001", "Delta", (2025, 9), 1_500_000, None, None),
    ("AM9001", "Echo", (2026, 1), 1_000_000, None, None),
    ("AM9001", "Fjord", (2026, 3), 1_000_000, None, None),
    ("AM9001", "Alpha", (2026, 5), -500_000, -650_000, "演示：记账金额 500,000，但份额按 650,000 到账计算"),
    ("AM9001", "Gamma", (2026, 8), 1_000_000, None, None),
    ("AM9002", "Alpha", (2025, 2), 2_000_000, None, None),
    ("AM9002", "Delta", (2026, 2), 1_000_000, None, None),
]
BENCHMARKS = [("示例股票指数", "股票", 0.008, 0.040), ("示例债券指数", "债券", 0.002, 0.012)]


NOTES = ["", "本文件全部为随机生成的模拟数据，与任何真实基金、客户或交易无关，可放心提交和分享。"]


def build_rows() -> dict[str, list[dict]]:
    rng = random.Random(SEED)
    months = month_range(START, AS_OF)
    base = (START[0] - 1, 12)

    fund_rows, return_rows, nav_rows, unit_nav = [], [], [], {}
    for i, (key, detail, share, role, region, strategy, mu, vol, beta) in enumerate(FUNDS, 1):
        fund_rows.append({
            "ISIN code": None if key == "Gamma" else f"KY00MOCK{i:04d}", "LEI code": f"MOCKLEI{i:013d}",
            "基金简称": key, "基金全称": f"{key} Mock Fund Ltd", "成立日期": month_start((2018, i)),
            "基金类型": "开放式", "币种": "USD", "股份类别": share, "运行状态": "已上架", "基金规模": 10.0 * i,
            "申购开放日": "月 / 第一个工作日", "赎回开放日": "季 / 最后一个工作日", "赎回通知期": "60 天",
            "最低初次申购金额": "1,000,000 USD", "最低追加申购金额": "100,000 USD", "最低赎回金额": "100,000 USD",
            "赎回金额限制": "25% / 季度 FLG", "追踪负责人": "产品组-示例", "约会、业绩负责人": "产品组-示例",
            "Amrita Feeder": "否", "基金策略": strategy, "基金策略详情": detail, "配置策略": role,
            "投资地区": region, "赎回费率": "锁定期内赎回 3%", "管理费率": "1.5% / 年", "业绩费率": "20%，高水位",
            "管理人": f"{key} Mock Management", "基金经理": "PM 示例", "投资者关系": "IR 示例",
            "IR邮箱1": f"ir@{key.lower()}.example.com",
        })
        nav = 100.0
        unit_nav[key] = {base: nav}
        nav_rows.append({"基金简称": key, "日期": month_end(base), "单位净值": nav})
        for m in months:
            r = round(rng.gauss(mu, vol), 4)
            est = m == AS_OF and key in ESTIMATED
            row = {"基金简称": key, "日期": month_end(m), "MTD收益率": r, "是否预估值": "是" if est else "否"}
            if est and key in RANGE_ESTIMATE:
                lo, hi, point = RANGE_ESTIMATE[key]
                row.update({"MTD收益率": None, "区间下限": lo, "区间上限": hi, "估算点值": point,
                            "备注": "基金经理只给了区间"})
            return_rows.append(row)
            if not est:
                nav *= 1 + beta * r - FEE_DRAG
                unit_nav[key][m] = round(nav, 6)
                nav_rows.append({"基金简称": key, "日期": month_end(m), "单位净值": unit_nav[key][m]})

    txn_rows, seen = [], set()
    for code, fund, m, amt, real, note in TXNS:
        prev = months[months.index(m) - 1] if m != START else base
        price = round(unit_nav[fund][prev], 4)
        first = (code, fund) not in seen
        seen.add((code, fund))
        txn_rows.append({
            "客户编号": code, "交易类型": "赎回" if amt < 0 else "初次申购" if first else "追加申购",
            "基金": fund, "确认日期": month_start(m), "金额": abs(amt), "币种": "USD",
            "确认份额": round(abs(real or amt) / price, 4), "确认净值": price, "备注": note,
        })

    bench_rows, bench_nav = [], []
    for name, cat, mu, vol in BENCHMARKS:
        bench_rows.append({"基准名称": name, "基准分类": cat, "备注": "模拟指数"})
        level = 1000.0
        bench_nav.append({"基准名称": name, "日期": month_end(base), "净值": level})
        for m in months:
            level *= 1 + rng.gauss(mu, vol)
            bench_nav.append({"基准名称": name, "日期": month_end(m), "净值": round(level, 4)})

    client_rows = [{
        "客户编号": code, "投资主体名称": name, "客户类型": "Key Account", "客户类型2": "Individual",
        "账户状态": "Active", "签署协议": "IAA", "产品": "3PFund", "首次投资日期": month_start(START),
        "最近 CDD 批准日期": month_start((2024, 12)), "客户风险评级": "Medium", "是否出月报": "是",
    } for code, name in CLIENTS]

    return {
        "三方基金": fund_rows, "客户": client_rows, "申赎记录": txn_rows, "基准": bench_rows,
        "基准净值": bench_nav, "基金净值": nav_rows, "基金收益率": return_rows,
    }


def main():
    (ROOT / "examples").mkdir(exist_ok=True)
    (ROOT / "templates").mkdir(exist_ok=True)
    out = ROOT / "examples" / "示例数据_模拟.xlsx"
    write_workbook(str(out), build_rows(), NOTES)
    write_workbook(str(ROOT / "templates" / "数据录入模板_空白.xlsx"))
    print("已生成", out.relative_to(ROOT), "和 templates/数据录入模板_空白.xlsx")


if __name__ == "__main__":
    main()
