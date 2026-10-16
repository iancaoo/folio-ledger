# Return Report（客户月报计算原型）

> 正式的客户月报已经移进 Finance 插件（见下文「系统内月报」）。这里的 Python 代码保留为原型、Excel 迁移工具和计算一致性的参照。

Finance 系统第二阶段「Return Tracker 报告计算」的原型：读取按《数据字段清单》录入的数据，为每个需要出月报的客户生成「投资组合回顾」报告，同时出一份校验报告。

输入有两种：Excel 录入表（表结构和 `schema/field-catalog.json` 对应的字段清单一致），或者直接从 Finance 系统读取（见下文「接入 Finance」）。两种输入都组装成同一个 `Dataset`，计算、校验和渲染部分共用。

## 快速开始

```bash
cd apps/return-report
pip install -r requirements.txt
python make_mock_data.py          # 重新生成 examples/ 下的模拟数据和 templates/ 下的空白模板
python run.py                     # 默认读 examples/示例数据_模拟.xlsx，输出到 output/
python -m unittest discover -s tests -t .
```

`run.py` 参数：`--data 录入表.xlsx`、`--client AM9001`（可重复；不填则处理「是否出月报 = 是」的所有客户）、`--as-of 2026-08`（默认取基金收益率中最新的月份）。

每个客户输出三个文件：`投资组合回顾_{客户编号}_{日期}.html`、`校验报告_….html`、`校验结果_….json`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `report/schema.py` | 录入表结构（9 张表），字段名与字段清单一致；生成模板 |
| `report/system_loader.py` | 读录入表，按客户组装计算数据 |
| `report/finance_source.py` | 调用 Finance 的 `finance:reportSnapshot`，把快照组装成同样的计算数据 |
| `seed_finance.py` | 把模拟录入表通过 Finance 领域接口写入演示库 |
| `report/engine.py` | 净值推算、组合收益、YTD、IRR、持仓分布 |
| `report/checks.py` | 规则校验，输出错误 / 警告 / 提示 |
| `report/render.py` | 报告和校验报告的 HTML |
| `report/loader.py` | 读取旧版 Return tracker（仅迁移用） |
| `migrate_tracker.py` | 把现有 tracker 迁移成录入表 |
| `make_mock_data.py` | 生成模拟示例数据 |
| `templates/数据录入模板_空白.xlsx` | 空白录入模板 |
| `examples/示例数据_模拟.xlsx` | 模拟示例数据 |

## 录入表

录入表共 9 张：三方基金、自营基金、自营基金_成分基金、客户、申赎记录、基准、基准净值、基金净值、基金收益率。

表头颜色的含义：

- 深蓝：字段清单中的必填字段。
- 浅蓝：字段清单中的选填字段。
- 绿色：关联键。字段清单里由页面上下文隐含（例如在客户页面里录入申赎），录入表里要显式填写，如申赎记录的「客户编号」。
- 橙色：建议新增的字段。生成月报需要，但字段清单里还没有：客户的「是否出月报」，以及基金收益率的「区间下限」「区间上限」「估算点值」「备注」。

数据单元格颜色的含义：无底色是真实数据；黄色是推算数据，由真实数据换算得到；红色是模拟数据，目前没有来源，正式使用前必须替换。校验报告会统计每张表里推算和模拟数据的数量。

## 计算口径

- 持有市值 = 持有份额 × 单位净值，持有份额 = Σ申购份额 − Σ赎回份额。没有单位净值的月份按「(上月市值 + 本月申赎) × (1 + MTD收益率)」推算。只有区间估算时，优先用估算点值，没有点值就用区间中点。
- 组合月度收益采用 Modified Dietz 方法，资金视为月初投入：(NAVt − NAVt-1 − Ft) / (NAVt-1 + Ft)。
- YTD 是当年各月收益的连乘。单只基金如果某个月只有区间估算，YTD 也显示为区间。
- IRR 与 Excel XIRR 口径相同：申赎记在确认月的月初，期末市值记在截止日。
- 持仓分布按配置策略、投资地区、基金策略分别汇总权重。
- 基准收益 = 本月末点位 / 上月末点位 − 1。

## 校验规则

| 类别 | 内容 |
| --- | --- |
| 净值勾稽 | 每只基金的客户实际收益（由市值和申赎推出）与基金公布的 MTD 收益比对；先用回归识别稳定的系统性差异（如份额类别不同），剩余的偏差超过阈值时报错或警告 |
| 必填字段 / 基金标签 | 必填字段缺失；配置策略、地区、策略不在字段清单的枚举中 |
| 估算数据 / 数据来源 | 当月仍为估算的基金；推算、模拟数据的数量 |
| 合计 / 缺失 / 大幅波动 | 分布合计是否为 100%；缺少收益率导致市值无法推算；单月涨跌超过 15% |

阈值在 `report/config.py` 中配置。模拟数据中故意放入了几处问题，用来演示这些规则：Alpha 有一笔赎回金额与份额不一致（错误），Bravo 的客户份额与公布收益存在系统性差异，Gamma 的配置策略填了不在枚举中的「混合」，Gamma 缺少 ISIN，Echo 只有区间估算。

## 接入 Finance

Finance 插件提供只读接口 `GET finance:reportSnapshot?report_date=2026-08-31&client_code=AM9001`（也可以用 `entity_ids=id1,id2`，最多 50 个）。接口在一个 REPEATABLE READ 只读事务里，一次读出所选投资主体截至报告日的所有交易，以及相关的份额类别、基金、净值、收益率、基准和基准点位，所以不会出现分页读取时混入不同版本数据的情况。数值都以字符串返回，保留数据库里的精度。Finance 的只读、录入和配置角色都可以调用。报告服务只读这个接口，不写任何业务表。

