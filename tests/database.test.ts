import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, readFile, utimes, symlink, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Database } from '@nocobase/database';
import { collections } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/models';
import { FinanceService } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/service';
import { domainWrite, installWriteGuard, writeOptions } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/write-scope';
import { sampleFund, sampleEntity, sampleValues, sampleProprietary } from './fixtures';
import { FinanceImports, parseUpload } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/imports';
import * as XLSX from 'xlsx';
import { cddDeadline } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/values';
import CreateInstruction from '@nocobase/plugin-workflow/dist/server/instructions/CreateInstruction';
import UpdateInstruction from '@nocobase/plugin-workflow/dist/server/instructions/UpdateInstruction';
import { FinanceOptions, initializeOptions } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/options';
import { optionDefinitions } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/options';
import { applyFinanceConstraints } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/constraints';
import { FinanceFiles } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/files';
import LocalStorage from '@nocobase/plugin-file-manager/dist/server/storages/local';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { tradeImportFields } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/trade-import';
import { mainImportFields } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/main-import';
import { FinanceQueries } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/queries';
import { FinanceDrafts } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/drafts';
import { FinanceIssues } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/issues';
import { FinanceExports } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/exports';
import { exportTables, exportColumns, exchangeMapping, exchangeSheet, exchangeText, exchangeValue } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/export';

const credentials = JSON.parse(readFileSync('.runtime/dev-credentials.json', 'utf8'));
const db = new Database({ dialect: 'postgres', host: '127.0.0.1', port: 15432,
  database: 'finance_test', username: 'finance_app', password: credentials.database_password, logging: false });
const service = new FinanceService(db, true);
const imports = new FinanceImports(service, '.runtime/test-imports');
const importMutation = async (method: string, payload: any, actor = 'test-user', key = randomUUID()) => {
  if (method === 'stage') {
    const queued = await imports.upload({ ...payload, request_key: key }, actor);
    await imports.process(queued.batch_id);
    return imports.view(queued.batch_id, actor);
  }
  const outcome = await service.write(actor, method, key, payload, transaction => imports[method](payload, transaction, actor));
  return method === 'commit' ? outcome : imports.view(outcome.batch_id, actor);
};
const mutate = async (method: string, payload: any, key = randomUUID()) => {
  const outcome = await service.write('test-user', method, key, payload, transaction => service[method](payload, transaction));
  if (outcome.fund_id) return (await service.model('fund_versions').findOne({ where: { fund_id: outcome.fund_id, version_no: outcome.version_no } })).get('snapshot');
  if (method === 'saveEntity') {
    const entity = (await service.model('investment_entities').findByPk(outcome.id)).toJSON();
    return { ...entity, next_cdd_deadline: cddDeadline(entity.latest_cdd_approval_date) };
  }
  return outcome;
};
const errorCode = (code: string) => (error: any) => error.code === code;
let fund: any, entityA: any, entityB: any;
before(async () => {
  assert.equal(db.options.database, 'finance_test', 'Destructive test setup must never target development');
  for (const collection of collections) db.collection(collection as any);
  await db.sync({ force: true });
  await applyFinanceConstraints(db);
  installWriteGuard(db);
  await initializeOptions(db);
  fund = await mutate('saveFund', sampleFund('DB-TEST'));
  entityA = await mutate('saveEntity', sampleEntity('DEMO-CLIENT', 'A'));
  entityB = await mutate('saveEntity', sampleEntity('DEMO-CLIENT', 'B'));
});
after(async () => db.close());
const trade = (units: string, type = '初次申购', date = '2026-01-01', entity = entityA) => ({ values: {
  entity_id: entity.id, share_class_id: fund.share_classes[0].id, transaction_type: type,
  confirmation_date: date, confirmed_units: units, currency: 'USD', amount: '123.456789012345', confirmed_nav: '1.0001', fee_rate: '0.02', fee: '0', remarks: '模拟交易；金额与份额分别保存',
} });

test('model stores two share classes and two entities under one group', () => {
  assert.equal(fund.share_classes.length, 2);
  assert.notEqual(entityA.id, entityB.id);
  assert.equal(entityA.client_group_id, entityB.client_group_id);
  assert.equal(entityA.next_cdd_deadline, '2027-02-27');
});
test('A01: different currencies and fee terms share one fund while NAVs and trades remain class-specific', async () => {
  const input = sampleFund('A01-ISOLATION');
  input.share_classes[0].terms.management_fee_text = '1.25%';
  input.share_classes[1].values.currency = 'JPY'; input.share_classes[1].terms.management_fee_text = '2.5%';
  const aggregate = await mutate('saveFund', input);
  const entity = await mutate('saveEntity', sampleEntity('A01-CLIENT', '两份额隔离'));
  for (const [index, units, nav] of [[0, '10', '1.25'], [1, '20', '140']] as const) {
    const share = aggregate.share_classes[index];
    assert.equal(share.fund_id, aggregate.fund.id);
    await mutate('saveTrade', { values: { entity_id: entity.id, share_class_id: share.id, transaction_type: '初次申购', confirmation_date: '2026-01-01', confirmed_units: units, amount: units, currency: share.currency } });
    await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: share.id, nav_date: '2026-01-01', nav_per_unit: nav } });
  }
  const positions = await service.positions(entity.id);
  for (const [index, currency, units, value] of [[0, 'USD', '10', '12.5'], [1, 'JPY', '20', '2800']] as const) {
    const position = positions.find(row => row.share_class_id === aggregate.share_classes[index].id);
    assert.equal(position.currency, currency); assert.equal(position.units, units); assert.equal(position.market_value, value);
  }
  input.share_classes[0].terms.management_fee_text = '1.5%';
  const edited = await mutate('saveFund', { ...input, id: aggregate.fund.id, technical_revision: 1, share_classes: input.share_classes.map((row, index) => ({ ...row, id: aggregate.share_classes[index].id })) });
  assert.equal(edited.share_classes[1].terms.management_fee_text, '2.5%');
  assert.deepEqual(await service.positions(entity.id), positions);
});
test('Nullable UUID relations remain absent; manual entry never invents import provenance', async () => {
  const separate = await mutate('saveFund', sampleFund('NULL-UUID'));
  const record = await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: separate.share_classes[1].id, nav_date: '2025-12-31', nav_per_unit: '1' } });
  const row = await service.model('fund_navs').findByPk(record.id);
  assert.equal(row.get('source_batch_id'), null);
  assert.equal(row.get('source_sheet'), null);
  assert.equal(row.get('source_row'), null);
  const options = collections.flatMap(collection => collection.fields.filter(field => field.type === 'uuid'));
  assert.ok(options.every(field => field.autoFill === (field.name === 'id')));
});
test('PostgreSQL NUMERIC is unscaled and API values remain exact strings', async () => {
  assert.equal(fund.fund.size_100m_usd, '123456789012345.12345678');
  const [columns]: any = await db.sequelize.query("SELECT data_type,numeric_scale FROM information_schema.columns WHERE table_name='finance_funds' AND column_name='size_100m_usd'");
  assert.equal(columns[0].data_type, 'numeric');
  assert.equal(columns[0].numeric_scale, null);
  assert.equal(fund.share_classes[0].terms.management_fee_text, '第一档 1.5%\n第二档按协议执行');
});
test('fund versions and idempotent retries commit together', async () => {
  const input = sampleFund('IDEMPOTENT');
  const key = randomUUID();
  const a = await mutate('saveFund', input, key);
  const b = await mutate('saveFund', input, key);
  assert.equal(a.fund.id, b.fund.id);
  assert.equal(await service.model('fund_versions').count({ where: { fund_id: a.fund.id } }), 1);
  await assert.rejects(mutate('saveFund', { ...input, fund: { ...input.fund, short_name: '不同内容' } }, key), errorCode('REQUEST_KEY_REUSED'));
  const update = { ...input, id: a.fund.id, technical_revision: 1, share_classes: input.share_classes.map((item, index) => ({ ...item, id: a.share_classes[index].id })) };
  const saved = await mutate('saveFund', update);
  assert.equal(saved.fund.business_version, 2);
  assert.equal(await service.model('fund_versions').count({ where: { fund_id: a.fund.id } }), 2);
});
test('actual transactions produce 70 units, NAV 1.25, value 87.5; unsafe void rolls back', async () => {
  const subscription = await mutate('saveTrade', trade('100'));
  await mutate('saveTrade', trade('30', '赎回', '2026-01-02'));
  await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: fund.share_classes[0].id, nav_date: '2026-01-03', nav_per_unit: '1.25' } });
  const [position] = await service.positions(entityA.id);
  assert.equal(position.units, '70'); assert.equal(position.market_value, '87.5');
  await assert.rejects(mutate('voidTrade', { id: subscription.id, technical_revision: 1, reason: '验证历史约束' }), errorCode('NEGATIVE_HISTORICAL_UNITS'));
  const row = await service.model('transactions').findByPk(subscription.id);
  assert.equal(row.get('is_void'), false); assert.equal(row.get('technical_revision'), 1);
  assert.equal(row.get('amount'), '123.456789012345');
});
test('concurrent withdrawals share an account lock and cannot create negative units', async () => {
  await mutate('saveTrade', trade('100', '初次申购', '2026-01-01', entityB));
  const outcomes = await Promise.allSettled([
    mutate('saveTrade', trade('80', '赎回', '2026-01-02', entityB)),
    mutate('saveTrade', trade('80', '赎回', '2026-01-02', entityB)),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected: any = outcomes.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'NEGATIVE_HISTORICAL_UNITS');
  const [position] = await service.positions(entityB.id);
  assert.equal(position.units, '20');
});
test('model and repository generic writes are blocked outside domain scope', async () => {
  await assert.rejects(service.model('funds').update({ short_name: 'bypass' }, { where: { id: fund.fund.id } }), errorCode('DOMAIN_WRITE_REQUIRED'));
  await assert.rejects(db.getRepository('finance_funds').update({ filterByTk: fund.fund.id, values: { short_name: 'bypass' } }), errorCode('DOMAIN_WRITE_REQUIRED'));
  const row = await service.model('funds').findByPk(fund.fund.id);
  assert.equal(row.get('short_name'), '模拟基金 DB-TEST');
});
test('failed aggregate leaves no partial fund or request receipt', async () => {
  const input = sampleFund('ROLLBACK');
  input.share_classes[1].values.isin = input.share_classes[0].values.isin;
  const key = randomUUID();
  await assert.rejects(mutate('saveFund', input, key), (error: any) => error.name === 'SequelizeUniqueConstraintError');
  assert.equal(await service.model('funds').count({ where: { lei: 'DEMO-ROLLBACK' } }), 0);
  assert.equal(await service.model('request_receipts').count({ where: { request_key: key } }), 0);
});
test('stale same-day overwrite rejected; NAV changes do not add fund version', async () => {
  const before = await service.model('fund_versions').count({ where: { fund_id: fund.fund.id } });
  const values = { share_class_id: fund.share_classes[0].id, nav_date: '2026-01-03', nav_per_unit: '1.50' };
  await assert.rejects(mutate('saveSeries', { data_type: 'nav', expected_revision: null, values }), errorCode('STALE_REVISION'));
  await mutate('saveSeries', { data_type: 'nav', expected_revision: 1, values });
  assert.equal(await service.model('fund_versions').count({ where: { fund_id: fund.fund.id } }), before);
});
test('database has no automatic business modified-by fields on funds or versions', async () => {
  const [columns]: any = await db.sequelize.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_name IN ('finance_funds','finance_fund_versions')");
  assert.equal(columns.some(row => /createdBy|updatedBy|created_by|updated_by/.test(row.column_name)), false);
});
test('Unconfirmed production options block formal writes, while demo values are labelled by mode', async () => {
  const formal = new FinanceService(db, false);
  const input = sampleFund('UNCONFIRMED');
  await assert.rejects(formal.write('test', 'saveFund', randomUUID(), input, transaction => formal.saveFund(input, transaction)), errorCode('CONFIG_UNCONFIRMED'));
});

test('Import preserves CSV decimal text, source row and first sheet; xlsx/xls accept text numbers', () => {
  const csv = Buffer.from('日期,单位净值\r\n2026-01-01,123456789012345.12345678\r\n');
  assert.equal(parseUpload('nav.csv', csv).rows[0].raw['单位净值'], '123456789012345.12345678');
  for (const bookType of ['xlsx', 'xls'] as const) {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['日期', '单位净值'], ['2026-02-01', '123456789012345.12345678']]), '首表');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['忽略表'], ['任何数据']]), '不读取');
    const parsed = parseUpload(`nav.${bookType}`, XLSX.write(book, { type: 'buffer', bookType }));
    assert.equal(parsed.rows[0].raw['单位净值'], '123456789012345.12345678');
    assert.equal(parsed.rows[0].source_row, 2); assert.equal(parsed.rows[0].source_sheet, '首表');
    assert.deepEqual(parsed.ignored_sheets, ['不读取']);
  }
});
const stage = (text: string, data_type = 'nav') => importMutation('stage', { original_name: `${data_type}.csv`, content_base64: Buffer.from(text).toString('base64'), data_type, share_class_id: fund.share_classes[0].id });
const preview = (result: any, mapping = { date: '日期', value: '数值' }, corrections = []) => importMutation('preview', { batch_id: result.batch.id, technical_revision: result.batch.technical_revision, mapping, corrections });
const commit = (result: any) => importMutation('commit', { batch_id: result.batch.id, technical_revision: result.batch.technical_revision, preview_token: result.batch.preview.token });

test('Import containing one invalid row writes nothing, corrected retry commits selected collection atomically', async () => {
  const staged = await stage('日期,数值\n2026-03-01,1.25\nnot-a-date,1.50\n');
  const invalid = await preview(staged);
  assert.equal(invalid.batch.status, 'needs_correction');
  await assert.rejects(commit(invalid), errorCode('PREVIEW_REQUIRED'));
  assert.equal(await service.model('fund_navs').count({ where: { nav_date: '2026-03-01' } }), 0);
  const fixed = await preview(invalid, { date: '日期', value: '数值' }, [{ id: invalid.rows[1].id, corrected: { 日期: '2026-03-02' } }] as any);
  assert.equal(fixed.rows[1].raw['日期'], 'not-a-date');
  assert.equal(fixed.rows[1].corrected['日期'], '2026-03-02');
  const saved = await commit(fixed);
  assert.equal(saved.committed_count, 2);
  assert.deepEqual(await commit(fixed), saved);
  const nav = await service.model('fund_navs').findByPk(saved.record_ids[1]);
  assert.equal(nav.get('source_row'), 3); assert.equal(nav.get('source_batch_id'), staged.batch.id);
});
test('Same-file same-date conflicts require explicit row selection; no last-row-wins', async () => {
  let result = await preview(await stage('日期,数值\n2026-04-01,1.25\n2026-04-01,1.30\n'));
  assert.equal(result.batch.status, 'needs_correction');
  assert.equal(result.rows[0].errors[0].code, 'DUPLICATE_FILE_KEY');
  result = await preview(result, { date: '日期', value: '数值' }, [{ id: result.rows[1].id, selected: false }] as any);
  assert.equal((await commit(result)).committed_count, 1);
});
test('Stale second row rolls back first row of whole import and preserves preview', async () => {
  const ready = await preview(await stage('日期,数值\n2026-05-01,1.25\n2026-05-02,1.30\n'));
  await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: fund.share_classes[0].id, nav_date: '2026-05-02', nav_per_unit: '2.0' } });
  await assert.rejects(commit(ready), errorCode('PREVIEW_STALE'));
  assert.equal(await service.model('fund_navs').count({ where: { nav_date: '2026-05-01' } }), 0);
  assert.equal((await imports.view(ready.batch.id, 'test-user')).batch.status, 'ready');
  const updated = await preview(ready);
  assert.equal(updated.rows[1].normalized.existing_value, '2');
  assert.equal((await commit(updated)).committed_count, 2);
});
test('Returns column mode resolves 2% and 0.02 to identical ratio while unknown estimate remains null', async () => {
  for (const [date, value, mode, expected] of [
    ['2026-06-01', '2%', 'percent', '0.02'],
    ['2026-06-02', '0.02', 'ratio', '0.02'],
    ['2026-06-03', `0.${'0'.repeat(80)}1%`, 'percent', `0.${'0'.repeat(82)}1`],
  ]) {
    const result = await preview(await stage(`日期,数值\n${date},${value}\n`, 'returns'), { date: '日期', value: '数值', value_mode: mode } as any);
    const saved = await commit(result);
    const row = await service.model('fund_returns').findByPk(saved.record_ids[0]);
    assert.equal(row.get('mtd_return'), expected); assert.equal(row.get('estimate_label'), null);
  }
});
test('Import batch visibility and writes are restricted to its owner', async () => {
  const result = await stage('日期,数值\n2026-07-01,1.00\n');
  await assert.rejects(imports.view(result.batch.id, 'other-user'), errorCode('FORBIDDEN'));
  await assert.rejects(importMutation('preview', { batch_id: result.batch.id, technical_revision: 1, mapping: { date: '日期', value: '数值' } }, 'other-user'), errorCode('FORBIDDEN'));
});
test('Request receipts retain only success locations, without duplicating business snapshots', async () => {
  const receipts = await service.model('request_receipts').findAll();
  for (const row of receipts) {
    const result = row.get('result');
    assert.equal('fund' in result || 'entity' in result || 'raw' in result || 'amount' in result || 'rows' in result || 'legal_name' in result, false);
  }
});
test('Concurrent retries of one key create one trade, including first account guard insertion', async () => {
  const values = { ...trade('0.1', '初次申购', '2026-01-01', entityB).values, share_class_id: fund.share_classes[1].id };
  const key = randomUUID();
  const [a, b] = await Promise.all([mutate('saveTrade', { values }, key), mutate('saveTrade', { values }, key)]);
  assert.deepEqual(a, b);
  assert.equal(await service.model('position_write_guards').count({ where: { entity_id: entityB.id, share_class_id: values.share_class_id } }), 1);
  const balance = (await service.positions(entityB.id)).find(row => row.share_class_id === values.share_class_id);
  assert.equal(balance.units, '0.1');
});
test('Exact NAV and tiny ratio survive database, text-cell Excel export and reimport', async () => {
  for (const [type, date, column, numeric, header] of [
    ['nav', 'nav_date', 'nav_per_unit', '123456789012345.12345678', '单位净值'],
    ['returns', 'return_date', 'mtd_return', '0.00000001', 'MTD收益（比例值）'],
  ]) {
    await mutate('saveSeries', { data_type: type, expected_revision: null, values: { share_class_id: fund.share_classes[1].id, [date]: '2026-09-01', [column]: numeric } });
    const bytes = await imports.exportSeries(type, fund.share_classes[1].id);
    assert.equal(parseUpload('export.xlsx', bytes).rows[0].raw[header], numeric);
    const staged = await importMutation('stage', { original_name: 'export.xlsx', content_base64: bytes.toString('base64'), data_type: type, share_class_id: fund.share_classes[1].id });
    const ready = await preview(staged, { date: '日期', value: header, ...(type === 'returns' ? { value_mode: 'ratio' } : {}) } as any);
    assert.equal(ready.rows[0].normalized.existing_value, numeric);
    await commit(ready);
    const record = await service.model(type === 'nav' ? 'fund_navs' : 'fund_returns').findOne({ where: { share_class_id: fund.share_classes[1].id, [date]: '2026-09-01' } });
    assert.equal(record.get(column), numeric);
  }
});
test('Domain API rejects system fields both inside values and at aggregate level', async () => {
  const input = sampleFund('FIELD-WHITELIST');
  await assert.rejects(mutate('saveFund', { ...input, is_deleted: true }), errorCode('FIELD_NOT_WRITABLE'));
  await assert.rejects(mutate('saveFund', { ...input, fund: { ...input.fund, business_version: 999 } }), errorCode('FIELD_NOT_WRITABLE'));
  await assert.rejects(mutate('saveTrade', { ...trade('1'), values: { ...trade('1').values, is_void: true } }), errorCode('FIELD_NOT_WRITABLE'));
  assert.equal(await service.model('funds').count({ where: { lei: 'DEMO-FIELD-WHITELIST' } }), 0);
});
test('Bulk, upsert, increment and hooks:false writes cannot bypass the per-query capability', async () => {
  const model = service.model('benchmarks');
  await assert.rejects(model.bulkCreate([{ id: randomUUID(), name: '未授权批量写入' }]), errorCode('DOMAIN_WRITE_REQUIRED'));
  await assert.rejects(model.create({ id: randomUUID(), name: '关闭 hook 的写入' }, { hooks: false }), errorCode('DOMAIN_WRITE_REQUIRED'));
  await assert.rejects(model.upsert({ id: randomUUID(), name: '未授权 upsert' }), errorCode('DOMAIN_WRITE_REQUIRED'));
  await assert.rejects(service.model('funds').increment('business_version', { where: { id: fund.fund.id } }), errorCode('DOMAIN_WRITE_REQUIRED'));
  await assert.rejects(domainWrite(() => model.create({ id: randomUUID(), name: '继承了上下文但没有凭证' })), errorCode('DOMAIN_WRITE_REQUIRED'));
  assert.equal(await model.count(), 0);
});
test('Nested repository relation writes and native workflow CRUD instructions are rejected', async () => {
  await assert.rejects(db.getRepository('finance_share_classes').update({ filterByTk: fund.share_classes[0].id, values: { fund: { id: fund.fund.id, short_name: '未授权关联写入' } } }), errorCode('DOMAIN_WRITE_REQUIRED'));
  const workflow: any = {
    app: { dataSourceManager: { dataSources: new Map([['main', { collectionManager: { getCollection: name => db.getCollection(name) } }]]) } },
    useDataSourceTransaction: () => undefined,
  };
  const processor: any = { getParsedValue: value => value, getScopeTransaction: () => undefined, execution: { id: 1, stack: [] } };
  const createNode: any = { id: 1, config: { collection: 'main:finance_benchmarks', params: { values: { name: '未授权工作流' } } } };
  const updateNode: any = { id: 2, config: { collection: 'main:finance_funds', params: { filter: { id: fund.fund.id }, values: { short_name: '未授权工作流' } } } };
  await assert.rejects(new CreateInstruction(workflow).run(createNode, null, processor), errorCode('DOMAIN_WRITE_REQUIRED'));
  await assert.rejects(domainWrite(() => new UpdateInstruction(workflow).run(updateNode, null, processor)), errorCode('DOMAIN_WRITE_REQUIRED'));
});
test('Different requests concurrently creating the first account preserve both real subscriptions', async () => {
  const entity = await mutate('saveEntity', sampleEntity('FIRST-ACCOUNT', '并发首次持仓'));
  const values = { ...trade('0.1', '初次申购', '2026-01-01', entity).values, share_class_id: fund.share_classes[1].id };
  await Promise.all([mutate('saveTrade', { values }), mutate('saveTrade', { values: { ...values, confirmed_units: '0.2' } })]);
  assert.equal((await service.positions(entity.id))[0].units, '0.3');
  assert.equal(await service.model('position_write_guards').count({ where: { entity_id: entity.id, share_class_id: values.share_class_id } }), 1);
});

test('Source-specific options seed once and preserve business confirmation and revisions', async () => {
  const options = new FinanceOptions(service);
  const initial = await options.list();
  assert.equal(initial.length, optionDefinitions.length);
  assert.deepEqual(initial.find(row => row.source_key === '三方基金页面:10')!.values.map(row => row.code).sort(), ['JPY', 'USD', 'Euro'].sort());
  assert.deepEqual(initial.find(row => row.source_key === '自营基金页面:10')!.values.map(row => row.code).sort(), ['JPY', 'USD'].sort());
  assert.equal(initial.find(row => row.source_key === '三方基金页面:26')!.confirmed, false);
  assert.equal(initial.find(row => row.source_key === '客户页面:6')!.confirmed, true);
  const selected = initial.find(row => row.source_key === '自营基金页面:25')!;
  const payload = { source_key: selected.source_key, technical_revision: selected.technical_revision, confirmed: false, values: [{ code: '模拟待确认策略', label: '模拟待确认策略' }] };
  const saveOptions = () => service.write('test-admin', 'saveOptions', randomUUID(), payload, transaction => options.save(payload, transaction));
  await saveOptions();
  await assert.rejects(saveOptions(), errorCode('STALE_REVISION'));
  await initializeOptions(db);
  const after = (await options.list()).find(row => row.source_key === selected.source_key)!;
  assert.equal(after.technical_revision, 2); assert.equal(after.confirmed, false);
  assert.deepEqual(after.values, payload.values);
});

