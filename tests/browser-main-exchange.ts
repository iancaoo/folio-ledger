import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { sampleFund, sampleEntity, sampleProprietary } from './fixtures';
import { exportColumns } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/export';

async function main() {
  const credentials = JSON.parse(readFileSync('.runtime/dev-credentials.json', 'utf8')); const base = 'http://127.0.0.1:13000/api/';
  const signed = await fetch(base + 'auth:signIn', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Authenticator': 'basic' }, body: JSON.stringify({ account: credentials.admin_email, password: credentials.admin_password }) }); assert.equal(signed.status, 200); const token = (await signed.json()).data.token;
  const headers = { Authorization: `Bearer ${token}`, 'X-Role': 'root', 'X-Authenticator': 'basic', 'Content-Type': 'application/json' };
  const api = async (action: string, values?: any) => { const response = await fetch(base + 'finance:' + action, { method: values ? 'POST' : 'GET', headers, body: values ? JSON.stringify({ request_key: randomUUID(), ...values }) : undefined }); const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body.data; };
  assert.equal((await api('metadata')).demo_mode, true);
  const suffix = randomUUID().slice(0, 8); const created = await api('saveFund', sampleFund('浏览器主数据交换-' + suffix)); const f = await api('fund?id=' + created.fund_id);
  const parentMade = await api('saveFund', { ...sampleProprietary('浏览器成分交换-' + suffix), compositions: [{ valuation_date: '2026-01-01', items: f.share_classes.map(share => ({ child_share_class_id: share.id, units: '10', remarks: null })) }] }); const parent = await api('fund?id=' + parentMade.fund_id);
  const e = await api('saveEntity', sampleEntity('BMEX-' + suffix, 'A')); await api('saveEntity', sampleEntity('BMEX-' + suffix, 'B')); const entity = await api('entity?id=' + e.id);
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1680, height: 1100 }, reducedMotion: 'reduce', storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:13000', localStorage: [{ name: 'NOCOBASE_TOKEN', value: token }, { name: 'NOCOBASE_AUTH', value: 'basic' }, { name: 'NOCOBASE_ROLE', value: 'root' }, { name: 'NOCOBASE_LOCALE', value: 'zh-CN' }] }] } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  async function select(label: string, text: string, search = false) {
    const input = page.getByLabel(label, { exact: true }).and(page.locator('input')); await input.focus(); if (search) await input.fill(text); else await input.press('ArrowDown');
    const controls = await input.getAttribute('aria-controls'); await page.locator('.ant-select-dropdown').filter({ has: page.locator(`[id="${controls}"]`) }).locator('.ant-select-item-option').filter({ hasText: text }).first().click();
  }
  let table: string; let rows: any[]; let names: Record<string, string>; const path = '.runtime/browser-main-exchange.xlsx';
  function readDownload(type: string) {
    table = type; names = Object.fromEntries(exportColumns(type).map(column => [column.key, column.label]));
    const book = XLSX.readFile(path); rows = XLSX.utils.sheet_to_json<any>(book.Sheets['业务数据'], { defval: '' });
  }
  async function file(type: string, filters: any, ids?: string[]) {
    const response = await fetch(base + 'finance:exportData?' + new URLSearchParams({ table: type, ...filters }), { headers }); assert.equal(response.status, 200);
    let bytes = Buffer.from(await response.arrayBuffer());
    if (ids) {
      const book = XLSX.read(bytes, { type: 'buffer' }); const columns = exportColumns(type); const matrix = XLSX.utils.sheet_to_json<any[]>(book.Sheets['业务数据'], { header: 1 }); const index = columns.findIndex(column => column.key === 'id');
      book.Sheets['业务数据'] = XLSX.utils.aoa_to_sheet([matrix[0], ...matrix.slice(1).filter(row => ids.includes(row[index]))]); bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    }
    writeFileSync(path, bytes); readDownload(type);
  }
  async function upload() {
    await select('导入类型', '业务交换文件'); await page.locator('input[type="file"]').setInputFiles(path); await page.getByRole('button', { name: '读取文件并暂存', exact: true }).click(); await page.getByText('已识别 Finance 交换文件', { exact: true }).waitFor();
  }
  const cell = (index: number, key: string) => page.getByLabel(`第 ${index + 2} 行 ${names[key]}`, { exact: true });
  const preview = async () => page.getByRole('button', { name: '重新校验并预览', exact: true }).click();
  const submit = async (count: number) => { await page.getByRole('button', { name: /提交选中集合/ }).click(); await page.getByText(`已提交 ${count} 行`, { exact: true }).waitFor(); };
  const fresh = async () => page.getByRole('button', { name: '开始新批次', exact: true }).click();
  try {
    await page.goto('http://127.0.0.1:13000/admin/finance'); await page.getByRole('tab', { name: '数据导出', exact: true }).click(); await select('导出业务表', '份额类别'); await select('限定导出基金', f.fund.short_name, true);
    const event = page.waitForEvent('download'); await page.getByRole('button', { name: '下载业务数据', exact: true }).click(); await (await event).saveAs(path); readDownload('share_classes');
    await page.getByRole('tab', { name: '导入与纠错', exact: true }).click(); await upload(); assert.equal(await cell(0, 'id').isDisabled(), true); assert.equal(await cell(0, 'fund_id').isDisabled(), true);
    await cell(0, 'class_label').fill('浏览器修改份额'); await preview(); await page.getByText('可提交', { exact: true }).waitFor();
    await page.getByRole('button', { name: '查看转换与旧值', exact: true }).first().click(); await page.getByText('ID、固定关联、状态及计算结果不由交换文件更改。', { exact: false }).waitFor(); await page.getByRole('dialog').getByRole('button', { name: /关\s*闭/ }).click();
    await submit(2); const current = await api('fund?id=' + f.fund.id); assert.equal(current.fund.business_version, 2); assert.equal(current.share_classes.find(row => row.id === rows[0][names.id]).class_label, '浏览器修改份额'); assert.deepEqual(current.share_classes.map(row => row.id).sort(), f.share_classes.map(row => row.id).sort());
    console.log('PASS browser: generic exchange auto-identifies shares, locks identities, shows new/old facts and saves one fund version');

    const parentBefore = await api('fund?id=' + parent.fund.id);
    await fresh(); await file('composition_items', { fund_id: parent.fund.id }); const unselectedId = rows[1][names.id]; const selectedId = rows[0][names.id];
    await upload(); await cell(0, 'units').fill('123456789012345.123456789'); await page.locator('[data-finance-import-rows] tbody tr[data-row-key]').nth(1).locator('input[type="checkbox"]').uncheck();
    await preview(); await page.getByText('需要修正', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: /提交选中集合/ }).isDisabled(), true);
    await page.getByRole('button', { name: '核对完整清单变更', exact: true }).click(); await page.getByText(/未选中的成分继续保留；不会因文件缺行而移除成分/).waitFor();
    const dialog = page.getByRole('dialog'); assert.equal(await dialog.locator('tbody tr[data-row-key]').count(), 2); await page.waitForFunction(() => [...document.querySelectorAll('.ant-modal')].some(element => getComputedStyle(element).transform === 'none' && getComputedStyle(element).opacity === '1')); await page.screenshot({ path: 'docs/verification/M4主数据交换成分确认.png', animations: 'disabled' });
    await dialog.getByRole('button', { name: '确认修改选中成分', exact: true }).click(); await page.getByText('可提交', { exact: true }).waitFor(); await submit(1);
    const comp = await api('fund?id=' + parent.fund.id); assert.equal(comp.fund.business_version, 2); assert.equal(comp.compositions[0].items.length, 2); assert.equal(comp.compositions[0].items.find(row => row.id === selectedId).units, '123456789012345.123456789'); assert.deepEqual(comp.compositions[0].items.find(row => row.id === unselectedId), parentBefore.compositions[0].items.find(row => row.id === unselectedId));
    console.log('PASS browser: composition exchange shows full diff, preserves unselected child and original IDs, and saves exact units');

    await fresh(); await file('client_groups', {}, [entity.entity.client_group_id]); await upload(); await cell(0, 'client_code').fill('BMEX-NEW-' + suffix); await preview();
    await page.getByRole('button', { name: '核对客户改名影响', exact: true }).click(); await page.getByText(/此分组下 2 个主体将显示新编号/).waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.ant-modal')].some(element => getComputedStyle(element).transform === 'none' && getComputedStyle(element).opacity === '1')); await page.screenshot({ path: 'docs/verification/M4主数据交换客户确认.png', animations: 'disabled' }); await page.getByRole('button', { name: '确认改名及影响范围', exact: true }).click(); await page.getByText('可提交', { exact: true }).waitFor(); await submit(1);
    const renamed = await api('entity?id=' + e.id); assert.equal(renamed.client_code, 'BMEX-NEW-' + suffix); assert.equal(renamed.entity.client_group_id, entity.entity.client_group_id); assert.equal(renamed.entity.technical_revision, entity.entity.technical_revision + 1);
    console.log('PASS browser: client rename lists the affected entity count and preserves group and entity identities');

    const uploaded = await api('uploadDocument', { fund_id: f.fund.id, original_name: '模拟交换文档.txt', document_type: '其他', content_base64: Buffer.from('模拟交换文档保持不变').toString('base64') }); assert.equal(uploaded.status, 'complete');
    await fresh(); await file('fund_documents', { fund_id: f.fund.id }); await upload(); assert.equal(await cell(0, 'original_name').isDisabled(), true); assert.equal(await cell(0, 'size_bytes').isDisabled(), true); await cell(0, 'document_type').fill('月报'); await preview(); await page.getByText('可提交', { exact: true }).waitFor(); await submit(1);
    const documents = await api('documents?fund_id=' + f.fund.id); const document = documents.find(row => row.id === uploaded.document_id); assert.equal(document.document_type, '月报'); assert.equal(document.original_name, '模拟交换文档.txt');
    console.log('PASS browser: document exchange enables classification only and preserves the original file binding and name');

    const nav = await api('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: f.share_classes[0].id, nav_date: '2026-01-01', nav_per_unit: '1.234567890123456789' } });
    await fresh(); await file('fund_navs', { fund_id: f.fund.id }); await upload(); await preview(); await page.getByText('可提交', { exact: true }).waitFor(); await submit(1); const value = (await api('list?table=fund_navs&id=' + nav.id))[0]; assert.equal(value.nav_per_unit, '1.234567890123456789'); assert.equal(value.technical_revision, 1);
    console.log('PASS browser: the generic exchange entry also routes NAV to the existing series workflow without a second target selection');
    assert.deepEqual(errors, []); writeFileSync('.runtime/browser-main-exchange-result.json', JSON.stringify({ passed: true, checks: 5, simulated: true, page_errors: errors, timestamp: new Date().toISOString(), fund_id: f.fund.id, parent_fund_id: parent.fund.id, entity_id: e.id }, null, 2));
  } catch (error) { await page.screenshot({ path: '.runtime/browser-main-exchange-error.png', fullPage: true }); writeFileSync('.runtime/browser-main-exchange-error.txt', await page.locator('body').innerText()); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