```bash
# Finance 在演示模式下运行时，把模拟录入表写进去（只能写演示库，可以重复执行）
python seed_finance.py --data examples/示例数据_模拟.xlsx
# 从 Finance 读数据出报告，输出文件名带 _finance 后缀
python run.py --source finance --client AM9001 --as-of 2026-08
# 端到端核对：写入 Finance 后读回，结果和直接读 Excel 逐项比对
FINANCE_LIVE=1 python -m unittest discover -s tests -t .
```

接口地址默认是 `http://127.0.0.1:13000/api/`，可以用 `--api` 或环境变量 `FINANCE_API` 修改。账号取自 `FINANCE_ACCOUNT` / `FINANCE_PASSWORD`，没设置时读开发环境的 `.runtime/dev-credentials.json`。需要指定角色时设置 `FINANCE_ROLE`。

用模拟数据核对过，两条路径算出的月度净值、申赎、组合收益、YTD、IRR、持仓分布和各基金 YTD 完全一致。校验结果有三处差别，都可以解释：

- ISIN 必填检查移到了录入环节。Finance 录入时就要求 ISIN，种子脚本给缺 ISIN 的 Gamma 补了 `MOCK-NO-ISIN-…`。
- 演示模式下的数据在校验报告里统一标为模拟数据。
- Finance 没有收益率区间字段，Echo 的区间估算只能存估算点值，报告里的区间显示不出来。

基准的选取规则两边相同：指定了 `benchmark_ids` 就用指定的；没有指定时，取报告月有点位的基准。同一个月有多个点位时，取最后一个作为月末点位。

## 系统内月报

Finance 插件的「报告中心 → 生成与记录」页面（也可以在投资主体列表点「月报」进入）。计算代码在 `apps/nocobase/packages/plugins/@finance/plugin-core/src/server/report/`，口径与本目录的 Python 版本相同。

1. **生成**：按投资主体或客户编号选择范围，填报告月份，可选指定基准。每个主体生成一条 `finance_report_runs` 记录，在后台队列里计算。应用重启后，未完成的任务会自动继续。
2. **追溯**：计算前在只读事务里读一次 `reportSnapshot`，整份快照连同 SHA-256、读取时间和计算版本存进记录，可以随时下载。报告 HTML 和校验报告 HTML 也一起保存，以后数据改了，已生成的报告不会变。
3. **复核与发布**：在线查看月报和校验结果。未发布的月报带「草稿」水印。有「错误」级校验时，发布必须填写复核说明。同一主体同一月份再次发布时，旧版本标为「已替代」。计算失败的任务可以重试。

权限沿用 Finance 角色：只读、录入、配置角色可以查看；录入角色可以生成和发布。月报接口只能通过 `finance:requestReports`、`finance:publishReport` 等领域接口写入，通用表接口会被拒绝。

系统版本比原型多一项「币种」校验：主体持有多种币种时，报告标为错误，不会把不同币种直接相加。

`FINANCE_LIVE=1` 的测试里，`test_plugin_report_matches_python_engine` 会让插件生成一份月报，下载它的数据快照，再用 Python 重算并逐项比对。

Finance 字段与月报需要的字段还有这些差距：

| 月报需要 | Finance 现状 |
| --- | --- |
| 收益率区间下限、上限、估算点值 | 只有 MTD 收益率和「是否估算」 |
| 客户「是否出月报」 | 没有，生成时手动选择主体或客户编号 |
| 多币种换算 | 没有汇率表，多币种主体只报错，不换算 |
| 配置策略「混合」 | 不在枚举中，录入时会被拒绝（演示模式不校验） |
| 每个值的来源（真实 / 推算 / 模拟） | 只有导入批次和来源行号 |

## 真实数据

真实资料不进仓库。`data/`、`local/`、`output/` 已加入 `.gitignore`，tracker、迁移后的录入表、迁移参数和生成的报告都放在这几个目录里。

把现有 tracker 迁移成录入表：

```bash
python migrate_tracker.py --tracker data/tracker.xlsx --increment data/增量.xlsx \
    --client-code AM0001 --client-name 客户名 --out data/系统数据.xlsx \
    --overrides local/migration_overrides.json
python run.py --data data/系统数据.xlsx
```

tracker 只有持仓市值、没有份额，迁移时按「首次申购单位净值 = 100」反推份额和单位净值，这些值标为黄色。字段清单要求但 tracker 里没有的字段用模拟值补齐，标为红色。`--overrides` 用于补充股份类别、基准分类，以及与 tracker 口径不同的申赎金额，格式见脚本开头的说明。

用一份真实月报做过核对，83 项数字中 76 项一致。其余 7 项是原报告自身前后矛盾：5 只基金的 YTD 与同一份报告里的月度收益连乘结果不一致，另有一只基金的地区标签前后不一致。

## 待业务确认

- 赎回金额按实际到账金额记，还是按申请金额记（两种口径会影响 IRR 和净值勾稽）。
- 基金只给出区间估算时，用于推算市值的点值由谁提供。
- 「是否出月报」以及收益率区间字段是否加入字段清单。
- 基准指数点位的来源和更新频率。
- 基金 YTD 用月度收益连乘，还是用基金公布的 YTD。
- 母基金（FOHF）的地区标签怎么填。
- 第一张表用基金公布的收益率，还是用客户份额实际的收益率。