test('Composite fields validate the numerical component separately from the candidate unit', async () => {
  const options = new FinanceOptions(service);
  for (const row of (await options.list()).filter(row => row.table === 'third_party_class_terms' && !row.confirmed)) {
    const payload = { source_key: row.source_key, technical_revision: row.technical_revision, confirmed: true, values: [{ code: 'USD', label: 'USD' }] };
    await service.write('test-admin', 'saveOptions', randomUUID(), payload, transaction => options.save(payload, transaction));
  }
  const formal = new FinanceService(db, false);
  const values = sampleValues('third_party_class_terms', 'third_party');
  for (const row of (await options.list()).filter(row => row.table === 'third_party_class_terms' && row.field in values)) values[row.field] = row.values[0].code;
  values.redemption_notice_offset = '123.4567890123456789';
  const check = input => formal.write('test', 'validation', randomUUID(), input, async transaction => { await formal.normalize('third_party_class_terms', input, transaction); return { id: 'validation-only', technical_revision: 1 }; });
  await check(values);
  await assert.rejects(check({ ...values, redemption_notice_day_unit: '非法单位' }), errorCode('INVALID_OPTION'));
  await assert.rejects(check({ ...values, redemption_notice_day_unit: null }), errorCode('REQUIRED'));
  await assert.rejects(check({ ...values, redemption_notice_offset: 'not-a-number' }), errorCode('DECIMAL_STRING_REQUIRED'));
  await assert.rejects(formal.write('test', 'saveEntity', randomUUID(), sampleEntity('WRONG', '编号'), transaction => formal.saveEntity(sampleEntity('WRONG', '编号'), transaction)), errorCode('INVALID_CLIENT_CODE'));
});

test('Configuration change invalidates a ready import and a new preview can commit', async () => {
  const staged = await importMutation('stage', { original_name: '模拟配置变更.csv', content_base64: Buffer.from('日期,值\n2032-01-01,1.22\n').toString('base64'), data_type: 'nav', share_class_id: fund.share_classes[1].id });
  let ready = await importMutation('preview', { batch_id: staged.batch.id, technical_revision: staged.batch.technical_revision, mapping: { date: '日期', value: '值' } });
  const options = new FinanceOptions(service);
  const option = (await options.list()).find(row => row.source_key === '三方基金页面:9')!;
  const payload = { source_key: option.source_key, technical_revision: option.technical_revision, confirmed: false, values: option.values };
  await service.write('test-admin', 'saveOptions', randomUUID(), payload, transaction => options.save(payload, transaction));
  await assert.rejects(importMutation('commit', { batch_id: ready.batch.id, technical_revision: ready.batch.technical_revision, preview_token: ready.batch.preview.token }), errorCode('PREVIEW_STALE'));
  assert.equal(await service.model('fund_navs').count({ where: { share_class_id: fund.share_classes[1].id, nav_date: '2032-01-01' } }), 0);
  ready = await importMutation('preview', { batch_id: ready.batch.id, technical_revision: ready.batch.technical_revision, mapping: { date: '日期', value: '值' } });
  assert.equal((await importMutation('commit', { batch_id: ready.batch.id, technical_revision: ready.batch.technical_revision, preview_token: ready.batch.preview.token })).committed_count, 1);
});

test('An existing NAV changed after preview refuses the selected batch; invalid rows may be excluded explicitly', async () => {
  const classId = fund.share_classes[0].id;
  const values = { share_class_id: classId, nav_date: '2033-01-01', nav_per_unit: '1.1' };
  await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values });
  const original = await preview(await stage('日期,数值\n2033-01-01,1.2\n2033-01-02,1.3\n'));
  assert.equal(original.rows[0].normalized.existing_value, '1.1');
  await mutate('saveSeries', { data_type: 'nav', expected_revision: 1, values: { ...values, nav_per_unit: '1.4' } });
  await assert.rejects(commit(original), errorCode('PREVIEW_STALE'));
  assert.equal(await service.model('fund_navs').count({ where: { share_class_id: classId, nav_date: '2033-01-02' } }), 0);
  const bad = await preview(await stage('日期,数值\n2033-02-01,1.2\ninvalid,1.3\n'));
  await assert.rejects(commit(bad), errorCode('PREVIEW_REQUIRED'));
  const selected = await preview(bad, { date: '日期', value: '数值' }, [{ id: bad.rows[1].id, selected: false }] as any);
  assert.equal((await commit(selected)).committed_count, 1);
  assert.equal((await imports.view(bad.batch.id, 'test-user')).rows[1].raw['日期'], 'invalid');
});

test('Soft delete and restore preserve holdings and references while blocking new records', async () => {
  const data = sampleFund('SOFT-DELETE');
  const aggregate = await mutate('saveFund', data);
  const entity = await mutate('saveEntity', sampleEntity('DEMO-SOFT-DELETE', '保留历史'));
  const input = { values: { entity_id: entity.id, share_class_id: aggregate.share_classes[0].id, transaction_type: '初次申购', confirmation_date: '2026-01-01', confirmed_units: '70', amount: '70', currency: 'USD' } };
  await mutate('saveTrade', input);
  await mutate('setDeleted', { table: 'funds', id: aggregate.fund.id, technical_revision: 1, deleted: true });
  assert.equal((await service.positions(entity.id))[0].fund_deleted, true);
  assert.equal((await service.positions(entity.id))[0].units, '70');
  await assert.rejects(mutate('saveTrade', input), errorCode('RESTORE_REQUIRED'));
  await mutate('setDeleted', { table: 'funds', id: aggregate.fund.id, technical_revision: 2, deleted: false });
  await mutate('setDeleted', { table: 'investment_entities', id: entity.id, technical_revision: 1, deleted: true });
  assert.equal((await service.positions(entity.id))[0].entity_deleted, true);
  await assert.rejects(mutate('saveTrade', input), errorCode('RESTORE_REQUIRED'));
  await mutate('setDeleted', { table: 'investment_entities', id: entity.id, technical_revision: 2, deleted: false });
  await mutate('saveTrade', { values: { ...input.values, confirmed_units: '1' } });
  assert.equal((await service.positions(entity.id))[0].units, '71');
  assert.equal((await service.versions(aggregate.fund.id)).length, 1);
});

test('Current positions ignore future facts; deleting the last usable NAV leaves a missing value', async () => {
  const aggregate = await mutate('saveFund', sampleFund('NAV-DELETE'));
  const entity = await mutate('saveEntity', sampleEntity('DEMO-NAV-DELETE', '净值缺失'));
  const values = { entity_id: entity.id, share_class_id: aggregate.share_classes[0].id, transaction_type: '初次申购', confirmation_date: '2025-01-01', confirmed_units: '70', amount: '70', currency: 'USD' };
  await mutate('saveTrade', { values });
  const nav = await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: values.share_class_id, nav_date: '2025-01-01', nav_per_unit: '1.25' } });
  await mutate('saveTrade', { values: { ...values, confirmation_date: '2099-01-01', confirmed_units: '20' } });
  await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: values.share_class_id, nav_date: '2099-01-01', nav_per_unit: '99' } });
  assert.equal((await service.positions(entity.id))[0].market_value, '87.5');
  await mutate('deleteSeries', { data_type: 'nav', id: nav.id, technical_revision: 1 });
  const [current] = await service.positions(entity.id);
  assert.equal(current.units, '70'); assert.equal(current.nav_per_unit, null); assert.equal(current.market_value, null);
  assert.equal((await service.positions(entity.id, '2099-01-01'))[0].units, '90');
  assert.equal((await service.versions(aggregate.fund.id)).length, 1);
});

test('Entity and benchmark edits use revisions and overwrite current data without business versions', async () => {
  const original = sampleEntity('DEMO-EDIT-ENTITY', '修订');
  const entity = await mutate('saveEntity', original);
  const updated = { ...original, id: entity.id, technical_revision: 1, entity: { ...original.entity, legal_name: '模拟主体修订后' }, agreements: ['IAA'], products: ['模拟产品'] };
  await mutate('saveEntity', updated);
  await assert.rejects(mutate('saveEntity', { ...updated, entity: { ...updated.entity, legal_name: '不应覆盖' } }), errorCode('STALE_REVISION'));
  const read = await service.entityAggregate(entity.id);
  assert.equal(read.entity.legal_name, '模拟主体修订后'); assert.deepEqual(read.agreements, ['IAA']); assert.deepEqual(read.products, ['模拟产品']);
  const benchmark = await mutate('saveBenchmark', { values: { name: '模拟基准', category: '模拟分类' } });
  const value = await mutate('saveSeries', { data_type: 'benchmark', expected_revision: null, values: { benchmark_id: benchmark.id, value_date: '2026-01-01', index_value: '123456789012345.12345678' } });
  await mutate('saveBenchmark', { id: benchmark.id, technical_revision: 1, values: { name: '模拟基准修改', category: '模拟分类2' } });
  assert.equal((await service.model('benchmark_values').findByPk(value.id)).get('benchmark_id'), benchmark.id);
  await assert.rejects(mutate('setDeleted', { table: 'benchmarks', id: benchmark.id, technical_revision: 2, deleted: true }), errorCode('INVALID_DELETION'));
});

test('Share-class disable belongs to one immutable fund version; referenced currencies cannot be changed', async () => {
  const input = sampleFund('CLASS-STATE');
  const original = await mutate('saveFund', input);
  const share = original.share_classes[0];
  const payload = { id: share.id, technical_revision: 1, fund_revision: 1, disabled: true };
  const key = randomUUID();
  const disabled = await mutate('setClassDisabled', payload, key);
  assert.equal(disabled.fund.business_version, 2);
  assert.equal(disabled.share_classes.find(row => row.id === share.id).is_deleted, true);
  await mutate('setClassDisabled', payload, key);
  assert.equal((await service.versions(original.fund.id)).length, 2);
  assert.equal((await service.versions(original.fund.id))[1].snapshot.share_classes[0].is_deleted, false);
  const restored = await mutate('setClassDisabled', { ...payload, technical_revision: 2, fund_revision: 2, disabled: false });
  assert.equal(restored.fund.business_version, 3);
  await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: share.id, nav_date: '2026-01-01', nav_per_unit: '1' } });
  const edit = { ...input, id: original.fund.id, technical_revision: 3, share_classes: input.share_classes.map((row, index) => ({ ...row, id: original.share_classes[index].id, values: { ...row.values, currency: 'HKD' } })) };
  await assert.rejects(mutate('saveFund', edit), errorCode('CURRENCY_IN_USE'));
  assert.equal((await service.versions(original.fund.id)).length, 3);
});

function fileHarness(label: string) {
  const directory = path.resolve('.runtime/test-documents', label);
  const storage = { id: 777, name: 'finance_private', type: 'local', renameMode: 'none', path: '', options: { documentRoot: path.join(directory, 'documents'), public: false, useOriginalUrl: false } };
  const faults = { verify: false, verifyNames: new Set<string>(), deletion: false, afterDeletion: false };
  class Adapter extends LocalStorage {
    async getFileStream(record) {
      if (faults.verify || faults.verifyNames.has(record.filename)) throw new Error('Simulated storage read failure after durable upload');
      return super.getFileStream(record);
    }
    async delete(records) {
      if (faults.deletion) return [0, records];
      const result = await super.delete(records);
      if (faults.afterDeletion) throw new Error('Simulated interruption after physical deletion');
      return result;
    }
  }
  const adapter = new Adapter(storage as any);
  const manager = {
    loadStorages: async () => {}, storagesCache: new Map([['private', storage]]), storageTypes: new Map([['local', Adapter]]),
    uploadFile: async ({ filePath }) => new Promise((resolve, reject) => adapter.make()._handleFile({}, { originalname: path.basename(filePath), stream: createReadStream(filePath) }, (error, result) => error ? reject(error) : resolve(result))),
    getFileStream: record => adapter.getFileStream(record),
  };
  const create = () => new FinanceFiles(service, manager, directory);
  return { files: create(), create, faults, directory };
}

test('Durable upload recovers after adapter failure, keeps exact bytes and one binding without a fund version', async () => {
  const f = await mutate('saveFund', sampleFund('FILE-RECOVER'));
  const harness = fileHarness(randomUUID());
  const payload = { fund_id: f.fund.id, original_name: '../模拟恢复.txt', document_type: '其他', content_base64: Buffer.from('模拟恢复文件\n').toString('base64'), request_key: randomUUID() };
  harness.faults.verify = true;
  const failed = await harness.files.upload(payload, 'file-owner');
  assert.equal(failed.status, 'failed');
  assert.equal(await service.model('fund_documents').count({ where: { fund_id: f.fund.id } }), 0);
  const operation = await harness.files.task(failed.task_id, 'file-owner');
  assert.equal(operation.get('document_id'), null);
  const destination = path.join(harness.directory, 'documents', operation.get('storage_key'));
  assert.equal(existsSync(destination), true, 'Destination survives failed verification for deterministic recovery');
  assert.equal((await harness.files.tasks(f.fund.id, 'different-owner')).length, 0);
  await assert.rejects(harness.files.retry({ task_id: failed.task_id, request_key: randomUUID() }, 'different-owner'), errorCode('FORBIDDEN'));
  harness.faults.verify = false;
  await harness.create().recover();
  const retried = await harness.files.upload(payload, 'file-owner');
  assert.equal(retried.status, 'complete');
  assert.equal(await service.model('fund_documents').count({ where: { fund_id: f.fund.id } }), 1);
  assert.equal((await service.versions(f.fund.id)).length, 1);
  const document = await service.model('fund_documents').findByPk(retried.document_id);
  await harness.files.requestDelete({ id: document.id, technical_revision: 1, request_key: randomUUID() }, 'file-owner');
  assert.equal(existsSync(destination), false);
});

test('Failed physical deletion blocks reads; restart can complete after file disappears but metadata remains', async () => {
  const f = await mutate('saveFund', sampleFund('FILE-DELETE'));
  const harness = fileHarness(randomUUID());
  const uploaded = await harness.files.upload({ fund_id: f.fund.id, original_name: '模拟删除.txt', document_type: '其他', content_base64: Buffer.from('待删除模拟文件').toString('base64'), request_key: randomUUID() }, 'file-owner');
  assert.equal(uploaded.status, 'complete');
  const document = await service.model('fund_documents').findByPk(uploaded.document_id);
  const file = await service.model('file_records').findByPk(document.get('storage_key'));
  const destination = path.join(harness.directory, 'documents', file.get('filename'));
  harness.faults.deletion = true;
  const deleted = await harness.files.requestDelete({ id: document.id, technical_revision: 1, request_key: randomUUID() }, 'file-owner');
  assert.equal(deleted.status, 'failed'); assert.equal(existsSync(destination), true);
  assert.equal((await document.reload()).get('deleting'), true);
  await assert.rejects(harness.files.download({}, document.id), errorCode('FILE_UNAVAILABLE'));
  await assert.rejects(harness.files.download({}, file.id, true), errorCode('FILE_UNAVAILABLE'));
  harness.faults.deletion = false; harness.faults.afterDeletion = true;
  const interrupted = await harness.files.retry({ task_id: deleted.task_id, request_key: randomUUID() }, 'file-owner');
  assert.equal(interrupted.status, 'failed'); assert.equal(existsSync(destination), false);
  assert.ok(await service.model('fund_documents').findByPk(document.id));
  harness.faults.afterDeletion = false;
  await harness.create().recover();
  assert.equal((await harness.files.task(deleted.task_id, 'file-owner')).get('status'), 'complete');
  assert.equal(await service.model('fund_documents').findByPk(document.id), null);
  assert.equal(await service.model('file_records').findByPk(file.id), null);
  assert.equal((await harness.files.task(uploaded.task_id, 'file-owner')).get('document_id'), null);
});

test('Cancelled and expired unbound uploads clear staged and destination files without touching live documents', async () => {
  const f = await mutate('saveFund', sampleFund('FILE-EXPIRY'));
  const harness = fileHarness(randomUUID());
  const input = { fund_id: f.fund.id, original_name: '模拟过期.txt', document_type: '其他', content_base64: Buffer.from('模拟过期文件').toString('base64') };
  const live = await harness.files.upload({ ...input, request_key: randomUUID() }, 'file-owner');
  harness.faults.verify = true;
  const pending = await harness.files.upload({ ...input, request_key: randomUUID() }, 'file-owner');
  const operation = await harness.files.task(pending.task_id, 'file-owner');
  const filename = operation.get('storage_key');
  assert.equal(existsSync(path.join(harness.directory, 'staging', filename)), true);
  harness.faults.deletion = true;
  const cancel = { task_id: pending.task_id, request_key: randomUUID() };
  assert.equal((await harness.files.cancelUpload(cancel, 'file-owner')).status, 'failed');
  assert.equal(existsSync(path.join(harness.directory, 'documents', filename)), true);
  harness.faults.deletion = false;
  await harness.create().recover();
  assert.equal((await harness.files.cancelUpload(cancel, 'file-owner')).status, 'cancelled');
  assert.equal(existsSync(path.join(harness.directory, 'documents', filename)), false);
  assert.equal(existsSync(path.join(harness.directory, 'staging', filename)), false);
  const expired = await harness.files.upload({ ...input, request_key: randomUUID() }, 'file-owner');
  await db.sequelize.query("UPDATE finance_file_operations SET created_at = now() - interval '8 days' WHERE id=:id", { replacements: { id: expired.task_id } });
  await harness.create().recover();
  assert.equal((await harness.files.task(expired.task_id, 'file-owner')).get('status'), 'cancelled');
  assert.equal((await harness.files.task(live.task_id, 'file-owner')).get('status'), 'complete');
  assert.equal((await harness.files.list(f.fund.id)).length, 1);
  harness.faults.verify = false;
  assert.equal((await harness.files.requestDelete({ id: live.document_id, technical_revision: 1, request_key: randomUUID() }, 'file-owner')).status, 'complete');
});

test('Identical real trades require explicit confirmation, and changed duplicate sets require rechecking', async () => {
  const e = await mutate('saveEntity', sampleEntity('DUPLICATE', '重复交易'));
  const payload = trade('10', '初次申购', '2026-01-01', e);
  const first = await mutate('saveTrade', payload);
  let warning: any;
  await assert.rejects(mutate('saveTrade', payload), error => { warning = error; return error.code === 'DUPLICATE_TRADE'; });
  assert.equal(warning.details.records.length, 1);
  assert.equal(await service.model('transactions').count({ where: { entity_id: e.id } }), 1);
  const secondPayload = { ...payload, duplicate_confirmation: warning.details.confirmation_token };
  const key = randomUUID();
  const second = await mutate('saveTrade', secondPayload, key);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(await mutate('saveTrade', secondPayload, key), second);
  await assert.rejects(mutate('saveTrade', secondPayload), errorCode('DUPLICATE_TRADE'));
  assert.equal((await service.positions(e.id))[0].units, '20');
});

test('Trade editing replays both accounts, rejects historical shortage and preserves manual currency and amounts', async () => {
  const a = await mutate('saveEntity', sampleEntity('EDIT-TRADES', '修改原主体'));
  const b = await mutate('saveEntity', sampleEntity('EDIT-TRADES', '修改目标主体'));
  const subscription = await mutate('saveTrade', trade('100', '初次申购', '2026-01-01', a));
  const withdrawal = await mutate('saveTrade', trade('30', '赎回', '2026-01-02', a));
  await assert.rejects(mutate('saveTrade', { id: subscription.id, technical_revision: 1, values: { ...trade('100', '初次申购', '2026-01-03', a).values } }), errorCode('NEGATIVE_HISTORICAL_UNITS'));
  await assert.rejects(mutate('saveTrade', { id: subscription.id, technical_revision: 1, values: { ...trade('100', '初次申购', '2026-01-01', b).values } }), errorCode('NEGATIVE_HISTORICAL_UNITS'));
  assert.equal((await service.model('transactions').findByPk(subscription.id)).get('technical_revision'), 1);
  const changed = await mutate('saveTrade', { id: withdrawal.id, technical_revision: 1, values: { ...trade('20', '赎回', '2026-01-02', a).values, currency: 'HKD', amount: '12345.6789' } });
  assert.equal(changed.technical_revision, 2);
  const current = await service.model('transactions').findByPk(changed.id);
  assert.equal(current.get('currency'), 'HKD'); assert.equal(current.get('amount'), '12345.6789');
  const position = (await service.positions(a.id))[0];
  assert.equal(position.units, '80'); assert.equal(position.currency, 'USD');
  await assert.rejects(mutate('saveTrade', { id: withdrawal.id, technical_revision: 1, ...trade('10', '赎回', '2026-01-02', a) }), errorCode('STALE_REVISION'));
});

test('Complete same-date composition uses latest eligible NAV and all-or-none weights; snapshots retain only source facts', async () => {
  const child = await mutate('saveFund', sampleFund('COMPOSITION-CHILD'));
  for (const [i, value] of ['1', '3'].entries()) await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: child.share_classes[i].id, nav_date: '2026-01-01', nav_per_unit: value } });
  await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: child.share_classes[0].id, nav_date: '2026-01-06', nav_per_unit: '100' } });
  const input = sampleProprietary('COMPOSITION');
  const list = { valuation_date: '2026-01-05', items: child.share_classes.map(row => ({ child_share_class_id: row.id, units: '100', remarks: '模拟成分' })) };
  const parent = await mutate('saveFund', { ...input, compositions: [list] });
  const first = (await service.compositionValues(parent.fund.id)).compositions[0];
  assert.deepEqual(first.issues, []); assert.equal(first.total_market_value, '400');
  const rowA = first.items.find(row => row.child_share_class_id === child.share_classes[0].id);
  const rowB = first.items.find(row => row.child_share_class_id === child.share_classes[1].id);
  assert.equal(rowA.market_value, '100'); assert.equal(rowA.weight, '0.25'); assert.equal(rowA.nav_date, '2026-01-01');
  assert.equal(rowB.market_value, '300'); assert.equal(rowB.weight, '0.75');
  const update = { ...input, id: parent.fund.id, technical_revision: 1, fund: { ...input.fund, short_name: '模拟合并修改' }, share_classes: input.share_classes.map((row, i) => ({ ...row, id: parent.share_classes[i].id })), compositions: [{ ...list, id: parent.compositions[0].id, items: [{ ...list.items[0], units: '200' }, list.items[1]] }] };
  const key = randomUUID();
  const changed = await mutate('saveFund', update, key); await mutate('saveFund', update, key);
  assert.equal(changed.fund.business_version, 2);
  const history = await service.versions(parent.fund.id);
  assert.equal(history.length, 2);
  assert.equal(history[1].snapshot.compositions[0].items.find(row => row.child_share_class_id === rowA.child_share_class_id).units, '100');
  assert.ok(history.every(version => version.snapshot.compositions.every(list => list.items.every(row => row.weight === undefined && row.nav_per_unit === undefined))));
  const nav = await service.model('fund_navs').findOne({ where: { share_class_id: rowB.child_share_class_id, nav_date: '2026-01-01' } });
  await mutate('deleteSeries', { data_type: 'nav', id: nav.id, technical_revision: nav.get('technical_revision') });
  const missing = (await service.compositionValues(parent.fund.id)).compositions[0];
  assert.ok(missing.issues.some(issue => issue.code === 'MISSING_NAV'));
  assert.ok(missing.items.every(row => row.weight === null)); assert.equal(missing.total_market_value, null);
  assert.equal((await service.versions(parent.fund.id)).length, 2);
  await assert.rejects(mutate('saveFund', { ...update, technical_revision: 2, compositions: [list] }), errorCode('COMPOSITION_DATE_EXISTS'));
  assert.equal((await service.versions(parent.fund.id)).length, 2);
});

