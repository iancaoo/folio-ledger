import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { sampleFund, sampleEntity } from './fixtures';
import * as XLSX from 'xlsx';
import { exchangeMapping, exportColumns } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/export';

const base = 'http://127.0.0.1:13000/api/';
let token: string, readerToken: string, editorToken: string, configuratorToken: string, outsiderToken: string, fund: any, entity: any;
let replayTrade: any, committedBatch: any, tradeBatch: any, mainBatch: any, seriesBatch: any;
async function call(resource: string, data?: any, auth = token, role = 'root') {
  const response = await fetch(base + resource, { method: data ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Authenticator': 'basic', ...(auth ? { Authorization: `Bearer ${auth}`, 'X-Role': role } : {}) }, body: data ? JSON.stringify(data) : undefined });
  return { status: response.status, body: await response.json() };
}
const mutation = async (action: string, payload: any, request_key = randomUUID()) => {
  const response = await call(`finance:${action}`, { ...payload, request_key });
  if (response.status === 200 && ['stageImport', 'previewImport'].includes(action)) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const view = await call(`finance:importBatch?id=${response.body.data.batch_id}`);
      if (!['parsing', 'awaiting_file'].includes(view.body.data.batch.status)) return view;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Import parsing did not finish');
  }
  return response;
};
before(async () => {
  const c = JSON.parse(readFileSync('.runtime/dev-credentials.json', 'utf8'));
  const login = await call('auth:signIn', { account: c.admin_email, password: c.admin_password }, '');
  assert.equal(login.status, 200, 'Development login failed'); token = login.body.data.token;
  const metadata = await call('finance:metadata');
  assert.equal(metadata.body.data.demo_mode, true, 'API smoke writes may only target explicit demo mode');
  const result = await mutation('saveFund', sampleFund(`API-${Date.now()}`));
  assert.equal(result.status, 200, JSON.stringify(result.body.errors)); fund = (await call(`finance:fund?id=${result.body.data.fund_id}`)).body.data;
  const saved = await mutation('saveEntity', sampleEntity(`API-${Date.now()}`, 'API-主体'));
  assert.equal(saved.status, 200, JSON.stringify(saved.body.errors)); entity = saved.body.data;
  const roles = await call('roles:get?filterByTk=finance_reader');
  if (!roles.body.data) {
    const result = await call('roles:create', { name: 'finance_reader', title: 'Finance 只读', strategy: { actions: ['view'] } });
    assert.equal(result.status, 200, 'Cannot provision demo read-only role');
  }
  const username = `reader_${Date.now()}`; const password = randomBytes(20).toString('hex');
  const user = await call('users:create', { username, nickname: '模拟只读测试用户', password, roles: [{ name: 'finance_reader' }] });
  assert.equal(user.status, 200, JSON.stringify(user.body.errors));
  const loginReader = await call('auth:signIn', { account: username, password }, '');
  assert.equal(loginReader.status, 200, 'Read-only login failed'); readerToken = loginReader.body.data.token;
  for (const role of ['finance_editor', 'finance_configurator', 'finance_product']) {
    const username = `${role}_${Date.now()}`; const password = randomBytes(20).toString('hex');
    const created = await call('users:create', { username, nickname: '模拟权限测试用户', password, roles: [{ name: role }] });
    assert.equal(created.status, 200, 'Finance role initialization must exist before HTTP tests');
    const signedIn = await call('auth:signIn', { account: username, password }, '');
    assert.equal(signedIn.status, 200);
    if (role === 'finance_editor') editorToken = signedIn.body.data.token;
    else if (role === 'finance_configurator') configuratorToken = signedIn.body.data.token;
    else outsiderToken = signedIn.body.data.token;
  }
});

test('HTTP full platform accepts exact fund aggregate after SES initialization', () => {
  assert.equal(fund.share_classes.length, 2);
  assert.equal(fund.fund.size_100m_usd, '123456789012345.12345678');
});
test('Anonymous and read-only sessions cannot mutate; spoofed role header is rejected', async () => {
  assert.equal((await call('finance:metadata', undefined, '')).status, 401);
  const view = await call('finance:list?table=funds', undefined, readerToken, 'finance_reader');
  assert.equal(view.status, 200);
  const write = await call('finance:saveEntity', { ...sampleEntity('UNAUTHORIZED', '未授权'), request_key: randomUUID() }, readerToken, 'finance_reader');
  assert.equal(write.status, 403); assert.equal(write.body.errors[0].code, 'FORBIDDEN');
  const spoof = await call('finance:saveEntity', { ...sampleEntity('SPOOF', '伪造角色'), request_key: randomUUID() }, readerToken, 'root');
  assert.equal(spoof.status, 401);
});
test('Root cannot bypass domain API through generic collection writes', async () => {
  for (const [resource, data] of [
    [`finance_funds:update?filterByTk=${fund.fund.id}`, { short_name: '绕过测试' }],
    ['finance_transactions:create', { entity_id: entity.id, confirmed_units: '-100' }],
    [`finance_funds:destroy?filterByTk=${fund.fund.id}`, {}],
    [`finance_share_classes/${fund.share_classes[0].id}/fund:update?filterByTk=${fund.fund.id}`, { short_name: '关联写入' }],
    [`finance_funds:update?filterByTk=${encodeURIComponent(JSON.stringify([fund.fund.id]))}`, { short_name: '批量写入' }],
    ['finance_fund_versions:create', { fund_id: fund.fund.id, version_no: 999, snapshot: {} }],
  ] as any) {
    for (const [auth, role] of [[token, 'root'], [editorToken, 'finance_editor']]) {
      const result = await call(resource, data, auth, role);
      assert.equal(result.status, 403); assert.equal(result.body.errors[0].code, 'DOMAIN_API_REQUIRED');
    }
  }
});
test('HTTP trade idempotency, withdrawal, NAV, holdings and unsafe void agree', async () => {
  const values = { entity_id: entity.id, share_class_id: fund.share_classes[0].id, transaction_type: '初次申购', confirmation_date: '2026-01-01', amount: '100.00000000001', confirmed_units: '100', currency: 'USD' };
  const key = randomUUID();
  const first = await mutation('saveTrade', { values }, key);
  assert.equal(first.status, 200, JSON.stringify(first.body.errors));
  const retry = await mutation('saveTrade', { values }, key);
  assert.equal(first.body.data.id, retry.body.data.id);
  replayTrade = { values, key, outcome: first.body.data };
  const withdrawal = await mutation('saveTrade', { values: { ...values, transaction_type: '赎回', confirmation_date: '2026-01-02', confirmed_units: '30' } });
  assert.equal(withdrawal.status, 200, JSON.stringify(withdrawal.body.errors));
  const nav = await mutation('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: values.share_class_id, nav_date: '2026-01-03', nav_per_unit: '1.25' } });
  assert.equal(nav.status, 200, JSON.stringify(nav.body.errors));
  const holdings = await call(`finance:positions?entity_id=${entity.id}`);
  assert.equal(holdings.body.data[0].units, '70'); assert.equal(holdings.body.data[0].market_value, '87.5');
  const voided = await mutation('voidTrade', { id: first.body.data.id, technical_revision: 1, reason: '模拟撤销校验' });
  assert.equal(voided.status, 422); assert.equal(voided.body.errors[0].code, 'NEGATIVE_HISTORICAL_UNITS');
});
test('Report snapshot reads one entity scope with exact decimals and Finance read permissions', async () => {
  const query = `finance:reportSnapshot?entity_ids=${entity.id}&report_date=2026-01-02`;
  for (const [auth, role, status] of [[token, 'root', 200], [readerToken, 'finance_reader', 200], [configuratorToken, 'finance_configurator', 200], [outsiderToken, 'finance_product', 403], ['', '', 401]]) {
    assert.equal((await call(query, undefined, auth, role)).status, status, role);
  }
  const snapshot = (await call(query, undefined, readerToken, 'finance_reader')).body.data;
  assert.equal(snapshot.schema, 'finance.report-snapshot/v1');
  assert.deepEqual(snapshot.entities.map((row: any) => row.id), [entity.id]);
  assert.deepEqual(snapshot.transactions.map((row: any) => [row.transaction_type, row.confirmed_units]), [['初次申购', '100'], ['赎回', '30']]);
  assert.equal(snapshot.transactions[0].amount, '100.00000000001');
  assert.deepEqual(snapshot.share_classes.map((row: any) => row.id), [fund.share_classes[0].id]);
  assert.deepEqual(snapshot.fund_navs, [], 'NAV dated after report_date must be excluded');
  const later = (await call(`finance:reportSnapshot?entity_ids=${entity.id}&report_date=2026-01-03`)).body.data;
  assert.deepEqual(later.fund_navs.map((row: any) => row.nav_per_unit), ['1.25']);
  assert.equal((await call('finance:reportSnapshot?report_date=2026-01-03')).body.errors[0].code, 'REQUIRED');
  assert.equal((await call(`finance:reportSnapshot?entity_ids=${entity.id}`)).body.errors[0].code, 'REQUIRED');
  assert.equal((await call(`finance:reportSnapshot?entity_ids=${randomUUID()}&report_date=2026-01-03`)).status, 404);
});
test('HTTP import previews, corrects and commits without generic writes', async () => {
  const staged = await mutation('stageImport', { original_name: '模拟净值.csv', content_base64: Buffer.from('日期,单位净值\n2026-08-01,1.25\ninvalid,1.5\n').toString('base64'), data_type: 'nav', share_class_id: fund.share_classes[1].id });
  assert.equal(staged.status, 200, JSON.stringify(staged.body.errors));
  let result = staged.body.data;
  const mapping = { date: '日期', value: '单位净值' };
  let response = await mutation('previewImport', { batch_id: result.batch.id, technical_revision: result.batch.technical_revision, mapping });
  assert.equal(response.status, 200, JSON.stringify(response.body.errors)); result = response.body.data;
  assert.equal(result.batch.status, 'needs_correction');
  response = await mutation('previewImport', { batch_id: result.batch.id, technical_revision: result.batch.technical_revision, mapping, corrections: [{ id: result.rows[1].id, corrected: { 日期: '2026-08-02' } }] });
  assert.equal(response.status, 200, JSON.stringify(response.body.errors)); result = response.body.data;
  const saved = await mutation('commitImport', { batch_id: result.batch.id, technical_revision: result.batch.technical_revision, preview_token: result.batch.preview.token });
  assert.equal(saved.status, 200, JSON.stringify(saved.body.errors)); assert.equal(saved.body.data.committed_count, 2);
  committedBatch = saved.body.data;
});
test('Trade batch API and template enforce permissions and preserve same-day accounting', async () => {
  const url = `${base}finance:tradeTemplate`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${outsiderToken}`, 'X-Role': 'finance_product', 'X-Authenticator': 'basic' } })).status, 403);
  const downloaded = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-Role': 'root', 'X-Authenticator': 'basic' } });
  assert.equal(downloaded.status, 200); assert.ok((await downloaded.arrayBuffer()).byteLength > 1000);
  const separate = (await mutation('saveEntity', sampleEntity(`API-BATCH-${Date.now()}`, '交易批次'))).body.data;
  const headers = ['entity_id', 'isin', 'transaction_type', 'confirmation_date', 'amount', 'currency', 'confirmed_units'];
  const input = { data_type: 'transactions', original_name: '模拟交易.csv', content_base64: Buffer.from([headers.join(','), `${separate.id},${fund.share_classes[0].isin},赎回,2026-01-01,30,USD,30`, `${separate.id},${fund.share_classes[0].isin},初次申购,2026-01-01,100,USD,100`].join('\n')).toString('base64') };
  assert.equal((await call('finance:stageImport', { ...input, request_key: randomUUID() }, readerToken, 'finance_reader')).status, 403);
  const staged = await mutation('stageImport', input);
  assert.equal(staged.status, 200, JSON.stringify(staged.body.errors));
  const ready = await mutation('previewImport', { batch_id: staged.body.data.batch.id, technical_revision: staged.body.data.batch.technical_revision, mapping: Object.fromEntries(headers.map(key => [key, key])) });
  assert.equal(ready.body.data.batch.status, 'ready', JSON.stringify(ready.body));
  const batch = ready.body.data.batch;
  const payload = { batch_id: batch.id, technical_revision: batch.technical_revision, preview_token: batch.preview.token };
  assert.equal((await call('finance:commitImport', { ...payload, request_key: randomUUID() }, readerToken, 'finance_reader')).status, 403);
  const result = await mutation('commitImport', payload);
  assert.equal(result.status, 200, JSON.stringify(result.body.errors));
  tradeBatch = { payload, result: result.body.data, entity_id: separate.id };
  assert.equal((await call(`finance:positions?entity_id=${separate.id}`)).body.data[0].units, '70');
});

test('Main-data templates and fund imports preserve permissions, ownership and one version per aggregate', async () => {
  const url = `${base}finance:mainTemplate?data_type=funds&fund_kind=third_party`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${outsiderToken}`, 'X-Role': 'finance_product', 'X-Authenticator': 'basic' } })).status, 403);
  const response = await fetch(url, { headers: { Authorization: `Bearer ${readerToken}`, 'X-Role': 'finance_reader', 'X-Authenticator': 'basic' } });
  assert.equal(response.status, 200); assert.ok((await response.arrayBuffer()).byteLength > 1000);
  const input = sampleFund(`API-MAIN-${Date.now()}`);
  const flatten = (prefix: string, value: any) => Object.fromEntries(Object.entries(value).flatMap(([key, item]: any) => item && typeof item === 'object' ? Object.entries(item).map(([part, v]) => [`${prefix}.${key}.${part}`, v]) : [[`${prefix}.${key}`, item]]));
  const rows = input.share_classes.map((share, index) => ({ fund_key: '新基金', ...(index === 0 ? { ...flatten('fund', input.fund), ...flatten('details', input.details) } : {}), ...flatten('share', share.values), ...flatten('terms', share.terms) }));
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))]; const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns, ...rows.map(row => columns.map(key => row[key] ?? ''))]), '模拟资料');
  const staged = await mutation('stageImport', { data_type: 'funds', fund_kind: 'third_party', original_name: '模拟基金主数据.xlsx', content_base64: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }).toString('base64') });
  assert.equal(staged.status, 200, JSON.stringify(staged.body.errors));
  const ready = await mutation('previewImport', { batch_id: staged.body.data.batch.id, technical_revision: staged.body.data.batch.technical_revision, mapping: Object.fromEntries(columns.map(key => [key, key])) });
  assert.equal(ready.body.data.batch.status, 'ready', JSON.stringify(ready.body));
  const batch = ready.body.data.batch;
  assert.equal((await call(`finance:importBatch?id=${batch.id}`, undefined, readerToken, 'finance_reader')).status, 403);
  const payload = { batch_id: batch.id, technical_revision: batch.technical_revision, preview_token: batch.preview.token };
  const saved = await mutation('commitImport', payload); assert.equal(saved.status, 200, JSON.stringify(saved.body.errors));
  mainBatch = { payload, result: saved.body.data };
  assert.equal(saved.body.data.object_count, 1); assert.equal(saved.body.data.committed_count, 2);
  assert.equal((await call(`finance:versions?fund_id=${saved.body.data.record_ids[0]}`)).body.data.length, 1);
});

