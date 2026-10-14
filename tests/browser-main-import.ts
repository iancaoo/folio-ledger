import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { sampleFund, sampleProprietary, sampleEntity } from './fixtures';
import { mainImportFields } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/main-import';

const flat = (prefix: string, values: any) => Object.fromEntries(Object.entries(values).flatMap(([key, value]: any) => value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).map(([part, child]) => [`${prefix}.${key}.${part}`, child]) : [[`${prefix}.${key}`, value]]));
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
  const childId = (await api('saveFund', sampleFund(`BROWSER-MAIN-CHILD-${suffix}`))).fund_id;
  const child = await api(`fund?id=${childId}`);
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:13000', localStorage: [
    { name: 'NOCOBASE_TOKEN', value: token }, { name: 'NOCOBASE_AUTH', value: 'basic' }, { name: 'NOCOBASE_ROLE', value: 'root' }, { name: 'NOCOBASE_LOCALE', value: 'zh-CN' },
  ] }] } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const panel = page.getByRole('tabpanel', { name: '导入与纠错' }); const dialog = () => page.getByRole('dialog').last();
  async function choose(label: string, text: string) {
    const input = panel.getByLabel(label, { exact: true });
    if (await input.evaluate(element => element.closest('.ant-select')?.querySelector('.ant-select-selection-item')?.textContent?.trim()) === text) return;
    await input.focus(); await input.press('ArrowDown');
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).click();
  }
  async function upload(name: string, type: string, items: any[], kind = 'third_party', full = false) {
    const fields = mainImportFields(type, kind).filter(field => full || items.some(item => field.key in item));
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([fields.map(field => field.label), ...items.map(item => fields.map(field => item[field.key] ?? ''))]), '模拟主数据');
    await panel.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) });
    await panel.getByRole('button', { name: '读取文件并暂存' }).click(); await panel.getByText('等待映射', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '重新校验并预览' }).click();
  }
  async function batch(name: string) { const row = (await api('importBatches')).rows.find(row => row.original_name === name); return api(`importBatch?id=${row.id}`); }
  async function finish(count: number) { await panel.getByRole('button', { name: `提交选中集合（${count} 行）` }).click(); await panel.getByText(`已提交 ${count} 行`, { exact: true }).waitFor(); }
  try {
    await page.goto('http://127.0.0.1:13000/admin/finance'); await page.getByRole('tab', { name: '导入与纠错' }).click();
    await choose('导入类型', '基金与份额（可含成分）'); await choose('基金类型', '自营基金');
    const downloaded = page.waitForEvent('download'); await panel.getByRole('button', { name: '下载主数据模板及参考' }).click();
    const template = XLSX.read(readFileSync(await (await downloaded).path()), { type: 'buffer' });
    assert.equal(template.SheetNames[0], '待导入数据'); assert.ok(template.SheetNames.includes('负责人参考')); assert.ok(template.SheetNames.includes('成分清单参考'));
    const fundInput = sampleProprietary(`BROWSER-MAIN-PARENT-${suffix}`);
    const createName = `浏览器主数据新建-${suffix}.xlsx`;
    const createRows = [
      ...fundInput.share_classes.map((share, index) => ({ row_type: '份额', fund_key: '自营一号', ...(index === 0 ? { ...flat('fund', fundInput.fund), ...flat('details', fundInput.details) } : {}), ...flat('share', share.values), ...flat('terms', share.terms) })),
      ...child.share_classes.map((share, index) => ({ row_type: '成分', fund_key: '自营一号', valuation_date: '2026-01-01', child_isin: share.isin, units: index === 0 ? '100' : '200' })),
    ];
    await upload(createName, 'funds', createRows, 'proprietary', true); await panel.getByText('可提交', { exact: true }).waitFor(); await finish(4);
    const saved = (await batch(createName)).batch.result; assert.equal(saved.object_count, 1);
    const parent = await api(`fund?id=${saved.record_ids[0]}`); assert.equal(parent.share_classes.length, 2); assert.equal(parent.compositions[0].items.length, 2);
    assert.equal((await api(`versions?fund_id=${parent.fund.id}`)).length, 1);
    console.log('PASS browser: source-based template creates two shares and a composition as one fund version');
    await panel.getByRole('button', { name: '开始新批次' }).click(); await choose('导入类型', '基金与份额（可含成分）'); await choose('基金类型', '自营基金');
    const editName = `浏览器主数据修改-${suffix}.xlsx`;
    const edited = [...parent.share_classes.map(share => ({ row_type: '份额', fund_id: parent.fund.id, share_id: share.id, 'share.currency': 'JPY' })), { row_type: '成分', fund_id: parent.fund.id, valuation_date: '2026-01-01', child_isin: child.share_classes[0].isin, units: '150' }];
    await upload(editName, 'funds', edited, 'proprietary'); await panel.getByText('需要修正', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '核对完整清单变更' }).click(); await dialog().getByText('移除', { exact: true }).waitFor();
    await dialog().getByText(child.share_classes[1].isin, { exact: true }).waitFor(); await page.waitForTimeout(350);
    await dialog().screenshot({ path: 'docs/verification/M4成分替换.png', animations: 'disabled' });
    await dialog().getByRole('button', { name: '确认替换完整清单' }).click(); await page.getByText('核对完整成分清单替换', { exact: true }).waitFor({ state: 'hidden' });
    await panel.getByText('可提交', { exact: true }).waitFor(); await finish(3);
    const latest = await api(`fund?id=${parent.fund.id}`); assert.deepEqual(latest.share_classes.map(row => row.currency), ['JPY', 'JPY']); assert.equal(latest.compositions[0].items.length, 1);
    const versions = await api(`versions?fund_id=${parent.fund.id}`); assert.equal(versions.length, 2); assert.equal(versions[1].snapshot.compositions[0].items.length, 2);
    console.log('PASS browser: full-list replacement exposes removed components and produces only one additional version');
    await panel.getByRole('button', { name: '开始新批次' }).click(); await choose('导入类型', '客户与投资主体');
    const entityInput = sampleEntity(`BROWSER-MAIN-${suffix}`, '批量主体A');
    const entityName = `浏览器主体批量-${suffix}.xlsx`;
    await upload(entityName, 'entities', [{ client_code: entityInput.client_code, ...flat('entity', entityInput.entity), agreements: 'n/a' }, { client_code: entityInput.client_code, ...flat('entity', { ...entityInput.entity, legal_name: '模拟批量主体B' }) }]);
    await panel.getByText('可提交', { exact: true }).waitFor(); await panel.getByRole('button', { name: '查看转换与旧值' }).first().click();
    await dialog().getByText(/下次 CDD 截止日期：2027-02-27/).waitFor(); await page.waitForTimeout(350);
    await dialog().screenshot({ path: 'docs/verification/M4主体导入.png', animations: 'disabled' });
    await dialog().getByRole('button', { name: /关\s*闭/ }).click(); await finish(2);
    const entityBatch = await batch(entityName); const entityIds = entityBatch.batch.result.record_ids;
    const a = await api(`entity?id=${entityIds[0]}`); const b = await api(`entity?id=${entityIds[1]}`);
    assert.notEqual(a.entity.id, b.entity.id); assert.equal(a.entity.client_group_id, b.entity.client_group_id);
    console.log('PASS browser: shared client code preserves separate subjects and read-only CDD calculation');
    await panel.getByRole('button', { name: '开始新批次' }).click(); await choose('导入类型', '客户与投资主体');
    const correctionName = `浏览器主体纠错-${suffix}.xlsx`;
    await upload(correctionName, 'entities', [{ id: a.entity.id, 'entity.review_form_signed_date': 'Hold' }]);
    await panel.getByText('需要修正', { exact: true }).waitFor();
    const dateLabel = mainImportFields('entities').find(field => field.key === 'entity.review_form_signed_date')!.label;
    await panel.getByLabel(`第 2 行 ${dateLabel}`, { exact: true }).fill('#清空'); await panel.getByRole('button', { name: '重新校验并预览' }).click();
    await panel.getByText('可提交', { exact: true }).waitFor(); await finish(1);
    const correction = await batch(correctionName); assert.equal(correction.rows[0].raw[dateLabel], 'Hold'); assert.equal(correction.rows[0].corrected[dateLabel], '#清空');
    assert.equal((await api(`entity?id=${a.entity.id}`)).entity.review_form_signed_date, null);
    console.log('PASS browser: invalid historical date is corrected explicitly without altering its original source');
    assert.deepEqual(errors, []);
    writeFileSync('.runtime/browser-main-import-result.json', JSON.stringify({ passed: true, checks: 4, timestamp: new Date().toISOString(), parent_fund_id: parent.fund.id, entity_ids: entityIds }, null, 2));
  } catch (error) { await page.screenshot({ path: '.runtime/browser-main-import-failure.png', fullPage: true }); console.error((await page.locator('body').innerText()).slice(-4000)); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
