import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { sampleFund, sampleEntity } from './fixtures';
import { exportColumns, exchangeValue } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/export';

async function main() {
  const credentials = JSON.parse(readFileSync('.runtime/dev-credentials.json', 'utf8'));
  const base = 'http://127.0.0.1:13000/api/';
  const signed = await fetch(base + 'auth:signIn', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authenticator': 'basic' }, body: JSON.stringify({ account: credentials.admin_email, password: credentials.admin_password }) });
  assert.equal(signed.status, 200); const token = (await signed.json()).data.token;
  const api = async (action: string, payload?: any) => {
    const response = await fetch(base + 'finance:' + action, { method: payload ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'X-Role': 'root', 'X-Authenticator': 'basic', 'Content-Type': 'application/json' }, body: payload ? JSON.stringify({ request_key: randomUUID(), ...payload }) : undefined });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.data;
  };
  assert.equal((await api('metadata')).demo_mode, true);
  const suffix = randomUUID().slice(0, 8);
  const created = await api('saveFund', sampleFund('浏览器导出-' + suffix)); const fund = await api('fund?id=' + created.fund_id); const share = fund.share_classes[0];
  const entity = await api('saveEntity', sampleEntity('BEXPORT-' + suffix, 'A'));
  await api('saveTrade', { values: { entity_id: entity.id, share_class_id: share.id, confirmation_date: '2026-01-01', transaction_type: '初次申购', confirmed_units: '100', amount: '1', currency: 'USD' } });
  const record = await api('saveSeries', { data_type: 'returns', expected_revision: null, values: { share_class_id: share.id, return_date: '2026-01-02', mtd_return: '0.0000000000000000123456789', estimate_label: null } });
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1100 }, reducedMotion: 'reduce', storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:13000', localStorage: [{ name: 'NOCOBASE_TOKEN', value: token }, { name: 'NOCOBASE_AUTH', value: 'basic' }, { name: 'NOCOBASE_ROLE', value: 'root' }, { name: 'NOCOBASE_LOCALE', value: 'zh-CN' }] }] } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  async function select(label: string, text: string, search = false) {
    const input = page.getByLabel(label, { exact: true }).and(page.locator('input')); await input.focus();
    if (search) await input.fill(text); else await input.press('ArrowDown');
    const controls = await input.getAttribute('aria-controls');
    await page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${controls}"]`) }).locator('.ant-select-item-option').filter({ hasText: text }).first().click();
  }
  async function download(table: string) {
    const event = page.waitForEvent('download'); await page.getByRole('button', { name: '下载业务数据', exact: true }).click(); const file = await event;
    assert.equal(await file.failure(), null); const path = `.runtime/browser-export-${table}.xlsx`; await file.saveAs(path);
    const book = XLSX.readFile(path); const rows = XLSX.utils.sheet_to_json<any>(book.Sheets['业务数据'], { defval: '' });
    return { path, rows: rows.map(row => Object.fromEntries(exportColumns(table).map(column => [column.key, exchangeValue(row[column.label])]))), book };
  }
  try {
    await page.goto('http://127.0.0.1:13000/admin/finance'); await page.getByRole('tab', { name: '数据导出', exact: true }).click();
    await select('限定导出基金', fund.fund.short_name, true); const fundFile = await download('funds');
    assert.equal(fundFile.rows.length, 1); assert.equal(fundFile.rows[0].id, fund.fund.id); assert.equal(fundFile.rows[0].size_100m_usd, '123456789012345.12345678');
    await page.getByText('基金：已下载 1 条，共 1 个 Excel 文件', { exact: true }).waitFor();
    console.log('PASS browser: scoped fund export downloads exact decimal text and reports actual row count');

    await select('导出业务表', 'MTD 收益'); await select('限定导出基金', fund.fund.short_name, true);
    await page.getByLabel('业务开始日期', { exact: true }).fill('2026-01-02'); await page.getByLabel('业务结束日期', { exact: true }).fill('2026-01-02');
    const file = await download('fund_returns'); assert.equal(file.rows[0].id, record.id); assert.equal(file.rows[0].mtd_return, '0.0000000000000000123456789'); assert.equal(file.rows[0].estimate_label, null);
    await page.locator('[data-finance-export]').screenshot({ path: 'docs/verification/M4业务导出.png', animations: 'disabled' });
    await page.getByRole('tab', { name: '导入与纠错', exact: true }).click(); await select('导入类型', 'MTD 收益率'); await select('对象识别方式', '每行通过标识列识别对象');
    await page.locator('input[type="file"]').setInputFiles(file.path); await page.getByRole('button', { name: '读取文件并暂存', exact: true }).click();
    await page.getByText('已识别 Finance 交换文件', { exact: true }).waitFor(); await page.getByRole('button', { name: '重新校验并预览', exact: true }).click();
    await page.getByText('可提交', { exact: true }).waitFor(); assert.equal(await page.getByRole('combobox', { name: '收益列口径', exact: true }).isDisabled(), true); await page.getByText('不变', { exact: true }).waitFor();
    console.log('PASS browser: exported return reopens with fixed ratio/ID mapping and previews unchanged');

    const names = Object.fromEntries(exportColumns('fund_returns').map(column => [column.key, column.label]));
    const dateCell = page.getByLabel(`第 2 行 ${names.return_date}`, { exact: true }); await dateCell.fill('2026-01-03');
    await page.getByRole('button', { name: '重新校验并预览', exact: true }).click(); await page.getByText('需要修正', { exact: true }).waitFor();
    await page.getByText(/记录 ID 与对象、日期不一致/).waitFor(); assert.equal(await page.getByRole('button', { name: /提交选中集合/ }).isDisabled(), true);
    await dateCell.fill('2026-01-02'); await page.getByLabel(`第 2 行 ${names.mtd_return}`, { exact: true }).fill('0.0000000000000000234567891');
    await page.getByRole('button', { name: '重新校验并预览', exact: true }).click(); await page.getByText('可提交', { exact: true }).waitFor();
    await page.getByRole('button', { name: '查看转换与旧值', exact: true }).click(); await page.getByRole('dialog').last().getByText(record.id, { exact: true }).first().waitFor(); await page.getByRole('dialog').last().getByRole('button', { name: /关\s*闭/ }).click();
    await page.getByRole('button', { name: /提交选中集合/ }).click(); await page.getByText('已提交 1 行', { exact: true }).waitFor();
    const current = await api(`seriesAt?data_type=returns&parent_id=${share.id}&date=2026-01-02`); assert.equal(current.id, record.id); assert.equal(current.mtd_return, '0.0000000000000000234567891'); assert.equal(current.estimate_label, null);
    await page.getByRole('tabpanel', { name: '导入与纠错', exact: true }).screenshot({ path: 'docs/verification/M4导出再导入.png', animations: 'disabled' });
    console.log('PASS browser: changed date is rejected; corrected value updates original ID with exact precision and null marker');

    await page.getByRole('tab', { name: '数据导出', exact: true }).click(); await select('导出业务表', '持仓核对（只读）'); await select('限定导出基金', fund.fund.short_name, true);
    await page.getByLabel('持仓截止日期', { exact: true }).fill('2026-01-02'); const positions = await download('positions');
    assert.equal(positions.rows.length, 1); assert.equal(positions.rows[0].units, '100'); assert.equal(positions.rows[0].market_value, null);
    console.log('PASS browser: switching export type clears former date filters; missing NAV remains null in read-only holdings');
    assert.deepEqual(errors, []);
    writeFileSync('.runtime/browser-export-result.json', JSON.stringify({ passed: 4, screenshots: ['M4业务导出.png', 'M4导出再导入.png'], simulated: true, page_errors: errors, executed_at: new Date().toISOString() }, null, 2));
  } catch (error) {
    await page.screenshot({ path: '.runtime/browser-export-error.png', fullPage: true });
    writeFileSync('.runtime/browser-export-error.txt', await page.locator('body').innerText());
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