test('Series templates and mixed-object benchmark batches enforce permission and preserve a restartable result', async () => {
  const url = `${base}finance:seriesTemplate?data_type=benchmark&target_mode=columns`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${outsiderToken}`, 'X-Role': 'finance_product', 'X-Authenticator': 'basic' } })).status, 403);
  const download = await fetch(url, { headers: { Authorization: `Bearer ${readerToken}`, 'X-Role': 'finance_reader', 'X-Authenticator': 'basic' } });
  assert.equal(download.status, 200); assert.match(download.headers.get('cache-control') || '', /private/);
  const book = XLSX.read(Buffer.from(await download.arrayBuffer()), { type: 'buffer' });
  assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1 })[0], ['基准 ID', '日期', '基准数值', '记录 ID（修改时填写）']);
  const a = await mutation('saveBenchmark', { values: { name: `模拟API基准A-${Date.now()}`, category: '模拟' } });
  const b = await mutation('saveBenchmark', { values: { name: `模拟API基准B-${Date.now()}`, category: '模拟' } });
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const input = { data_type: 'benchmark', target_mode: 'columns', original_name: '模拟API多基准.csv', content_base64: Buffer.from(`基准 ID,日期,数值\n${a.body.data.id},2026-02-01,123456789012345.12345678\n${b.body.data.id},2026-02-01,1.25`).toString('base64') };
  assert.equal((await call('finance:stageImport', { ...input, request_key: randomUUID() }, readerToken, 'finance_reader')).status, 403);
  const staged = await mutation('stageImport', input); assert.equal(staged.status, 200);
  const preview = await mutation('previewImport', { batch_id: staged.body.data.batch.id, technical_revision: staged.body.data.batch.technical_revision, mapping: { benchmark_id: '基准 ID', date: '日期', value: '数值' } });
  assert.equal(preview.body.data.batch.status, 'ready', JSON.stringify(preview.body.errors));
  assert.equal(preview.body.data.rows[0].normalized.values.index_value, '123456789012345.12345678');
  const batch = preview.body.data.batch; const payload = { batch_id: batch.id, technical_revision: batch.technical_revision, preview_token: batch.preview.token };
  assert.equal((await call('finance:commitImport', { ...payload, request_key: randomUUID() }, readerToken, 'finance_reader')).status, 403);
  assert.equal((await call(`finance:importBatch?id=${batch.id}`, undefined, readerToken, 'finance_reader')).status, 403);
  const saved = await mutation('commitImport', payload); assert.equal(saved.status, 200); assert.equal(saved.body.data.inserted_count, 2);
  seriesBatch = { payload, result: saved.body.data };
});

test('Paged queries and remote reference lookup keep Finance permissions, complete labels and exact same-day lookup', async () => {
  for (const resource of ['summary','list?table=funds','lookup?resource=share_classes','positionList','userLookup?group=all',`seriesAt?data_type=nav&parent_id=${fund.share_classes[0].id}&date=2026-01-03`]) {
    assert.equal((await call(`finance:${resource}`, undefined, '')).status, 401);
    assert.equal((await call(`finance:${resource}`, undefined, outsiderToken, 'finance_product')).status, 403);
    assert.equal((await call(`finance:${resource}`, undefined, readerToken, 'finance_reader')).status, 200);
  }
  const shares = await call(`finance:lookup?resource=share_classes&search=${encodeURIComponent(fund.share_classes[0].isin)}&page_size=1`, undefined, readerToken, 'finance_reader');
  assert.equal(shares.body.data.rows[0].value, fund.share_classes[0].id); assert.match(shares.body.data.rows[0].label, /USD/);
  const list = await call(`finance:list?table=transactions&entity_id=${entity.id}&page_size=1&state=active`);
  assert.equal(list.body.data.length, 1); assert.equal(list.body.meta.count, 2); assert.equal(list.body.meta.page_size, 1);
  assert.ok(list.body.data[0]._entity_name); assert.ok(list.body.data[0]._share_label);
  assert.equal((await call('finance:list?table=request_receipts')).status, 403);
  assert.equal((await call('finance:list?table=funds&page=-1')).status, 422);
  assert.equal((await call('finance:list?table=funds&order=short_name')).status, 422);
  const at = await call(`finance:seriesAt?data_type=nav&parent_id=${fund.share_classes[0].id}&date=2026-01-03`); assert.equal(at.body.data.nav_per_unit,'1.25');
  const positions = await call(`finance:positionList?entity_id=${entity.id}&page_size=1`); assert.equal(positions.body.data.rows[0].units,'70'); assert.equal(positions.body.data.rows[0].market_value,'87.5');
  const users = await call('finance:userLookup?group=all&page_size=1'); assert.equal(users.body.data.rows.length,1); assert.deepEqual(Object.keys(users.body.data.rows[0].record).sort(),['id','nickname','username']);
});

test('Application restart preserves the original success location and committed import result', async () => {
  const restart = spawnSync('python3', ['scripts/dev-app.py', 'restart'], { encoding: 'utf8', timeout: 25000 });
  assert.equal(restart.status, 0, restart.stderr || restart.stdout);
  // A keep-alive socket from the stopped process may reset on the first request.
  // Retry the exact same idempotency key, just as the UI retains it on network failure.
  let retry: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { retry = await mutation('saveTrade', { values: replayTrade.values }, replayTrade.key); break; }
    catch (error) { if (attempt === 2) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert.equal(retry.status, 200, JSON.stringify(retry.body.errors)); assert.deepEqual(retry.body.data, replayTrade.outcome);
  const batch = await call(`finance:importBatch?id=${committedBatch.batch_id}`);
  assert.equal(batch.status, 200); assert.equal(batch.body.data.batch.status, 'committed');
  assert.deepEqual(batch.body.data.batch.result, committedBatch);
  assert.deepEqual((await mutation('commitImport', tradeBatch.payload)).body.data, tradeBatch.result);
  assert.deepEqual((await mutation('commitImport', mainBatch.payload)).body.data, mainBatch.result);
  assert.deepEqual((await mutation('commitImport', seriesBatch.payload)).body.data, seriesBatch.result);
  assert.equal((await call(`finance:versions?fund_id=${mainBatch.result.record_ids[0]}`)).body.data.length, 1);
  assert.equal((await call(`finance:positions?entity_id=${tradeBatch.entity_id}`)).body.data[0].units, '70');
  assert.equal((await call(`finance:positions?entity_id=${entity.id}`)).body.data[0].units, '70');
});

test('Finance editor can enter data but cannot change platform schema, roles, plugins or option configuration', async () => {
  const metadata = await call('finance:metadata', undefined, editorToken, 'finance_editor');
  assert.equal(metadata.status, 200); assert.deepEqual(metadata.body.data.permissions, { write: true, configure: false });
  assert.ok(metadata.body.data.options.length > 30);
  assert.equal((await call('finance:users?group=product', undefined, editorToken, 'finance_editor')).status, 200);
  const saved = await call('finance:saveEntity', { ...sampleEntity(`EDITOR-${Date.now()}`, '录入员'), request_key: randomUUID() }, editorToken, 'finance_editor');
  assert.equal(saved.status, 200, JSON.stringify(saved.body.errors));
  for (const [resource, data] of [
    ['collections:create', { name: `forbidden_${Date.now()}`, title: '拒绝创建测试' }],
    ['uiSchemas:insert', { type: 'void', 'x-component': 'div', name: 'forbidden_test' }],
    ['roles:create', { name: 'forbidden_test', title: '禁止提权', allowConfigure: true }],
    ['pm:list', undefined],
    ['finance:saveOptions', { request_key: randomUUID() }],
  ] as any) assert.equal((await call(resource, data, editorToken, 'finance_editor')).status, 403, resource);
  const config = await call('finance:metadata', undefined, configuratorToken, 'finance_configurator');
  assert.deepEqual(config.body.data.permissions, { write: false, configure: true });
  const row = config.body.data.options.find(item => item.source_key === '自营基金页面:25');
  const configured = await call('finance:saveOptions', { source_key: row.source_key, technical_revision: row.technical_revision, confirmed: false, values: row.values, request_key: randomUUID() }, configuratorToken, 'finance_configurator');
  assert.equal(configured.status, 200, JSON.stringify(configured.body.errors));
  assert.equal((await call('finance:saveEntity', { ...sampleEntity('CONFIG-DENY', '禁止业务写入'), request_key: randomUUID() }, configuratorToken, 'finance_configurator')).status, 403);
});

test('Private document upload, protected downloads, retry and physical deletion use one file task', async () => {
  const content = Buffer.from('明确标记的模拟文档。Private Finance file test.\n');
  const payload = { fund_id: fund.fund.id, document_type: '其他', original_name: '../模拟说明.txt', content_base64: content.toString('base64') };
  const key = randomUUID();
  const uploaded = await mutation('uploadDocument', payload, key);
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.data.status, 'complete');
  const retry = await mutation('uploadDocument', payload, key);
  assert.equal(retry.body.data.document_id, uploaded.body.data.document_id);
  const id = uploaded.body.data.document_id;
  const documents = await call(`finance:documents?fund_id=${fund.fund.id}`);
  const document = documents.body.data.find(row => row.id === id);
  assert.equal(document.original_name, '模拟说明.txt'); assert.equal(String(document.size_bytes), String(content.length));
  assert.equal(document.storage_key, undefined);
  const credentials = JSON.parse(readFileSync('.runtime/dev-credentials.json', 'utf8'));
  const db = new Client({ host: '127.0.0.1', port: 15432, user: 'finance_app', database: 'finance_dev', password: credentials.database_password });
  let stored: any;
  try {
    await db.connect();
    stored = (await db.query('SELECT f.id, f.filename FROM finance_file_records f JOIN finance_fund_documents d ON d.storage_key=f.id::text WHERE d.id=$1', [id])).rows[0];
  } finally { await db.end(); }
  const physical = resolve('apps/nocobase/storage/finance/documents', stored.filename);
  assert.equal(existsSync(physical), true, 'Success must correspond to an actual private file');
  const headers = { Authorization: `Bearer ${readerToken}`, 'X-Role': 'finance_reader', 'X-Authenticator': 'basic' };
  const downloaded = await fetch(`${base}finance:downloadDocument?id=${id}`, { headers });
  assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), content);
  assert.equal((await fetch(`${base}finance:downloadDocument?id=${id}`)).status, 401);
  for (const url of [`${base}finance_file_records:getFile?filterByTk=${stored.id}`, `http://127.0.0.1:13000/files/main/main/finance_file_records/${stored.id}.txt`]) {
    const native = await fetch(url, { headers, redirect: 'manual' });
    assert.equal(native.status, 200, url); assert.deepEqual(Buffer.from(await native.arrayBuffer()), content);
    assert.equal((await fetch(url, { redirect: 'manual' })).status, 401, url);
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${outsiderToken}`, 'X-Role': 'finance_product', 'X-Authenticator': 'basic' }, redirect: 'manual' })).status, 403, url);
  }
  for (const prefix of ['/finance-private-files/', '/storage/finance/documents/', '/storage/uploads/']) {
    const response = await fetch(`http://127.0.0.1:13000${prefix}${stored.filename}`, { redirect: 'manual' });
    assert.notDeepEqual(Buffer.from(await response.arrayBuffer()), content, 'No raw public path may expose the file');
  }
  const unauthorizedTask = await call(`finance:fileTask?id=${uploaded.body.data.task_id}`, undefined, readerToken, 'finance_reader');
  assert.equal(unauthorizedTask.status, 403);
  assert.equal((await call(`finance_file_records:list`)).status, 403);
  const versions = await call(`finance:versions?fund_id=${fund.fund.id}`);
  assert.equal(versions.body.data.length, 1);
  const removed = await mutation('deleteDocument', { id, technical_revision: document.technical_revision });
  assert.equal(removed.status, 200, JSON.stringify(removed.body)); assert.equal(removed.body.data.status, 'complete');
  assert.equal(existsSync(physical), false, 'Complete deletion must remove the actual file');
  assert.equal((await fetch(`${base}finance:downloadDocument?id=${id}`, { headers })).status, 404);
  assert.equal((await call(`finance:documents?fund_id=${fund.fund.id}`)).body.data.length, 0);
  const again = await mutation('retryFile', { task_id: removed.body.data.task_id });
  assert.equal(again.body.data.status, 'complete');
});

