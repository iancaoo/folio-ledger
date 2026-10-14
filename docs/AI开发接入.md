# NocoBase CLI 与 Skills 接入

2026-10-14：已连接现有 Finance 开发实例。此次接入没有升级应用、重建数据库或更改业务页面。

## 本机配置

| 项目 | 当前值 |
| --- | --- |
| 独立 CLI | `@nocobase/cli@2.2.24`，全局命令 `nb` |
| 应用版本 | NocoBase 2.2.24 |
| CLI 环境 | `finance-local`，HTTP 连接模式 |
| API 地址 | `http://127.0.0.1:13000/api` |
| 认证 | 现有开发管理员 basic 登录；CLI 保存会话 token |
| 官方 Skills | `@nocobase/skills@2.0.58`，20 项，已迁移为项目内文件 |
| Skills 位置 | 项目内 `.agents/skills/nocobase-*`，不再全局加载 |
| CLI 配置 | `~/.nocobase/config.json`，权限 600；父目录权限 700 |

凭据未写入项目文档或 Git。CLI 配置不应复制进交接包。开发管理员权限仅用于本机开发，不代表生产 AI 账号的权限方案。

## 日常使用

```sh
nb env list
nb env use finance-local
nb env info finance-local
nb api pm get --filter-by-tk @finance/plugin-core -j
nb api --help
```

认证过期时执行 `nb env auth finance-local`，按提示重新登录。不要把密码直接写入文档或提交到仓库。

这是对已有实例的 HTTP 接入，CLI 未接管本地进程或 PostgreSQL 生命周期。启动与停止仍按项目 README 的现有脚本执行；不要直接对该 HTTP 环境运行 `nb app upgrade/down`。

Skills 已按用户要求从全局目录迁入本项目，文件内容及哈希保持一致；项目级清单查询识别到 20 项，全局清单为 0 项。来源版本和文件哈希保存在 `.agents/nocobase-skills-source.json`。旧全局安装记录已归档到 `.runtime/skills-global-migration/`。不要执行 `nb skills install/update`：当前 CLI 的这两个命令会全局安装；后续更新必须保持项目范围。

CLI 程序及认证配置仍在原来的全局位置，本次只迁移 Skills。已加载旧 Skills 的会话可能保留当轮上下文；重新打开项目会话可重新发现本地路径。可以提出：“在 finance-local 环境中，使用 NocoBase 官方 Skills 检查页面配置能力，并为一个普通主数据列表设计原生可视化页面。”

## 本次验证与边界

| 验证 | 结果 |
| --- | --- |
| `nb env add` 连接并登录 | 成功；环境 ready，运行时版本 2.2.24 |
| `nb skills install --yes --json` | 安装 20 项 Skills，版本 2.0.58 |
| `nb skills check --json` | `installed=true`、`managedByNb=true`、`updateAvailable=false` |
| `nb api pm get --filter-by-tk @finance/plugin-core -j` | Finance 0.1.0 已安装、已启用、兼容 |
| `nb api flow-surfaces catalog --body '{}' -j` | 原生页面能力目录成功返回 |
| collection-manager 查询 `finance_` 集合 | 返回空列表；不能据此认定插件业务表不存在 |
| 通用 resource 读取 `finance_funds` | 403 / `DOMAIN_API_REQUIRED`，符合业务接口保护 |
| `nb portal list -j` | 当前 CLI 无此命令；不能宣称新版 Multi-portal Skills 流程已通过 |

官方 Skills 仍标注草稿，其内容可能比固定的 CLI/应用版本更前沿。执行时先以当前 CLI 帮助、实例返回的能力和项目约束为准。此次验证确认了认证、命令发现、插件读取与原生页面能力目录；尚未验证原生页面“AI 创建→人工修改→AI 继续修改”的完整闭环。

当前 Finance 页面仍是自定义 React 插件。接入 Skills 不会自动将其转换为原生可视化页面。Finance 业务数据继续通过 `finance:*` 领域接口处理；不能为了使用通用 CLI 而移除业务校验、开放直接 CRUD，或重复创建同名集合。当前运行时命令目录未提供 Finance 自定义业务动作的专用命令。

下一步适合在独立试验页面验证原生列表／表单，然后决定哪些页面迁移到原生配置。交易校验、精度、幂等和导入提交继续保留在服务端业务插件中。

## 接入依据

- [官方 AI Agent 接入指南](https://docs.nocobase.com/ai/quick-start)
- [官方 Skills 仓库](https://github.com/nocobase/skills)
- 实际执行路径：安装固定版本 CLI → `nb env add` 连接现有 API → `nb skills install` → 只读命令验证。未使用新应用安装流程。