test('Missing optional composition dates and units or mixed currencies remain savable without misleading weights', async () => {
  const children = sampleFund('COMPOSITION-MISSING');
  children.share_classes[1].values.currency = 'HKD';
  const child = await mutate('saveFund', children);
  for (const row of child.share_classes) await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: row.id, nav_date: '2026-01-01', nav_per_unit: '1' } });
  const items = child.share_classes.map(row => ({ child_share_class_id: row.id, units: '10' }));
  const input = sampleProprietary('COMPOSITION-MISSING');
  const parent = await mutate('saveFund', { ...input, compositions: [{ valuation_date: '2026-01-05', items }, { valuation_date: null, items: [{ child_share_class_id: child.share_classes[0].id }] }, { valuation_date: null, items: [] }] });
  const result = await service.compositionValues(parent.fund.id);
  assert.equal(result.compositions.length, 3);
  assert.ok(result.compositions[0].issues.some(issue => issue.code === 'MIXED_CURRENCIES'));
  assert.ok(result.compositions[1].issues.some(issue => issue.code === 'MISSING_DATE'));
  assert.ok(result.compositions[1].issues.some(issue => issue.code === 'MISSING_UNITS'));
  assert.ok(result.compositions.every(list => list.items.every(row => row.weight === null)));
  const update = { ...input, id: parent.fund.id, technical_revision: 1, share_classes: [], compositions: [{ valuation_date: '2026-02-01', items: [items[0], items[0]] }] };
  await assert.rejects(mutate('saveFund', update), errorCode('DUPLICATE_COMPOSITION_CLASS'));
  assert.equal((await service.versions(parent.fund.id)).length, 1);
  await assert.rejects(mutate('saveFund', { ...update, compositions: [{ valuation_date: null, items: [{ child_share_class_id: parent.share_classes[0].id, units: '10' }] }] }), errorCode('THIRD_PARTY_REQUIRED'));
});

test('A manual overwrite clears the former import provenance while preserving the batch source', async () => {
  const f = await mutate('saveFund', sampleFund('MANUAL-SOURCE'));
  const shareId = f.share_classes[0].id;
  const staged = await importMutation('stage', { data_type: 'nav', share_class_id: shareId, original_name: '模拟来源.csv', content_base64: Buffer.from('日期,净值\n2026-01-01,1.25\n').toString('base64') });
  const ready = await importMutation('preview', { batch_id: staged.batch.id, technical_revision: staged.batch.technical_revision, mapping: { date: '日期', value: '净值' } });
  const result = await importMutation('commit', { batch_id: ready.batch.id, technical_revision: ready.batch.technical_revision, preview_token: ready.batch.preview.token });
  const row = await service.model('fund_navs').findByPk(result.record_ids[0]);
  assert.equal(row.get('source_batch_id'), ready.batch.id);
  await mutate('saveSeries', { data_type: 'nav', expected_revision: 1, values: { share_class_id: shareId, nav_date: '2026-01-01', nav_per_unit: '2' } });
  await row.reload();
  assert.equal(row.get('source_batch_id'), null); assert.equal(row.get('source_sheet'), null); assert.equal(row.get('source_row'), null);
  assert.equal((await imports.view(ready.batch.id, 'test-user')).rows[0].raw['净值'], '1.25');
});

test('A durable import batch survives interruption before bytes and resumes the same original file exactly once', async () => {
  const actor = 'recover-import-owner';
  const content = Buffer.from('日期,数值\n2026-02-01,123456789012345.12345678\n');
  const payload = { data_type: 'nav', share_class_id: fund.share_classes[0].id, original_name: '模拟中断.csv', content_base64: content.toString('base64') };
  const requestKey = randomUUID();
  const reserved = await service.write(actor, 'stageImport', requestKey, payload, transaction => imports.stage(payload, transaction, actor));
  assert.equal((await imports.view(reserved.batch_id, actor)).batch.status, 'awaiting_file');
  await imports.process(reserved.batch_id);
  assert.equal((await imports.view(reserved.batch_id, actor)).rows.length, 0);
  await assert.rejects(imports.upload({ batch_id: reserved.batch_id, content_base64: Buffer.from('different file').toString('base64'), request_key: randomUUID() }, actor), errorCode('FILE_CONTENT_MISMATCH'));
  await imports.upload({ batch_id: reserved.batch_id, content_base64: payload.content_base64, request_key: randomUUID() }, actor);
  assert.equal((await imports.view(reserved.batch_id, actor)).batch.status, 'parsing');
  const restarted = new FinanceImports(service, '.runtime/test-imports');
  await Promise.all([restarted.process(reserved.batch_id), imports.process(reserved.batch_id)]);
  assert.deepEqual(await imports.upload({ ...payload, request_key: requestKey }, actor), reserved);
  const parsed = await imports.view(reserved.batch_id, actor);
  assert.equal(parsed.batch.status, 'staged'); assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].raw['数值'], '123456789012345.12345678');
  const ctx: any = { set() {}, attachment() {} };
  await imports.download(ctx, reserved.batch_id, actor);
  const chunks = []; for await (const chunk of ctx.body) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), content);
  await assert.rejects(imports.download({}, reserved.batch_id, 'other-owner'), errorCode('FORBIDDEN'));
  assert.equal((await imports.list(actor)).count, 1);
});

test('Import cancellation stops parsing and commit; parse failure leaves a recoverable batch without partial rows', async () => {
  const actor = 'cancel-import-owner';
  const input = { data_type: 'nav', share_class_id: fund.share_classes[0].id, original_name: '模拟取消.csv', content_base64: Buffer.from('日期,数值\n2026-03-01,1.25\n').toString('base64') };
  const queued = await imports.upload({ ...input, request_key: randomUUID() }, actor);
  await service.write(actor, 'cancelImport', randomUUID(), { batch_id: queued.batch_id, technical_revision: 1 }, transaction => imports.cancel({ batch_id: queued.batch_id, technical_revision: 1 }, transaction, actor));
  await imports.process(queued.batch_id);
  const cancelled = await imports.view(queued.batch_id, actor);
  assert.equal(cancelled.batch.status, 'cancelled'); assert.equal(cancelled.rows.length, 0);
  await assert.rejects(importMutation('preview', { batch_id: queued.batch_id, technical_revision: 2, mapping: { date: '日期', value: '数值' } }, actor), errorCode('BATCH_NOT_EDITABLE'));
  const bad = await imports.upload({ ...input, original_name: '模拟无效表头.csv', content_base64: Buffer.from('重复,重复\n1,2\n').toString('base64'), request_key: randomUUID() }, actor);
  await imports.process(bad.batch_id);
  const failed = await imports.view(bad.batch_id, actor);
  assert.equal(failed.batch.status, 'failed'); assert.equal(failed.rows.length, 0); assert.match(failed.batch.context.parse_error, /表头不能为空或重复/);
  await importMutation('retryParse', { batch_id: bad.batch_id, technical_revision: failed.batch.technical_revision }, actor);
  await new FinanceImports(service, '.runtime/test-imports').recover();
  assert.equal((await imports.view(bad.batch_id, actor)).batch.status, 'failed');
  assert.equal((await imports.view(bad.batch_id, actor)).rows.length, 0);
});

const tradeMapping = Object.fromEntries([...tradeImportFields.map(field => [field.key, field.key]), ['fee_rate_mode', 'percent']]);
async function stageTrades(items: any[]) {
  const names = tradeImportFields.map(field => field.key);
  const csv = [names.join(','), ...items.map(item => names.map(key => item[key] ?? '').join(','))].join('\n');
  return importMutation('stage', { data_type: 'transactions', original_name: '模拟申赎.csv', content_base64: Buffer.from(csv).toString('base64') });
}
const importTradeRow = (entity: any, units: string, type = '初次申购', date = '2026-01-01') => ({
  ...trade(units, type, date, entity).values, isin: fund.share_classes[0].isin, fee_rate: '2%', remarks: '模拟批量交易',
});

test('Trade import replays the final same-day set independently of row order, retaining exact facts and provenance', async () => {
  for (const reverse of [false, true]) {
    const entity = await mutate('saveEntity', sampleEntity('BATCH-ORDER', String(reverse)));
    const items = [importTradeRow(entity, '30', '赎回'), importTradeRow(entity, '100')];
    if (reverse) items.reverse();
    const ready = await preview(await stageTrades(items), tradeMapping as any);
    assert.equal(ready.batch.status, 'ready', JSON.stringify(ready.rows.map(row => row.errors)));
    const result = await commit(ready);
    assert.equal(result.committed_count, 2); assert.equal(result.inserted_count, 2);
    assert.deepEqual(await commit(ready), result);
    assert.equal((await service.positions(entity.id))[0].units, '70');
    const record = await service.model('transactions').findByPk(result.record_ids[0]);
    assert.equal(record.get('fee_rate'), '0.02'); assert.equal(record.get('amount'), '123.456789012345');
    assert.equal(record.get('source_batch_id'), ready.batch.id); assert.equal(record.get('source_row'), 2);
    assert.equal(await service.model('transactions').count({ where: { entity_id: entity.id } }), 2);
  }
});

test('Trade import uses explicit IDs, rejects ambiguous updates and preserves raw values during correction', async () => {
  const entity = await mutate('saveEntity', sampleEntity('BATCH-IDENTITY', 'one'));
  const value = importTradeRow(entity, '1');
  let invalid = await preview(await stageTrades([{ ...value, entity_id: 'BATCH-IDENTITY' }, { ...value, isin: 'Unknown' }]), tradeMapping as any);
  assert.equal(invalid.batch.status, 'needs_correction');
  assert.equal(invalid.rows[0].errors[0].code, 'INVALID_ID'); assert.equal(invalid.rows[1].errors[0].code, 'ISIN_NOT_FOUND');
  await assert.rejects(preview(invalid, tradeMapping as any, [null]), errorCode('INVALID_CORRECTION'));
  invalid = await preview(invalid, tradeMapping as any, [{ id: invalid.rows[0].id, corrected: { entity_id: entity.id } }, { id: invalid.rows[1].id, selected: false }] as any);
  assert.equal(invalid.batch.status, 'ready'); assert.equal(invalid.rows[0].raw.entity_id, 'BATCH-IDENTITY');
  const saved = await commit(invalid);
  const duplicateId = await preview(await stageTrades([{ ...value, id: saved.record_ids[0] }, { ...value, id: saved.record_ids[0] }]), tradeMapping as any);
  assert.equal(duplicateId.rows[0].errors[0].code, 'DUPLICATE_FILE_KEY');
  const missing = await preview(await stageTrades([{ ...value, id: randomUUID() }]), tradeMapping as any);
  assert.equal(missing.batch.status, 'needs_correction'); assert.equal(missing.rows[0].errors[0].code, 'NOT_FOUND');
  await assert.rejects(commit(missing), errorCode('PREVIEW_REQUIRED'));
});

test('Same-file and existing duplicate trades need explicit confirmations tied to the current selected set', async () => {
  const entity = await mutate('saveEntity', sampleEntity('BATCH-DUPLICATE', 'one'));
  const value = importTradeRow(entity, '1');
  let result = await preview(await stageTrades([value, value]), tradeMapping as any);
  assert.equal(result.batch.status, 'needs_correction');
  assert.ok(result.rows.every(row => row.errors.some(error => error.code === 'DUPLICATE_TRADE')));
  const confirmations = result.rows.map(row => ({ id: row.id, duplicate_confirmation: row.normalized.required_confirmation }));
  result = await preview(result, tradeMapping as any, confirmations as any);
  assert.equal(result.batch.status, 'ready'); assert.equal((await commit(result)).committed_count, 2);
  const more = await preview(await stageTrades([value, value]), tradeMapping as any);
  const confirmed = await preview(more, tradeMapping as any, more.rows.map(row => ({ id: row.id, duplicate_confirmation: row.normalized.required_confirmation })) as any);
  assert.equal(confirmed.batch.status, 'ready');
  const changed = await preview(confirmed, tradeMapping as any, [{ id: confirmed.rows[1].id, selected: false }] as any);
  assert.equal(changed.batch.status, 'needs_correction');
  assert.notEqual(changed.rows[0].normalized.required_confirmation, confirmed.rows[0].normalized.required_confirmation);
  const rechecked = await preview(changed, tradeMapping as any, [{ id: changed.rows[0].id, duplicate_confirmation: changed.rows[0].normalized.required_confirmation }] as any);
  assert.equal((await commit(rechecked)).committed_count, 1);
  assert.equal((await service.positions(entity.id))[0].units, '3');
});

test('Batch trade updates show old values, reject shortages in either old account, and identify unchanged rows', async () => {
  const entity = await mutate('saveEntity', sampleEntity('BATCH-EDIT', 'original'));
  const other = await mutate('saveEntity', sampleEntity('BATCH-EDIT', 'destination'));
  const buy = await mutate('saveTrade', trade('100', '初次申购', '2026-01-01', entity));
  await mutate('saveTrade', trade('30', '赎回', '2026-01-02', entity));
  const move = await preview(await stageTrades([{ ...importTradeRow(other, '100'), id: buy.id }]), tradeMapping as any);
  assert.equal(move.batch.status, 'needs_correction');
  assert.equal(move.rows[0].errors[0].code, 'NEGATIVE_HISTORICAL_UNITS');
  assert.equal(move.rows[0].errors[0].details.conflict_date, '2026-01-02');
  const edit = await preview(await stageTrades([{ ...importTradeRow(entity, '90'), id: buy.id }]), tradeMapping as any);
  assert.equal(edit.rows[0].operation, 'overwrite'); assert.equal(edit.rows[0].normalized.existing_value.confirmed_units, '100');
  assert.equal(edit.rows[0].normalized.existing_isin, fund.share_classes[0].isin);
  assert.equal((await commit(edit)).overwritten_count, 1);
  assert.equal((await service.positions(entity.id))[0].units, '60');
  const same = await preview(await stageTrades([{ ...importTradeRow(entity, '90'), id: buy.id }]), tradeMapping as any);
  assert.equal(same.rows[0].operation, 'unchanged');
  const before = (await service.model('transactions').findByPk(buy.id)).get('technical_revision');
  assert.equal((await commit(same)).unchanged_count, 1);
  assert.equal((await service.model('transactions').findByPk(buy.id)).get('technical_revision'), before);
});

test('A manual trade after batch preview invalidates it; related entity changes and voided edits also invalidate it', async () => {
  const entity = await mutate('saveEntity', sampleEntity('BATCH-STALE', 'one'));
  const value = importTradeRow(entity, '100');
  const ready = await preview(await stageTrades([value]), tradeMapping as any);
  await mutate('saveTrade', trade('2', '初次申购', '2025-12-31', entity));
  await assert.rejects(commit(ready), errorCode('PREVIEW_STALE'));
  assert.equal(await service.model('transactions').count({ where: { source_batch_id: ready.batch.id } }), 0);
  const updated = await preview(ready, tradeMapping as any);
  const saved = await commit(updated);
  const editing = await preview(await stageTrades([{ ...value, id: saved.record_ids[0], amount: '100' }]), tradeMapping as any);
  await mutate('voidTrade', { id: saved.record_ids[0], technical_revision: 1, reason: '模拟撤销' });
  await assert.rejects(commit(editing), errorCode('PREVIEW_STALE'));
  const dependent = await preview(await stageTrades([value]), tradeMapping as any);
  await mutate('setDeleted', { table: 'investment_entities', id: entity.id, technical_revision: 1, deleted: true });
  await assert.rejects(commit(dependent), errorCode('PREVIEW_STALE'));
});

test('Trade import rolls back earlier writes and its success receipt on a late persistence failure', async () => {
  const entity = await mutate('saveEntity', sampleEntity('BATCH-ROLLBACK', 'one'));
  const ready = await preview(await stageTrades([importTradeRow(entity, '30', '赎回'), importTradeRow(entity, '100')]), tradeMapping as any);
  const persist = service.persistTrade;
  let count = 0;
  service.persistTrade = async function (...args: any[]) { if (++count === 2) throw new Error('Injected late trade persistence failure'); return persist.apply(this, args); };
  const key = randomUUID();
  try {
    await assert.rejects(importMutation('commit', { batch_id: ready.batch.id, technical_revision: ready.batch.technical_revision, preview_token: ready.batch.preview.token }, 'test-user', key), /Injected late/);
  } finally { service.persistTrade = persist; }
  assert.equal(await service.model('transactions').count({ where: { entity_id: entity.id } }), 0);
  assert.equal(await service.model('request_receipts').count({ where: { request_key: key } }), 0);
  assert.equal((await imports.view(ready.batch.id, 'test-user')).batch.status, 'ready');
  assert.equal((await commit(ready)).committed_count, 2);
});

test('Concurrent trade batches protect account history and require re-preview after another batch wins', async () => {
  const entity = await mutate('saveEntity', sampleEntity('BATCH-CONCURRENT', 'one'));
  await mutate('saveTrade', trade('100', '初次申购', '2026-01-01', entity));
  const batches = [];
  for (const amount of ['80', '81']) batches.push(await preview(await stageTrades([{ ...importTradeRow(entity, '80', '赎回', '2026-01-02'), amount }]), tradeMapping as any));
  const results = await Promise.allSettled(batches.map(commit));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const loser = results.findIndex(result => result.status === 'rejected');
  assert.equal((results[loser] as any).reason.code, 'PREVIEW_STALE');
  assert.equal((await service.positions(entity.id))[0].units, '20');
  const again = await preview(batches[loser], tradeMapping as any);
  assert.equal(again.batch.status, 'needs_correction'); assert.equal(again.rows[0].errors[0].code, 'NEGATIVE_HISTORICAL_UNITS');
});

const flat = (prefix: string, values: any) => Object.fromEntries(Object.entries(values).flatMap(([key, value]: any) => value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).map(([part, child]) => [`${prefix}.${key}.${part}`, child]) : [[`${prefix}.${key}`, value]]));
const fundImportRows = (input: any, group = '新基金1') => input.share_classes.map((share, index) => ({ row_type: '份额', fund_key: group, ...(index === 0 ? { ...flat('fund', input.fund), ...flat('details', input.details) } : {}), ...flat('share', share.values), ...flat('terms', share.terms) }));
async function stageMain(type: string, items: any[], kind = 'third_party') {
  const columns = [...new Set(items.flatMap(item => Object.keys(item)))];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([columns, ...items.map(item => columns.map(key => item[key] ?? ''))]), '模拟主数据');
  const staged = await importMutation('stage', { data_type: type, fund_kind: kind, original_name: '模拟主数据.xlsx', content_base64: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }).toString('base64') });
  return { staged, mapping: Object.fromEntries(columns.map(key => [key, key])) };
}
const previewMain = async (type: string, items: any[], kind = 'third_party') => { const input = await stageMain(type, items, kind); return preview(input.staged, input.mapping as any); };

test('Main-data templates trace source fields and provide unambiguous, parseable columns', async () => {
  for (const [type, kind] of [['entities', 'third_party'], ['funds', 'third_party'], ['funds', 'proprietary'], ['compositions', 'proprietary']]) {
    const definitions = mainImportFields(type, kind);
    assert.ok(definitions.length <= 100); assert.equal(new Set(definitions.map(field => field.label)).size, definitions.length);
    assert.ok(definitions.every(field => !/is_deleted|saved_at|business_version|technical_revision/.test(field.key)));
    const book = XLSX.read(await imports.mainTemplate(type, kind), { type: 'buffer' });
    assert.equal(book.SheetNames[0], '待导入数据'); assert.ok(book.SheetNames.includes('负责人参考'));
    assert.deepEqual(XLSX.utils.sheet_to_json(book.Sheets['待导入数据'], { header: 1 })[0], definitions.map(field => field.label));
  }
});

test('Entity import preserves two subjects sharing one client code and calculates CDD without preview writes', async () => {
  const source = sampleEntity('MAIN-CLIENT', '主体A');
  const data = [{ client_code: source.client_code, ...flat('entity', source.entity), agreements: 'n/a', products: 'OFC\nEAM' }, { client_code: source.client_code, ...flat('entity', { ...source.entity, legal_name: '模拟主体 主体B' }) }];
  const before = await service.model('investment_entities').count();
  const ready = await previewMain('entities', data);
  assert.equal(ready.batch.status, 'ready', JSON.stringify(ready.rows.map(row => row.errors)));
  assert.equal(await service.model('investment_entities').count(), before);
  assert.equal(ready.rows[0].normalized.next_cdd_deadline, '2027-02-27');
  const saved = await commit(ready); assert.equal(saved.object_count, 2); assert.equal(saved.committed_count, 2);
  const a = await service.entityAggregate(saved.record_ids[0]); const b = await service.entityAggregate(saved.record_ids[1]);
  assert.equal(a.entity.client_group_id, b.entity.client_group_id); assert.notEqual(a.entity.id, b.entity.id);
  assert.deepEqual(a.products.sort(), ['EAM', 'OFC']); assert.deepEqual(await commit(ready), saved);
  const edit = await previewMain('entities', [{ id: a.entity.id, 'entity.legal_name': '模拟已修改名称', 'entity.latest_cdd_approval_date': '#清空', products: '#清空' }]);
  assert.equal(edit.batch.status, 'ready', JSON.stringify(edit.rows[0].errors));
  await commit(edit); const updated = await service.entityAggregate(a.entity.id);
  assert.equal(updated.entity.legal_name, '模拟已修改名称'); assert.equal(updated.entity.latest_cdd_approval_date, null); assert.equal(updated.next_cdd_deadline, null); assert.deepEqual(updated.products, []); assert.deepEqual(updated.agreements, ['n/a']);
});

test('Entity imports preserve invalid source dates and reject missing or duplicate IDs, stale edits and system mappings', async () => {
  const source = sampleEntity('MAIN-ERROR', '待修正');
  let bad = await previewMain('entities', [{ client_code: source.client_code, ...flat('entity', source.entity), 'entity.review_form_signed_date': 'Hold' }]);
  assert.equal(bad.batch.status, 'needs_correction'); assert.equal(bad.rows[0].raw['entity.review_form_signed_date'], 'Hold');
  await assert.rejects(commit(bad), errorCode('PREVIEW_REQUIRED'));
  bad = await preview(bad, bad.batch.mapping, [{ id: bad.rows[0].id, corrected: { 'entity.review_form_signed_date': '#清空' } }] as any);
  const saved = await commit(bad);
  const duplicate = await previewMain('entities', [{ id: saved.record_ids[0], 'entity.legal_name': '一' }, { id: saved.record_ids[0], 'entity.legal_name': '二' }]);
  assert.equal(duplicate.rows[0].errors[0].code, 'DUPLICATE_FILE_KEY');
  const invalidId = await previewMain('entities', [{ id: randomUUID(), 'entity.legal_name': '不得新增' }]);
  assert.equal(invalidId.batch.status, 'needs_correction');
  const edited = await previewMain('entities', [{ id: saved.record_ids[0], 'entity.city': '模拟城市' }]);
  await mutate('setDeleted', { table: 'investment_entities', id: saved.record_ids[0], technical_revision: 1, deleted: true });
  await assert.rejects(commit(edited), errorCode('PREVIEW_STALE'));
  await assert.rejects(preview(edited, { id: 'id', 'entity.is_deleted': 'entity.city' } as any), errorCode('INVALID_MAPPING'));
});

test('A new two-class fund imports as one aggregate and one version, with exact numbers and composite terms', async () => {
  const input = sampleFund('MAIN-NEW');
  const ready = await previewMain('funds', fundImportRows(input));
  assert.equal(ready.batch.status, 'ready', JSON.stringify(ready.rows.map(row => row.errors)));
  assert.equal(ready.batch.preview.object_count, 1);
  assert.equal(await service.model('funds').count({ where: { lei: input.fund.lei } }), 0);
  const saved = await commit(ready); const aggregate = await service.fundAggregate(saved.record_ids[0]);
  assert.equal(saved.committed_count, 2); assert.equal(saved.object_count, 1); assert.equal(aggregate.share_classes.length, 2);
  assert.equal(aggregate.fund.size_100m_usd, '123456789012345.12345678');
  assert.deepEqual(aggregate.share_classes[0].terms.gate_raw, input.share_classes[0].terms.gate_raw);
  assert.equal((await service.versions(aggregate.fund.id)).length, 1);
  assert.deepEqual(await commit(ready), saved);
  const repeated = await previewMain('funds', [{ row_type: '基金资料', fund_id: aggregate.fund.id, 'fund.short_name': aggregate.fund.short_name }]);
  await commit(repeated); assert.equal((await service.versions(aggregate.fund.id)).length, 2);
});

test('Conflicting fund rows, duplicate ISINs and stale absence checks cannot silently overwrite another fund', async () => {
  const conflictRows = fundImportRows(sampleFund('MAIN-CONFLICT'));
  conflictRows[1]['fund.short_name'] = '模拟不同名称';
  const conflict = await previewMain('funds', conflictRows);
  assert.equal(conflict.rows[0].errors[0].code, 'CONFLICTING_FUND_FIELD');
  const duplicates = fundImportRows(sampleFund('MAIN-DUP-ISIN'));
  duplicates[1]['share.isin'] = duplicates[0]['share.isin'];
  assert.equal((await previewMain('funds', duplicates)).rows[0].errors[0].code, 'DUPLICATE_FILE_KEY');
  const concurrentInput = sampleFund('MAIN-ABSENT');
  const ready = await previewMain('funds', fundImportRows(concurrentInput));
  assert.equal(ready.batch.status, 'ready');
  await mutate('saveFund', concurrentInput);
  await assert.rejects(commit(ready), errorCode('PREVIEW_STALE'));
  assert.equal(await service.model('funds').count({ where: { lei: concurrentInput.fund.lei } }), 1);
});

