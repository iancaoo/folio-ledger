import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { chromium } from 'playwright';
import { IsolatedApp } from './isolated-app';
import { sampleFund, sampleEntity } from './fixtures';

test('Offline whole-database and private-file backup restores into isolation with roles, keys, receipts and unfinished tasks intact', async () => {
  const source = new IsolatedApp(); const target = new IsolatedApp(); let browser: any;
  const started = Date.now(); const checks: string[] = [];
  const backup = resolve('.runtime/backups', source.id); const secrets = resolve('.runtime/backup-secrets', source.id);
  const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const api = async (instance: IsolatedApp, action: string, body?: any) => (await instance.request(`finance:${action}`, body && { ...body, request_key: body.request_key || randomUUID() })).data;
  async function waitBatch(instance: IsolatedApp, id: string) {
    for (let i = 0; i < 150; i++) { const view = await api(instance, `importBatch?id=${id}`); if (!['parsing', 'awaiting_file'].includes(view.batch.status)) return view; await new Promise(done => setTimeout(done, 100)); }
    throw new Error('Restored parse task did not settle');
  }
  async function snapshots(instance: IsolatedApp) {
    const tables = (await instance.db!.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'finance_%' ORDER BY tablename")).rows;
    const result: any = {};
    for (const { tablename } of tables) { assert.match(tablename, /^finance_[a-z_]+$/); result[tablename] = (await instance.db!.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(row_to_json(t)::text,'|' ORDER BY id),'')) AS hash FROM ${tablename} t`)).rows[0]; }
    return result;
  }
  const constraints = async (instance: IsolatedApp) => (await instance.db!.query("SELECT conname,contype,convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN (SELECT oid FROM pg_class WHERE relname LIKE 'finance_%') ORDER BY conname")).rows.map(row => ({ ...row,
    // pg_restore can deparse the varchar-array-to-text cast element by element.
    // Both forms enforce the same enum; other constraints compare verbatim.
    definition: row.conname === 'finance_funds_fund_kind_ck' ? row.definition.replace(/::(?:character varying|text)(?:\[\])?/g, '').replace(/[()]/g, '') : row.definition,
  }));
  function profile(instance: IsolatedApp, appKey = instance.env.APP_KEY) {
    const path = join(instance.storage, 'backup-profile.json');
    writeFileSync(path, JSON.stringify({ database: { host: '127.0.0.1', port: 15432, user: 'finance_app', password: instance.credentials.database_password, name: instance.database }, storage_path: instance.storage, app_port: instance.port, app_key: appKey }), { mode: 0o600 });
    return path;
  }
  function backupCommand(action: string, profilePath?: string) {
    return spawnSync('python3', ['scripts/backup.py', action, '--backup', backup, '--secrets', secrets, ...(profilePath ? ['--profile', profilePath] : [])], { encoding: 'utf8', timeout: 60000 });
  }
  async function reconnect(instance: IsolatedApp) {
    instance.db = new Client({ host: '127.0.0.1', port: 15432, user: 'finance_app', password: instance.credentials.database_password, database: instance.database }); await instance.db.connect();
  }
  try {
    await source.create(); await source.command('install', '--lang', 'zh-CN'); await source.start(); await source.login();
    const owner = String((await source.db!.query('SELECT id FROM users WHERE email=$1', [source.rootEmail])).rows[0].id);
    const input = sampleFund('RECOVERY'); input.details.coverage_owner_user_id = owner;
    const fundRequest = { ...input, request_key: randomUUID() }; const savedFund = await api(source, 'saveFund', fundRequest);
    const fund = await api(source, `fund?id=${savedFund.fund_id}`); const share = fund.share_classes[0];
    const entity = await api(source, 'saveEntity', sampleEntity('RECOVERY-CLIENT', '备份恢复'));
    const tradeRequest = { request_key: randomUUID(), values: { entity_id: entity.id, share_class_id: share.id, transaction_type: '初次申购', confirmation_date: '2026-01-01', confirmed_units: '100', amount: '100.000000000001', currency: 'USD' } };
    const tradeResult = await api(source, 'saveTrade', tradeRequest);
    await api(source, 'saveTrade', { values: { ...tradeRequest.values, confirmation_date: '2026-01-02', transaction_type: '赎回', confirmed_units: '30' } });
    const upload = await api(source, 'stageImport', { data_type: 'nav', share_class_id: share.id, original_name: '模拟恢复净值.csv', content_base64: Buffer.from('日期,数值\n2026-01-03,1.25\n').toString('base64') });
    const staged = await waitBatch(source, upload.batch_id);
    await api(source, 'previewImport', { batch_id: upload.batch_id, technical_revision: staged.batch.technical_revision, mapping: { date: '日期', value: '数值' } });
    const ready = await waitBatch(source, upload.batch_id);
    const commitRequest = { request_key: randomUUID(), batch_id: ready.batch.id, technical_revision: ready.batch.technical_revision, preview_token: ready.batch.preview.token };
    const commitResult = await api(source, 'commitImport', commitRequest);
    const draft = await api(source, 'saveDraft', { form_type: 'benchmark', content: { values: { name: '恢复后保留的未完成模拟草稿', remarks: '123456789012345.12345678' } } });
    const options = await api(source, 'options');
    const selected = options.find(row => row.values.length && row.source_key !== '净值与文档:13');
    await api(source, 'saveOptions', { source_key: selected.source_key, technical_revision: selected.technical_revision, confirmed: false, values: selected.values });
    const documentBytes = Buffer.from('模拟保留文件：备份与恢复必须逐字节一致。\n');
    const kept = await api(source, 'uploadDocument', { fund_id: fund.fund.id, document_type: '其他', original_name: '模拟保留.txt', content_base64: documentBytes.toString('base64') });
    const removed = await api(source, 'uploadDocument', { fund_id: fund.fund.id, document_type: '其他', original_name: '模拟删除中断.txt', content_base64: documentBytes.toString('base64') });
    assert.equal(kept.status, 'complete'); assert.equal(removed.status, 'complete');
    const files = (await source.db!.query('SELECT d.id AS document_id,f.* FROM finance_fund_documents d JOIN finance_file_records f ON f.id::text=d.storage_key')).rows;
    const deletedFile = files.find(row => row.document_id === removed.document_id);
    const readerPassword = randomBytes(24).toString('hex');
    await source.request('users:create', { username: 'restore-reader', nickname: '模拟恢复只读', password: readerPassword, roles: [{ name: 'finance_reader' }] });
    // Starting a backup with the source still serving must be rejected.
    const sourceProfile = profile(source); const onlineAttempt = backupCommand('create', sourceProfile);
    assert.notEqual(onlineAttempt.status, 0); assert.match(onlineAttempt.stderr, /port is still open/); assert.equal(existsSync(backup), false);
    await source.stop();
    const parseId = randomUUID(); const pendingBytes = Buffer.from('日期,数值\n2026-02-01,123456789012345.12345678\n');
    const pendingUploadId = randomUUID(); const waitingUploadId = randomUUID(); const deleteId = randomUUID(); const pendingFileBytes = Buffer.from('模拟待恢复上传，已写暂存、尚未建立文档。');
    mkdirSync(join(source.storage, 'finance/imports'), { recursive: true }); mkdirSync(join(source.storage, 'finance/staging'), { recursive: true });
    writeFileSync(join(source.storage, 'finance/imports', `${parseId}.csv`), pendingBytes, { mode: 0o600 });
    writeFileSync(join(source.storage, 'finance/staging', `${pendingUploadId}.txt`), pendingFileBytes, { mode: 0o600 });
    await source.db!.query(`INSERT INTO finance_import_batches(id,owner_id,data_type,status,original_name,storage_key,context,technical_revision,preview_revision,created_at,updated_at)
      VALUES($1,$2,'nav','parsing','模拟解析中断.csv',$3,$4,1,0,NOW(),NOW())`, [parseId, owner, `${parseId}.csv`, { target_mode: 'single', share_class_id: share.id, headers: [], file_sha256: hash(pendingBytes), parse_claim: { token: randomUUID(), expires_at: '2020-01-01T00:00:00Z' } }]);
    for (const id of [pendingUploadId, waitingUploadId]) await source.db!.query(`INSERT INTO finance_file_operations(id,fund_id,owner_id,operation,status,storage_key,context,technical_revision,created_at,updated_at)
      VALUES($1,$2,$3,'upload','pending',$4,$5,1,NOW(),NOW())`, [id, fund.fund.id, owner, `${id}.txt`, { fund_id: fund.fund.id, document_type: '其他', original_name: '模拟上传中断.txt', extname: '.txt', mimetype: 'text/plain', size: pendingFileBytes.length, sha256: hash(pendingFileBytes) }]);
    await source.db!.query('UPDATE finance_fund_documents SET deleting=true,technical_revision=technical_revision+1 WHERE id=$1', [removed.document_id]);
    await source.db!.query(`INSERT INTO finance_file_operations(id,fund_id,owner_id,operation,status,storage_key,document_id,context,technical_revision,created_at,updated_at)
      VALUES($1,$2,$3,'delete','pending',$4,$5,$6,1,NOW(),NOW())`, [deleteId, fund.fund.id, owner, deletedFile.filename, removed.document_id, { record_id: deletedFile.id, document_id: removed.document_id }]);
    const before = await snapshots(source); const beforeConstraints = await constraints(source);
    const platformBefore = (await source.db!.query(`SELECT (SELECT count(*) FROM roles) AS roles,(SELECT count(*) FROM "rolesUsers") AS memberships,(SELECT count(*) FROM "desktopRoutes") AS routes,(SELECT count(*) FROM migrations) AS migrations`)).rows[0];
    const keyBytes = readFileSync(join(source.storage, 'apps/main/aes_key.dat'));
    await source.db!.end(); source.db = undefined;
    const backedUp = backupCommand('create', sourceProfile); assert.equal(backedUp.status, 0, backedUp.stderr);
    assert.equal(backupCommand('verify').status, 0); checks.push('运行中的应用拒绝备份；停止写入后数据库、原件、文档、暂存文件与密钥配套备份，SHA-256 核验通过');
    const manifestText = readFileSync(join(backup, 'manifest.json'), 'utf8'); assert.ok(!manifestText.includes(source.env.APP_KEY!)); assert.ok(!manifestText.includes(source.credentials.database_password));
    // A corrupted source file is detected before any restore mutation.
    const copiedOriginal = join(backup, 'storage/finance/imports', `${parseId}.csv`); const correctOriginal = readFileSync(copiedOriginal);
    writeFileSync(copiedOriginal, Buffer.from('tampered')); assert.notEqual(backupCommand('verify').status, 0); writeFileSync(copiedOriginal, correctOriginal);
    assert.equal(backupCommand('verify').status, 0); checks.push('密钥单独受控保存；文件被修改后校验拒绝；恢复前需全部文件哈希一致');
    await target.create(); const targetProfile = profile(target);
    await target.db!.end(); target.db = undefined;
    const restored = backupCommand('restore', targetProfile); assert.equal(restored.status, 0, restored.stderr);
    target.env.APP_KEY = JSON.parse(readFileSync(join(secrets, 'runtime.json'), 'utf8')).app_key;
    await reconnect(target); assert.deepEqual(await snapshots(target), before); assert.deepEqual(await constraints(target), beforeConstraints);
    await assert.rejects(target.db!.query("UPDATE finance_funds SET fund_kind='invalid' WHERE id=$1", [fund.fund.id]), (error: any) => error.code === '23514' && error.constraint === 'finance_funds_fund_kind_ck');
    assert.deepEqual((await target.db!.query(`SELECT (SELECT count(*) FROM roles) AS roles,(SELECT count(*) FROM "rolesUsers") AS memberships,(SELECT count(*) FROM "desktopRoutes") AS routes,(SELECT count(*) FROM migrations) AS migrations`)).rows[0], platformBefore);
    assert.deepEqual(readFileSync(join(target.storage, 'apps/main/aes_key.dat')), keyBytes);
    checks.push('28 个 Finance 表逐行内容摘要与行数一致；全部约束、角色成员、页面菜单及迁移记录保留；AES 密钥一致');
    await target.db!.end(); target.db = undefined;
    const overwrite = backupCommand('restore', targetProfile); assert.notEqual(overwrite.status, 0); assert.match(overwrite.stderr, /not empty/); await reconnect(target);
    checks.push('已有数据的目标库拒绝覆盖；原库及原文件保持隔离');
    await target.command('upgrade', '--skip-code-update'); await target.start();
    target.token = (await target.request('auth:signIn', { account: source.rootEmail, password: source.rootPassword }, '')).data.token;
    assert.deepEqual(await api(target, 'saveFund', fundRequest), savedFund); assert.deepEqual(await api(target, 'saveTrade', tradeRequest), tradeResult); assert.deepEqual(await api(target, 'commitImport', commitRequest), commitResult);
    assert.equal((await api(target, `versions?fund_id=${fund.fund.id}`)).length, 1);
    const positions = await api(target, `positionList?entity_id=${entity.id}`); assert.equal(positions.rows[0].units, '70'); assert.equal(positions.rows[0].market_value, '87.5');
    assert.equal((await api(target, `draft?id=${draft.id}`)).content.values.remarks, '123456789012345.12345678');
    assert.equal((await api(target, 'options')).find(row => row.source_key === selected.source_key).confirmed, false);
    checks.push('固定版本升级及启动成功；70 份／87.5 市值、个人草稿、候选配置保留；原基金、交易、提交请求重试不重复');
    const recovered = await waitBatch(target, parseId); assert.equal(recovered.batch.status, 'staged'); assert.equal(recovered.rows[0].raw['数值'], '123456789012345.12345678');
    await api(target, 'previewImport', { batch_id: parseId, technical_revision: recovered.batch.technical_revision, mapping: { date: '日期', value: '数值' } });
    const parsed = await waitBatch(target, parseId); const result = await api(target, 'commitImport', { batch_id: parseId, technical_revision: parsed.batch.technical_revision, preview_token: parsed.batch.preview.token }); assert.equal(result.inserted_count, 1);
    for (let i = 0; i < 100; i++) { const state = await api(target, `fileTask?id=${deleteId}`); if (state.status === 'complete') break; await new Promise(done => setTimeout(done, 100)); }
    assert.equal((await api(target, `fileTask?id=${deleteId}`)).status, 'complete'); assert.equal(existsSync(join(target.storage, 'finance/documents', deletedFile.filename)), false);
    assert.equal(existsSync(join(source.storage, 'finance/documents', deletedFile.filename)), true, 'Restored deletion must not touch source storage');
    const recoveredFile = await api(target, `fileTask?id=${pendingUploadId}`); assert.equal(recoveredFile.status, 'complete');
    assert.equal((await api(target, `fileTask?id=${waitingUploadId}`)).status, 'awaiting_upload');
    const resumed = await api(target, 'retryFile', { task_id: waitingUploadId, content_base64: pendingFileBytes.toString('base64') }); assert.equal(resumed.status, 'complete');
    assert.equal((await api(target, 'retryFile', { task_id: pendingUploadId })).document_id, recoveredFile.document_id);
    assert.equal((await api(target, `documents?fund_id=${fund.fund.id}`)).length, 3);
    checks.push('过期解析任务接管后精确值可提交；暂存上传自动恢复，缺失上传可补传，删除任务完成且不会误删原环境文件；重试无重复文档');
    const readerToken = (await target.request('auth:signIn', { account: 'restore-reader', password: readerPassword }, '')).data.token;
    const headers = { Authorization: `Bearer ${readerToken}`, 'X-Role': 'finance_reader', 'X-Authenticator': 'basic' };
    const download = await fetch(`${target.origin}/api/finance:downloadDocument?id=${kept.document_id}`, { headers }); assert.equal(download.status, 200); assert.deepEqual(Buffer.from(await download.arrayBuffer()), documentBytes);
    assert.equal((await fetch(`${target.origin}/api/finance:downloadDocument?id=${kept.document_id}`)).status, 401);
    const denied = await fetch(`${target.origin}/api/finance:saveEntity`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...sampleEntity('DENIED', '只读拒写'), request_key: randomUUID() }) }); assert.equal(denied.status, 403);
    assert.equal((await fetch(`${target.origin}/api/finance:downloadImport?id=${parseId}`, { headers })).status, 403);
    checks.push('恢复后可用原账号登录；私有文档字节一致，匿名下载与只读写入仍拒绝，批次原件所有者限制保留');
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1050 }, storageState: { cookies: [], origins: [{ origin: target.origin, localStorage: [{ name: 'NOCOBASE_TOKEN', value: target.token }, { name: 'NOCOBASE_ROLE', value: 'root' }, { name: 'NOCOBASE_AUTH', value: 'basic' }, { name: 'NOCOBASE_LOCALE', value: 'zh-CN' }] }] } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${target.origin}/admin/finance`); await page.getByRole('tab', { name: '持仓核对', exact: true }).click();
    const table = page.locator('[data-finance-table="positionList"]'); await table.locator('.ant-table-row').first().waitFor(); assert.match(await table.innerText(), /70/);
    await table.screenshot({ path: 'docs/verification/M5恢复后持仓.png', animations: 'disabled' }); assert.deepEqual(errors, []);
    checks.push('真实浏览器恢复后页面入口、持仓列表及核心关联可访问，无页面运行错误');
    writeFileSync('docs/verification/M5备份恢复验证.json', JSON.stringify({ executed_at: new Date().toISOString(), passed: true, tests: 1, simulated: true, duration_ms: Date.now() - started,
      environment: { platform: 'NocoBase 2.2.24', postgres: '17.9', node: process.version, separate_database: true, separate_storage: true, source_app_stopped: true },
      restored_finance_tables: Object.keys(before).length, constraints: beforeConstraints.length, checks,
      fault_injection: '应用停止后在独立源库构造解析认领过期、上传已暂存／缺文件、删除未执行四个持久检查点；并非在真实用户数据上中断任务',
      limitations: ['同机独立实例；生产主机、异机环境和异地介质尚未验收', '只支持本项目单应用的 PostgreSQL 与本地 finance/uploads 存储；额外存储或子应用需扩展备份范围', '密钥目录必须与数据备份分别受控保管；备份校验不是加密或签名', '原始业务保留周期与生产每日备份调度需部署管理员确定'],
      files: ['M5恢复后持仓.png'], source_sha256: Object.fromEntries(['scripts/backup.py','tests/backup-restore.test.ts','tests/isolated-app.ts'].map(file => [file, hash(readFileSync(file))])) }, null, 2) + '\n');
  } finally { if (browser) await browser.close(); await source.dispose(); await target.dispose(); }
});
