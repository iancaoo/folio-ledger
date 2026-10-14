import { readFileSync, writeFileSync } from 'node:fs';
import { sampleFund, sampleEntity } from '../tests/fixtures';

async function main() {
  const credentials = JSON.parse(readFileSync('.runtime/dev-credentials.json', 'utf8'));
  const base = 'http://127.0.0.1:13000/api/';
  const login = await fetch(`${base}auth:signIn`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authenticator': 'basic' }, body: JSON.stringify({ account: credentials.admin_email, password: credentials.admin_password }) });
  if (!login.ok) throw new Error('本地演示管理员登录失败');
  const token = (await login.json()).data.token;
  async function request(action: string, payload?: any, key?: string) {
    const response = await fetch(`${base}finance:${action}`, { method: payload ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Authenticator': 'basic', 'X-Role': 'root', Authorization: `Bearer ${token}` }, body: payload ? JSON.stringify({ ...payload, request_key: `finance-demo-v1-${key}` }) : undefined });
    const body = await response.json();
    if (!response.ok) throw new Error(body.errors?.[0]?.message || '演示初始化未成功');
    return body.data;
  }
  const metadata = await request('metadata');
  if (!metadata.demo_mode) throw new Error('仅允许在 FINANCE_DEMO_MODE=true 的模拟环境初始化');
  const fund = sampleFund('入门演示');
  fund.details.coverage_owner_user_id = metadata.current_user_id;
  const saved = await request('saveFund', fund, 'fund');
  const aggregate = await request(`fund?id=${saved.fund_id}`);
  const entities = [];
  for (const label of ['A', 'B']) entities.push(await request('saveEntity', sampleEntity('DEMO-STARTER-01', `入门演示 ${label}`), `entity-${label}`));
  for (const [type, units, date, key] of [['初次申购', '100', '2026-01-01', 'subscription'], ['赎回', '30', '2026-01-02', 'withdrawal']]) {
    await request('saveTrade', { values: { entity_id: entities[0].id, share_class_id: aggregate.share_classes[0].id, transaction_type: type, confirmation_date: date, confirmed_units: units, amount: units, currency: 'USD' } }, key);
  }
  await request('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: aggregate.share_classes[0].id, nav_date: '2026-01-03', nav_per_unit: '1.25' } }, 'nav');
  const result = { fund_id: saved.fund_id, entities: entities.map(row => row.id), expected: { units: '70', market_value: '87.5' } };
  writeFileSync('.runtime/demo-records.json', JSON.stringify(result, null, 2), { mode: 0o600 });
  const positions = await request(`positions?entity_id=${entities[0].id}`);
  const position = positions.find(row => row.share_class_id === aggregate.share_classes[0].id);
  console.log(`入门模拟资料已就绪；重复运行不会新增基金版本或交易。当前持仓：${position?.units ?? '缺失'} 份，${position?.market_value ?? '缺少净值'} USD。初始预期为 70 份、87.50 USD。`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