test('One batch changes two proprietary share classes and a complete composition with only one fund version', async () => {
  const child = await mutate('saveFund', sampleFund('MAIN-CHILD'));
  const parent = await mutate('saveFund', { ...sampleProprietary('MAIN-PARENT'), compositions: [{ valuation_date: '2026-01-01', items: [{ child_share_class_id: child.share_classes[0].id, units: '100' }, { child_share_class_id: child.share_classes[1].id, units: '200' }] }] });
  const data = [
    { row_type: '份额', fund_id: parent.fund.id, share_id: parent.share_classes[0].id, 'share.currency': 'JPY' },
    { row_type: '份额', fund_id: parent.fund.id, share_id: parent.share_classes[1].id, 'share.currency': 'JPY' },
    { row_type: '成分', fund_id: parent.fund.id, valuation_date: '2026-01-01', child_isin: child.share_classes[0].isin, units: '150' },
  ];
  let ready = await previewMain('funds', data, 'proprietary');
  assert.equal(ready.batch.status, 'needs_correction', JSON.stringify(ready.rows.map(row => row.errors)));
  const lead = ready.rows.find(row => row.normalized.required_confirmation);
  assert.equal(lead.normalized.list_diff.before.length, 2); assert.equal(lead.normalized.list_diff.after.length, 1);
  assert.equal((await service.versions(parent.fund.id)).length, 1);
  ready = await preview(ready, ready.batch.mapping, [{ id: lead.id, replacement_confirmation: lead.normalized.required_confirmation }] as any);
  assert.equal(ready.batch.status, 'ready', JSON.stringify(ready.rows.map(row => row.errors)));
  const saved = await commit(ready); assert.equal(saved.committed_count, 3); assert.equal(saved.object_count, 1); assert.equal(saved.objects[0].version_no, 2);
  const after = await service.fundAggregate(parent.fund.id);
  assert.deepEqual(after.share_classes.map(row => row.currency), ['JPY', 'JPY']);
  assert.equal(after.compositions[0].items.length, 1); assert.equal(after.compositions[0].items[0].units, '150');
  const versions = await service.versions(parent.fund.id); assert.equal(versions.length, 2);
  assert.equal(versions[1].snapshot.compositions[0].items.length, 2);
  assert.deepEqual(await commit(ready), saved);
});

test('Composition import allows optional blanks, requires complete-list confirmation and invalidates changed references', async () => {
  const child = await mutate('saveFund', sampleFund('MAIN-COMP-CHILD'));
  const parent = await mutate('saveFund', sampleProprietary('MAIN-COMP-PARENT'));
  const newList = await previewMain('compositions', [{ fund_id: parent.fund.id, list_key: '未定日期1', child_isin: child.share_classes[0].isin }], 'proprietary');
  assert.equal(newList.batch.status, 'ready', JSON.stringify(newList.rows[0].errors));
  await commit(newList);
  const snapshot = (await service.fundAggregate(parent.fund.id)).compositions[0];
  assert.equal(snapshot.valuation_date, null); assert.equal(snapshot.items[0].units, null);
  let clear = await previewMain('compositions', [{ row_type: '清空成分', fund_id: parent.fund.id, list_id: snapshot.id }], 'proprietary');
  assert.equal(clear.batch.status, 'needs_correction');
  clear = await preview(clear, clear.batch.mapping, [{ id: clear.rows[0].id, replacement_confirmation: clear.rows[0].normalized.required_confirmation }] as any);
  await commit(clear); assert.equal((await service.fundAggregate(parent.fund.id)).compositions[0].items.length, 0);
  const initial = await previewMain('compositions', child.share_classes.map((share, index) => ({ fund_id: parent.fund.id, valuation_date: '2026-02-01', child_isin: share.isin, units: index ? '20' : '10' })), 'proprietary');
  await commit(initial);
  const blank = await previewMain('compositions', child.share_classes.map(share => ({ fund_id: parent.fund.id, valuation_date: '2026-02-01', child_isin: share.isin })), 'proprietary');
  assert.equal(blank.batch.status, 'ready'); assert.equal(blank.rows[0].normalized.existing_value.units, '10');
  await commit(blank);
  assert.deepEqual((await service.fundAggregate(parent.fund.id)).compositions.find(list => list.valuation_date === '2026-02-01').items.map(item => item.units).sort(), ['10', '20']);
  let changing = await previewMain('compositions', child.share_classes.map((share, index) => ({ fund_id: parent.fund.id, valuation_date: '2026-02-01', child_isin: share.isin, units: index ? '20' : '11' })), 'proprietary');
  const token = changing.rows[0].normalized.required_confirmation;
  changing = await preview(changing, changing.batch.mapping, [{ id: changing.rows[0].id, replacement_confirmation: token }] as any);
  assert.equal(changing.batch.status, 'ready');
  changing = await preview(changing, changing.batch.mapping, [{ id: changing.rows[1].id, selected: false }] as any);
  assert.equal(changing.batch.status, 'needs_correction'); assert.notEqual(changing.rows[0].normalized.required_confirmation, token);
  assert.equal(changing.rows[0].normalized.list_diff.before.length, 2); assert.equal(changing.rows[0].normalized.list_diff.after.length, 1);
  const ready = await previewMain('compositions', [{ fund_id: parent.fund.id, valuation_date: '2026-05-01', child_isin: child.share_classes[1].isin, units: '10' }], 'proprietary');
  await mutate('setClassDisabled', { id: child.share_classes[1].id, technical_revision: 1, fund_revision: 1, disabled: true });
  await assert.rejects(commit(ready), errorCode('PREVIEW_STALE'));
});

test('Main-data batches roll back funds, share classes, versions and receipts after a later aggregate failure', async () => {
  const inputs = [sampleFund('MAIN-ROLLBACK-ONE'), sampleFund('MAIN-ROLLBACK-TWO')];
  const ready = await previewMain('funds', inputs.flatMap((input, index) => fundImportRows(input, `新基金${index}`)));
  assert.equal(ready.batch.status, 'ready');
  const save = service.saveFund; let count = 0;
  service.saveFund = async function (...args: any[]) { if (++count === 2) throw new Error('Injected second aggregate failure'); return save.apply(this, args); };
  const key = randomUUID();
  try { await assert.rejects(importMutation('commit', { batch_id: ready.batch.id, technical_revision: ready.batch.technical_revision, preview_token: ready.batch.preview.token }, 'test-user', key), /Injected second/); }
  finally { service.saveFund = save; }
  assert.equal(await service.model('funds').count({ where: { lei: inputs.map(input => input.fund.lei) } }), 0);
  assert.equal(await service.model('request_receipts').count({ where: { request_key: key } }), 0);
  assert.equal((await imports.view(ready.batch.id, 'test-user')).batch.status, 'ready');
  assert.equal((await commit(ready)).object_count, 2);
});

test('Manual fund creation and bulk edits sharing an ISIN and child fund never deadlock or duplicate the identity', async () => {
  const child = await mutate('saveFund', sampleFund('MAIN-LOCK-CHILD'));
  const isin = 'DEMO-MAIN-LOCK-CONTEST';
  const ready = await previewMain('funds', [{ row_type: '份额', fund_id: child.fund.id, share_id: child.share_classes[0].id, 'share.isin': isin }]);
  assert.equal(ready.batch.status, 'ready');
  const input = sampleProprietary('MAIN-LOCK-PARENT'); input.share_classes[0].values.isin = isin;
  const competing = { ...input, compositions: [{ valuation_date: '2026-01-01', items: [{ child_share_class_id: child.share_classes[1].id, units: '1' }] }] };
  const results = await Promise.allSettled([commit(ready), mutate('saveFund', competing)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const failure: any = results.find(result => result.status === 'rejected');
  assert.ok(failure.reason.code === 'PREVIEW_STALE' || failure.reason.name === 'SequelizeUniqueConstraintError', failure.reason.message);
  assert.equal(await service.model('share_classes').count({ where: { isin } }), 1);
});

test('Composite Gate terms enforce the same required number and unit in manual entry and imports', async () => {
  const input = sampleFund('MAIN-GATE');
  input.share_classes[0].terms.gate_raw = { value: '', unit: '天/ILG' };
  await assert.rejects(mutate('saveFund', input), errorCode('REQUIRED'));
  assert.equal(await service.model('funds').count({ where: { lei: input.fund.lei } }), 0);
  const valid = sampleFund('MAIN-GATE-EXISTING'); const saved = await mutate('saveFund', valid);
  const bad = await previewMain('funds', [{ fund_id: saved.fund.id, share_id: saved.share_classes[0].id, 'terms.gate_raw.value': '#清空' }]);
  assert.equal(bad.batch.status, 'needs_correction'); assert.equal(bad.rows[0].errors[0].code, 'REQUIRED');
  await assert.rejects(commit(bad), errorCode('PREVIEW_REQUIRED'));
  assert.equal((await service.versions(saved.fund.id)).length, 1);
});

const stageSeries = (type: string, rows: string, context = {}) => importMutation('stage', { data_type: type, target_mode: 'columns', original_name: '模拟多对象.csv', content_base64: Buffer.from(rows).toString('base64'), ...context });
const seriesMapping = { isin: 'ISIN', date: '日期', value: '数值' };
const benchmarkMapping = { benchmark_id: '基准 ID', date: '日期', value: '数值' };

test('Series templates identify objects explicitly and support a single target without an identity column', async () => {
  for (const type of ['nav', 'returns', 'benchmark']) for (const mode of ['single', 'columns']) {
    const book = XLSX.read(await imports.seriesTemplate(type, mode), { type: 'buffer' });
    const headings = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1 })[0] as string[];
    assert.equal(headings.includes(type === 'benchmark' ? '基准 ID' : 'ISIN'), mode === 'columns');
    assert.equal(headings.includes('是否预估值'), type === 'returns');
    assert.equal(new Set(headings).size, headings.length);
    assert.ok(book.SheetNames.includes(type === 'benchmark' ? '基准参考' : '份额参考'));
  }
  await assert.rejects(imports.seriesTemplate('transactions'), errorCode('INVALID_TEMPLATE'));
  await assert.rejects(stageSeries('nav', '日期,数值\n2026-01-01,1', { share_class_id: fund.share_classes[0].id }), errorCode('AMBIGUOUS_TARGET'));
});

test('Multiple funds and share classes use object plus date uniqueness, exact values and stable import provenance', async () => {
  const child = await mutate('saveFund', sampleFund('SERIES-MULTI'));
  const parent = await mutate('saveFund', sampleProprietary('SERIES-PROP'));
  const all = [child.share_classes[0], parent.share_classes[0], child.share_classes[1]];
  const original = '123456789012345.12345678';
  const staged = await stageSeries('nav', 'ISIN,日期,数值\n' + all.map(row => `${row.isin},2026-01-01,${original}`).join('\n'));
  const ready = await preview(staged, seriesMapping);
  assert.equal(ready.batch.status, 'ready', JSON.stringify(ready.rows));
  const result = await commit(ready); assert.equal(result.inserted_count, 3);
  assert.deepEqual(await commit(ready), result);
  const rows = await service.model('fund_navs').findAll({ where: { source_batch_id: staged.batch.id }, order: [['source_row', 'ASC']] });
  assert.deepEqual(rows.map(row => row.get('share_class_id')), all.map(row => row.id));
  assert.ok(rows.every(row => row.get('nav_per_unit') === original));
  assert.deepEqual(rows.map(row => row.get('source_row')), [2, 3, 4]);
  assert.equal((await service.versions(child.fund.id)).length, 1);
  assert.equal((await service.versions(parent.fund.id)).length, 1);
  const same = await preview(await stageSeries('nav', 'ISIN,日期,数值\n' + all.map(row => `${row.isin},2026-01-01,${original}`).join('\n')), seriesMapping);
  assert.ok(same.rows.every(row => row.operation === 'unchanged')); assert.equal((await commit(same)).unchanged_count, 3);
  for (const row of rows) { await row.reload(); assert.equal(row.get('technical_revision'), 1); assert.equal(row.get('source_batch_id'), staged.batch.id); }
});

test('Multi-object invalid identities and duplicate dates stay visible until corrected or explicitly excluded', async () => {
  const input = `ISIN,日期,数值\n${fund.share_classes[0].isin},2040-01-01,1\nMISSING-ISIN,2040-01-01,2\n${fund.share_classes[0].isin},2040-01-01,3`;
  let result = await preview(await stageSeries('nav', input), seriesMapping);
  assert.equal(result.batch.status, 'needs_correction');
  assert.equal(result.rows[1].errors[0].code, 'IDENTITY_NOT_FOUND');
  assert.equal(result.rows[0].errors[0].code, 'DUPLICATE_FILE_KEY');
  await assert.rejects(commit(result), errorCode('PREVIEW_REQUIRED'));
  await assert.rejects(preview(result, { ...seriesMapping, isin: '日期' }), errorCode('AMBIGUOUS_MAPPING'));
  await assert.rejects(preview(result, { ...seriesMapping, source_batch_id: '数值' } as any), errorCode('FIELD_NOT_WRITABLE'));
  result = await preview(result, seriesMapping, [{ id: result.rows[1].id, corrected: { ISIN: fund.share_classes[1].isin } }, { id: result.rows[2].id, selected: false }] as any);
  assert.equal(result.rows[1].raw.ISIN, 'MISSING-ISIN'); assert.equal(result.rows[1].corrected.ISIN, fund.share_classes[1].isin);
  assert.equal((await commit(result)).committed_count, 2);
});

test('Return estimate mapping preserves unknown and warns before replacing a formal value; proprietary returns remain rejected', async () => {
  const aggregate = await mutate('saveFund', sampleFund('SERIES-ESTIMATE'));
  const share = aggregate.share_classes[0];
  await mutate('saveSeries', { data_type: 'returns', values: { share_class_id: share.id, return_date: '2026-02-01', mtd_return: '0.01', estimate_label: '否' }, expected_revision: null });
  const mapping = { ...seriesMapping, estimate: '预估', value_mode: 'percent' };
  let result = await preview(await stageSeries('returns', `ISIN,日期,数值,预估\n${share.isin},2026-02-01,2%,是\n${aggregate.share_classes[1].isin},2026-02-01,0.000001%,`), mapping);
  assert.equal(result.rows[0].normalized.existing_values.estimate_label, '否');
  assert.equal(result.rows[0].normalized.values.mtd_return, '0.02');
  assert.ok(result.rows[0].normalized.warnings.some(text => text.includes('正式值覆盖为预估值')));
  assert.equal(result.rows[1].normalized.values.mtd_return, '0.00000001');
  const saved = await commit(result); assert.equal(saved.overwritten_count, 1); assert.equal(saved.inserted_count, 1);
  result = await preview(await stageSeries('returns', `ISIN,日期,数值,预估\n${share.isin},2026-02-01,0.02,否`), { ...seriesMapping, value_mode: 'ratio' } as any);
  assert.equal(result.rows[0].normalized.values.estimate_label, null, 'Unmapped estimate must become unknown, never retain an old label');
  await commit(result);
  assert.equal((await service.model('fund_returns').findByPk(saved.record_ids[0])).get('estimate_label'), null);
  const proprietary = await mutate('saveFund', sampleProprietary('NO-PROP-RETURN'));
  const wrong = await preview(await stageSeries('returns', `ISIN,日期,数值\n${proprietary.share_classes[0].isin},2026-02-01,0.02`), { ...seriesMapping, value_mode: 'ratio' } as any);
  assert.equal(wrong.rows[0].errors[0].code, 'THIRD_PARTY_REQUIRED');
});

test('Single and multiple benchmark imports use exact IDs, preserve long decimals and detect definition changes', async () => {
  const first = await mutate('saveBenchmark', { values: { name: '模拟同名基准', category: '模拟' } });
  const second = await mutate('saveBenchmark', { values: { name: '模拟同名基准', category: '模拟' } });
  let result = await preview(await stageSeries('benchmark', `基准 ID,日期,数值\n${first.id},2026-01-01,123456789012345.12345678\n${second.id},2026-01-01,0.00000001`), benchmarkMapping);
  assert.equal(result.batch.status, 'ready');
  const saved = await commit(result); assert.equal(saved.inserted_count, 2);
  assert.equal((await service.model('benchmark_values').findByPk(saved.record_ids[0])).get('index_value'), '123456789012345.12345678');
  const staged = await stageSeries('benchmark', '日期,数值\n2026-01-02,5', { target_mode: 'single', benchmark_id: first.id });
  result = await preview(staged);
  await mutate('saveBenchmark', { id: first.id, technical_revision: 1, values: { name: '模拟基准已改名', category: '模拟' } });
  await assert.rejects(commit(result), errorCode('PREVIEW_STALE'));
  assert.equal(await service.model('benchmark_values').count({ where: { benchmark_id: first.id, value_date: '2026-01-02' } }), 0);
  result = await preview(result); assert.ok(result.rows[0].normalized.target_label.includes('已改名')); await commit(result);
  const unknown = await preview(await stageSeries('benchmark', `基准 ID,日期,数值\n${randomUUID()},2026-01-01,1\n模拟同名基准,2026-01-01,2`), benchmarkMapping);
  assert.equal(unknown.batch.status, 'needs_correction'); assert.equal(unknown.rows[0].errors[0].code, 'NOT_FOUND'); assert.equal(unknown.rows[1].errors[0].code, 'INVALID_ID');
});

test('Series preview detects delete-and-reinsert with identical revision and parent deletion; excluded targets do not stale a batch', async () => {
  const aggregate = await mutate('saveFund', sampleFund('SERIES-STALE'));
  const share = aggregate.share_classes[0];
  const values = { share_class_id: share.id, nav_date: '2026-03-01', nav_per_unit: '1' };
  const saved = await mutate('saveSeries', { data_type: 'nav', values, expected_revision: null });
  const text = `ISIN,日期,数值\n${share.isin},2026-03-01,2\n${aggregate.share_classes[1].isin},2026-03-02,3`;
  const result = await preview(await stageSeries('nav', text), seriesMapping);
  await mutate('deleteSeries', { data_type: 'nav', id: saved.id, technical_revision: 1 });
  const replacement = await mutate('saveSeries', { data_type: 'nav', values, expected_revision: null });
  assert.notEqual(replacement.id, saved.id); assert.equal(replacement.technical_revision, saved.technical_revision);
  await assert.rejects(commit(result), errorCode('PREVIEW_STALE'));
  const renewed = await preview(result, seriesMapping, [{ id: result.rows[1].id, selected: false }] as any);
  await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: aggregate.share_classes[1].id, nav_date: '2026-03-02', nav_per_unit: '4' } });
  assert.equal((await commit(renewed)).committed_count, 1, 'Unselected date changes must not stale selected records');
  const deleted = await preview(await stageSeries('nav', text), seriesMapping);
  await mutate('setDeleted', { table: 'funds', id: aggregate.fund.id, technical_revision: aggregate.fund.technical_revision, deleted: true });
  await assert.rejects(commit(deleted), errorCode('PREVIEW_STALE'));
});

test('Multi-object series failure rolls back earlier records, revisions and success receipt before safe retry', async () => {
  const aggregate = await mutate('saveFund', sampleFund('SERIES-ROLLBACK'));
  const ready = await preview(await stageSeries('nav', `ISIN,日期,数值\n${aggregate.share_classes[0].isin},2026-01-01,1\n${aggregate.share_classes[1].isin},2026-01-01,2`), seriesMapping);
  const original = service.saveSeries; let count = 0;
  service.saveSeries = async function(payload, tx) { if (++count === 2) throw new Error('Injected later series failure'); return original.call(this, payload, tx); };
  const key = randomUUID(); const payload = { batch_id: ready.batch.id, technical_revision: ready.batch.technical_revision, preview_token: ready.batch.preview.token };
  try { await assert.rejects(importMutation('commit', payload, 'test-user', key), /Injected later series failure/); }
  finally { service.saveSeries = original; }
  assert.equal(await service.model('fund_navs').count({ where: { source_batch_id: ready.batch.id } }), 0);
  assert.equal(await service.model('request_receipts').count({ where: { request_key: key } }), 0);
  assert.equal((await imports.view(ready.batch.id, 'test-user')).batch.status, 'ready');
  assert.equal((await importMutation('commit', payload, 'test-user', key)).committed_count, 2);
});

test('Concurrent reversed-order series batches share aggregate lock order and allow only one stale target set to commit', async () => {
  const child = await mutate('saveFund', sampleFund('SERIES-CONCURRENT'));
  const parent = await mutate('saveFund', sampleProprietary('SERIES-CONCURRENT-PROP'));
  const lines = [child.share_classes[0], parent.share_classes[0]].map(row => `${row.isin},2026-01-01,1`);
  const a = await preview(await stageSeries('nav', 'ISIN,日期,数值\n' + lines.join('\n')), seriesMapping);
  const b = await preview(await stageSeries('nav', 'ISIN,日期,数值\n' + [...lines].reverse().join('\n')), seriesMapping);
  const results = await Promise.allSettled([commit(a), commit(b)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'PREVIEW_STALE');
  assert.equal(await service.model('fund_navs').count({ where: { share_class_id: [child.share_classes[0].id, parent.share_classes[0].id] } }), 2);
});

const queries = new FinanceQueries(service);
test('Paged business queries reach every record beyond 200 and use deterministic ties without interpreting search metacharacters', async () => {
  const created: any[] = [];
  for (let i = 0; i < 205; i++) created.push(await mutate('saveBenchmark', { values: { name: `模拟分页-${String(i).padStart(3,'0')}`, category: '分页测试' } }));
  await domainWrite(() => db.sequelize.transaction(async transaction => service.model('benchmarks').update({ created_at: new Date('2020-01-01T00:00:00Z') }, { where: { id: created.map(row => row.id) }, ...writeOptions(transaction) })));
  const collected: string[] = [];
  for (let page = 1; page <= 11; page++) {
    const result = await queries.list({ table: 'benchmarks', search: '模拟分页-', page, page_size: 20 });
    assert.equal(result.count, 205); assert.equal(result.page, page); collected.push(...result.rows.map(row => row.id));
  }
  assert.equal(new Set(collected).size, 205); assert.deepEqual([...collected].sort(), created.map(row => row.id).sort());
  assert.deepEqual(collected, [...collected].sort(), 'Equal timestamps use ID as a deterministic tie-breaker');
  const final = await queries.list({ table: 'benchmarks', search: '模拟分页-204' }); assert.equal(final.rows[0].id, created[204].id);
  const literal = await mutate('saveBenchmark', { values: { name: '模拟%_\\标识', category: '匹配测试' } });
  assert.deepEqual((await queries.list({ table: 'benchmarks', search: '%_\\' })).rows.map(row => row.id), [literal.id]);
  assert.equal((await queries.list({ table: 'benchmarks', search: "' OR TRUE --" })).count, 0);
  assert.equal((await queries.list({ table: 'benchmarks', search: '模拟分页-', page: 99, page_size: 20 })).count, 205);
});

test('Remote lookups page through large share sets and hydrate historical IDs while enforcing active and fund-kind filters', async () => {
  const input = sampleFund('QUERY-SHARES'); const template = input.share_classes[0];
  input.share_classes = Array.from({ length: 205 }, (_, i) => ({ values: { ...template.values, isin: `QUERY-SHARE-${String(i).padStart(3,'0')}`, class_label: `类别${i}` }, terms: { ...template.terms } }));
  const aggregate = await mutate('saveFund', input); const last = aggregate.share_classes.find(row => row.isin === 'QUERY-SHARE-204');
  const page = await queries.lookup({ resource: 'share_classes', search: 'QUERY-SHARE-', page: 11, page_size: 20 });
  assert.equal(page.count, 205); assert.equal(page.rows.length, 5);
  const exact = await queries.lookup({ resource: 'share_classes', search: 'QUERY-SHARE-204' });
  assert.equal(exact.rows.length, 1); assert.equal(exact.rows[0].value, last.id); assert.match(exact.rows[0].label, /USD/);
  const listing = await queries.list({ table: 'funds', id: aggregate.fund.id }); assert.equal(listing.rows[0]._share_classes.length, 205);
  assert.equal((await queries.lookup({ resource: 'share_classes', fund_kind: 'proprietary', search: 'QUERY-SHARE-' })).count, 0);
  await mutate('setDeleted', { table: 'funds', id: aggregate.fund.id, technical_revision: 1, deleted: true });
  assert.equal((await queries.lookup({ resource: 'share_classes', search: 'QUERY-SHARE-' })).count, 0);
  const hydrated = await queries.lookup({ resource: 'share_classes', ids: last.id }); assert.equal(hydrated.rows[0].disabled, true); assert.match(hydrated.rows[0].label, /QUERY-SHARE-204/);
  assert.equal((await queries.lookup({ resource: 'funds', state: 'all', ids: aggregate.fund.id })).rows[0].disabled, false);
});

test('Joined lists retain entity and share labels, apply date and state filters, and retrieve same-day values outside any page', async () => {
  const aggregate = await mutate('saveFund', sampleFund('QUERY-LABELS'));
  const entity = await mutate('saveEntity', sampleEntity('QUERY-CLIENT','查询主体'));
  const values = { ...trade('10').values, entity_id: entity.id, share_class_id: aggregate.share_classes[0].id };
  const record = await mutate('saveTrade', { values });
  let result = await queries.list({ table: 'transactions', entity_id: entity.id, state: 'active', date_from: '2026-01-01', date_to: '2026-01-01' });
  assert.equal(result.count, 1); assert.equal(result.rows[0]._entity_name, entity.legal_name); assert.equal(result.rows[0]._client_code, 'QUERY-CLIENT'); assert.match(result.rows[0]._share_label,/QUERY-LABELS/);
  assert.equal((await queries.list({ table: 'transactions', entity_id: entity.id, date_from: '2026-01-02' })).count, 0);
  await mutate('voidTrade', { id: record.id, technical_revision: 1 });
  assert.equal((await queries.list({ table: 'transactions', entity_id: entity.id, state: 'active' })).count, 0);
  assert.equal((await queries.list({ table: 'transactions', entity_id: entity.id, state: 'inactive' })).count, 1);
  await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: values.share_class_id, nav_date: '1990-01-01', nav_per_unit: '123456789012345.12345678' } });
  const nav = await queries.seriesAt({ data_type: 'nav', parent_id: values.share_class_id, date: '1990-01-01' }); assert.equal(nav.nav_per_unit, '123456789012345.12345678');
  assert.equal(await queries.seriesAt({ data_type: 'nav', parent_id: values.share_class_id, date: '1990-01-02' }), null);
  const entityList = await queries.list({ table: 'investment_entities', client_code: 'QUERY-CLIENT' }); assert.equal(entityList.rows[0]._client_code, 'QUERY-CLIENT');
  const counts = await queries.summary(); assert.equal(counts.transactions, await service.model('transactions').count({ where: { is_void: false } }));
});

