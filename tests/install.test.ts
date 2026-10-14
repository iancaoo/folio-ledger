import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { sampleFund } from './fixtures';
import { catalog, fields } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/models';
import { createServer } from 'node:net';

// Isolated, disposable DB + storage + IPC socket. No commands target finance_dev.
test('Fresh install, replayable initialization and upgrade preserve one aggregate and its receipt', async () => {
  const root = process.cwd();
  await new Promise<void>((resolveFree, reject) => {
    const probe = createServer(); probe.once('error', reject); probe.listen(13001, '127.0.0.1', () => probe.close(() => resolveFree()));
  });
  const id = randomBytes(5).toString('hex');
  const database = `finance_install_${id}`;
  const storage = resolve('.runtime/install-check', id);
  mkdirSync(storage, { recursive: true });
  const log = openSync(`${storage}/install.log`, 'a', 0o600);
  const credentials = JSON.parse(readFileSync('.runtime/dev-credentials.json', 'utf8'));
  const node = process.execPath;
  const yarn = resolve('.runtime/tooling/node_modules/yarn/bin/yarn.js');
  const env = { ...process.env, PATH: `${dirname(node)}:${process.env.PATH}`, DB_DATABASE: database,
    STORAGE_PATH: storage, SOCKET_PATH: `/tmp/finance-install-${id}.sock`, APP_PORT: '13001',
    APP_HOST: '127.0.0.1', APP_KEY: randomBytes(32).toString('hex'), FINANCE_DEMO_MODE: 'true',
    INIT_ROOT_EMAIL: `install-${id}@finance.local`, INIT_ROOT_PASSWORD: randomBytes(20).toString('hex'),
  };
  const bootstrap = statement => {
    const result = spawnSync('psql', ['-h', resolve('.runtime/pg-socket'), '-p', '15432', '-U', 'finance_bootstrap', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: statement, encoding: 'utf8' });
    assert.equal(result.status, 0, 'Isolated database setup/cleanup failed');
  };
  const command = (...args: string[]) => new Promise<void>((resolveRun, reject) => {
    const child = spawn(node, [yarn, 'nocobase', ...args], { cwd: resolve('apps/nocobase'), env, stdio: ['ignore', log, log] });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`CLI ${args[0]} failed. Check ${storage}/install.log`)));
  });
  let app: any, db: any;
  async function stop() {
    if (app && app.exitCode === null) {
      const exit = new Promise<void>(resolveExit => app.once('exit', () => resolveExit()));
      process.kill(-app.pid, 'SIGTERM');
      const timeout = setTimeout(() => { try { process.kill(-app.pid, 'SIGKILL'); } catch {} }, 8000);
      await exit; clearTimeout(timeout);
    }
    app = undefined;
  }
  async function start() {
    app = spawn(node, [yarn, 'start', '--launch-mode=node'], { cwd: resolve('apps/nocobase'), env, detached: true, stdio: ['ignore', log, log] });
    for (let i = 0; i < 80; i++) {
      assert.equal(app.exitCode, null, 'Isolated app exited during startup');
      try { const response = await fetch('http://127.0.0.1:13001/api/app:getInfo'); if ((await response.json()).data?.version) return; } catch {}
      await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
    }
    throw new Error('Isolated app did not become ready');
  }
  let token = '';
  async function api(action: string, body?: any) {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:13001/api/${action}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Authenticator': 'basic', ...(token ? { Authorization: `Bearer ${token}`, 'X-Role': 'root' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result.errors)); return result.data;
      } catch (error) { if (attempt >= 2) throw error; await new Promise(resolveDelay => setTimeout(resolveDelay, 200)); }
    }
  }
  bootstrap(`CREATE DATABASE ${database} OWNER finance_app;`);
  const started = Date.now();
  try {
    await command('install', '--lang', 'zh-CN');
    db = new Client({ host: '127.0.0.1', port: 15432, user: 'finance_app', password: credentials.database_password, database });
    await db.connect();
    const owner = (await db.query('SELECT id FROM users WHERE email=$1', [env.INIT_ROOT_EMAIL])).rows[0];
    assert.ok(owner, 'Root user missing on fresh install');
    const roles = (await db.query("SELECT name, \"allowConfigure\" FROM roles WHERE name LIKE 'finance_%'")).rows;
    assert.equal(roles.length, 4); assert.ok(roles.every(row => row.allowConfigure === false));
    const menu = await db.query("SELECT id FROM \"desktopRoutes\" WHERE \"schemaUid\"='finance-workspace-entry'");
    assert.equal(menu.rowCount, 1);
    const constraints = await db.query("SELECT conname FROM pg_constraint WHERE conname LIKE 'finance_%' AND contype='c'");
    assert.ok(constraints.rowCount >= 32);
    const userFk = await db.query("SELECT conname FROM pg_constraint WHERE conname LIKE 'finance_%_user_fk'");
    assert.equal(userFk.rowCount, 2);
    const sourceRows = await db.query("SELECT COUNT(*) AS count FROM finance_option_sets");
    assert.ok(Number(sourceRows.rows[0].count) > 30);
    const actualColumns = (await db.query("SELECT table_name,column_name,data_type,numeric_scale,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'finance_%'")).rows;
    const mapping = catalog.fields.map(source => {
      if (!source.logical_table) return { source_key: source.source_key, label: source.label, handling: source.mapping, result: 'explicit-rule-or-deferred' };
      const columns = source.mapping.split('；')[0].split(' + ').map(part => {
        const [table, name] = part.includes('.') ? part.split('.') : [source.logical_table, part];
        return { table: `finance_${table}`, name, logical_table: table };
      });
      for (const column of columns) {
        const actual = actualColumns.find(row => row.table_name === column.table && row.column_name === column.name);
        assert.ok(actual, `Missing physical column for ${source.source_key}: ${column.table}.${column.name}`);
        if (fields[column.logical_table].find(field => field.name === column.name)?.type === 'decimal') {
          assert.equal(actual.data_type, 'numeric'); assert.equal(actual.numeric_scale, null);
        }
      }
      return { source_key: source.source_key, label: source.label, table: `finance_${source.logical_table}`, columns, required_unconfirmed: source.required_unconfirmed, result: 'physical-columns-verified' };
    });
    assert.equal(mapping.length, 161);
    await start();
    token = (await api('auth:signIn', { account: env.INIT_ROOT_EMAIL, password: env.INIT_ROOT_PASSWORD })).token;
    const payload = { ...sampleFund(`FRESH-${id}`), request_key: randomUUID() };
    payload.details.coverage_owner_user_id = String(owner.id);
    const saved = await api('finance:saveFund', payload);
    const aggregate = await api(`finance:fund?id=${saved.fund_id}`);
    assert.equal(aggregate.share_classes.length, 2);
    await stop();
    await command('install'); // Existing DB must be retained, never force/clean.
    await command('upgrade', '--skip-code-update');
    await start();
    assert.deepEqual(await api('finance:saveFund', payload), saved);
    assert.equal((await db.query('SELECT COUNT(*) AS count FROM finance_fund_versions')).rows[0].count, '1');
    assert.equal((await db.query("SELECT COUNT(*) AS count FROM \"desktopRoutes\" WHERE \"schemaUid\"='finance-workspace-entry'")).rows[0].count, '1');
    const replayRoles = (await db.query("SELECT name, \"allowConfigure\" FROM roles WHERE name LIKE 'finance_%'")).rows;
    assert.deepEqual(replayRoles.map(row => row.name).sort(), roles.map(row => row.name).sort());
    mkdirSync(resolve('docs/verification'), { recursive: true });
    writeFileSync(resolve('docs/verification/M1安装迁移.json'), JSON.stringify({ checked_at: new Date().toISOString(), platform: '2.2.24', isolated_database: true, isolated_storage: true, duration_ms: Date.now() - started,
      checks: ['空库安装', '四个业务角色无平台设计权限', '菜单不重复', '数据库 CHECK 与负责人外键', '候选初始化', '基金两份额', '重复安装保留数据', '固定版本升级', '重启后同请求重放只有一个资料版本'], result: 'passed' }, null, 2) + '\n');
    writeFileSync(resolve('docs/verification/M1字段落点.json'), JSON.stringify({ checked_at: new Date().toISOString(), source_rows: 161, mapping, note: '核对实际数据库列；计算项、动作和未定义字段仍按处理说明执行，不代表所有页面已完成。' }, null, 2) + '\n');
  } finally {
    await stop(); if (db) await db.end(); closeSync(log);
    bootstrap(`DROP DATABASE ${database} WITH (FORCE);`);
  }
});
