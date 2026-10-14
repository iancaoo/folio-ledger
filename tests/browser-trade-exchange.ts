import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { sampleFund, sampleEntity } from './fixtures';
import { exportColumns, exchangeValue } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/export';

async function main() {
  const credentials = JSON.parse(readFileSync('.runtime/dev-credentials.json', 'utf8')); const base = 'http://127.0.0.1:13000/api/';
  const signed = await fetch(base + 'auth:signIn', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authenticator': 'basic' }, body: JSON.stringify({ account: credentials.admin_email, password: credentials.admin_password }) }); assert.equal(signed.status, 200); const token = (await signed.json()).data.token;
  const api = async (action: string, values?: any) => { const response = await fetch(base + 'finance:' + action, { method: values ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'X-Role': 'root', 'X-Authenticator': 'basic', 'Content-Type': 'application/json' }, body: values ? JSON.stringify({ request_key: randomUUID(), ...values }) : undefined }); const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.data; };
  assert.equal((await api('metadata')).demo_mode, true);
  const suffix = randomUUID().slice(0, 8); const created = await api('saveFund', sampleFund('浏览器交易交换-' + suffix)); const f = await api('fund?id=' + created.fund_id); const e = await api('saveEntity', sampleEntity('BTEX-' + suffix, 'A'));
  const values = { entity_id: e.id, share_class_id: f.share_classes[0].id, confirmation_date: '2026-01-01', amount: '123456789012345.123456789', currency: 'USD', fee_rate: '0.000000123456789', remarks: '  原值\n\\N  ' };
  const a = await api('saveTrade', { values: { ...values, transaction_type: '初次申购', confirmed_units: '100' } });
  const b = await api('saveTrade', { values: { ...values, transaction_type: '赎回', confirmed_units: '30' } });
  const v = await api('saveTrade', { values: { ...values, transaction_type: '追加申购', confirmed_units: '20' } }); await api('voidTrade', { id: v.id, technical_revision: v.technical_revision, reason: '浏览器模拟撤销' });
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1100 }, reducedMotion: 'reduce', storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:13000', localStorage: [{ name: 'NOCOBASE_TOKEN', value: token }, { name: 'NOCOBASE_AUTH', value: 'basic' }, { name: 'NOCOBASE_ROLE', value: 'root' }, { name: 'NOCOBASE_LOCALE', value: 'zh-CN' }] }] } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  async function select(label: string, text: string, search = false) {
    const input = page.getByLabel(label, { exact: true }).and(page.locator('input')); await input.focus(); if (search) await input.fill(text); else await input.press('ArrowDown');
    const controls = await input.getAttribute('aria-controls'); await page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${controls}"]`) }).locator('.ant-select-item-option').filter({ hasText: text }).first().click();
  }
  const columns = exportColumns('transactions'); const names = Object.fromEntries(columns.map(column => [column.key, column.label]));
  const path = '.runtime/browser-trade-exchange.xlsx'; let rows: any[];
  async function upload() {
    await select('导入类型', '申赎交易'); await page.locator('input[type="file"]').setInputFiles(path); await page.getByRole('button', { name: '读取文件并暂存', exact: true }).click(); await page.getByText('已识别 Finance 交换文件', { exact: true }).waitFor();
  }
  const cell = (record: any, key: string) => page.getByLabel(`第 ${rows.findIndex(row => row.id === record.id) + 2} 行 ${names[key]}`, { exact: true });
  const preview = async () => { await page.getByRole('button', { name: '重新校验并预览', exact: true }).click(); };
  try {
    await page.goto('http://127.0.0.1:13000/admin/finance'); await page.getByRole('tab', { name: '数据导出', exact: true }).click(); await select('导出业务表', '申赎记录'); await select('限定导出基金', f.fund.short_name, true);
    const event = page.waitForEvent('download'); await page.getByRole('button', { name: '下载业务数据', exact: true }).click(); await (await event).saveAs(path);
    const book = XLSX.readFile(path); rows = XLSX.utils.sheet_to_json<any>(book.Sheets['业务数据'], { defval: '' }).map(row => Object.fromEntries(columns.map(column => [column.key, exchangeValue(row[column.label])])));
    assert.equal(rows.length, 3); assert.equal(rows.find(row => row.id === v.id).is_void, 'true'); assert.equal(rows[0].amount, values.amount); assert.equal(rows[0].remarks, values.remarks);
    await page.getByRole('tab', { name: '导入与纠错', exact: true }).click(); await upload(); await preview(); await page.getByText('可提交', { exact: true }).waitFor();
    assert.equal(await cell(a, 'id').isDisabled(), true); assert.equal(await cell(v, 'is_void').isDisabled(), true); assert.equal(await page.getByLabel('费率列口径', { exact: true }).and(page.locator('input')).isDisabled(), true);
    await page.getByRole('button', { name: /提交选中集合/ }).click(); await page.getByText('已提交 3 行', { exact: true }).waitFor(); await page.getByText('新增 0，修改 0，不变 3。可到申赎和持仓页面核对。重复提交不会追加交易。', { exact: true }).waitFor();
    assert.equal((await api('list?table=transactions&id=' + v.id))[0].is_void, true);
    console.log('PASS browser: transaction export preserves exact text and voided state; unchanged reimport locks IDs and writes no new trades');

    await page.getByRole('button', { name: '开始新批次', exact: true }).click(); await upload(); await cell(v, 'amount').fill('999'); await preview(); await page.getByText('需要修正', { exact: true }).waitFor(); await page.getByText(/已撤销交易只允许核对原值/).waitFor(); assert.equal(await page.getByRole('button', { name: /提交选中集合/ }).isDisabled(), true);
    await cell(v, 'amount').fill(values.amount); await cell(a, 'confirmed_units').fill('10'); await cell(b, 'confirmed_units').fill('3'); await preview(); await page.getByText('可提交', { exact: true }).waitFor();
    await page.getByRole('tabpanel', { name: '导入与纠错', exact: true }).screenshot({ path: 'docs/verification/M4交易交换预览.png', animations: 'disabled' });
    console.log('PASS browser: editing a voided transaction is blocked until its original value is restored');

    await page.getByRole('button', { name: /提交选中集合/ }).click(); await page.getByText('已提交 3 行', { exact: true }).waitFor(); await page.getByText('新增 0，修改 2，不变 1。可到申赎和持仓页面核对。重复提交不会追加交易。', { exact: true }).waitFor();
    assert.equal((await api('positions?entity_id=' + e.id))[0].units, '7');
    for (const [record, units] of [[a, '10'], [b, '3']] as any[]) { const current = (await api('list?table=transactions&id=' + record.id))[0]; assert.equal(current.id, record.id); assert.equal(current.confirmed_units, units); assert.equal(current.remarks, values.remarks); assert.equal(current.fee_rate, values.fee_rate); }
    const dead = (await api('list?table=transactions&id=' + v.id))[0]; assert.equal(dead.is_void, true); assert.equal(dead.confirmed_units, '20');
    console.log('PASS browser: two changed transactions commit as one final daily set; the third voided record and every ID remain intact');
    assert.deepEqual(errors, []); writeFileSync('.runtime/browser-trade-exchange-result.json', JSON.stringify({ passed: true, checks: 3, simulated: true, page_errors: errors, timestamp: new Date().toISOString(), fund_id: f.fund.id, entity_id: e.id }, null, 2));
  } catch (error) { await page.screenshot({ path: '.runtime/browser-trade-exchange-error.png', fullPage: true }); writeFileSync('.runtime/browser-trade-exchange-error.txt', await page.locator('body').innerText()); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