test('Paged holdings preserve exact totals, cutoff dates, missing NAV, deleted objects and independent same-client subjects', async () => {
  const aggregate = await mutate('saveFund', sampleFund('QUERY-POSITIONS'));
  const a = await mutate('saveEntity', sampleEntity('QUERY-POSITION-GROUP','甲'));
  const b = await mutate('saveEntity', sampleEntity('QUERY-POSITION-GROUP','乙'));
  for (const entity of [a,b]) for (const share of aggregate.share_classes) await mutate('saveTrade', { values: { ...trade('0.1').values, entity_id: entity.id, share_class_id: share.id } });
  await mutate('saveTrade', { values: { ...trade('0.2','追加申购','2026-01-02').values, entity_id: a.id, share_class_id: aggregate.share_classes[0].id } });
  await mutate('saveSeries', { data_type:'nav', expected_revision:null, values: { share_class_id:aggregate.share_classes[0].id, nav_date:'2026-01-01', nav_per_unit:'1.25' } });
  await mutate('saveSeries', { data_type:'nav', expected_revision:null, values: { share_class_id:aggregate.share_classes[0].id, nav_date:'2099-01-01', nav_per_unit:'99' } });
  const result = await queries.positions({ entity_id:a.id, as_of:'2026-01-02', page_size:1 }); assert.equal(result.count,2); assert.equal(result.rows.length,1);
  const combined = [...result.rows, ...(await queries.positions({ entity_id:a.id, as_of:'2026-01-02', page:2, page_size:1 })).rows];
  const valued=combined.find(row=>row.share_class_id===aggregate.share_classes[0].id); assert.equal(valued.units,'0.3'); assert.equal(valued.market_value,'0.375'); assert.equal(valued.nav_date,'2026-01-01');
  assert.equal(combined.find(row=>row.share_class_id===aggregate.share_classes[1].id).market_value,null);
  assert.equal((await queries.positions({ entity_id:a.id, as_of:'2026-01-01', share_class_id:aggregate.share_classes[0].id })).rows[0].units,'0.1');
  assert.equal((await queries.positions({ entity_id:b.id, as_of:'2026-01-02', share_class_id:aggregate.share_classes[0].id })).rows[0].units,'0.1');
  await mutate('setDeleted',{ table:'funds', id:aggregate.fund.id, technical_revision:1, deleted:true });
  assert.equal((await queries.positions({ entity_id:a.id, balance:'positive' })).rows[0].fund_deleted,true);
  assert.equal((await queries.positions({ entity_id:a.id, currency:'JPY' })).count,0);
});

test('Query parameters cannot expose private tables, interpolate sort SQL or bypass validated paging and references', async () => {
  for (const table of ['request_receipts','import_batches','users','constructor','__proto__',"funds; DROP TABLE finance_funds"]) await assert.rejects(queries.list({ table }),errorCode('INVALID_RESOURCE'));
  for (const query of [{page:0},{page:1.2},{page:'Infinity'},{page_size:-1}]) await assert.rejects(queries.list({table:'funds',...query}),errorCode('INVALID_PAGINATION'));
  await assert.rejects(queries.list({table:'funds',order:'short_name;select 1'}),errorCode('INVALID_SORT'));
  await assert.rejects(queries.list({table:'funds',filter:{is_deleted:false}}),errorCode('INVALID_FILTER'));
  await assert.rejects(queries.list({table:'fund_navs',date_from:'2026-02-30'}),errorCode('INVALID_DATE'));
  await assert.rejects(queries.list({table:'fund_navs',date_from:'2026-02-01',date_to:'2026-01-01'}),errorCode('INVALID_DATE_ORDER'));
  await assert.rejects(queries.lookup({resource:'share_classes',ids:'not-an-id'}),errorCode('INVALID_ID'));
  assert.equal((await queries.list({table:'funds',page_size:1000})).page_size,200);
});

const drafts = new FinanceDrafts(service);
const draftMutation = (method: string, payload: any, actor = 'draft-owner', key = randomUUID()) => service.write(actor, `${method}Draft`, key, payload, tx => drafts[method](payload, actor, tx));
const draftSubmit = (action: string, payload: any, draft: any, actor = 'draft-owner', key = randomUUID()) => service.write(actor, action, key, { ...payload, draft }, tx => drafts.submit(draft, action, payload, actor, tx, () => service[action](payload, tx)));

test('Personal drafts preserve incomplete exact text for every form without business writes; owner-scoped list/get', async () => {
  const tables = ['funds', 'share_classes', 'investment_entities', 'transactions', 'fund_navs', 'fund_returns', 'benchmarks', 'benchmark_values', 'fund_versions'];
  const before = await Promise.all(tables.map(table => service.model(table).count()));
  const samples = {
    fund: { fund_kind: 'proprietary', fund: { short_name: '草稿基金', size_100m_usd: '123456789012345.123456789000' }, share_classes: [{ values: {}, terms: {} }], compositions: [{ items: [{ units: '尚未核对', remarks: '空关联允许暂存' }] }] },
    entity: { client_code: '', entity: { legal_name: '草稿主体' }, agreements: [] },
    trade: { entity_id: '', fee_rate: '0.0000000000000001', confirmed_units: '-' },
    series: { data_type: 'returns', value: '0.0000000000000001', estimate_label: null },
    benchmark: { remarks: '草稿_%精确' }, benchmarkValue: { index_value: '123456789012345.123456789000' },
  };
  const rows = [];
  for (const [form_type, values] of Object.entries(samples)) {
    const row = await draftMutation('save', { form_type, content: { values } }); rows.push(row);
    assert.deepEqual((await drafts.get(row.id, 'draft-owner')).get('content'), { values });
    await assert.rejects(drafts.get(row.id, 'another-user'), errorCode('DRAFT_NOT_FOUND'));
  }
  assert.deepEqual(await Promise.all(tables.map(table => service.model(table).count())), before);
  const first = await drafts.list({ page_size: 2 }, 'draft-owner');
  assert.equal(first.count, 6); assert.equal(first.rows.length, 2); assert.ok(first.rows.every(row => !Object.hasOwn(row, 'content')));
  const last = await drafts.list({ page_size: 2, page: 3 }, 'draft-owner'); assert.equal(last.rows.length, 2);
  assert.equal((await drafts.list({}, 'another-user')).count, 0);
  assert.equal((await drafts.list({ search: '_%', form_type: 'benchmark' }, 'draft-owner')).count, 1);
  await assert.rejects(draftMutation('save', { form_type: 'fund', content: { values: { fund_kind: 'third_party', fund: { business_version: '9' } } } }), errorCode('FIELD_NOT_WRITABLE'));
  await assert.rejects(draftMutation('save', { form_type: 'benchmarkValue', content: { values: { index_value: 0.1 } } }), errorCode('INVALID_DRAFT'));
  await assert.rejects(draftMutation('save', { form_type: 'benchmark', owner_id: 'another-user', content: { values: {} } }), errorCode('FIELD_NOT_WRITABLE'));
  await assert.rejects(draftMutation('save', { form_type: 'benchmark', content: { values: { remarks: 'x'.repeat(1024 * 1024) } } }), errorCode('DRAFT_TOO_LARGE'));
  await assert.rejects(draftMutation('save', { form_type: '__proto__', content: { values: {} } }), errorCode('INVALID_DRAFT'));
});

test('Draft revisions serialize concurrent changes and prevent stale discard; receipt retries never recreate deleted drafts', async () => {
  const input = { form_type: 'benchmark', content: { values: { name: '并发草稿' } } }, key = randomUUID();
  const created = await draftMutation('save', input, 'concurrent-owner', key);
  assert.deepEqual(await draftMutation('save', input, 'concurrent-owner', key), created);
  const base = { ...created, form_type: 'benchmark' };
  const changes = await Promise.allSettled(['一', '二'].map(name => draftMutation('save', { ...base, content: { values: { name } } }, 'concurrent-owner')));
  assert.equal(changes.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal((changes.find(row => row.status === 'rejected') as any).reason.code, 'STALE_REVISION');
  const current = await drafts.get(created.id, 'concurrent-owner'); assert.equal(current.get('technical_revision'), 2);
  await assert.rejects(draftMutation('discard', created, 'concurrent-owner'), errorCode('STALE_REVISION'));
  const ref = { id: created.id, technical_revision: 2 }, discardKey = randomUUID();
  await assert.rejects(draftMutation('discard', ref, 'another-user'), errorCode('DRAFT_NOT_FOUND'));
  const discarded = await draftMutation('discard', ref, 'concurrent-owner', discardKey);
  assert.deepEqual(await draftMutation('discard', ref, 'concurrent-owner', discardKey), discarded);
  assert.deepEqual(await draftMutation('save', input, 'concurrent-owner', key), created);
  await assert.rejects(drafts.get(created.id, 'concurrent-owner'), errorCode('DRAFT_NOT_FOUND'));
  await assert.rejects(draftMutation('save', { ...base, technical_revision: 2, content: { values: {} } }, 'concurrent-owner'), errorCode('DRAFT_NOT_FOUND'));
});

test('Formal save and draft consumption are atomic, type-bound, owner-bound, and retry-safe', async () => {
  const input = sampleFund('DRAFT-CONSUME');
  const draft = await draftMutation('save', { form_type: 'fund', content: { values: input } });
  await assert.rejects(draftSubmit('saveFund', input, draft, 'intruder'), errorCode('DRAFT_NOT_FOUND'));
  await assert.rejects(draftSubmit('saveBenchmark', { values: { name: '错误对象' } }, draft), errorCode('DRAFT_TARGET_CHANGED'));
  const bad = { ...input, share_classes: [{ values: {}, terms: {} }] };
  await assert.rejects(draftSubmit('saveFund', bad, draft));
  assert.equal((await drafts.get(draft.id, 'draft-owner')).get('technical_revision'), 1);
  assert.equal(await service.model('funds').count({ where: { short_name: input.fund.short_name } }), 0);
  const key = randomUUID(); const result = await draftSubmit('saveFund', input, draft, 'draft-owner', key);
  assert.deepEqual(await draftSubmit('saveFund', input, draft, 'draft-owner', key), result);
  assert.equal(await service.model('fund_versions').count({ where: { fund_id: result.fund_id } }), 1);
  await assert.rejects(drafts.get(draft.id, 'draft-owner'), errorCode('DRAFT_NOT_FOUND'));
  await assert.rejects(draftSubmit('saveFund', input, draft), errorCode('DRAFT_NOT_FOUND'));
  const receipt = await service.model('request_receipts').findOne({ where: { actor_id: 'draft-owner', request_key: key } });
  assert.ok(!JSON.stringify(receipt.get('result')).includes('DRAFT-CONSUME'), 'receipt contains no draft contents');
});

test('Resumed edit drafts keep original business revisions and survive a stale formal save', async () => {
  const original = await mutate('saveBenchmark', { values: { name: '原资料' } });
  const content = { values: { name: '草稿修改' }, editing: { id: original.id, technical_revision: original.technical_revision } };
  const draft = await draftMutation('save', { form_type: 'benchmark', content });
  await mutate('saveBenchmark', { ...original, values: { name: '另一用户的修改' } });
  await assert.rejects(draftSubmit('saveBenchmark', { ...original, values: content.values }, draft), errorCode('STALE_REVISION'));
  assert.deepEqual((await drafts.get(draft.id, 'draft-owner')).get('content'), content);
  await assert.rejects(draftMutation('save', { ...draft, form_type: 'benchmark', content: { ...content, editing: { ...content.editing, technical_revision: 2 } } }), errorCode('DRAFT_TARGET_CHANGED'));
  await assert.rejects(draftSubmit('saveBenchmark', { id: original.id, technical_revision: 2, values: content.values }, draft), errorCode('DRAFT_TARGET_CHANGED'));
  assert.equal((await service.model('benchmarks').findByPk(original.id)).get('name'), '另一用户的修改');
});

test('Failure while consuming a draft rolls back the business result and receipt; retry and concurrent submit remain singular', async () => {
  const draft = await draftMutation('save', { form_type: 'benchmark', content: { values: { name: '模拟草稿消费回滚' } } });
  const payload = { values: { name: '模拟草稿消费回滚', remarks: '业务写入后故障' } }, key = randomUUID();
  const model = service.model('entry_drafts');
  model.addHook('beforeDestroy', 'test-draft-consumption-failure', row => { if (row.id === draft.id) throw new Error('simulated draft cleanup failure'); });
  try { await assert.rejects(draftSubmit('saveBenchmark', payload, draft, 'draft-owner', key), /simulated draft cleanup failure/); }
  finally { model.removeHook('beforeDestroy', 'test-draft-consumption-failure'); }
  assert.equal(await service.model('benchmarks').count({ where: { name: payload.values.name } }), 0);
  assert.equal(await service.model('request_receipts').count({ where: { actor_id: 'draft-owner', request_key: key } }), 0);
  assert.equal((await drafts.get(draft.id, 'draft-owner')).get('technical_revision'), 1);
  const outcomes = await Promise.allSettled([draftSubmit('saveBenchmark', payload, draft, 'draft-owner', key), draftSubmit('saveBenchmark', payload, draft)]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal((outcomes.find(row => row.status === 'rejected') as any).reason.code, 'DRAFT_NOT_FOUND');
  assert.equal(await service.model('benchmarks').count({ where: { name: payload.values.name } }), 1);
});

const quality = new FinanceIssues(service);
test('Quality holdings use the cutoff, positive independent balances, and actual NAV availability without invented age thresholds', async () => {
  const f = await mutate('saveFund', sampleFund('QUALITY-HOLDINGS'));
  const a = await mutate('saveEntity', sampleEntity('QUALITY-CLIENT', 'QUALITY-A'));
  const b = await mutate('saveEntity', sampleEntity('QUALITY-CLIENT', 'QUALITY-B'));
  for (const entity of [a,b]) await mutate('saveTrade', { values: { ...trade('7').values, entity_id: entity.id, share_class_id: f.share_classes[0].id } });
  await mutate('saveTrade', { values: { ...trade('7','赎回','2026-01-02').values, entity_id: b.id, share_class_id: f.share_classes[0].id } });
  await mutate('saveSeries', { data_type:'nav', expected_revision:null, values:{share_class_id:f.share_classes[0].id,nav_date:'2026-01-03',nav_per_unit:'1.25'} });
  const issues = await quality.list({category:'missing_nav',fund_id:f.fund.id,as_of:'2026-01-02'},'quality-owner');
  assert.equal(issues.count,1); assert.equal(issues.rows[0].entity_id,a.id); assert.equal(issues.rows[0].context.units,'7');
  assert.equal((await quality.list({category:'missing_nav',fund_id:f.fund.id,as_of:'2026-01-03'},'quality-owner')).count,0);
  await mutate('saveSeries',{data_type:'nav',expected_revision:null,values:{share_class_id:f.share_classes[0].id,nav_date:'1990-01-01',nav_per_unit:'0'}});
  assert.equal((await quality.list({category:'missing_nav',fund_id:f.fund.id,as_of:'2026-01-02'},'quality-owner')).count,0,'old and zero NAV is available, not missing or automatically expired');
});

test('Quality estimates and all dated fact types remain actionable until corrected, with deterministic paging and no write side effects', async () => {
  const f = await mutate('saveFund',sampleFund('QUALITY-FUTURE_%'));
  const entity = await mutate('saveEntity',sampleEntity('QUALITY-FUTURE','未来主体'));
  const future = await mutate('saveTrade',{values:{...trade('1').values,entity_id:entity.id,share_class_id:f.share_classes[0].id,confirmation_date:'2030-01-01'}});
  await mutate('saveSeries',{data_type:'nav',expected_revision:null,values:{share_class_id:f.share_classes[0].id,nav_date:'2030-01-01',nav_per_unit:'1.25000000000000001'}});
  const returns = await mutate('saveSeries',{data_type:'returns',expected_revision:null,values:{share_class_id:f.share_classes[0].id,return_date:'2030-01-01',mtd_return:'0.00000000000000001',estimate_label:null}});
  const before = await service.model('request_receipts').count();
  const report = await quality.list({fund_id:f.fund.id,as_of:'2026-01-01',page_size:2},'quality-owner');
  assert.equal(report.count,4); assert.equal(report.summary.future,3); assert.equal(report.summary.unknown_estimate,1);
  const next = await quality.list({fund_id:f.fund.id,as_of:'2026-01-01',page_size:2,page:2},'quality-owner');
  assert.equal(new Set([...report.rows,...next.rows].map(row=>row.id)).size,4);
  assert.equal((await quality.list({fund_id:f.fund.id,as_of:'2026-01-01',search:'_%'},'quality-owner')).count,4);
  assert.equal(await service.model('request_receipts').count(),before);
  await mutate('saveSeries',{data_type:'returns',expected_revision:1,values:{share_class_id:f.share_classes[0].id,return_date:'2030-01-01',mtd_return:'0.00000000000000001',estimate_label:'否'}});
  assert.equal((await quality.list({fund_id:f.fund.id,category:'unknown_estimate'},'quality-owner')).count,0);
  await mutate('setDeleted',{table:'investment_entities',id:entity.id,technical_revision:1,deleted:true});
  const deleted=await quality.list({fund_id:f.fund.id,category:'future',as_of:'2026-01-01'},'quality-owner'); assert.equal(deleted.rows.find(row=>row.record_id===future.id).context.deleted,true);
  await mutate('setDeleted',{table:'investment_entities',id:entity.id,technical_revision:2,deleted:false});
  await mutate('voidTrade',{...future,reason:'模拟未来交易核对'});
  assert.equal((await quality.list({fund_id:f.fund.id,category:'future',as_of:'2026-01-01'},'quality-owner')).count,2);
  const benchmark = await mutate('saveBenchmark',{values:{name:'模拟未来基准-QUALITY',category:'模拟'}});
  const value = await mutate('saveSeries',{data_type:'benchmark',expected_revision:null,values:{benchmark_id:benchmark.id,value_date:'2030-01-01',index_value:'1.2'}});
  const found = await quality.list({category:'future',search:'模拟未来基准-QUALITY',as_of:'2026-01-01'},'quality-owner'); assert.equal(found.count,1); assert.equal(found.rows[0].record_id,value.id);
  await assert.rejects(mutate('deleteSeries',{data_type:'benchmark',id:value.id,technical_revision:2}),errorCode('STALE_REVISION'));
  await mutate('deleteSeries',{data_type:'benchmark',...value});
  assert.equal((await quality.list({category:'future',search:'模拟未来基准-QUALITY',as_of:'2026-01-01'},'quality-owner')).count,0);
  assert.ok(await service.model('benchmarks').findByPk(benchmark.id));
});

test('Quality composition diagnostics match valuation rules for every incomplete group, mixed currencies and non-positive totals', async () => {
  const input = sampleFund('QUALITY-COMPOSITION'); input.share_classes[1].values.currency='HKD';
  const f = await mutate('saveFund',input); const [a,b]=f.share_classes;
  for(const share of [a,b]) await mutate('saveSeries',{data_type:'nav',expected_revision:null,values:{share_class_id:share.id,nav_date:'2026-01-01',nav_per_unit:'1.25'}});
  const parent = await mutate('saveFund',{...sampleProprietary('QUALITY-PARENT'),compositions:[
    {valuation_date:null,items:[]}, {valuation_date:'2026-01-01',items:[{child_share_class_id:a.id,units:null}]},
    {valuation_date:'2026-01-02',items:[{child_share_class_id:a.id,units:'1'},{child_share_class_id:b.id,units:'2'}]},
    {valuation_date:'2026-01-03',items:[{child_share_class_id:a.id,units:'0'}]},
    {valuation_date:'1990-01-01',items:[{child_share_class_id:a.id,units:'1'}]},
    {valuation_date:'2030-01-01',items:[{child_share_class_id:a.id,units:'1'}]},
  ]});
  const values = await service.compositionValues(parent.fund.id);
  const expected = values.compositions.flatMap(list=>list.issues.map(issue=>`${list.id}:${issue.code}:${issue.child_share_class_id||''}`)).sort();
  const issues = await quality.list({category:'composition',fund_id:parent.fund.id,as_of:'2026-01-05',page_size:100},'quality-owner');
  assert.deepEqual(issues.rows.map(issue=>`${issue.record_id}:${issue.code}:${issue.share_class_id||''}`).sort(),expected);
  assert.equal((await quality.list({category:'future',fund_id:parent.fund.id,as_of:'2026-01-05'},'quality-owner')).count,1);
});

test('Quality import errors and source links are owner-scoped, honor selection/cancellation, and include failed parsing', async () => {
  const f = await mutate('saveFund',sampleFund('QUALITY-IMPORT'));
  const actor='quality-private-owner';
  const staged = await importMutation('stage',{data_type:'returns',share_class_id:f.share_classes[0].id,original_name:'质量私有错误.csv',content_base64:Buffer.from('日期,数值\n2026-01-01,bad\n2026-01-02,1\n').toString('base64')},actor);
  const payload={batch_id:staged.batch.id,technical_revision:staged.batch.technical_revision,mapping:{date:'日期',value:'数值',value_mode:'percent'}};
  let preview=await importMutation('preview',payload,actor);
  const own=await quality.list({category:'imports',search:'质量私有错误.csv'},actor);
  assert.ok(own.count>0); assert.equal(own.rows[0].source_row,2); assert.equal(own.rows[0].source_access,true);
  const other=await quality.list({category:'imports',search:'质量私有错误.csv'},'another-owner'); assert.equal(other.count,0); assert.ok(other.recent_imports.every(row=>row.original_name!=='质量私有错误.csv')); assert.ok(own.recent_imports.some(row=>row.id===staged.batch.id));
  preview=await importMutation('preview',{...payload,technical_revision:preview.batch.technical_revision,corrections:[{id:preview.rows[0].id,selected:false}]},actor);
  assert.equal((await quality.list({category:'imports',search:'质量私有错误.csv'},actor)).count,0);
  await importMutation('commit',{batch_id:preview.batch.id,technical_revision:preview.batch.technical_revision,preview_token:preview.batch.preview.token},actor);
  const visible=await quality.list({category:'unknown_estimate',fund_id:f.fund.id},actor); assert.equal(visible.count,1); assert.equal(visible.rows[0].source_name,'质量私有错误.csv');
  const masked=await quality.list({category:'unknown_estimate',fund_id:f.fund.id},'another-owner'); assert.equal(masked.count,1); assert.equal(masked.rows[0].source_access,false); assert.equal(masked.rows[0].source_name,null);
  const failure=await importMutation('stage',{data_type:'nav',share_class_id:f.share_classes[0].id,original_name:'质量解析失败.csv',content_base64:Buffer.from('重复,重复\n1,2\n').toString('base64')},actor);
  const failed=await quality.list({category:'imports',search:'质量解析失败.csv'},actor); assert.equal(failed.count,1); assert.equal(failed.rows[0].code,'PARSE_FAILED');
  await importMutation('cancel',{batch_id:failure.batch.id,technical_revision:failure.batch.technical_revision},actor);
  assert.equal((await quality.list({category:'imports',search:'质量解析失败.csv'},actor)).count,0);
});

test('Quality configuration matches source definitions and rejects unsupported or malformed query controls', async () => {
  const options=await new FinanceOptions(service).list();
  const expected=options.filter(row=>!row.confirmed||!row.values.length).map(row=>row.source_key).sort();
  const actual=await quality.list({category:'options',page_size:200},'quality-owner'); assert.deepEqual(actual.rows.map(row=>row.context.source_key).sort(),expected);
  for(const query of [{category:'__proto__'},{as_of:'2026-02-30'},{page:0},{owner_id:'another-owner'},{filter:{}},{sort:'drop table finance_funds'},{fund_id:'invalid'}]) await assert.rejects(quality.list(query,'quality-owner'));
  await assert.rejects(mutate('deleteSeries',{data_type:'constructor',id:randomUUID(),technical_revision:1}),errorCode('INVALID_SERIES'));
});

const exportsService = new FinanceExports(service);
const exportRows = (bytes: Buffer, table: string) => {
  const book = XLSX.read(bytes, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json<any>(book.Sheets['业务数据'], { defval: '' });
  const columns = exportColumns(table);
  return rows.map(row => Object.fromEntries(columns.map(column => [column.key, exchangeValue(row[column.label])])));
};
test('Business export covers every permitted table, excludes private paths and rejects arbitrary filters', async () => {
  for (const table of exportTables) {
    const result = await exportsService.download({ table });
    assert.equal(result.parts, 1, table);
    const book = XLSX.read(result.bytes, { type: 'buffer' });
    assert.ok(book.Sheets[exchangeSheet], table);
    assert.equal(exportRows(result.bytes, table).length, result.count, table);
    assert.ok(exportColumns(table).every(column => !['storage_key', 'file_id'].includes(column.key)), table);
    for (const address of Object.keys(book.Sheets['业务数据']).filter(address => !address.startsWith('!'))) {
      assert.equal(book.Sheets['业务数据'][address].t, 's', `${table}:${address}`);
      assert.equal(book.Sheets['业务数据'][address].f, undefined, `${table}:${address}`);
    }
  }
  for (const table of ['request_receipts', 'import_rows', 'entry_drafts', 'file_records', 'option_sets', '__proto__']) await assert.rejects(exportsService.download({ table }), errorCode('INVALID_EXPORT'));
  await assert.rejects(exportsService.download({ table: 'funds', page: 1 }), errorCode('INVALID_EXPORT_FILTER'));
  await assert.rejects(exportsService.download({ table: 'funds', date_from: '2026-01-01' }), errorCode('INVALID_EXPORT_FILTER'));
  await assert.rejects(exportsService.download({ table: 'positions', state: 'active' }), errorCode('INVALID_EXPORT_FILTER'));
  await assert.rejects(exportsService.download({ table: 'fund_navs', date_from: '2026-01-02', date_to: '2026-01-01' }), errorCode('INVALID_DATE_ORDER'));
  assert.equal(exportColumns('transactions').find(column => column.key === 'fee_rate').unit, '比例值；0.02 = 2%');
  assert.equal(exportColumns('transactions').find(column => column.key === 'source_batch_id').role, 'readonly');
});

test('Exchange encoding preserves exact text, nulls, formulas as text, and deleted or voided facts', async () => {
  const special = [null, '', '\\N', '\\\\N', '=1+1', '+123', '@SUM(1)', '0000123', '空\n白', '123456789012345678901234567890.123456789'];
  assert.deepEqual(special.map(value => exchangeValue(exchangeText(value))), special);
  assert.throws(() => exchangeText('x'.repeat(32768)), errorCode('EXCEL_CELL_LIMIT'));
  assert.throws(() => exchangeText('x\u0000'), errorCode('EXCEL_CELL_LIMIT'));
  const sample = sampleFund('EXPORT-EXACT'); sample.fund.full_name = '=HYPERLINK("https://example.invalid")';
  const f = await mutate('saveFund', sample);
  const e = await mutate('saveEntity', sampleEntity('EXPORT', 'TEXT'));
  const saved = await mutate('saveTrade', { values: { entity_id: e.id, share_class_id: f.share_classes[0].id, transaction_type: '初次申购', confirmation_date: '2026-01-01', amount: '12345678901234567890.123456789', currency: 'USD', confirmed_units: '0.00000001', remarks: '\\N' } });
  await mutate('voidTrade', { id: saved.id, technical_revision: saved.technical_revision, reason: '模拟撤销' });
  await mutate('setDeleted', { table: 'funds', id: f.fund.id, technical_revision: f.fund.technical_revision, deleted: true });
  const funds = exportRows((await exportsService.download({ table: 'funds', fund_id: f.fund.id })).bytes, 'funds');
  assert.equal(funds[0].id, f.fund.id); assert.equal(funds[0].full_name, sample.fund.full_name); assert.equal(funds[0].is_deleted, 'true');
  const rows = exportRows((await exportsService.download({ table: 'transactions', fund_id: f.fund.id, entity_id: e.id })).bytes, 'transactions');
  assert.equal(rows.length, 1); assert.equal(rows[0].is_void, 'true'); assert.equal(rows[0].amount, '12345678901234567890.123456789'); assert.equal(rows[0].remarks, '\\N'); assert.equal(rows[0].confirmed_nav, null);
  assert.equal((await exportsService.download({ table: 'transactions', fund_id: f.fund.id, state: 'active' })).count, 0);
});

test('NAV, return and benchmark exchange reimport preserves record IDs, dates, numbers, nulls and revisions', async () => {
  const f = await mutate('saveFund', sampleFund('EXPORT-ROUNDTRIP'));
  const b = await mutate('saveBenchmark', { values: { name: 'EXPORT 基准', category: '模拟', remarks: '\\N' } });
  for (const [table, data_type, parent, parentId, dateField, valueField, value] of [
    ['fund_navs', 'nav', 'share_class_id', f.share_classes[0].id, 'nav_date', 'nav_per_unit', '123456789012345.123456789'],
    ['fund_returns', 'returns', 'share_class_id', f.share_classes[0].id, 'return_date', 'mtd_return', '0.00000000000000000123456789'],
    ['benchmark_values', 'benchmark', 'benchmark_id', b.id, 'value_date', 'index_value', '98765432109876543210.123456789'],
  ]) {
    const saved = await mutate('saveSeries', { data_type, expected_revision: null, values: { [parent]: parentId, [dateField]: '2026-03-01', [valueField]: value, ...(data_type === 'returns' ? { estimate_label: null } : {}) } });
    const downloaded = await exportsService.download({ table, [parent]: parentId });
    const before = (await service.model(table).findByPk(saved.id)).toJSON();
    let batch = await importMutation('stage', { data_type, target_mode: 'columns', original_name: downloaded.filename, content_base64: downloaded.bytes.toString('base64') });
    assert.equal(batch.batch.status, 'staged', JSON.stringify(batch.batch.context));
    const mapping = exchangeMapping(table);
    batch = await importMutation('preview', { batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, mapping });
    assert.equal(batch.batch.status, 'ready', JSON.stringify(batch.rows));
    assert.equal(batch.rows[0].operation, 'unchanged');
    const result = await importMutation('commit', { batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, preview_token: batch.batch.preview.token });
    assert.deepEqual(result.record_ids, [saved.id]); assert.equal(result.unchanged_count, 1);
    assert.deepEqual((await service.model(table).findByPk(saved.id)).toJSON(), before);
  }
});

test('Exchange import rejects remapped read-only data, lost IDs, changed dates and incompatible types', async () => {
  const f = await mutate('saveFund', sampleFund('EXPORT-ID-CHECK'));
  const saved = await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: f.share_classes[0].id, nav_date: '2026-03-01', nav_per_unit: '1.23456789' } });
  const downloaded = await exportsService.download({ table: 'fund_navs', fund_id: f.fund.id });
  let batch = await importMutation('stage', { data_type: 'nav', target_mode: 'columns', original_name: downloaded.filename, content_base64: downloaded.bytes.toString('base64') });
  const mapping = exchangeMapping('fund_navs');
  await assert.rejects(importMutation('preview', { batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, mapping: { ...mapping, value: exportColumns('fund_navs').find(column => column.key === 'technical_revision').label } }), errorCode('EXCHANGE_MAPPING'));
  for (const [corrected, code] of [[{ [mapping.id]: '' }, 'EXCHANGE_ID_REQUIRED'], [{ [mapping.date]: '2026-03-02' }, 'RECORD_ID_MISMATCH']]) {
    batch = await importMutation('preview', { batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, mapping, corrections: [{ id: batch.rows[0].id, corrected }] });
    assert.equal(batch.batch.status, 'needs_correction'); assert.ok(batch.rows[0].errors.some(error => error.code === code), JSON.stringify(batch.rows[0]));
  }
  assert.equal(await service.model('fund_navs').count({ where: { share_class_id: f.share_classes[0].id } }), 1);
  assert.equal((await service.model('fund_navs').findByPk(saved.id)).get('nav_date'), '2026-03-01');
  const wrong = await importMutation('stage', { data_type: 'returns', target_mode: 'columns', original_name: downloaded.filename, content_base64: downloaded.bytes.toString('base64') });
  assert.equal(wrong.batch.status, 'failed'); assert.match(wrong.batch.context.parse_error, /自动识别类型/);
  const readonly = await exportsService.download({ table: 'positions', entity_id: entityA.id });
  const blocked = await importMutation('stage', { data_type: 'nav', target_mode: 'columns', original_name: readonly.filename, content_base64: readonly.bytes.toString('base64') });
  assert.equal(blocked.batch.status, 'failed'); assert.match(blocked.batch.context.parse_error, /只读计算结果/);
});

