import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { sampleFund, sampleEntity } from './fixtures';

async function main() {
  const credentials = JSON.parse(readFileSync('.runtime/dev-credentials.json', 'utf8'));
  const base = 'http://127.0.0.1:13000/api/';
  const login = await fetch(`${base}auth:signIn`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authenticator': 'basic' }, body: JSON.stringify({ account: credentials.admin_email, password: credentials.admin_password }) });
  assert.equal(login.status, 200); const token = (await login.json()).data.token;
  const auth = { Authorization: `Bearer ${token}`, 'X-Role': 'root', 'X-Authenticator': 'basic', 'Content-Type': 'application/json' };
  async function api(action: string, payload?: any) {
    const response = await fetch(base + `finance:${action}`, { method: payload ? 'POST' : 'GET', headers: auth, body: payload ? JSON.stringify({ ...payload, request_key: randomUUID() }) : undefined });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result.errors)); return result.data;
  }
  assert.equal((await api('metadata')).demo_mode, true);
  const suffix = Date.now();
  const savedFund = await api('saveFund', sampleFund(`BROWSER-IMPORT-${suffix}`));
  const fund = await api(`fund?id=${savedFund.fund_id}`);
  const entity = await api('saveEntity', sampleEntity(`BROWSER-IMPORT-${suffix}`, '浏览器交易导入'));
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:13000', localStorage: [
    { name: 'NOCOBASE_TOKEN', value: token }, { name: 'NOCOBASE_AUTH', value: 'basic' }, { name: 'NOCOBASE_ROLE', value: 'root' }, { name: 'NOCOBASE_LOCALE', value: 'zh-CN' },
  ] }] } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const panel = page.getByRole('tabpanel', { name: '导入与纠错' });
  const dialog = () => page.getByRole('dialog').last();
  const mappingHeaders = ['主体 ID', 'ISIN', '交易类型', '确认日期', '金额', '币种', '确认份额', '费率'];
  const row = (type: string, units: string, date = '2026-01-01') => [entity.id, fund.share_classes[0].isin, type, date, '123.456789012345', 'USD', units, '2%'].join(',');
  async function chooseImport() {
    await panel.getByLabel('导入类型', { exact: true }).focus();
    await panel.getByLabel('导入类型', { exact: true }).press('ArrowDown');
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^申赎交易$/ }).click();
  }
  async function upload(name: string, rows: string[], headers = mappingHeaders) {
    await panel.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from([headers.join(','), ...rows].join('\n')) });
    await panel.getByRole('button', { name: '读取文件并暂存' }).click();
    await panel.getByText('等待映射', { exact: true }).waitFor();
    await panel.getByRole('combobox', { name: '费率列口径', exact: true }).focus();
    await panel.getByRole('combobox', { name: '费率列口径', exact: true }).press('ArrowDown');
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^百分数/ }).click();
    await panel.getByRole('button', { name: '重新校验并预览' }).click();
  }
  try {
    await page.goto('http://127.0.0.1:13000/admin/finance');
    await page.getByRole('tab', { name: '导入与纠错' }).click();
    await chooseImport();
    const download = page.waitForEvent('download');
    await panel.getByRole('button', { name: '下载交易模板（含主体与份额参考）' }).click();
    const template = XLSX.read(readFileSync(await (await download).path()), { type: 'buffer' });
    assert.equal(template.SheetNames[0], '交易录入');
    assert.ok(XLSX.utils.sheet_to_json(template.Sheets['主体参考']).some((row: any) => row['主体 ID'] === entity.id));
    console.log('PASS browser: transaction template includes exact source identities');
    await upload(`浏览器交易行序-${suffix}.csv`, [row('赎回', '30'), row('初次申购', '100')]);
    await panel.getByText('可提交', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '查看转换与旧值' }).first().click();
    await dialog().getByRole('cell', { name: '0.02', exact: true }).waitFor();
    await dialog().getByRole('cell', { name: '123.456789012345', exact: true }).first().waitFor();
    // Ant Design portals can be present before their opacity transition ends.
    await page.waitForTimeout(350);
    await dialog().screenshot({ path: 'docs/verification/M4交易转换.png', animations: 'disabled' });
    await dialog().getByRole('button', { name: /关\s*闭/ }).click();
    await panel.getByRole('button', { name: '提交选中集合（2 行）' }).click();
    await panel.getByText('已提交 2 行', { exact: true }).waitFor();
    assert.equal((await api(`positions?entity_id=${entity.id}`))[0].units, '70');
    const firstBatch = (await api('importBatches')).rows.find(batch => batch.original_name === `浏览器交易行序-${suffix}.csv`);
    const originalBuyId = (await api(`importBatch?id=${firstBatch.id}`)).batch.result.record_ids[1];
    console.log('PASS browser: withdrawal-first batch retains decimal conversion and produces 70 units');
    await panel.getByRole('button', { name: '开始新批次' }).click();
    await chooseImport();
    await upload(`浏览器重复交易-${suffix}.csv`, [row('追加申购', '10'), row('追加申购', '10')]);
    await panel.getByText('需要修正', { exact: true }).waitFor();
    for (let i = 0; i < 2; i++) {
      await panel.getByRole('button', { name: '核对重复交易' }).first().click();
      await dialog().getByText('本文件第 2 行', { exact: true }).waitFor();
      await dialog().getByText('本文件第 3 行', { exact: true }).waitFor();
      await dialog().getByRole('button', { name: '确认是独立交易' }).click();
      await page.getByText(/确认第 \d+ 行是另一笔真实交易/).waitFor({ state: 'hidden' });
    }
    await panel.getByText('可提交', { exact: true }).waitFor();
    await page.screenshot({ path: 'docs/verification/M4交易导入.png', fullPage: true, animations: 'disabled' });
    await panel.getByRole('button', { name: '提交选中集合（2 行）' }).click();
    await panel.getByText('已提交 2 行', { exact: true }).waitFor();
    assert.equal((await api(`positions?entity_id=${entity.id}`))[0].units, '90');
    console.log('PASS browser: identical real trades require separate explicit confirmations');
    await panel.getByRole('button', { name: '开始新批次' }).click();
    await chooseImport();
    await upload(`浏览器交易过期-${suffix}.csv`, [row('追加申购', '5', '2026-01-03')]);
    await panel.getByText('可提交', { exact: true }).waitFor();
    await api('saveTrade', { values: { entity_id: entity.id, share_class_id: fund.share_classes[0].id, confirmation_date: '2026-01-02', transaction_type: '追加申购', confirmed_units: '1', amount: '1', currency: 'USD' } });
    await panel.getByRole('button', { name: '提交选中集合（1 行）' }).click();
    await page.getByText(/关联资料或持仓历史已变化，请重新预览/).waitFor();
    assert.equal((await api(`positions?entity_id=${entity.id}`))[0].units, '91');
    await panel.getByRole('button', { name: '重新校验并预览' }).click();
    await panel.getByRole('button', { name: '提交选中集合（1 行）', disabled: false }).waitFor();
    await panel.getByRole('button', { name: '提交选中集合（1 行）' }).click();
    await panel.getByText('已提交 1 行', { exact: true }).waitFor();
    assert.equal((await api(`positions?entity_id=${entity.id}`))[0].units, '96');
    console.log('PASS browser: changed history blocks commit and a fresh preview can complete');
    await panel.getByRole('button', { name: '开始新批次' }).click();
    await chooseImport();
    await upload(`浏览器交易修改-${suffix}.csv`, [`${row('初次申购', '80')},${originalBuyId}`], [...mappingHeaders, '交易 ID（修改时填写）']);
    await panel.getByText('可提交', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '查看转换与旧值' }).click();
    await dialog().getByRole('row').filter({ hasText: '确认份额' }).getByRole('cell', { name: '100', exact: true }).waitFor();
    await dialog().getByRole('row').filter({ hasText: 'ISIN' }).getByRole('cell', { name: fund.share_classes[0].isin, exact: true }).last().waitFor();
    await page.waitForTimeout(350);
    await dialog().screenshot({ path: 'docs/verification/M4交易转换.png', animations: 'disabled' });
    await dialog().getByRole('button', { name: /关\s*闭/ }).click();
    await panel.getByRole('button', { name: '提交选中集合（1 行）' }).click();
    await panel.getByText('已提交 1 行', { exact: true }).waitFor();
    await panel.getByText(/新增 0，修改 1，不变 0/).waitFor();
    assert.equal((await api(`positions?entity_id=${entity.id}`))[0].units, '76');
    console.log('PASS browser: explicit transaction ID exposes old values and updates one existing trade');
    assert.deepEqual(errors, []);
    writeFileSync('.runtime/browser-trade-import-result.json', JSON.stringify({ passed: true, timestamp: new Date().toISOString(), checks: 5, fund_id: fund.fund.id, entity_id: entity.id }, null, 2));
  } catch (error) {
    await page.screenshot({ path: '.runtime/browser-trade-import-failure.png', fullPage: true });
    console.error((await page.locator('body').innerText()).slice(-3500)); throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
