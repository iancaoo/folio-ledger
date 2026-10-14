import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { Client } from 'pg';

/** Disposable verification instance. It never installs into or resets finance_dev. */
export class IsolatedApp {
  readonly id = randomBytes(6).toString('hex');
  readonly database = `finance_verify_${this.id}`;
  readonly storage = resolve('.runtime/verification', this.id);
  readonly node = process.execPath;
  readonly yarn = resolve('.runtime/tooling/node_modules/yarn/bin/yarn.js');
  readonly credentials = JSON.parse(readFileSync('.runtime/dev-credentials.json', 'utf8'));
  readonly rootEmail = `verify-${this.id}@finance.local`;
  readonly rootPassword = randomBytes(24).toString('hex');
  env: NodeJS.ProcessEnv;
  port: number;
  log: number;
  app?: ChildProcess;
  db?: Client;
  token = '';
  private created = false;
  get origin() { return `http://127.0.0.1:${this.port}`; }

  private bootstrap(sql: string) {
    assert.match(this.database, /^finance_verify_[0-9a-f]{12}$/);
    const result = spawnSync('psql', ['-h', resolve('.runtime/pg-socket'), '-p', '15432', '-U', 'finance_bootstrap', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql, encoding: 'utf8' });
    assert.equal(result.status, 0, 'Disposable verification database setup/cleanup failed');
  }
  async create() {
    this.port = await new Promise<number>((accept, reject) => {
      const probe = createServer(); probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as any).port; probe.close(() => accept(port)); });
    });
    mkdirSync(this.storage, { recursive: true, mode: 0o700 });
    this.log = openSync(`${this.storage}/app.log`, 'a', 0o600);
    this.env = { ...process.env, PATH: `${dirname(this.node)}:${process.env.PATH}`, DB_DIALECT: 'postgres', DB_HOST: '127.0.0.1', DB_PORT: '15432',
      DB_DATABASE: this.database, DB_USER: 'finance_app', DB_PASSWORD: this.credentials.database_password,
      STORAGE_PATH: this.storage, SOCKET_PATH: `/tmp/finance-verify-${this.id}.sock`, APP_PORT: String(this.port), APP_HOST: '127.0.0.1',
      APP_KEY: randomBytes(32).toString('hex'), FINANCE_DEMO_MODE: 'true', REQUEST_BODY_LIMIT: '16mb',
      INIT_ROOT_EMAIL: this.rootEmail, INIT_ROOT_PASSWORD: this.rootPassword };
    this.bootstrap(`CREATE DATABASE ${this.database} OWNER finance_app;`); this.created = true;
    this.db = new Client({ host: '127.0.0.1', port: 15432, user: 'finance_app', password: this.credentials.database_password, database: this.database });
    await this.db.connect();
  }
  async command(...args: string[]) {
    await new Promise<void>((accept, reject) => {
      const child = spawn(this.node, [this.yarn, 'nocobase', ...args], { cwd: resolve('apps/nocobase'), env: this.env, stdio: ['ignore', this.log, this.log] });
      child.on('error', reject); child.on('exit', code => code === 0 ? accept() : reject(new Error(`Isolated CLI ${args[0]} failed; see ${this.storage}/app.log`)));
    });
  }
  async start() {
    assert.ok(!this.app || this.app.exitCode !== null, 'Verification app already started');
    this.app = spawn(this.node, [this.yarn, 'start', '--launch-mode=node'], { cwd: resolve('apps/nocobase'), env: this.env, detached: true, stdio: ['ignore', this.log, this.log] });
    for (let i = 0; i < 160; i++) {
      assert.equal(this.app.exitCode, null, 'Isolated app exited during startup');
      try { const response = await fetch(`${this.origin}/api/app:getInfo`, { signal: AbortSignal.timeout(2000) }); if ((await response.json()).data?.version) return; } catch {}
      await new Promise(done => setTimeout(done, 250));
    }
    throw new Error('Isolated app startup timed out');
  }
  async stop() {
    const app = this.app;
    if (app && app.exitCode === null) {
      const stopped = new Promise<void>(accept => app.once('exit', () => accept()));
      try { process.kill(-app.pid!, 'SIGTERM'); } catch (error: any) { if (error.code !== 'ESRCH') throw error; }
      const timer = setTimeout(() => { try { process.kill(-app.pid!, 'SIGKILL'); } catch {} }, 8000);
      await stopped; clearTimeout(timer);
    }
    this.app = undefined;
  }
  async request(action: string, payload?: any, token = this.token, role = 'root') {
    const started = performance.now();
    const response = await fetch(`${this.origin}/api/${action}`, { method: payload === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Authenticator': 'basic', ...(token ? { Authorization: `Bearer ${token}`, 'X-Role': role } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(90000) });
    const body = await response.json();
    assert.equal(response.status, 200, `Isolated ${action.split('?')[0]}: ${JSON.stringify(body.errors)}`);
    return { data: body.data, meta: body.meta, ms: performance.now() - started };
  }
  async login() { this.token = (await this.request('auth:signIn', { account: this.rootEmail, password: this.rootPassword }, '')).data.token; }
  async dispose() {
    try { await this.stop(); } finally {
      if (this.db) { await this.db.end(); this.db = undefined; }
      if (this.created) { this.bootstrap(`DROP DATABASE ${this.database} WITH (FORCE);`); this.created = false; }
      if (this.log !== undefined) { closeSync(this.log); this.log = undefined as any; }
    }
  }
}