test('Exports compute holdings, CDD and composition values using the same fact rules', async () => {
  const f = await mutate('saveFund', sampleFund('EXPORT-COMPUTED')); const share = f.share_classes[0];
  const e = await mutate('saveEntity', sampleEntity('EXPORT-COMPUTED', 'A'));
  await mutate('saveTrade', { values: { entity_id: e.id, share_class_id: share.id, transaction_type: '初次申购', confirmation_date: '2026-01-01', confirmed_units: '0.3', amount: '0', currency: 'USD' } });
  await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: share.id, nav_date: '2026-01-02', nav_per_unit: '1.23456789' } });
  const p = sampleProprietary('EXPORT-COMPOSITION'); p.compositions = [{ valuation_date: '2026-01-02', items: [{ child_share_class_id: share.id, units: '0.3', remarks: '' }] }];
  const parent = await mutate('saveFund', p);
  const positions = exportRows((await exportsService.download({ table: 'positions', entity_id: e.id, as_of: '2026-01-02' })).bytes, 'positions');
  assert.equal(positions[0].market_value, '0.370370367'); assert.equal(positions[0].nav_date, '2026-01-02');
  assert.equal(exportColumns('positions').every(column => column.role === 'readonly'), true);
  const entities = exportRows((await exportsService.download({ table: 'investment_entities', entity_id: e.id })).bytes, 'investment_entities');
  assert.equal(entities[0].next_cdd_deadline, e.next_cdd_deadline);
  const components = exportRows((await exportsService.download({ table: 'composition_items', fund_id: parent.fund.id })).bytes, 'composition_items');
  assert.equal(components[0]._weight, '1'); assert.equal(components[0]._market_value, '0.370370367');
  assert.equal(exportColumns('composition_items').find(column => column.key === '_weight').role, 'readonly');
});

test('Large exports include every row once, split into reuploadable workbooks, and retain one concurrent snapshot', async () => {
  const b = await mutate('saveBenchmark', { values: { name: 'EXPORT-PAGES', category: '模拟' } });
  const records = Array.from({ length: 10001 }, (_, index) => ({ id: randomUUID(), benchmark_id: b.id, value_date: new Date(Date.UTC(2000, 0, index + 1)).toISOString().slice(0, 10), index_value: `${index}.1234567890123456789` })).sort((a, b) => a.id.localeCompare(b.id));
  await service.write('test-user', 'fixture-export', randomUUID(), {}, transaction => service.model('benchmark_values').bulkCreate(records, writeOptions(transaction)));
  const last = records.at(-1); const originalQuery = db.sequelize.query; let changed = false;
  db.sequelize.query = async function(text: any, options: any) {
    const result = await originalQuery.call(this, text, options);
    if (!changed && typeof text === 'string' && text.includes('FROM finance_benchmark_values t') && text.includes('LIMIT 1000')) {
      changed = true;
      await mutate('saveSeries', { data_type: 'benchmark', expected_revision: 1, values: { benchmark_id: b.id, value_date: last.value_date, index_value: '999' } });
    }
    return result;
  } as any;
  let result;
  try { result = await exportsService.download({ table: 'benchmark_values', benchmark_id: b.id }); }
  finally { db.sequelize.query = originalQuery; }
  assert.ok(changed); assert.equal(result.count, 10001); assert.equal(result.parts, 2); assert.equal(result.contentType, 'application/zip');
  const archive = XLSX.CFB.read(result.bytes, { type: 'buffer' });
  const files = archive.FileIndex.filter(file => file.name.endsWith('.xlsx'));
  const manifest = JSON.parse(Buffer.from(archive.FileIndex.find(file => file.name === 'manifest.json').content).toString('utf8'));
  assert.equal(manifest.count, 10001); assert.equal(manifest.files.reduce((total, file) => total + file.count, 0), 10001);
  const all = files.flatMap(file => { const bytes = Buffer.from(file.content); assert.ok(bytes.length <= 10 * 1024 * 1024); assert.ok(parseUpload(file.name, bytes).rows.length <= 10000); return exportRows(bytes, 'benchmark_values'); });
  assert.equal(new Set(all.map(row => row.id)).size, 10001);
  assert.equal(all.find(row => row.id === last.id).index_value, last.index_value);
  assert.equal((await service.model('benchmark_values').findByPk(last.id)).get('index_value'), '999');
});

