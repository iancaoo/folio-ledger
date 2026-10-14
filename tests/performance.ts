import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';
import { IsolatedApp } from './isolated-app';
import { sampleEntity, sampleFund } from './fixtures';

const app = new IsolatedApp();
const samples: Record<string, number[]> = {};
const record = (name: string, ms: number) => (samples[name] ||= []).push(ms);
const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => Math.round(sorted[Math.ceil(sorted.length * p) - 1]);
  return { samples: sorted.length, p50_ms: at(0.5), p95_ms: at(0.95), max_ms: at(1) };
};
async function main() {
  const started = Date.now(); let browser: any;
  try {
    await app.create(); await app.command('install', '--lang', 'zh-CN'); await app.start(); await app.login();
    assert.equal((await app.request('finance:metadata')).data.demo_mode, true);
    console.log('Isolated instance installed; preparing synthetic master data.');
    const owner = (await app.db!.query('SELECT id FROM users WHERE email=$1', [app.rootEmail])).rows[0].id;
    const shares: string[] = []; const entities: string[] = []; const sessions: string[] = [];
    for (let i = 0; i < 20; i++) {
      const input = sampleFund(`PERF-${i}`); input.details.coverage_owner_user_id = String(owner);
      input.share_classes = Array.from({ length: 5 }, (_, j) => ({ values: { ...input.share_classes[0].values, isin: `PERF-${i}-${j}`, class_label: String(j) }, terms: { ...input.share_classes[0].terms } }));
      const saved = (await app.request('finance:saveFund', { ...input, request_key: randomUUID() })).data;
      shares.push(...(await app.request(`finance:fund?id=${saved.fund_id}`)).data.share_classes.map(row => row.id));
    }
    for (let i = 0; i < 100; i++) entities.push((await app.request('finance:saveEntity', { ...sampleEntity(`PERF-${Math.floor(i / 5)}`, `性能-${i}`), request_key: randomUUID() })).data.id);
    for (let i = 0; i < 5; i++) {
      const username = `perf-${i}`; const password = randomBytes(24).toString('hex');
      await app.request('users:create', { username, nickname: `模拟性能会话 ${i + 1}`, password, roles: [{ name: 'finance_editor' }] });
      sessions.push((await app.request('auth:signIn', { account: username, password }, '')).data.token);
    }
    await app.stop();
    assert.match(app.database, /^finance_verify_/); // Large SQL fixtures are confined to the disposable DB.
    await app.db!.query(`INSERT INTO finance_transactions (id,entity_id,share_class_id,transaction_type,confirmation_date,confirmed_units,amount,currency,confirmed_nav,is_void,technical_revision,created_at,updated_at)
      SELECT gen_random_uuid(),e.id,($2::uuid[])[((e.ord::integer-1)*10+slot)%100+1],CASE WHEN day%2=0 THEN '追加申购' ELSE '赎回' END,
        DATE '2018-01-01'+day,CASE WHEN day%2=0 THEN 100 ELSE 30 END,CASE WHEN day%2=0 THEN 125 ELSE 37.5 END,'USD',1.25,false,1,
        TIMESTAMPTZ '2026-01-01 00:00:00Z'+(e.ord*1000+slot*100+day)*INTERVAL '1 second',NOW()
      FROM unnest($1::uuid[]) WITH ORDINALITY e(id,ord) CROSS JOIN generate_series(0,9) slot CROSS JOIN generate_series(0,99) day`, [entities, shares]);
    await app.db!.query(`INSERT INTO finance_fund_navs (id,share_class_id,nav_date,nav_per_unit,technical_revision,created_at,updated_at)
      SELECT gen_random_uuid(),s.id,DATE '2018-01-01'+day,1.25+day::numeric/1000000,1,
        TIMESTAMPTZ '2026-01-01 00:00:00Z'+(s.ord*3000+day)*INTERVAL '1 second',NOW()
      FROM unnest($1::uuid[]) WITH ORDINALITY s(id,ord) CROSS JOIN generate_series(0,2999) day`, [shares]);
    await app.db!.query('ANALYZE');
    const counts = (await app.db!.query('SELECT (SELECT count(*)::int FROM finance_transactions) AS transactions,(SELECT count(*)::int FROM finance_fund_navs) AS navs')).rows[0];
    assert.deepEqual(counts, { transactions: 100000, navs: 300000 });
    await app.start();
    console.log('Seeded 100,000 trades / 300,000 NAVs. Measuring five authenticated editor sessions.');
    // Twenty measured rounds per session; no successful response is excluded.
    await Promise.all(sessions.map(async (token, session) => {
      const request = (action: string, body?: any) => app.request(`finance:${action}`, body, token, 'finance_editor');
      const operations = [
        ['http_trade_list', 'list?table=transactions&page_size=10&order=newest'],
        ['http_nav_list', 'list?table=fund_navs&page_size=10&order=newest'],
        ['http_entity_positions', `positionList?entity_id=${entities[session]}&as_of=2026-10-14&page_size=10`],
        ['http_all_positions', 'positionList?as_of=2026-10-14&page_size=10'],
      ];
      for (const [, action] of operations) await request(action); // One disclosed warm-up per read.
      for (let round = 0; round < 20; round++) {
        for (const [name, action] of operations) { const response = await request(action); assert.equal(response.data.length ?? response.data.rows?.length, 10); record(name, response.ms); }
        const trade = await request('saveTrade', { request_key: randomUUID(), values: { entity_id: entities[session], share_class_id: shares[session * 10], confirmation_date: '2026-10-14', transaction_type: '追加申购', confirmed_units: String(round + 1), amount: String(round + 1), currency: 'USD' } });
        assert.ok(trade.data.id); record('http_trade_save', trade.ms);
        const date = new Date(Date.UTC(2010, 0, 1 + round)).toISOString().slice(0, 10);
        const nav = await request('saveSeries', { request_key: randomUUID(), data_type: 'nav', expected_revision: null, values: { share_class_id: shares[session], nav_date: date, nav_per_unit: '1.234567890123456789' } });
        assert.ok(nav.data.id); record('http_nav_save', nav.ms);
      }
    }));
    console.log('HTTP read/save samples completed; measuring five concurrent 10,000-row previews.');
    await Promise.all(sessions.map(async (token, session) => {
      const request = (action: string, body?: any) => app.request(`finance:${action}`, body, token, 'finance_editor');
      const rows = ['日期,单位净值', ...Array.from({ length: 10000 }, (_, i) => `${new Date(Date.UTC(1980, 0, i + 1)).toISOString().slice(0, 10)},123456789012345.12345678`)];
      const start = performance.now();
      const upload = await request('stageImport', { request_key: randomUUID(), original_name: '模拟性能一万行.csv', data_type: 'nav', share_class_id: shares[session], content_base64: Buffer.from(rows.join('\n')).toString('base64') });
      record('http_import_ack', upload.ms);
      let view: any;
      for (let i = 0; i < 600; i++) { view = (await request(`importBatch?id=${upload.data.batch_id}`)).data; if (!['parsing', 'awaiting_file'].includes(view.batch.status)) break; await new Promise(done => setTimeout(done, 100)); }
      assert.equal(view.batch.status, 'staged'); assert.equal(view.rows.length, 10000); record('import_parse_ready', performance.now() - start);
      const preview = await request('previewImport', { request_key: randomUUID(), batch_id: view.batch.id, technical_revision: view.batch.technical_revision, mapping: { date: '日期', value: '单位净值' } });
      assert.equal(preview.data.status, 'ready'); record('http_import_preview', preview.ms);
    }));
    console.log('Preview samples completed; measuring five real browser sessions and table rendering.');
    browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const pageErrors: string[] = [];
    await Promise.all(sessions.map(async (token, session) => {
      const page = await browser.newPage({ viewport: { width: 1500, height: 1050 }, reducedMotion: 'reduce', storageState: { cookies: [], origins: [{ origin: app.origin, localStorage: [{ name: 'NOCOBASE_TOKEN', value: token }, { name: 'NOCOBASE_ROLE', value: 'finance_editor' }, { name: 'NOCOBASE_AUTH', value: 'basic' }, { name: 'NOCOBASE_LOCALE', value: 'zh-CN' }] }] } });
      page.on('pageerror', error => pageErrors.push(error.message));
      const ready = async (table: string) => {
        const node = page.locator(`[data-finance-table="${table}"]`);
        await node.locator('.ant-table-row').first().waitFor(); await node.locator('.ant-spin-spinning').waitFor({ state: 'hidden' });
        await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        return node;
      };
      const opening = performance.now(); await page.goto(`${app.origin}/admin/finance`); await ready('funds'); record('browser_cold_application', performance.now() - opening);
      for (const [tab, table, name] of [['申赎录入', 'transactions', 'trade_list'], ['净值与收益', 'fund_navs', 'nav_list'], ['持仓核对', 'positionList', 'positions']]) {
        const entry = performance.now(); await page.getByRole('tab', { name: tab, exact: true }).click(); const node = await ready(table); record(`browser_first_${name}`, performance.now() - entry);
        for (let round = 0; round < 20; round++) {
          const response = page.waitForResponse(r => table === 'positionList' ? r.url().includes('finance:positionList') : r.url().includes('finance:list') && new URL(r.url()).searchParams.get('table') === table);
          const start = performance.now(); await node.getByRole('button', { name: '刷新列表', exact: true }).click(); assert.equal((await response).status(), 200); await ready(table); record(`browser_refresh_${name}`, performance.now() - start);
        }
        if (session === 0 && table === 'transactions') await node.screenshot({ path: 'docs/verification/M5十万交易列表.png', animations: 'disabled' });
      }
      await page.close();
    }));
    assert.deepEqual(pageErrors, []);
    const metrics = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
      const measure = summary(values); const target = name === 'http_import_preview' ? 30000 : name.includes('parse_ready') || name === 'browser_cold_application' ? null : 2000;
      return [name, { ...measure, target_p95_ms: target, target_met: target === null ? null : measure.p95_ms <= target }];
    }));
    const report = { executed_at: new Date().toISOString(), duration_ms: Date.now() - started, simulated: true, isolated_database: true, isolated_storage: true,
      environment: { platform: 'NocoBase 2.2.24', plugin: JSON.parse(readFileSync('apps/nocobase/packages/plugins/@finance/plugin-core/package.json', 'utf8')).version, node: process.version, postgres: (await app.db!.query('SHOW server_version')).rows[0].server_version,
        os: os.platform(), arch: os.arch(), cpu_model: os.cpus()[0].model, logical_cpus: os.cpus().length, memory_gib: Math.round(os.totalmem() / 1024 ** 3) },
      scale: { ...counts, funds: 20, share_classes: 100, entities: 100, accounts: 1000, trades_per_account: 100, concurrent_sessions: 5, added_measured_trades: 100, added_measured_navs: 100 }, metrics,
      passed: Object.values(metrics).every((metric: any) => metric.target_met !== false), page_errors: pageErrors,
      method: ['五个独立录入员账号，每会话顺序请求，同时运行；每项读写 100 个测量样本', '每个 HTTP 读取在计时前各预热一次；保存没有预热', '一万行预览五份文件同时开始，五个样本的 P95 等于最大值；不将其解释为长期容量结论', '浏览器使用五个独立 Chrome 上下文，首次应用打开单独记录；列表首次进入各五个样本，刷新到渲染完成各一百个样本', 'P95 使用最近秩法；时间包含 localhost HTTP 往返，浏览器项另包含布局与两次 animation frame', '大规模数据通过隔离库 SQL 夹具准备，测量中的写入全部经过真实 Finance HTTP 领域动作', '这是当前单机与分布的技术基准，不能外推为生产网络、冷启动或任意单账户交易规模的保证'],
      source_sha256: Object.fromEntries(['tests/performance.ts','tests/isolated-app.ts','apps/nocobase/packages/plugins/@finance/plugin-core/src/server/queries.ts','apps/nocobase/packages/plugins/@finance/plugin-core/src/server/service.ts'].map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])) };
    writeFileSync('docs/verification/M5性能验证.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ passed: report.passed, metrics }, null, 2));
    assert.ok(report.passed, 'Performance target missed; inspect M5性能验证.json before accepting.');
  } finally { if (browser) await browser.close(); await app.dispose(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
