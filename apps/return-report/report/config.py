ALLOWED_ROLES = ["均衡", "进攻", "机会", "现金管理"]
ALLOWED_REGIONS = ["全球", "美国", "欧洲", "大中华", "泛亚洲", "韩国", "日本", "新兴市场"]
ALLOWED_STRATEGIES = ["多策略", "量化", "固收", "股票多空", "股票多头", "商品", "宏观",
                      "波动率", "CTA", "事件驱动", "加密", "私募风投"]

RISK_ORDER = ["均衡型", "混合型", "进攻型", "机会型", "现金管理型"]
REGION_ORDER = ALLOWED_REGIONS
STRATEGY_ORDER = ALLOWED_STRATEGIES

RECON_WARN = 0.003
RECON_FIT_TOL = 0.005
RECON_ERROR = 0.01
BIG_MOVE = 0.15