test('Exchange files missing their metadata cannot fall back to ambiguous ordinary import semantics', async () => {
  const result = await exportsService.download({ table: 'fund_navs' });
  const book = XLSX.read(result.bytes, { type: 'buffer' });
  delete book.Sheets[exchangeSheet]; book.SheetNames = book.SheetNames.filter(name => name !== exchangeSheet);
  assert.throws(() => parseUpload('exchange-without-metadata.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })), errorCode('EXCHANGE_METADATA_MISSING'));
});

test('Saving entity choices retains IDs and timestamps for unchanged associations, including reordered lists', async () => {
  const e = await mutate('saveEntity', { ...sampleEntity('ID-CHOICES', 'A'), agreements: ['模拟协议 A', '模拟协议 B'], products: ['模拟产品 A', '模拟产品 B'] });
  const before = await service.entityAggregate(e.id);
  const choices = async (table: string) => (await service.model(table).findAll({ where: { entity_id: e.id }, order: [['option_code', 'ASC']] })).map(row => row.toJSON());
  const agreements = await choices('entity_agreements'), products = await choices('entity_products');
  await mutate('saveEntity', { id: e.id, technical_revision: e.technical_revision, ...sampleEntity('ID-CHOICES', 'A'), agreements: [...before.agreements].reverse(), products: [...before.products].reverse() });
  assert.deepEqual(await choices('entity_agreements'), agreements); assert.deepEqual(await choices('entity_products'), products);
  const current = await service.entityAggregate(e.id);
  await mutate('saveEntity', { id: e.id, technical_revision: current.entity.technical_revision, ...sampleEntity('ID-CHOICES', 'A'), agreements: ['模拟协议 A', '模拟协议 C'], products: ['模拟产品 B'] });
  const changed = await choices('entity_agreements');
  assert.deepEqual(changed.find(row => row.option_code === '模拟协议 A'), agreements[0]);
  assert.ok(!changed.some(row => row.id === agreements[1].id)); assert.ok(!agreements.some(row => row.id === changed.find(row => row.option_code === '模拟协议 C').id));
  assert.deepEqual(await choices('entity_products'), [products[1]]);
});

test('Composition edits retain child identities and only change modified rows within one fund version', async () => {
  const child = await mutate('saveFund', sampleFund('ID-COMPOSITION'));
  const payload = { ...sampleProprietary('ID-COMPOSITION'), compositions: [{ valuation_date: '2026-01-01', items: child.share_classes.map((share, index) => ({ child_share_class_id: share.id, units: String(index + 1), remarks: index ? null : '保留' })) }] };
  const parent = await mutate('saveFund', payload); const list = parent.compositions[0];
  const details = async () => (await service.model('composition_items').findAll({ where: { snapshot_id: list.id }, order: [['child_share_class_id', 'ASC']] })).map(row => row.toJSON());
  const before = await details();
  const unchanged = await mutate('saveFund', { ...payload, id: parent.fund.id, technical_revision: parent.fund.technical_revision, share_classes: [], compositions: [{ id: list.id, ...payload.compositions[0] }] });
  assert.equal(unchanged.fund.business_version, 2); assert.deepEqual(await details(), before);
  const changed = await mutate('saveFund', { ...payload, id: parent.fund.id, technical_revision: unchanged.fund.technical_revision, share_classes: [], compositions: [{ id: list.id, valuation_date: '2026-01-01', items: payload.compositions[0].items.map((item, index) => index ? item : { ...item, units: '1.123456789123456789' }) }] });
  const after = await details();
  for (const previous of before) {
    const current = after.find(row => row.id === previous.id); assert.ok(current); assert.deepEqual(current.created_at, previous.created_at);
    if (previous.child_share_class_id === child.share_classes[0].id) { assert.equal(current.technical_revision, previous.technical_revision + 1); assert.equal(current.units, '1.123456789123456789'); }
    else assert.deepEqual(current, previous);
  }
  await mutate('saveFund', { ...payload, id: parent.fund.id, technical_revision: changed.fund.technical_revision, share_classes: [], compositions: [{ id: list.id, valuation_date: '2026-01-01', items: [payload.compositions[0].items[1]] }] });
  assert.equal((await details()).length, 1); assert.equal((await details())[0].id, list.items.find(item => item.child_share_class_id === child.share_classes[1].id).id);
});

async function tradeExchangeFixture(name: string, voided = false, currency = 'USD') {
  const f = await mutate('saveFund', sampleFund(name)); const e = await mutate('saveEntity', sampleEntity(name, 'A'));
  const values = { entity_id: e.id, share_class_id: f.share_classes[0].id, currency, confirmation_date: '2026-01-01', fee_rate: '0.0000000123456789', fee: null, confirmed_nav: null, remarks: '  原文本\n\\N =1+1  ' };
  const a = await mutate('saveTrade', { values: { ...values, transaction_type: '初次申购', confirmed_units: '100', amount: '1234567890123456789.123456789' } });
  const b = await mutate('saveTrade', { values: { ...values, transaction_type: '赎回', confirmed_units: '30', amount: '987654321.123456789' } });
  if (voided) { const v = await mutate('saveTrade', { values: { ...values, transaction_type: '追加申购', confirmed_units: '20', amount: '200' } }); await mutate('voidTrade', { id: v.id, technical_revision: v.technical_revision, reason: '模拟撤销' }); }
  const file = await exportsService.download({ table: 'transactions', fund_id: f.fund.id });
  const batch = await importMutation('stage', { data_type: 'transactions', original_name: file.filename, content_base64: file.bytes.toString('base64') });
  assert.equal(batch.batch.status, 'staged', JSON.stringify(batch.batch.context));
  return { f, e, a, b, file, batch, mapping: exchangeMapping('transactions') as any, names: Object.fromEntries(exportColumns('transactions').map(column => [column.key, column.label])) };
}

test('Transaction exchange verifies active and voided facts unchanged, preserving IDs, exact text, nulls and provenance', async () => {
  const { f, batch, mapping } = await tradeExchangeFixture('EXCHANGE-TRADE-ROUNDTRIP', true);
  const before = (await service.model('transactions').findAll({ where: { share_class_id: f.share_classes[0].id }, order: [['id', 'ASC']] })).map(row => row.toJSON());
  const preview = await importMutation('preview', { batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, mapping });
  assert.equal(preview.batch.status, 'ready', JSON.stringify(preview.rows)); assert.ok(preview.rows.every(row => row.operation === 'unchanged'));
  const result = await importMutation('commit', { batch_id: batch.batch.id, technical_revision: preview.batch.technical_revision, preview_token: preview.batch.preview.token });
  assert.equal(result.unchanged_count, 3); assert.equal(result.overwritten_count, 0); assert.deepEqual([...result.record_ids].sort(), before.map(row => row.id));
  const after = (await service.model('transactions').findAll({ where: { share_class_id: f.share_classes[0].id }, order: [['id', 'ASC']] })).map(row => row.toJSON()); assert.deepEqual(after, before);
});

test('Transaction exchange changes a complete final daily set atomically while retaining the original record IDs', async () => {
  const { f, e, a, b, batch, mapping, names } = await tradeExchangeFixture('EXCHANGE-TRADE-DAILY');
  const corrections = batch.rows.map(row => ({ id: row.id, corrected: { [names.confirmed_units]: row.raw[names.id] === a.id ? '10' : '3' } }));
  const preview = await importMutation('preview', { batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, mapping, corrections });
  assert.equal(preview.batch.status, 'ready', JSON.stringify(preview.rows));
  const key = randomUUID(); const payload = { batch_id: batch.batch.id, technical_revision: preview.batch.technical_revision, preview_token: preview.batch.preview.token };
  const result = await importMutation('commit', payload, 'test-user', key); assert.equal(result.overwritten_count, 2); assert.deepEqual([...result.record_ids].sort(), [a.id, b.id].sort());
  assert.equal((await service.positions(e.id))[0].units, '7');
  assert.deepEqual(await importMutation('commit', payload, 'test-user', key), result);
  const current = await service.model('transactions').findByPk(a.id);
  assert.equal(current.get('remarks'), '  原文本\n\\N =1+1  '); assert.equal(current.get('fee_rate'), '0.0000000123456789'); assert.equal(current.get('fee'), null); assert.equal(current.get('source_batch_id'), batch.batch.id);
  assert.equal(await service.model('transactions').count({ where: { share_class_id: f.share_classes[0].id } }), 2);
});

test('Transaction exchange cannot restore voided trades, misidentify a share, lose IDs or reinterpret readonly fields', async () => {
  const { batch: initial, mapping, names, f } = await tradeExchangeFixture('EXCHANGE-TRADE-GUARD', true); let batch = initial;
  await assert.rejects(importMutation('preview', { batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, mapping: { ...mapping, amount: names.technical_revision } }), errorCode('EXCHANGE_MAPPING'));
  const dead = batch.rows.find(row => row.raw[names.is_void] === 'true'); const alive = batch.rows.find(row => row.raw[names.is_void] === 'false');
  for (const [target, corrected, code] of [
    [dead, { [names.is_void]: 'false' }, 'EXCHANGE_STATE_MISMATCH'],
    [dead, { [names.amount]: '999' }, 'TRADE_VOIDED'],
    [alive, { [names.id]: '' }, 'EXCHANGE_ID_REQUIRED'],
    [alive, { [names.share_class_id]: f.share_classes[1].id }, 'RECORD_ID_MISMATCH'],
  ] as any[]) {
    batch = await importMutation('preview', { batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, mapping, corrections: batch.rows.map(row => ({ id: row.id, corrected: row.id === target.id ? corrected : {} })) });
    assert.equal(batch.batch.status, 'needs_correction'); assert.ok(batch.rows.find(row => row.id === target.id).errors.some(error => error.code === code), JSON.stringify(batch.rows));
  }
  assert.equal((await service.model('transactions').findByPk(dead.raw[names.id])).get('is_void'), true);
});

test('An unchanged exchange verification becomes stale after another write, including a subsequent void', async () => {
  const { batch, mapping, a, b } = await tradeExchangeFixture('EXCHANGE-TRADE-STALE');
  const preview = await importMutation('preview', { batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, mapping });
  const old = (await service.model('transactions').findByPk(a.id)).toJSON();
  await mutate('voidTrade', { id: b.id, technical_revision: b.technical_revision, reason: '预览后的另一操作' });
  await assert.rejects(importMutation('commit', { batch_id: batch.batch.id, technical_revision: preview.batch.technical_revision, preview_token: preview.batch.preview.token }), errorCode('PREVIEW_STALE'));
  assert.deepEqual((await service.model('transactions').findByPk(a.id)).toJSON(), old);
});

test('A failed transaction exchange commit rolls back changes and receipt, then safely retries the same final set', async () => {
  const { batch, mapping, names, a, b } = await tradeExchangeFixture('EXCHANGE-TRADE-ROLLBACK');
  const before = await Promise.all([a.id, b.id].map(async id => (await service.model('transactions').findByPk(id)).toJSON()));
  const preview = await importMutation('preview', { batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, mapping, corrections: batch.rows.map(row => ({ id: row.id, corrected: { [names.remarks]: '核对后修正' } })) });
  const persist = service.persistTrade.bind(service); let count = 0;
  service.persistTrade = async (...args: any[]) => { if (++count === 2) throw new Error('simulated exchange persistence failure'); return persist(...args); };
  const key = randomUUID(); const payload = { batch_id: batch.batch.id, technical_revision: preview.batch.technical_revision, preview_token: preview.batch.preview.token };
  try { await assert.rejects(importMutation('commit', payload, 'test-user', key), /simulated exchange persistence failure/); }
  finally { service.persistTrade = persist; }
  assert.deepEqual(await Promise.all([a.id, b.id].map(async id => (await service.model('transactions').findByPk(id)).toJSON())), before);
  assert.equal(await service.model('request_receipts').count({ where: { request_key: key } }), 0);
  assert.equal((await importMutation('commit', payload, 'test-user', key)).overwritten_count, 2);
});

test('Unchanged duplicate and archived trades can be verified without adding records or changing deleted parents', async () => {
  const { f, a } = await tradeExchangeFixture('EXCHANGE-TRADE-ARCHIVED');
  const old = (await service.model('transactions').findByPk(a.id)).toJSON();
  const values = { ...Object.fromEntries(tradeImportFields.filter(field => !['id', 'isin'].includes(field.key)).map(field => [field.key, old[field.key]])), share_class_id: old.share_class_id };
  let confirmation;
  try { await mutate('saveTrade', { values }); assert.fail('Duplicate requires confirmation'); }
  catch (error: any) { assert.equal(error.code, 'DUPLICATE_TRADE'); confirmation = error.details.confirmation_token; }
  const duplicate = await mutate('saveTrade', { values, duplicate_confirmation: confirmation });
  await mutate('setDeleted', { table: 'funds', id: f.fund.id, technical_revision: f.fund.technical_revision, deleted: true });
  const file = await exportsService.download({ table: 'transactions', fund_id: f.fund.id });
  const batch = await importMutation('stage', { data_type: 'transactions', original_name: file.filename, content_base64: file.bytes.toString('base64') });
  const preview = await importMutation('preview', { batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, mapping: exchangeMapping('transactions') });
  assert.equal(preview.batch.status, 'ready', JSON.stringify(preview.rows));
  const result = await importMutation('commit', { batch_id: batch.batch.id, technical_revision: preview.batch.technical_revision, preview_token: preview.batch.preview.token });
  assert.equal(result.unchanged_count, 3); assert.ok(result.record_ids.includes(duplicate.id));
  assert.equal((await service.model('funds').findByPk(f.fund.id)).get('is_deleted'), true);
  assert.equal(await service.model('transactions').count({ where: { share_class_id: f.share_classes[0].id } }), 3);
});

test('Mixed transaction exchange keeps unchanged and voided rows intact while validating changed rows against full history', async () => {
  const { f, e, a, b, batch, mapping, names } = await tradeExchangeFixture('EXCHANGE-TRADE-MIXED', true);
  const rows = (await service.model('transactions').findAll({ where: { share_class_id: f.share_classes[0].id } })).map(row => row.toJSON());
  const target = batch.rows.find(row => row.raw[names.id] === b.id);
  const preview = await importMutation('preview', { batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, mapping, corrections: [{ id: target.id, corrected: { [names.confirmed_units]: '35', [names.remarks]: '\\N' } }] });
  assert.equal(preview.batch.status, 'ready', JSON.stringify(preview.rows));
  const result = await importMutation('commit', { batch_id: batch.batch.id, technical_revision: preview.batch.technical_revision, preview_token: preview.batch.preview.token });
  assert.equal(result.unchanged_count, 2); assert.equal(result.overwritten_count, 1); assert.equal((await service.positions(e.id))[0].units, '65');
  assert.equal((await service.model('transactions').findByPk(b.id)).get('remarks'), null);
  for (const old of rows.filter(row => row.id !== b.id)) assert.deepEqual((await service.model('transactions').findByPk(old.id)).toJSON(), old);
});

test('Exact transaction exchange verification does not rewrite legacy facts to satisfy new option rules', async () => {
  const { batch, mapping, names, a } = await tradeExchangeFixture('EXCHANGE-LEGACY-RULES', false, 'LEGACY-' + randomUUID());
  const strict = new FinanceService(db, false); const strictImports = new FinanceImports(strict, imports.directory);
  const before = (await service.model('transactions').findByPk(a.id)).toJSON();
  await strict.write('test-user', 'strictPreview', randomUUID(), {}, transaction => strictImports.preview({ batch_id: batch.batch.id, technical_revision: batch.batch.technical_revision, mapping }, transaction, 'test-user'));
  let preview = await strictImports.view(batch.batch.id, 'test-user'); assert.equal(preview.batch.status, 'ready', JSON.stringify(preview.rows));
  const target = preview.rows.find(row => row.raw[names.id] === a.id);
  await strict.write('test-user', 'strictPreview', randomUUID(), {}, transaction => strictImports.preview({ batch_id: batch.batch.id, technical_revision: preview.batch.technical_revision, mapping, corrections: [{ id: target.id, corrected: { [names.amount]: '999' } }] }, transaction, 'test-user'));
  preview = await strictImports.view(batch.batch.id, 'test-user'); assert.equal(preview.batch.status, 'needs_correction'); assert.ok(preview.rows.find(row => row.id === target.id).errors.some(error => ['CONFIG_UNCONFIRMED', 'INVALID_OPTION'].includes(error.code)));
  await strict.write('test-user', 'strictPreview', randomUUID(), {}, transaction => strictImports.preview({ batch_id: batch.batch.id, technical_revision: preview.batch.technical_revision, mapping, corrections: [{ id: target.id, corrected: {} }] }, transaction, 'test-user'));
  preview = await strictImports.view(batch.batch.id, 'test-user');
  const result = await strict.write('test-user', 'strictCommit', randomUUID(), {}, transaction => strictImports.commit({ batch_id: batch.batch.id, technical_revision: preview.batch.technical_revision, preview_token: preview.batch.preview.token }, transaction, 'test-user'));
  assert.equal(result.unchanged_count, 2); assert.deepEqual((await service.model('transactions').findByPk(a.id)).toJSON(), before);
});

async function mainExchange(table: string, filters: any = {}, ids?: string[]) {
  const file = await exportsService.download({ table, ...filters });
  const batch = await importMutation('stage', { data_type: 'exchange', original_name: file.filename, content_base64: file.bytes.toString('base64') });
  assert.equal(batch.batch.status, 'staged', JSON.stringify(batch.batch.context));
  const names = Object.fromEntries(exportColumns(table).map(column => [column.key, column.label]));
  const corrections = batch.rows.map(row => ({ id: row.id, selected: !ids || ids.includes(row.raw[names.id]) }));
  const preview = async (current: any, extra: any[] = []) => importMutation('preview', { batch_id: current.batch.id, technical_revision: current.batch.technical_revision, mapping: exchangeMapping(table), corrections: corrections.map(change => ({ ...change, ...(extra.find(item => item.id === change.id) || {}) })) });
  return { batch, names, preview };
}
const commitExchange = (view: any, key = randomUUID()) => importMutation('commit', { batch_id: view.batch.id, technical_revision: view.batch.technical_revision, preview_token: view.batch.preview.token }, 'test-user', key);
const readyExchange = (view: any) => assert.equal(view.batch.status, 'ready', JSON.stringify(view.rows.filter(row => row.selected).map(row => ({ values: row.normalized?.values, errors: row.errors }))));

test('All fourteen main-data exchange tables round-trip their existing facts and IDs; each active fund save adds one version', async () => {
  const child = await mutate('saveFund', sampleFund('MAIN-EX-ROUNDTRIP'));
  const parent = await mutate('saveFund', { ...sampleProprietary('MAIN-EX-ROUNDTRIP'), compositions: [{ valuation_date: '2026-01-01', items: child.share_classes.map((share, index) => ({ child_share_class_id: share.id, units: '1.1234567890123456789', remarks: index ? null : '  原备注\n\\N =1+1  ' })) }] });
  const e = await mutate('saveEntity', { ...sampleEntity('MAIN-EX-ROUNDTRIP', 'A'), agreements: ['模拟协议 A', '模拟协议 B'], products: ['模拟产品 A'] });
  const b = await mutate('saveBenchmark', { values: { name: '交换基准', category: '模拟分类', remarks: '  基准\n\\N  ' } });
  const harness = fileHarness(randomUUID());
  const doc = await harness.files.upload({ fund_id: child.fund.id, original_name: '模拟交换原件.txt', document_type: '其他', content_base64: Buffer.from('原文件保持不变').toString('base64'), request_key: randomUUID() }, 'file-owner');
  const cases: any[] = [
    ['funds', { fund_id: child.fund.id }], ['share_classes', { fund_id: child.fund.id }], ['third_party_fund_details', { fund_id: child.fund.id }], ['third_party_class_terms', { fund_id: child.fund.id }],
    ['proprietary_fund_details', { fund_id: parent.fund.id }], ['proprietary_class_terms', { fund_id: parent.fund.id }], ['composition_snapshots', { fund_id: parent.fund.id }], ['composition_items', { fund_id: parent.fund.id }],
    ['client_groups', {}, [e.client_group_id]], ['investment_entities', { entity_id: e.id }], ['entity_agreements', { entity_id: e.id }], ['entity_products', { entity_id: e.id }], ['benchmarks', { benchmark_id: b.id }], ['fund_documents', { fund_id: child.fund.id }],
  ];
  for (const [table, filters, ids] of cases) {
    const x = await mainExchange(table, filters, ids); const p = await x.preview(x.batch); readyExchange(p);
    const selected = p.rows.filter(row => row.selected); assert.ok(selected.length); assert.ok(selected.every(row => row.operation === 'unchanged'), table);
    const before = await Promise.all(selected.map(async row => (await service.model(table).findByPk(row.raw[x.names.id])).toJSON()));
    const result = await commitExchange(p); assert.equal(result.committed_count, selected.length); assert.equal(result.overwritten_count, 0); assert.deepEqual([...result.record_ids].sort(), before.map(row => row.id).sort());
    const facts = exportColumns(table).filter(column => column.role !== 'readonly');
    for (const old of before) {
      const current = (await service.model(table).findByPk(old.id)).toJSON();
      for (const column of facts) assert.deepEqual(current[column.key], old[column.key], `${table}.${column.key}`);
      assert.deepEqual(current.created_at, old.created_at);
    }
    assert.equal(result.version_count, ['funds', 'share_classes', 'third_party_fund_details', 'third_party_class_terms', 'proprietary_fund_details', 'proprietary_class_terms', 'composition_snapshots', 'composition_items'].includes(table) ? 1 : 0);
  }
  assert.equal((await service.model('fund_documents').findByPk(doc.document_id)).get('original_name'), '模拟交换原件.txt');
});

test('Partial share and terms exchanges preserve other classes and fields and save one fund version per selected set', async () => {
  const f = await mutate('saveFund', sampleFund('MAIN-EX-PARTIAL'));
  const x = await mainExchange('third_party_class_terms', { fund_id: f.fund.id });
  const target = x.batch.rows.find(row => row.raw[x.names.share_class_id] === f.share_classes[0].id);
  const p = await x.preview(x.batch, x.batch.rows.map(row => ({ id: row.id, selected: row.id === target.id, corrected: row.id === target.id ? { [x.names.management_fee_text]: '  第一档\n第二档 \\N  ' } : {} })));
  readyExchange(p); const key = randomUUID(); const result = await commitExchange(p, key); assert.deepEqual(await commitExchange(p, key), result); assert.equal(result.version_count, 1);
  const current = await service.fundAggregate(f.fund.id);
  assert.equal(current.fund.business_version, 2); assert.deepEqual(JSON.parse(JSON.stringify(current.share_classes[1])), f.share_classes[1]);
  assert.equal(current.share_classes[0].terms.id, f.share_classes[0].terms.id); assert.equal(current.share_classes[0].terms.management_fee_text, '  第一档\n第二档 \\N  ');
  assert.deepEqual(JSON.parse(JSON.stringify(current.details)), f.details);
  const shares = await mainExchange('share_classes', { fund_id: f.fund.id });
  const changed = await shares.preview(shares.batch, shares.batch.rows.map((row, index) => ({ id: row.id, corrected: { [shares.names.class_label]: index ? '新 B' : '新 A' } })));
  readyExchange(changed); assert.equal((await commitExchange(changed)).version_count, 1); assert.equal((await service.fundAggregate(f.fund.id)).fund.business_version, 3);
});

test('Composition exchange confirms a full diff but changes only selected IDs; omitted children and precise values survive', async () => {
  const child = await mutate('saveFund', sampleFund('MAIN-EX-COMP'));
  const parent = await mutate('saveFund', { ...sampleProprietary('MAIN-EX-COMP'), compositions: [{ valuation_date: '2026-01-01', items: child.share_classes.map(share => ({ child_share_class_id: share.id, units: '10', remarks: null })) }] });
  const x = await mainExchange('composition_items', { fund_id: parent.fund.id }); const target = x.batch.rows[0]; const other = x.batch.rows[1];
  const corrected = { [x.names.units]: '123456789012345.123456789', [x.names.remarks]: '\\N' };
  const changes = [{ id: target.id, corrected }, { id: other.id, selected: false }];
  let p = await x.preview(x.batch, changes); assert.equal(p.batch.status, 'needs_correction');
  const lead = p.rows.find(row => row.id === target.id); assert.ok(lead.errors.some(error => error.code === 'COMPOSITION_CONFIRMATION_REQUIRED')); assert.equal(lead.normalized.list_diff.patch, true); assert.equal(lead.normalized.list_diff.after.length, 2);
  const beforeOther = (await service.model('composition_items').findByPk(other.raw[x.names.id])).toJSON();
  p = await x.preview(p, [{ ...changes[0], replacement_confirmation: lead.normalized.required_confirmation }, changes[1]]); readyExchange(p);
  const result = await commitExchange(p); assert.equal(result.version_count, 1); assert.deepEqual(result.record_ids, [target.raw[x.names.id]]);
  assert.equal((await service.model('composition_items').findByPk(target.raw[x.names.id])).get('units'), corrected[x.names.units]);
  assert.deepEqual((await service.model('composition_items').findByPk(other.raw[x.names.id])).toJSON(), beforeOther);
  assert.equal((await service.fundAggregate(parent.fund.id)).compositions[0].items.length, 2);
  const dates = await mainExchange('composition_snapshots', { fund_id: parent.fund.id });
  let d = await dates.preview(dates.batch, [{ id: dates.batch.rows[0].id, corrected: { [dates.names.valuation_date]: '2026-02-01' } }]);
  assert.equal(d.rows[0].normalized.list_diff.new_date, '2026-02-01');
  d = await dates.preview(d, [{ id: d.rows[0].id, replacement_confirmation: d.rows[0].normalized.required_confirmation }]); readyExchange(d); await commitExchange(d);
  assert.equal((await service.fundAggregate(parent.fund.id)).compositions[0].valuation_date, '2026-02-01');
});

test('Entity choice exchange supports a final-set swap with stable IDs and rejects duplicates or foreign associations', async () => {
  const e = await mutate('saveEntity', { ...sampleEntity('MAIN-EX-CHOICES', 'A'), agreements: ['协议 A', '协议 B'], products: ['产品 A', '产品 B'] });
  for (const table of ['entity_agreements', 'entity_products']) {
    const x = await mainExchange(table, { entity_id: e.id }); const [a, b] = x.batch.rows;
    let p = await x.preview(x.batch, [{ id: a.id, corrected: { [x.names.option_code]: b.raw[x.names.option_code] } }]); assert.equal(p.batch.status, 'needs_correction'); assert.ok(p.rows.some(row => row.errors.some(error => error.code === 'INVALID_OPTIONS')));
    const before = await Promise.all(x.batch.rows.map(async row => (await service.model(table).findByPk(row.raw[x.names.id])).toJSON()));
    p = await x.preview(p, [{ id: a.id, corrected: { [x.names.option_code]: b.raw[x.names.option_code] } }, { id: b.id, corrected: { [x.names.option_code]: a.raw[x.names.option_code] } }]); readyExchange(p);
    const result = await commitExchange(p); assert.equal(result.overwritten_count, 2);
    for (let i = 0; i < 2; i++) { const row = (await service.model(table).findByPk(before[i].id)).toJSON(); assert.equal(row.option_code, before[1 - i].option_code); assert.deepEqual(row.created_at, before[i].created_at); assert.equal(row.technical_revision, before[i].technical_revision + 1); }
  }
  const x = await mainExchange('entity_agreements', { entity_id: e.id });
  const p = await x.preview(x.batch, [{ id: x.batch.rows[0].id, corrected: { [x.names.entity_id]: entityA.id } }]); assert.equal(p.batch.status, 'needs_correction'); assert.ok(p.rows.some(row => row.errors.some(error => error.code === 'RECORD_ID_MISMATCH')));
});

test('Client group exchange confirms all affected entities, preserves IDs and blocks merging existing groups', async () => {
  const a = await mutate('saveEntity', sampleEntity('MAIN-EX-GROUP', 'A')); const b = await mutate('saveEntity', sampleEntity('MAIN-EX-GROUP', 'B'));
  const x = await mainExchange('client_groups', {}, [a.client_group_id]); const target = x.batch.rows.find(row => row.raw[x.names.id] === a.client_group_id);
  let p = await x.preview(x.batch, [{ id: target.id, corrected: { [x.names.client_code]: 'MAIN-EX-RENAMED' } }]); assert.equal(p.batch.status, 'needs_correction');
  let row = p.rows.find(row => row.id === target.id); assert.equal(row.normalized.client_diff.entity_count, 2); assert.ok(row.errors.some(error => error.code === 'CLIENT_RENAME_CONFIRMATION_REQUIRED'));
  p = await x.preview(p, [{ id: target.id, replacement_confirmation: row.normalized.required_confirmation }]); readyExchange(p); await commitExchange(p);
  for (const e of [a, b]) { const current = await service.entityAggregate(e.id); assert.equal(current.client_code, 'MAIN-EX-RENAMED'); assert.equal(current.entity.client_group_id, a.client_group_id); assert.equal(current.entity.technical_revision, e.technical_revision + 1); }
  const again = await mainExchange('client_groups', {}, [a.client_group_id]); const t = again.batch.rows.find(row => row.raw[again.names.id] === a.client_group_id);
  p = await again.preview(again.batch, [{ id: t.id, corrected: { [again.names.client_code]: 'DEMO-CLIENT' } }]); assert.equal(p.batch.status, 'needs_correction'); assert.ok(p.rows.find(row => row.id === t.id).errors.some(error => error.code === 'CLIENT_CODE_EXISTS'));
});

test('Document exchange modifies classification only; metadata tampering cannot rename or replace the binary', async () => {
  const f = await mutate('saveFund', sampleFund('MAIN-EX-DOC')); const harness = fileHarness(randomUUID());
  const uploaded = await harness.files.upload({ fund_id: f.fund.id, original_name: '模拟原件.txt', document_type: '其他', content_base64: Buffer.from('模拟原件内容').toString('base64'), request_key: randomUUID() }, 'file-owner');
  const old = (await service.model('fund_documents').findByPk(uploaded.document_id)).toJSON();
  const x = await mainExchange('fund_documents', { fund_id: f.fund.id });
  const p = await x.preview(x.batch, [{ id: x.batch.rows[0].id, corrected: { [x.names.document_type]: '月报', [x.names.original_name]: '伪造文件名', [x.names.size_bytes]: '999999' } }]); readyExchange(p); await commitExchange(p);
  const current = (await service.model('fund_documents').findByPk(uploaded.document_id)).toJSON();
  assert.equal(current.document_type, '月报'); for (const key of ['storage_key', 'file_id', 'original_name', 'size_bytes', 'uploaded_at', 'fund_id', 'created_at']) assert.deepEqual(current[key], old[key]);
  assert.equal((await service.fundAggregate(f.fund.id)).fund.business_version, 1);
});

test('Main exchange commits are stale after referenced changes and late failures roll back every object and receipt', async () => {
  const a = await mutate('saveBenchmark', { values: { name: '交换回滚 A', category: '模拟', remarks: null } }); const b = await mutate('saveBenchmark', { values: { name: '交换回滚 B', category: '模拟', remarks: null } });
  const x = await mainExchange('benchmarks', {}, [a.id, b.id]);
  let p = await x.preview(x.batch, x.batch.rows.filter(row => [a.id, b.id].includes(row.raw[x.names.id])).map(row => ({ id: row.id, corrected: { [x.names.remarks]: '选中修改' } }))); readyExchange(p);
  await mutate('saveBenchmark', { id: a.id, technical_revision: a.technical_revision, values: { name: '另一人修改', category: '模拟', remarks: null } });
  await assert.rejects(commitExchange(p), errorCode('PREVIEW_STALE'));
  p = await x.preview(p); readyExchange(p);
  const old = await Promise.all([a.id, b.id].map(async id => (await service.model('benchmarks').findByPk(id)).toJSON()));
  const original = service.saveBenchmark.bind(service); let count = 0;
  service.saveBenchmark = async (...args: any[]) => { if (++count === 2) throw new Error('simulated main exchange failure'); return original(...args); };
  const key = randomUUID(); try { await assert.rejects(commitExchange(p, key), /simulated main exchange failure/); } finally { service.saveBenchmark = original; }
  assert.deepEqual(await Promise.all([a.id, b.id].map(async id => (await service.model('benchmarks').findByPk(id)).toJSON())), old); assert.equal(await service.model('request_receipts').count({ where: { request_key: key } }), 0);
  assert.equal((await commitExchange(p, key)).overwritten_count, 2);
});

test('Main exchange rejects missing IDs, state changes and remapping while archived unchanged facts remain verifiable', async () => {
  const f = await mutate('saveFund', sampleFund('MAIN-EX-GUARDS')); await mutate('setDeleted', { table: 'funds', id: f.fund.id, technical_revision: 1, deleted: true });
  const x = await mainExchange('funds', { fund_id: f.fund.id }); let p = await x.preview(x.batch); readyExchange(p); const result = await commitExchange(p); assert.equal(result.version_count, 0);
  const y = await mainExchange('funds', { fund_id: f.fund.id }); const row = y.batch.rows[0];
  await assert.rejects(importMutation('preview', { batch_id: y.batch.batch.id, technical_revision: y.batch.batch.technical_revision, mapping: { ...exchangeMapping('funds'), short_name: y.names.business_version } }), errorCode('EXCHANGE_MAPPING'));
  let current = y.batch;
  for (const [corrected, code] of [[{ [y.names.id]: '' }, 'EXCHANGE_ID_REQUIRED'], [{ [y.names.is_deleted]: 'false' }, 'EXCHANGE_STATE_MISMATCH'], [{ [y.names.short_name]: '不能改已删除基金' }, 'RESTORE_REQUIRED']] as any[]) {
    current = await y.preview(current, [{ id: row.id, corrected }]); assert.equal(current.batch.status, 'needs_correction'); assert.ok(current.rows[0].errors.some(error => error.code === code), JSON.stringify(current.rows[0].errors));
  }
  assert.equal((await service.model('funds').findByPk(f.fund.id)).get('short_name'), f.fund.short_name);
});

test('Generic exchange entry routes series and trades automatically and rejects ordinary files or derived positions', async () => {
  const f = await mutate('saveFund', sampleFund('MAIN-EX-AUTO')); await mutate('saveSeries', { data_type: 'nav', expected_revision: null, values: { share_class_id: f.share_classes[0].id, nav_date: '2026-01-01', nav_per_unit: '1.234567891' } });
  const x = await mainExchange('fund_navs', { fund_id: f.fund.id }); assert.equal(x.batch.batch.data_type, 'nav'); assert.equal(x.batch.batch.context.target_mode, 'columns'); const p = await x.preview(x.batch); readyExchange(p); assert.equal((await commitExchange(p)).unchanged_count, 1);
  const trade = await tradeExchangeFixture('MAIN-EX-AUTO-TRADE'); const y = await mainExchange('transactions', { fund_id: trade.f.fund.id }); assert.equal(y.batch.batch.data_type, 'transactions'); readyExchange(await y.preview(y.batch));
  const raw = await importMutation('stage', { data_type: 'exchange', original_name: '普通.csv', content_base64: Buffer.from('日期,净值\n2026-01-01,1\n').toString('base64') }); assert.equal(raw.batch.status, 'failed'); assert.match(raw.batch.context.parse_error, /只接收/);
  const file = await exportsService.download({ table: 'positions', entity_id: trade.e.id }); const blocked = await importMutation('stage', { data_type: 'exchange', original_name: file.filename, content_base64: file.bytes.toString('base64') }); assert.equal(blocked.batch.status, 'failed'); assert.match(blocked.batch.context.parse_error, /只读计算结果/);
});

test('Main exchange rechecks absent ISINs and client membership so concurrent changes invalidate old previews', async () => {
  const f = await mutate('saveFund', sampleFund('MAIN-EX-IDENTITY-STALE')); const x = await mainExchange('share_classes', { fund_id: f.fund.id }); const target = x.batch.rows[0];
  const isin = 'DEMO-CLAIMED-' + randomUUID(); const p = await x.preview(x.batch, [{ id: target.id, corrected: { [x.names.isin]: isin } }]); readyExchange(p);
  const other = sampleFund('MAIN-EX-IDENTITY-OTHER'); other.share_classes[0].values.isin = isin; await mutate('saveFund', other);
  await assert.rejects(commitExchange(p), errorCode('PREVIEW_STALE')); assert.equal((await service.fundAggregate(f.fund.id)).fund.business_version, 1);
  const e = await mutate('saveEntity', sampleEntity('MAIN-EX-MEMBERSHIP', 'A')); const y = await mainExchange('client_groups', {}, [e.client_group_id]); const row = y.batch.rows.find(row => row.raw[y.names.id] === e.client_group_id);
  let view = await y.preview(y.batch, [{ id: row.id, corrected: { [y.names.client_code]: 'MAIN-EX-MEMBERSHIP-NEW' } }]);
  const confirmation = view.rows.find(item => item.id === row.id).normalized.required_confirmation;
  view = await y.preview(view, [{ id: row.id, replacement_confirmation: confirmation }]); readyExchange(view);
  await mutate('saveEntity', sampleEntity('MAIN-EX-MEMBERSHIP', 'B')); await assert.rejects(commitExchange(view), errorCode('PREVIEW_STALE'));
  view = await y.preview(view); const changed = view.rows.find(item => item.id === row.id); assert.equal(changed.normalized.client_diff.entity_count, 2); assert.notEqual(changed.normalized.required_confirmation, confirmation); assert.ok(changed.errors.some(error => error.code === 'CLIENT_RENAME_CONFIRMATION_REQUIRED'));
  assert.equal((await service.entityAggregate(e.id)).client_code, 'MAIN-EX-MEMBERSHIP');
});

test('Entity exchange preserves multi-select IDs, rejects exclusive n/a and uses current option rules for any changed choice', async () => {
  const e = await mutate('saveEntity', { ...sampleEntity('AM9701', 'A'), agreements: ['协议 A', '协议 B'], products: ['产品 A'] });
  const before = await service.entityAggregate(e.id); const associations = (await service.model('entity_agreements').findAll({ where: { entity_id: e.id }, order: [['id', 'ASC']] })).map(row => row.toJSON());
  const x = await mainExchange('investment_entities', { entity_id: e.id });
  let p = await x.preview(x.batch, [{ id: x.batch.rows[0].id, corrected: { [x.names.legal_name]: '  新主体名称  ', [x.names.latest_cdd_approval_date]: '2025-01-31' } }]); readyExchange(p); await commitExchange(p);
  const after = await service.entityAggregate(e.id); assert.equal(after.entity.legal_name, '  新主体名称  '); assert.equal(after.next_cdd_deadline, '2028-01-30'); assert.equal(after.entity.client_group_id, before.entity.client_group_id); assert.deepEqual((await service.model('entity_agreements').findAll({ where: { entity_id: e.id }, order: [['id', 'ASC']] })).map(row => row.toJSON()), associations);
  const y = await mainExchange('entity_agreements', { entity_id: e.id });
  p = await y.preview(y.batch, [{ id: y.batch.rows[0].id, corrected: { [y.names.option_code]: 'n/a' } }]); assert.equal(p.batch.status, 'needs_correction'); assert.ok(p.rows.some(row => row.errors.some(error => error.code === 'EXCLUSIVE_NA')));
  const strict = new FinanceService(db, false); const strictImports = new FinanceImports(strict, imports.directory); const z = await mainExchange('entity_products', { entity_id: e.id });
  await strict.write('test-user', 'strictMainPreview', randomUUID(), {}, transaction => strictImports.preview({ batch_id: z.batch.batch.id, technical_revision: z.batch.batch.technical_revision, mapping: exchangeMapping('entity_products') }, transaction, 'test-user'));
  let view = await strictImports.view(z.batch.batch.id, 'test-user'); readyExchange(view);
  await strict.write('test-user', 'strictMainPreview', randomUUID(), {}, transaction => strictImports.preview({ batch_id: view.batch.id, technical_revision: view.batch.technical_revision, mapping: exchangeMapping('entity_products'), corrections: [{ id: view.rows[0].id, corrected: { [z.names.option_code]: '未经确认的产品' } }] }, transaction, 'test-user'));
  view = await strictImports.view(z.batch.batch.id, 'test-user'); assert.equal(view.batch.status, 'needs_correction'); assert.ok(view.rows[0].errors.some(error => ['CONFIG_UNCONFIRMED', 'INVALID_OPTION'].includes(error.code)), JSON.stringify(view.rows[0].errors)); assert.equal((await service.entityAggregate(e.id)).products[0], '产品 A');
});

function formulaFile(formula: string, cached?: number, type: 'xlsx' | 'xls' = 'xlsx') {
  const book = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet([['日期', '数值', '参考 A', '参考 B'], ['2026-01-01', '', 0.1, 0.2]]);
  sheet.B2 = { t: 'n', f: formula, ...(cached === undefined ? {} : { v: cached }) };
  if (type === 'xls') { assert.equal(formula, '1+2'); (sheet.B2 as any).bf = [7, 0, 0x1e, 1, 0, 0x1e, 2, 0, 0x03]; }
  XLSX.utils.book_append_sheet(book, sheet, '模拟公式');
  return XLSX.write(book, { type: 'buffer', bookType: type }) as Buffer;
}
test('Workbook parser verifies arithmetic and local SUM caches and preserves cache text rather than recomputed values', () => {
  for (const [formula, value] of [['SUM(C2:D2)', 0.3], ['($C$2+D2)*100%', 0.3], ['SUM(C2,D2,1)/2', 0.65], ['-C2 + +D2', 0.1]] as any[]) {
    const parsed = parseUpload('公式.xlsx', formulaFile(formula, value)); assert.equal(parsed.rows[0].raw['数值'], String(value)); assert.equal(parsed.diagnostics.formula_count, 1); assert.match(parsed.diagnostics.notes[0], /缓存/);
  }
  const text = parseUpload('公式文本.csv', Buffer.from('日期,备注\n2026-01-01,=1+1\n')); assert.equal(text.rows[0].raw['备注'], '=1+1'); assert.equal(text.diagnostics.formula_count, 0);
});
test('Workbook parser locates missing, stale, external, circular and unsupported formula caches instead of dropping rows', () => {
  for (const [formula, value, code] of [['C2+D2', undefined, 'FORMULA_CACHE_MISSING'], ['C2+D2', 99, 'FORMULA_CACHE_MISMATCH'], ['B2+1', 2, 'FORMULA_CYCLE'], ["'[外部.xlsx]数据'!A1", 1, 'FORMULA_UNSUPPORTED'], ['NOW()', 1, 'FORMULA_UNSUPPORTED'], ['SUM(A100:A200)', 0, 'FORMULA_REFERENCE'], ['1/0', 1, 'FORMULA_CACHE_MISMATCH']] as any[]) {
    assert.throws(() => parseUpload('公式.xlsx', formulaFile(formula, value)), (error: any) => { assert.equal(error.code, code); assert.equal(error.details.sheet, '模拟公式'); assert.match(error.message, /模拟公式!/); return true; });
  }
  const book = XLSX.utils.book_new(); const sheet = XLSX.utils.aoa_to_sheet([['只有公式'], ['']]); sheet.A2 = { t: 'n', f: '1+2' }; XLSX.utils.book_append_sheet(book, sheet, '不能漏行');
  assert.throws(() => parseUpload('只有公式.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })), errorCode('FORMULA_CACHE_MISSING'));
});
test('Formula verification rejects rounded intermediate divisions and bounds every intermediate result', () => {
  for (const [formula, cache] of [['1e-50/2', 0], ['1e-50/2', 5e-51], ['1/3', 0.3333333333333333], ['(1/3)*3-1', 0]] as const) {
    assert.throws(() => parseUpload('精度.xlsx', formulaFile(formula, cache)), errorCode('FORMULA_PRECISION_UNVERIFIED'));
  }
  assert.equal(parseUpload('精确除法.xlsx', formulaFile('1/8', 0.125)).rows[0].raw['数值'], '0.125');
  assert.throws(() => parseUpload('范围.xlsx', formulaFile('1e1000*10/1e1000', 10)), errorCode('FORMULA_LIMIT'));
});
test('Real BIFF8 formula caches are checked and XLS precision-risk numeric cells require exact source text', () => {
  const checked = parseUpload('公式.xls', formulaFile('1+2', 3, 'xls')); assert.equal(checked.rows[0].raw['数值'], '3'); assert.equal(checked.diagnostics.formula_count, 1);
  assert.throws(() => parseUpload('过期.xls', formulaFile('1+2', 4, 'xls')), errorCode('FORMULA_CACHE_MISMATCH'));
  for (const value of [1234567890123456, 1.2345678901234567, 1000000000000000]) {
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['日期', '数值'], ['2026-01-01', value]]), '精度');
    assert.throws(() => parseUpload('精度.xls', XLSX.write(book, { type: 'buffer', bookType: 'xls' })), (error: any) => error.code === 'XLS_PRECISION_RISK' && error.details.cell === 'B2');
    book.Sheets['精度'].B2 = { t: 's', v: '123456789012345.12345678' };
    assert.equal(parseUpload('文本.xls', XLSX.write(book, { type: 'buffer', bookType: 'xls' })).rows[0].raw['数值'], '123456789012345.12345678');
  }
});
test('Parser retains exact OOXML numeric lexemes and respects the workbook date system', () => {
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['日期', '数值'], [1, 0]]), '原数值'); book.Sheets['原数值'].A2.z = 'yyyy-mm-dd'; book.Workbook = { WBProps: { date1904: true } };
  const archive = XLSX.CFB.read(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), { type: 'buffer' });
  const sheet = archive.FileIndex.find(file => file.name === 'sheet1.xml'); assert.ok(sheet);
  sheet.content = Buffer.from(Buffer.from(sheet.content).toString('utf8').replace(/(<c\b[^>]*r="B2"[^>]*><v>)0(<\/v>)/, '$1123456789012345.12345678$2')); sheet.size = sheet.content.length;
  const parsed = parseUpload('精确原数值.xlsx', XLSX.CFB.write(archive, { type: 'buffer', fileType: 'zip' })); assert.equal(parsed.rows[0].raw['数值'], '123456789012345.12345678'); assert.equal(parsed.rows[0].raw['日期'], '1904-01-02');
});
test('Invalid formula files persist a precise failure and original bytes with no partial rows or business writes', async () => {
  const bytes = formulaFile('SUM(C2:D2)', 99);
  const staged = await importMutation('stage', { data_type: 'nav', share_class_id: fund.share_classes[0].id, original_name: '模拟错误公式.xlsx', content_base64: bytes.toString('base64') });
  assert.equal(staged.batch.status, 'failed'); assert.equal(staged.batch.context.parse_error_code, 'FORMULA_CACHE_MISMATCH'); assert.equal(staged.batch.context.parse_error_details.cell, 'B2'); assert.equal(staged.rows.length, 0);
  const ctx: any = { attachment() {}, set() {} }; await imports.download(ctx, staged.batch.id, 'test-user'); const chunks = []; for await (const chunk of ctx.body) chunks.push(chunk); assert.deepEqual(Buffer.concat(chunks), bytes);
});
test('Pending parsing releases the batch write lock so cancellation wins and completed parsing cannot resurrect it', async () => {
  const local = new FinanceImports(service, '.runtime/test-import-cancel-' + randomUUID());
  const upload = await local.upload({ data_type: 'nav', share_class_id: fund.share_classes[0].id, original_name: '模拟线程.csv', content_base64: Buffer.from('日期,数值\n2026-01-01,1\n').toString('base64'), request_key: randomUUID() }, 'thread-owner');
  let started: () => void; const entered = new Promise<void>(resolve => { started = resolve; }); let release: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const parse = local.parser.parse.bind(local.parser); local.parser.parse = async (...args) => { started(); await gate; return parse(...args); };
  const work = local.process(upload.batch_id); await entered;
  const current = await local.view(upload.batch_id, 'thread-owner');
  let timer: any;
  try {
    const cancel = service.write('thread-owner', 'cancelImport', randomUUID(), {}, transaction => local.cancel({ batch_id: upload.batch_id, technical_revision: current.batch.technical_revision }, transaction, 'thread-owner'));
    await Promise.race([cancel, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Parser held a transaction lock during workbook work')), 1000); })]);
  } finally { clearTimeout(timer); release(); await work; await local.close(); }
  const final = await local.view(upload.batch_id, 'thread-owner'); assert.equal(final.batch.status, 'cancelled'); assert.equal(final.rows.length, 0);
});
test('The parser worker runs outside the web event loop and is replaceable after a real worker termination', async () => {
  const local = new FinanceImports(service, '.runtime/test-worker-' + randomUUID());
  const csv = Buffer.from(['日期,数值', ...Array.from({ length: 10000 }, () => '2026-01-01,123456789012345.12345678')].join('\n'));
  let yielded = false; const timer = setTimeout(() => { yielded = true; }, 0);
  const parsed = await local.parser.parse('线程.csv', csv); clearTimeout(timer); assert.equal(yielded, true); assert.equal(parsed.rows.length, 10000); assert.ok(local.parser.worker.threadId > 0);
  const first = local.parser.worker; const interrupted = local.parser.parse('线程.csv', csv); const rejected = assert.rejects(interrupted, errorCode('PARSER_INTERRUPTED')); await first.terminate(); await rejected;
  assert.equal((await local.parser.parse('恢复.csv', Buffer.from('日期,数值\n2026-01-01,1\n'))).rows.length, 1); assert.notEqual(local.parser.worker, first); await local.close();
});
test('Restart recovery takes an expired parse claim once and skips a currently live claim', async () => {
  const local = new FinanceImports(service, '.runtime/test-lease-' + randomUUID()); const payload = { data_type: 'nav', share_class_id: fund.share_classes[0].id, original_name: '恢复.csv', content_base64: Buffer.from('日期,数值\n2026-01-01,1\n').toString('base64'), request_key: randomUUID() };
  const upload = await local.upload(payload, 'lease-owner'); const batch = await service.model('import_batches').findByPk(upload.batch_id);
  await domainWrite(() => batch.update({ context: { ...batch.get('context'), parse_claim: { token: randomUUID(), expires_at: new Date(Date.now() + 120000).toISOString() } } }, writeOptions()));
  await local.process(batch.id); assert.equal((await local.view(batch.id, 'lease-owner')).batch.status, 'parsing');
  await domainWrite(() => batch.update({ context: { ...batch.get('context'), parse_claim: { token: randomUUID(), expires_at: new Date(Date.now() - 1000).toISOString() } } }, writeOptions()));
  const restarted = new FinanceImports(service, local.directory); await Promise.all([local.process(batch.id), restarted.process(batch.id)]);
  const final = await local.view(batch.id, 'lease-owner'); assert.equal(final.batch.status, 'staged'); assert.equal(final.rows.length, 1); assert.equal(final.batch.context.parse_claim, null); await local.close(); await restarted.close();
});
test('Recovery prioritizes ready files and rotates more than fifty missing uploads without starving later work', async () => {
  const local = new FinanceImports(service, '.runtime/test-fair-import-' + randomUUID()); const actor = 'fair-import-owner'; const old = new Date(Date.now() - 3600000);
  const ids = Array.from({ length: 60 }, () => randomUUID());
  await domainWrite(() => service.model('import_batches').bulkCreate(ids.map(id => ({ id, owner_id: actor, data_type: 'nav', status: 'awaiting_file', original_name: '缺少原件.csv', storage_key: id + '.csv', context: { file_sha256: 'missing', headers: [], ignored_sheets: [] }, created_at: old, updated_at: old })), writeOptions()));
  const real = await local.upload({ data_type: 'nav', share_class_id: fund.share_classes[0].id, original_name: '实际文件.csv', content_base64: Buffer.from('日期,数值\n2026-01-01,1\n').toString('base64'), request_key: randomUUID() }, actor);
  await local.recover(); assert.equal((await local.view(real.batch_id, actor)).batch.status, 'staged'); await local.recover();
  const remaining = await service.model('import_batches').findAll({ where: { owner_id: actor, status: 'awaiting_file' } }); assert.equal(remaining.length, 60); assert.ok(remaining.every(row => row.get('updated_at').getTime() > old.getTime())); await local.close();
});
test('Orphan cleanup removes only expired generated files and remnants; associated originals, fresh files and symlinks stay', async () => {
  const local = new FinanceImports(service, '.runtime/test-orphans-' + randomUUID()); const bytes = Buffer.from('日期,数值\n2026-01-01,1\n');
  const uploaded = await local.upload({ data_type: 'nav', share_class_id: fund.share_classes[0].id, original_name: '保留原件.csv', content_base64: bytes.toString('base64'), request_key: randomUUID() }, 'orphan-owner');
  const batch = await service.model('import_batches').findByPk(uploaded.batch_id); const original = path.join(local.directory, batch.get('storage_key')); const part = original + '.part'; const orphan = path.join(local.directory, randomUUID() + '.csv'); const fresh = path.join(local.directory, randomUUID() + '.xlsx'); const unknown = path.join(local.directory, '不要删除.csv'); const link = path.join(local.directory, randomUUID() + '.xls');
  await writeFile(part, bytes); await writeFile(orphan, bytes); await writeFile(fresh, bytes); await writeFile(unknown, bytes); await symlink(path.resolve(unknown), link);
  const old = new Date(Date.now() - 8 * 86400000); for (const file of [original, part, orphan, unknown]) await utimes(file, old, old);
  await service.write('orphan-owner', 'cancelImport', randomUUID(), {}, transaction => local.cancel({ batch_id: batch.id, technical_revision: batch.get('technical_revision') }, transaction, 'orphan-owner'));
  assert.equal((await local.cleanupOrphans()).removed, 2); assert.equal(existsSync(orphan), false); assert.equal(existsSync(part), false); assert.deepEqual(await readFile(original), bytes); assert.ok(existsSync(fresh)); assert.ok(existsSync(unknown)); assert.equal((await lstat(link)).isSymbolicLink(), true); await local.close();
});
test('Parser upgrades reject legacy editable previews but retain their original rows and successful committed results', async () => {
  const staged = await stage('日期,数值\n2030-01-01,1.25\n'); const ready = await preview(staged); const batch = await service.model('import_batches').findByPk(ready.batch.id);
  const context = { ...batch.get('context') }; delete context.parser_version;
  await domainWrite(() => batch.update({ context }, writeOptions()));
  await assert.rejects(commit(ready), errorCode('PARSER_UPDATE_REQUIRED')); await assert.rejects(preview(ready), errorCode('PARSER_UPDATE_REQUIRED'));
  assert.equal((await imports.view(batch.id, 'test-user')).rows[0].raw['数值'], '1.25');
  await domainWrite(() => batch.update({ context: ready.batch.context }, writeOptions())); const result = await commit(ready);
  await batch.reload(); await domainWrite(() => batch.update({ context }, writeOptions())); assert.deepEqual(await commit(ready), result);
});
test('Persistently failing old file tasks no longer starve a later recoverable upload', async () => {
  const harness = fileHarness(randomUUID()); const tasks = [];
  harness.faults.verify = true;
  for (let i = 0; i < 51; i++) {
    const task = await harness.files.upload({ fund_id: fund.fund.id, original_name: '模拟公平恢复.txt', document_type: '其他', content_base64: Buffer.from('模拟公平恢复 ' + i).toString('base64'), request_key: randomUUID() }, 'fair-file-owner');
    assert.equal(task.status, 'failed'); tasks.push(await harness.files.task(task.task_id, 'fair-file-owner'));
  }
  harness.faults.verify = false; for (const task of tasks.slice(0, 50)) harness.faults.verifyNames.add(task.get('storage_key'));
  await harness.files.recover(); await harness.files.recover(); assert.equal((await harness.files.task(tasks[50].id, 'fair-file-owner')).get('status'), 'complete'); assert.equal((await harness.files.task(tasks[0].id, 'fair-file-owner')).get('status'), 'failed');
});

test('Workbench NAV coverage uses exact date, paginates and excludes inactive shares without treating future NAV as available', async () => {
  const aggregate = await mutate('saveFund', sampleFund('WORKBENCH-NAV'));
  const [a,b] = aggregate.share_classes;
  const scope = { fund_id: aggregate.fund.id, as_of: '2026-06-30', page_size: 1 };
  await mutate('saveSeries', { data_type: 'nav', values: { share_class_id: a.id, nav_date: '2026-06-29', nav_per_unit: '1.123456789012345' }, expected_revision: null });
  await mutate('saveSeries', { data_type: 'nav', values: { share_class_id: b.id, nav_date: '2026-07-01', nav_per_unit: '2' }, expected_revision: null });
  let result = await queries.navCoverage(scope);
  assert.deepEqual(result.summary, { total: 2, recorded: 0, missing: 2 });
  const second = await queries.navCoverage({ ...scope, page: 2 });
  assert.notEqual(result.rows[0].id,second.rows[0].id);
  const before = await queries.navCoverage({ ...scope, share_class_id: a.id });
  assert.equal(before.rows[0].latest_nav, '1.123456789012345');
  assert.equal(before.rows[0].exact_nav, null);
  assert.equal((await queries.navCoverage({ ...scope, share_class_id: b.id })).rows[0].latest_date, null);
  await mutate('saveSeries', { data_type: 'nav', values: { share_class_id: a.id, nav_date: '2026-06-30', nav_per_unit: '1.234567890123456' }, expected_revision: null });
  result = await queries.navCoverage({ ...scope, status: 'missing' });
  assert.equal(result.count, 1); assert.equal(result.rows[0].id, b.id);
  assert.deepEqual(result.summary, { total: 2, recorded: 1, missing: 1 });
  assert.equal((await queries.navCoverage({ ...scope, status: 'recorded' })).rows[0].exact_nav, '1.234567890123456');
  await mutate('setClassDisabled', { id: b.id, technical_revision: b.technical_revision, fund_revision: aggregate.fund.technical_revision, disabled: true });
  result = await queries.navCoverage(scope); assert.deepEqual(result.summary,{total:1,recorded:1,missing:0});
  const current = await service.fundAggregate(aggregate.fund.id);
  await mutate('setDeleted', { table: 'funds', id: current.fund.id, technical_revision: current.fund.technical_revision, deleted: true });
  assert.equal((await queries.navCoverage(scope)).count, 0);
  await assert.rejects(queries.navCoverage({ ...scope, as_of: '2026-02-30' }));
  await assert.rejects(queries.navCoverage({ ...scope, status: 'unknown' }));
  await assert.rejects(queries.navCoverage({ ...scope, fund_id: "' OR TRUE" }));
});