test('Document size and signature checks run through the real HTTP body parser', async () => {
  const invalid = await mutation('uploadDocument', { fund_id: fund.fund.id, document_type: '其他', original_name: '模拟伪造.pdf', content_base64: Buffer.from('not a PDF').toString('base64') });
  assert.equal(invalid.status, 422); assert.equal(invalid.body.errors[0].code, 'FILE_SIGNATURE_MISMATCH');
  const large = Buffer.alloc(10 * 1024 * 1024, 'x');
  const uploaded = await mutation('uploadDocument', { fund_id: fund.fund.id, document_type: '其他', original_name: '模拟上限10MB.txt', content_base64: large.toString('base64') });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body)); assert.equal(uploaded.body.data.status, 'complete');
  const docs = (await call(`finance:documents?fund_id=${fund.fund.id}`)).body.data;
  const row = docs.find(row => row.id === uploaded.body.data.document_id);
  assert.equal(String(row.size_bytes), String(large.length));
  assert.equal((await mutation('deleteDocument', { id: row.id, technical_revision: row.technical_revision })).body.data.status, 'complete');
  const tooLarge = await mutation('uploadDocument', { fund_id: fund.fund.id, document_type: '其他', original_name: '模拟超限.txt', content_base64: Buffer.alloc(large.length + 1, 'x').toString('base64') });
  assert.equal(tooLarge.status, 422); assert.equal(tooLarge.body.errors[0].code, 'INVALID_FILE_TYPE');
});

