import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { sampleFund } from './fixtures';

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
  const fundId = (await api('saveFund', sampleFund(`BROWSER-SERIES-${suffix}`))).fund_id;
  const fund = await api(`fund?id=${fundId}`); const [a, b] = fund.share_classes;
  const benchmarkA = await api('saveBenchmark', { values: { name: `模拟导入基准A-${suffix}`, category: '模拟' } });
  const benchmarkB = await api('saveBenchmark', { values: { name: `模拟导入基准B-${suffix}`, category: '模拟' } });
  await api('saveSeries', { data_type: 'returns', expected_revision: null, values: { share_class_id: a.id, return_date: '2026-03-01', mtd_return: '0.01', estimate_label: '否' } });
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:13000', localStorage: [
    { name: 'NOCOBASE_TOKEN', value: token }, { name: 'NOCOBASE_AUTH', value: 'basic' }, { name: 'NOCOBASE_ROLE', value: 'root' }, { name: 'NOCOBASE_LOCALE', value: 'zh-CN' },
  ] }] } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const panel = page.getByRole('tabpanel', { name: '导入与纠错' }); const dialog = () => page.getByRole('dialog').last();
  async function choose(label: string, text: string) {
    const labelled = panel.getByLabel(label, { exact: true }).first();
    const input = await labelled.evaluate(element => element.tagName === 'INPUT') ? labelled : labelled.locator('input').first();
    if (await input.evaluate(element => element.closest('.ant-select')?.querySelector('.ant-select-selection-item')?.textContent?.trim()) === text) return;
    await input.focus(); await input.press('ArrowDown');
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: ·.*)?$`) }).click();
  }
  async function upload(name: string, rows: string[][]) {
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '模拟时序');
    await panel.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
    await panel.getByRole('button', { name: '读取文件并暂存' }).click(); await panel.getByText('等待映射', { exact: true }).waitFor();
  }
  async function preview() { await panel.getByRole('button', { name: '重新校验并预览' }).click(); }
  async function finish(count: number) { await panel.getByRole('button', { name: `提交选中集合（${count} 行）` }).click(); await panel.getByText(`已提交 ${count} 行`, { exact: true }).waitFor(); }
  async function batch(name: string) { const row = (await api('importBatches')).rows.find(row => row.original_name === name); return api(`importBatch?id=${row.id}`); }
  try {
    await page.goto('http://127.0.0.1:13000/admin/finance'); await page.getByRole('tab', { name: '导入与纠错' }).click();
    await choose('对象识别方式', '每行通过标识列识别对象');
    const navName = `浏览器多对象净值-${suffix}.xlsx`;
    await upload(navName, [['ISIN', '日期', '单位净值'], [a.isin, '2026-02-01', '123456789012345.12345678'], [b.isin, '2026-02-01', '1.25'], [a.isin, '2026-02-01', '1.5']]);
    await preview(); await panel.getByText('需要修正', { exact: true }).waitFor();
    await panel.getByText('同对象同日存在多行，请明确取消选择或修正冲突行').first().waitFor();
    await panel.getByLabel('第 4 行 日期', { exact: true }).fill('2026-02-02'); await preview(); await panel.getByText('可提交', { exact: true }).waitFor(); await finish(3);
    const nav = await batch(navName); assert.equal(nav.batch.result.inserted_count, 3); assert.equal(nav.rows[0].normalized.values.nav_per_unit, '123456789012345.12345678');
    assert.notEqual(nav.rows[0].normalized.values.share_class_id, nav.rows[1].normalized.values.share_class_id);
    console.log('PASS browser: multiple ISINs preserve same-day independence and exact NAV, while true duplicate keys require correction');

    await panel.getByRole('button', { name: '开始新批次' }).click(); await choose('导入类型', 'MTD 收益率');
    const returnName = `浏览器多对象收益-${suffix}.xlsx`;
    await upload(returnName, [['ISIN', '日期', '百分数收益', '是否预估值'], [a.isin, '2026-03-01', '2%', '是'], [b.isin, '2026-03-01', '0.000001%', '']]);
    await choose('MTD 收益映射', '百分数收益'); await choose('收益列口径', '百分数：2 或 2% 表示 2%');
    await preview(); await panel.getByText('可提交', { exact: true }).waitFor();
    await panel.getByText('将把正式值覆盖为预估值，请核对。', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '查看转换与旧值' }).first().click(); await dialog().getByText('0.02', { exact: true }).waitFor();
    await dialog().getByText('否', { exact: true }).waitFor(); await page.waitForTimeout(350);
    await dialog().screenshot({ path: 'docs/verification/M4收益转换.png', animations: 'disabled' });
    await dialog().getByRole('button', { name: /关\s*闭/ }).click(); await finish(2);
    const returns = await batch(returnName); assert.equal(returns.batch.result.overwritten_count, 1); assert.equal(returns.rows[1].normalized.values.mtd_return, '0.00000001'); assert.equal(returns.rows[1].normalized.values.estimate_label, null);
    console.log('PASS browser: returns map percent and estimate columns explicitly and expose formal-to-estimated overwrite warnings');

    await panel.getByRole('button', { name: '开始新批次' }).click(); await choose('导入类型', '基准数值');
    const download = page.waitForEvent('download'); await panel.getByRole('button', { name: '下载时序模板及对象参考' }).click();
    const template = XLSX.read(readFileSync(await (await download).path()), { type: 'buffer' }); assert.ok(template.SheetNames.includes('基准参考'));
    const benchmarkName = `浏览器多基准-${suffix}.xlsx`;
    await upload(benchmarkName, [['基准 ID', '日期', '基准数值'], [benchmarkA.id, '2026-01-01', '100.000000001'], [benchmarkB.id, '2026-01-01', '200.000000002']]);
    await preview(); await panel.getByText('可提交', { exact: true }).waitFor();
    await api('saveBenchmark', { id: benchmarkA.id, technical_revision: 1, values: { name: `模拟导入基准A更新-${suffix}`, category: '模拟' } });
    await panel.getByRole('button', { name: '提交选中集合（2 行）' }).click();
    await page.getByText(/关联对象或同日记录已变化，请重新预览并核对旧值/).first().waitFor();
    assert.equal((await batch(benchmarkName)).batch.status, 'ready');
    await preview(); await panel.getByRole('button', { name: '查看转换与旧值' }).first().click();
    await dialog().getByText(`目标对象：模拟导入基准A更新-${suffix}`, { exact: true }).waitFor(); await dialog().getByRole('button', { name: /关\s*闭/ }).click();
    await finish(2); assert.equal((await batch(benchmarkName)).batch.result.inserted_count, 2);
    await panel.screenshot({ path: 'docs/verification/M4多基准导入.png', animations: 'disabled' });
    console.log('PASS browser: benchmark templates provide stable IDs; concurrent definition change requires a new preview');

    await panel.getByRole('button', { name: '开始新批次' }).click(); await choose('对象识别方式', '整份文件使用一个对象');
    await choose('导入到基准', `模拟导入基准B-${suffix}`);
    const sameName = `浏览器单基准不变-${suffix}.xlsx`;
    await upload(sameName, [['日期', '基准数值'], ['2026-01-01', '200.000000002']]);
    await preview(); await panel.getByText('不变', { exact: true }).waitFor(); await finish(1);
    assert.equal((await batch(sameName)).batch.result.unchanged_count, 1);
    console.log('PASS browser: single-target benchmark mode recognizes unchanged records without rewriting them');
    assert.deepEqual(errors, []);
    writeFileSync('.runtime/browser-series-import-result.json', JSON.stringify({ passed: true, checks: 4, timestamp: new Date().toISOString(), fund_id: fundId, benchmark_ids: [benchmarkA.id, benchmarkB.id] }, null, 2));
  } catch (error) { await page.screenshot({ path: '.runtime/browser-series-import-failure.png', fullPage: true }); console.error((await page.locator('body').innerText()).slice(-4000)); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
