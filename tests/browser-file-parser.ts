import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { sampleFund } from './fixtures';

async function main() {
  const credentials = JSON.parse(readFileSync('.runtime/dev-credentials.json', 'utf8')); const base = 'http://127.0.0.1:13000/api/';
  const signed = await fetch(base + 'auth:signIn', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authenticator': 'basic' }, body: JSON.stringify({ account: credentials.admin_email, password: credentials.admin_password }) }); assert.equal(signed.status, 200); const token = (await signed.json()).data.token;
  const headers = { Authorization: `Bearer ${token}`, 'X-Role': 'root', 'X-Authenticator': 'basic', 'Content-Type': 'application/json' };
  const api = async (action: string, values?: any) => { const response = await fetch(base + 'finance:' + action, { method: values ? 'POST' : 'GET', headers, body: values ? JSON.stringify({ request_key: randomUUID(), ...values }) : undefined }); const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.data; };
  assert.equal((await api('metadata')).demo_mode, true); const suffix = randomUUID().slice(0, 8); const created = await api('saveFund', sampleFund('浏览器文件诊断-' + suffix)); const f = await api('fund?id=' + created.fund_id); const share = f.share_classes[0];
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, reducedMotion: 'reduce', storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:13000', localStorage: [{ name: 'NOCOBASE_TOKEN', value: token }, { name: 'NOCOBASE_AUTH', value: 'basic' }, { name: 'NOCOBASE_ROLE', value: 'root' }, { name: 'NOCOBASE_LOCALE', value: 'zh-CN' }] }] } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const panel = page.getByRole('tabpanel', { name: '导入与纠错', exact: true });
  async function choose(label: string, text: string) {
    const input = panel.getByLabel(label, { exact: true }).and(page.locator('input')); await input.focus(); await input.press('ArrowDown');
    const controls = await input.getAttribute('aria-controls'); await page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${controls}"]`) }).locator('.ant-select-item-option').filter({ hasText: text }).first().click();
  }
  const make = (kind: 'missing' | 'valid' | 'precision' | 'text') => {
    const book = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet([['ISIN', '日期', '单位净值'], [share.isin, kind === 'valid' ? '2035-01-01' : '2035-01-02', kind === 'precision' ? 1234567890123456 : kind === 'text' ? '123456789012345.12345678' : '']]);
    if (['missing', 'valid'].includes(kind)) sheet.C2 = { t: 'n', f: '0.1+0.2', ...(kind === 'valid' ? { v: 0.3 } : {}) };
    if (kind === 'text') { XLSX.utils.sheet_add_aoa(sheet, [[share.isin, '2035-01-03', 0.125]], { origin: 'A3' }); }
    XLSX.utils.book_append_sheet(book, sheet, '模拟诊断'); return XLSX.write(book, { type: 'buffer', bookType: ['text', 'precision'].includes(kind) ? 'xls' : 'xlsx' }) as Buffer;
  };
  async function upload(kind: 'missing' | 'valid' | 'precision' | 'text') {
    await choose('对象识别方式', '每行通过标识列识别对象'); const ext = ['text', 'precision'].includes(kind) ? 'xls' : 'xlsx';
    await panel.locator('input[type=file]').setInputFiles({ name: `模拟文件诊断-${kind}-${suffix}.${ext}`, mimeType: 'application/octet-stream', buffer: make(kind) }); await panel.getByRole('button', { name: '读取文件并暂存', exact: true }).click();
  }
  const fresh = async () => panel.getByRole('button', { name: '开始新批次', exact: true }).click();
  try {
    await page.goto('http://127.0.0.1:13000/admin/finance'); await page.getByRole('tab', { name: '导入与纠错', exact: true }).click();
    await upload('missing'); await panel.getByText('文件解析失败', { exact: true }).waitFor(); await panel.getByText(/模拟诊断!C2：公式没有可核验的缓存值/).waitFor(); assert.equal(await panel.getByRole('button', { name: /提交选中集合/ }).count(), 0);
    await panel.getByRole('button', { name: '刷新批次', exact: true }).click(); await panel.getByText(/模拟诊断!C2：公式没有可核验的缓存值/).waitFor();
    const download = page.waitForEvent('download'); await panel.getByRole('button', { name: '下载原文件', exact: true }).click(); assert.deepEqual(readFileSync(await (await download).path()), make('missing'));
    await panel.screenshot({ path: 'docs/verification/M4公式缓存诊断.png', animations: 'disabled' });
    console.log('PASS browser: a formula without cache produces an exact cell diagnostic, no submit action, and an unchanged downloadable original');

    await fresh(); await upload('valid'); await panel.getByText(/已核验 1 个公式缓存/).waitFor(); await panel.getByRole('button', { name: '重新校验并预览', exact: true }).click(); await panel.getByText('可提交', { exact: true }).waitFor();
    await panel.getByRole('button', { name: /提交选中集合/ }).click(); await panel.getByText('已提交 1 行', { exact: true }).waitFor();
    const nav = await api('list?table=fund_navs&share_class_id=' + share.id); assert.equal(nav.find(row => row.nav_date === '2035-01-01').nav_per_unit, '0.3');
    console.log('PASS browser: a verified formula cache is explained and imports its exact cached number through the normal preview');

    await fresh(); await upload('precision'); await panel.getByText('文件解析失败', { exact: true }).waitFor(); await panel.getByText(/模拟诊断!C2：XLS 数字单元格超过/).waitFor();
    await panel.screenshot({ path: 'docs/verification/M4XLS精度诊断.png', animations: 'disabled' });
    await fresh(); await upload('text'); await panel.getByText(/XLS 数字按文件保存的双精度值读取/).waitFor(); await panel.getByRole('button', { name: '重新校验并预览', exact: true }).click(); await panel.getByText('可提交', { exact: true }).waitFor(); await panel.getByRole('button', { name: /提交选中集合/ }).click(); await panel.getByText('已提交 2 行', { exact: true }).waitFor();
    const values = await api('list?table=fund_navs&share_class_id=' + share.id); assert.equal(values.find(row => row.nav_date === '2035-01-02').nav_per_unit, '123456789012345.12345678'); assert.equal(values.find(row => row.nav_date === '2035-01-03').nav_per_unit, '0.125');
    console.log('PASS browser: risky XLS numbers require source correction; exact text and ordinary numeric values then import without lost digits');
    assert.deepEqual(errors, []); writeFileSync('.runtime/browser-file-parser-result.json', JSON.stringify({ passed: true, checks: 3, simulated: true, page_errors: errors, timestamp: new Date().toISOString(), fund_id: f.fund.id }, null, 2));
  } catch (error) { await page.screenshot({ path: '.runtime/browser-file-parser-error.png', fullPage: true }); writeFileSync('.runtime/browser-file-parser-error.txt', await page.locator('body').innerText()); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