test('Owned import history and original files survive reload; cancellation cannot undo a committed batch', async () => {
  const batches = await call('finance:importBatches');
  assert.ok(batches.body.data.rows.some(row => row.id === committedBatch.batch_id));
  assert.equal((await call('finance:importBatches', undefined, readerToken, 'finance_reader')).body.data.count, 0);
  const url = `${base}finance:downloadImport?id=${committedBatch.batch_id}`;
  const source = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'X-Role': 'root', 'X-Authenticator': 'basic' } });
  assert.equal(source.status, 200); assert.match(await source.text(), /invalid,1.5/);
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${readerToken}`, 'X-Role': 'finance_reader', 'X-Authenticator': 'basic' } })).status, 403);
  const batch = (await call(`finance:importBatch?id=${committedBatch.batch_id}`)).body.data.batch;
  const rejected = await mutation('cancelImport', { batch_id: batch.id, technical_revision: batch.technical_revision });
  assert.equal(rejected.status, 409); assert.equal(rejected.body.errors[0].code, 'BATCH_COMMITTED');
  const invalid = await mutation('stageImport', { original_name: '模拟解析失败.csv', data_type: 'nav', share_class_id: fund.share_classes[0].id, content_base64: Buffer.from('重复,重复\n1,2\n').toString('base64') });
  assert.equal(invalid.status, 200); assert.equal(invalid.body.data.batch.status, 'failed');
  assert.equal(invalid.body.data.rows.length, 0);
});

test('Personal draft HTTP lifecycle enforces owner and role, survives restart, and consumes exactly once', async () => {
  const input = { form_type: 'benchmark', content: { values: { name: `草稿 HTTP ${Date.now()}`, remarks: '未填分类；123456789012345.123456789000' } }, request_key: randomUUID() };
  for (const action of ['saveDraft', 'discardDraft']) {
    assert.equal((await call(`finance:${action}`, input, '')).status, 401);
    for (const [auth, role] of [[readerToken,'finance_reader'],[configuratorToken,'finance_configurator'],[outsiderToken,'finance_product']]) assert.equal((await call(`finance:${action}`, input, auth, role)).status, 403);
  }
  const created = await call('finance:saveDraft', input, editorToken, 'finance_editor'); assert.equal(created.status, 200, JSON.stringify(created.body));
  const draft = created.body.data;
  assert.equal((await call(`finance:draft?id=${draft.id}`)).status, 404, 'root has no implicit access to another owner');
  assert.equal((await call(`finance:discardDraft`, { ...draft, request_key: randomUUID() })).status, 404);
  assert.equal((await call(`finance_entry_drafts:get?filterByTk=${draft.id}`)).status, 403);
  assert.equal((await call(`finance:drafts`, undefined, '')).status, 401);
  assert.equal((await call(`finance:saveDraft`, undefined, editorToken, 'finance_editor')).status, 405);
  const restart = spawnSync('python3', ['scripts/dev-app.py', 'restart'], { encoding: 'utf8', timeout: 25000 });
  assert.equal(restart.status, 0, restart.stderr || restart.stdout);
  let recovered: any;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { recovered = await call(`finance:draft?id=${draft.id}`, undefined, editorToken, 'finance_editor'); if (recovered.status === 200) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(recovered?.status, 200); assert.deepEqual(recovered.body.data.content, input.content);
  const list = await call('finance:drafts?form_type=benchmark&search='+encodeURIComponent(input.content.values.name), undefined, editorToken, 'finance_editor');
  assert.equal(list.body.data.count, 1); assert.equal(list.body.data.rows[0].id, draft.id);
  assert.equal((await call('finance:drafts?search='+encodeURIComponent(input.content.values.name))).body.data.count, 0);
  const formal = { values: { ...input.content.values, category: '模拟分类' }, draft, request_key: randomUUID() };
  const saved = await call('finance:saveBenchmark', formal, editorToken, 'finance_editor'); assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const retry = await call('finance:saveBenchmark', formal, editorToken, 'finance_editor'); assert.deepEqual(retry.body, saved.body);
  assert.equal((await call(`finance:draft?id=${draft.id}`, undefined, editorToken, 'finance_editor')).status, 404);
  assert.equal((await call('finance:saveBenchmark', { ...formal, request_key: randomUUID() }, editorToken, 'finance_editor')).status, 404);
  const records = await call('finance:list?table=benchmarks&search='+encodeURIComponent(input.content.values.name)); assert.equal(records.body.meta.count, 1);
});

test('Quality API allows Finance readers, masks private import failures, and protects corrective writes', async () => {
  assert.equal((await call('finance:issues',undefined,'')).status,401);
  assert.equal((await call('finance:issues',undefined,outsiderToken,'finance_product')).status,403);
  const future = await mutation('saveSeries',{data_type:'returns',expected_revision:null,values:{share_class_id:fund.share_classes[0].id,return_date:'2040-01-01',mtd_return:'0.00000000000001',estimate_label:null}});
  assert.equal(future.status,200);
  for(const [auth,role] of [[token,'root'],[readerToken,'finance_reader'],[editorToken,'finance_editor'],[configuratorToken,'finance_configurator']]) {
    const issues=await call(`finance:issues?category=unknown_estimate&fund_id=${fund.fund.id}`,undefined,auth,role);
    assert.equal(issues.status,200,JSON.stringify(issues.body));assert.ok(issues.body.data.rows.some(row=>row.record_id===future.body.data.id));
  }
  const name=`质量API私有-${Date.now()}.csv`;
  const uploaded=await call('finance:stageImport',{data_type:'nav',share_class_id:fund.share_classes[0].id,original_name:name,content_base64:Buffer.from('重复,重复\n1,2\n').toString('base64'),request_key:randomUUID()},editorToken,'finance_editor');assert.equal(uploaded.status,200);
  let batch:any;
  for(let attempt=0;attempt<50;attempt++){batch=await call('finance:importBatch?id='+uploaded.body.data.batch_id,undefined,editorToken,'finance_editor');if(batch.body.data.batch.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(batch.body.data.batch.status,'failed');
  const query='finance:issues?category=imports&search='+encodeURIComponent(name);
  assert.equal((await call(query,undefined,editorToken,'finance_editor')).body.data.count,1);
  assert.equal((await call(query)).body.data.count,0);
  assert.equal((await call(query,undefined,readerToken,'finance_reader')).body.data.count,0);
  assert.equal((await call('finance:issues?owner_id=1')).status,422);
  assert.equal((await call('finance:issues?category=constructor')).status,422);
  const benchmark=await mutation('saveBenchmark',{values:{name:`模拟质量API基准-${Date.now()}`}});
  const value=await mutation('saveSeries',{data_type:'benchmark',expected_revision:null,values:{benchmark_id:benchmark.body.data.id,value_date:'2040-01-01',index_value:'1.25'}});
  const deletion={data_type:'benchmark',...value.body.data,request_key:randomUUID()};
  assert.equal((await call('finance:deleteSeries',deletion,readerToken,'finance_reader')).status,403);
  assert.equal((await call('finance:deleteSeries',deletion)).status,200);
  assert.equal((await call(`finance:list?table=benchmarks&id=${benchmark.body.data.id}`)).body.meta.count,1);
});

test('Business exports reuse Finance read permissions, hide private tables and roundtrip through protected import actions', async () => {
  for (const [auth, role, status] of [[token, 'root', 200], [readerToken, 'finance_reader', 200], [editorToken, 'finance_editor', 200], [configuratorToken, 'finance_configurator', 200], [outsiderToken, 'finance_product', 403], ['', '', 401]]) {
    const response = await fetch(base + 'finance:exportData?table=funds&fund_id=' + fund.fund.id, { headers: { 'X-Authenticator': 'basic', ...(auth ? { Authorization: `Bearer ${auth}`, 'X-Role': role } : {}) } });
    assert.equal(response.status, status, `${role} ${response.status}`);
    if (status === 200) {
      assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(response.headers.get('x-finance-count'), '1');
      const book = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: 'buffer' }); assert.ok(book.Sheets['Finance交换信息']);
    }
  }
  for (const table of ['file_records', 'entry_drafts', 'request_receipts']) assert.equal((await call(`finance:exportData?table=${table}`)).status, 403);
  assert.equal((await call('finance:exportData?table=funds&filter[is_deleted]=false')).status, 422);
  const record = await mutation('saveSeries', { data_type: 'returns', expected_revision: null, values: { share_class_id: fund.share_classes[0].id, return_date: '2045-01-01', mtd_return: '0.00000000000000000123', estimate_label: null } });
  assert.equal(record.status, 200);
  const downloaded = await fetch(base + 'finance:exportData?table=fund_returns&share_class_id=' + fund.share_classes[0].id + '&date_from=2045-01-01&date_to=2045-01-01', { headers: { Authorization: `Bearer ${readerToken}`, 'X-Role': 'finance_reader', 'X-Authenticator': 'basic' } });
  assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get('x-finance-count'), '1');
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  const denied = await call('finance:stageImport', { request_key: randomUUID(), data_type: 'returns', target_mode: 'columns', original_name: 'exchange.xlsx', content_base64: bytes.toString('base64') }, readerToken, 'finance_reader'); assert.equal(denied.status, 403);
  const batch = await mutation('stageImport', { data_type: 'returns', target_mode: 'columns', original_name: 'exchange.xlsx', content_base64: bytes.toString('base64') });
  assert.equal(batch.body.data.batch.status, 'staged');
  const book = XLSX.read(bytes, { type: 'buffer' }); const dictionary = XLSX.utils.sheet_to_json<any[]>(book.Sheets['字段说明'], { header: 1 });
  const labels = Object.fromEntries(dictionary.slice(1).map(row => [row[1], row[0]]));
  const mapping = { id: labels.id, isin: labels._isin, date: labels.return_date, value: labels.mtd_return, estimate: labels.estimate_label, value_mode: 'ratio' };
  const preview = await mutation('previewImport', { batch_id: batch.body.data.batch.id, technical_revision: batch.body.data.batch.technical_revision, mapping });
  assert.equal(preview.body.data.batch.status, 'ready', JSON.stringify(preview.body)); assert.equal(preview.body.data.rows[0].operation, 'unchanged');
  const committed = await mutation('commitImport', { batch_id: batch.body.data.batch.id, technical_revision: preview.body.data.batch.technical_revision, preview_token: preview.body.data.batch.preview.token });
  assert.equal(committed.status, 200); assert.deepEqual(committed.body.data.record_ids, [record.body.data.id]); assert.equal(committed.body.data.unchanged_count, 1);
});

test('Transaction exchange HTTP preserves voided states, fixed mappings and original IDs through reimport', async () => {
  const created = await mutation('saveFund', sampleFund('HTTP-TRADE-EXCHANGE-' + randomUUID().slice(0, 8))); const f = (await call('finance:fund?id=' + created.body.data.fund_id)).body.data;
  const e = await mutation('saveEntity', sampleEntity('HTTP-EXCHANGE-' + randomUUID().slice(0, 8), 'A'));
  const values = { entity_id: e.body.data.id, share_class_id: f.share_classes[0].id, transaction_type: '初次申购', confirmation_date: '2026-01-01', confirmed_units: '100', amount: '123456789012345.123456789', currency: 'USD', fee_rate: '0.000000123456789', remarks: '  原始备注\n\\N  ' };
  const active = await mutation('saveTrade', { values }); const inactive = await mutation('saveTrade', { values: { ...values, confirmed_units: '20', amount: '200' } });
  assert.equal((await mutation('voidTrade', { id: inactive.body.data.id, technical_revision: inactive.body.data.technical_revision, reason: '交换验证' })).status, 200);
  const response = await fetch(base + 'finance:exportData?table=transactions&fund_id=' + f.fund.id, { headers: { Authorization: `Bearer ${readerToken}`, 'X-Role': 'finance_reader', 'X-Authenticator': 'basic' } }); assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer()); const book = XLSX.read(bytes, { type: 'buffer' });
  const dictionary = XLSX.utils.sheet_to_json<any[]>(book.Sheets['字段说明'], { header: 1 }); const labels = Object.fromEntries(dictionary.slice(1).map(row => [row[1], row[0]]));
  const mapping = { ...Object.fromEntries(['entity_id', 'transaction_type', 'confirmation_date', 'amount', 'currency', 'confirmed_units', 'confirmed_nav', 'fee_rate', 'fee', 'remarks', 'id'].map(key => [key, labels[key]])), isin: labels._isin, fee_rate_mode: 'ratio' };
  let batch = await mutation('stageImport', { data_type: 'transactions', original_name: '交易交换.xlsx', content_base64: bytes.toString('base64') }); assert.equal(batch.body.data.batch.status, 'staged');
  const wrong = await mutation('previewImport', { batch_id: batch.body.data.batch.id, technical_revision: batch.body.data.batch.technical_revision, mapping: { ...mapping, amount: labels.technical_revision } }); assert.equal(wrong.status, 422); assert.equal(wrong.body.errors[0].code, 'EXCHANGE_MAPPING');
  batch = await mutation('previewImport', { batch_id: batch.body.data.batch.id, technical_revision: batch.body.data.batch.technical_revision, mapping }); assert.equal(batch.body.data.batch.status, 'ready', JSON.stringify(batch.body));
  const committed = await mutation('commitImport', { batch_id: batch.body.data.batch.id, technical_revision: batch.body.data.batch.technical_revision, preview_token: batch.body.data.batch.preview.token });
  assert.equal(committed.status, 200); assert.equal(committed.body.data.unchanged_count, 2); assert.deepEqual([...committed.body.data.record_ids].sort(), [active.body.data.id, inactive.body.data.id].sort());
  const current = (await call('finance:list?table=transactions&id=' + inactive.body.data.id)).body.data[0]; assert.equal(current.is_void, true); assert.equal(current.remarks, values.remarks); assert.equal(current.fee_rate, values.fee_rate);
});

test('Main exchange HTTP autodetects a business table, checks owner and write roles, and commits one version with original IDs', async () => {
  const made = await mutation('saveFund', sampleFund('HTTP-MAIN-EXCHANGE-' + randomUUID().slice(0, 8))); const f = (await call('finance:fund?id=' + made.body.data.fund_id)).body.data;
  const response = await fetch(base + 'finance:exportData?table=share_classes&fund_id=' + f.fund.id, { headers: { Authorization: `Bearer ${readerToken}`, 'X-Role': 'finance_reader', 'X-Authenticator': 'basic' } }); assert.equal(response.status, 200);
  const payload = { data_type: 'exchange', original_name: '份额交换.xlsx', content_base64: Buffer.from(await response.arrayBuffer()).toString('base64') };
  for (const [auth, role] of [[readerToken, 'finance_reader'], [configuratorToken, 'finance_configurator']]) assert.equal((await call('finance:stageImport', { ...payload, request_key: randomUUID() }, auth, role)).status, 403);
  let view = await mutation('stageImport', payload); assert.equal(view.body.data.batch.data_type, 'exchange');
  const mapping = exchangeMapping('share_classes'); const names = Object.fromEntries(exportColumns('share_classes').map(column => [column.key, column.label]));
  assert.equal((await call('finance:previewImport', { batch_id: view.body.data.batch.id, technical_revision: view.body.data.batch.technical_revision, mapping, request_key: randomUUID() }, editorToken, 'finance_editor')).status, 403);
  const target = view.body.data.rows[0];
  view = await mutation('previewImport', { batch_id: view.body.data.batch.id, technical_revision: view.body.data.batch.technical_revision, mapping, corrections: [{ id: target.id, corrected: { [names.class_label]: 'HTTP 修正份额' } }] });
  assert.equal(view.body.data.batch.status, 'ready', JSON.stringify(view.body));
  const input = { batch_id: view.body.data.batch.id, technical_revision: view.body.data.batch.technical_revision, preview_token: view.body.data.batch.preview.token }; const key = randomUUID();
  assert.equal((await call('finance:commitImport', { ...input, request_key: randomUUID() }, readerToken, 'finance_reader')).status, 403);
  const result = await mutation('commitImport', input, key); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.data.version_count, 1); assert.equal(result.body.data.overwritten_count, 1); assert.deepEqual((await mutation('commitImport', input, key)).body.data, result.body.data);
  const current = (await call('finance:fund?id=' + f.fund.id)).body.data; assert.equal(current.fund.business_version, 2); assert.equal(current.share_classes.find(row => row.id === target.raw[names.id]).class_label, 'HTTP 修正份额'); assert.deepEqual(current.share_classes.map(row => row.id).sort(), f.share_classes.map(row => row.id).sort());
});

test('HTTP worker parsing reports precise formula diagnostics, persists them across restart and accepts verified caches', async () => {
  const make = (value?: number) => {
    const book = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet([['日期', '数值'], ['2033-01-01', '']]); sheet.B2 = { t: 'n', f: '0.1+0.2', ...(value === undefined ? {} : { v: value }) }; XLSX.utils.book_append_sheet(book, sheet, '模拟缓存'); return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  };
  const payload = (value?: number) => ({ data_type: 'nav', share_class_id: fund.share_classes[0].id, original_name: '模拟缓存.xlsx', content_base64: make(value).toString('base64') });
  const missing = await mutation('stageImport', payload()); assert.equal(missing.body.data.batch.status, 'failed', JSON.stringify(missing.body)); assert.equal(missing.body.data.batch.context.parse_error_code, 'FORMULA_CACHE_MISSING'); assert.equal(missing.body.data.batch.context.parse_error_details.cell, 'B2'); assert.equal(missing.body.data.rows.length, 0);
  const stale = await mutation('stageImport', payload(0.4)); assert.equal(stale.body.data.batch.context.parse_error_code, 'FORMULA_CACHE_MISMATCH');
  const raw = await fetch(base + 'finance:downloadImport?id=' + stale.body.data.batch.id, { headers: { Authorization: `Bearer ${token}`, 'X-Authenticator': 'basic', 'X-Role': 'root' } }); assert.equal(raw.status, 200); assert.deepEqual(Buffer.from(await raw.arrayBuffer()), make(0.4));
  const valid = await mutation('stageImport', payload(0.3)); assert.equal(valid.body.data.batch.status, 'staged', JSON.stringify(valid.body)); assert.equal(valid.body.data.batch.context.diagnostics.formula_count, 1); assert.equal(valid.body.data.rows[0].raw['数值'], '0.3');
  const restart = spawnSync('python3', ['scripts/dev-app.py', 'restart'], { encoding: 'utf8', timeout: 60000 }); assert.equal(restart.status, 0, restart.stderr);
  const restored = await call('finance:importBatch?id=' + missing.body.data.batch.id); assert.equal(restored.body.data.batch.context.parse_error_code, 'FORMULA_CACHE_MISSING');
  const p = await mutation('previewImport', { batch_id: valid.body.data.batch.id, technical_revision: valid.body.data.batch.technical_revision, mapping: { date: '日期', value: '数值' } }); assert.equal(p.body.data.batch.status, 'ready', JSON.stringify(p.body));
  const result = await mutation('commitImport', { batch_id: p.body.data.batch.id, technical_revision: p.body.data.batch.technical_revision, preview_token: p.body.data.batch.preview.token }); assert.equal(result.status, 200); assert.equal((await call('finance:list?table=fund_navs&id=' + result.body.data.record_ids[0])).body.data[0].nav_per_unit, '0.3');
});

test('Workbench coverage follows Finance read permissions and keeps domain write protection', async () => {
  const params = `as_of=2026-06-30&fund_id=${fund.fund.id}`;
  assert.equal((await call(`finance:navCoverage?${params}`, undefined, '')).status, 401);
  assert.equal((await call(`finance:navCoverage?${params}`, undefined, outsiderToken, 'finance_product')).status, 403);
  const result = await call(`finance:navCoverage?${params}`, undefined, readerToken, 'finance_reader');
  assert.equal(result.status, 200); assert.equal(result.body.data.summary.total, 2);
  const write = await call('finance:saveSeries', { data_type: 'nav', values: { share_class_id: fund.share_classes[0].id, nav_date: '2026-06-30', nav_per_unit: '1.23' }, expected_revision: null, request_key: randomUUID() }, readerToken, 'finance_reader');
  assert.equal(write.status, 403);
});

test('Native Finance navigation preserves reader/editor/configurator entry boundaries', async (t) => {
  const rootMenu = await call('desktopRoutes:listAccessible?paginate=false');
  const flatten = (rows: any[]): any[] => rows.flatMap(row => [row, ...flatten(row.children || [])]);
  const rootRows = flatten(rootMenu.body.data || []);
  if (!rootRows.some(row => row.type === 'flowPage' && row.title === '基金列表')) {
    t.skip('Native navigation has not been provisioned in this environment'); return;
  }
  for (const [role, auth, configure] of [
    ['finance_reader', readerToken, false], ['finance_editor', editorToken, false],
    ['finance_configurator', configuratorToken, true],
  ] as const) {
    const result = await call('desktopRoutes:listAccessible?paginate=false', undefined, auth, role);
    assert.equal(result.status, 200);
    const rows = flatten(result.body.data || []);
    for (const title of ['总览', '基金列表', '净值与收益', '客户与主体', '持仓核对', '交易录入', '导入中心', '数据质量']) {
      assert.ok(rows.some(row => row.title === title && row.type === 'flowPage'), `${role}: missing ${title}`);
    }
    assert.equal(rows.some(row => row.title === '字段候选配置'), configure, `${role}: configuration menu boundary`);
    const metadata = await call('finance:metadata', undefined, auth, role);
    assert.equal(metadata.body.data.permissions.write, role === 'finance_editor');
    assert.equal(metadata.body.data.permissions.configure, configure);
  }
  const outsiderMenu = await call('desktopRoutes:listAccessible?paginate=false', undefined, outsiderToken, 'finance_product');
  assert.equal(outsiderMenu.status, 200);
  assert.equal(flatten(outsiderMenu.body.data || []).some(row => row.title === '基金列表'), false);
});
