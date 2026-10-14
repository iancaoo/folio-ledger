import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { sampleFund } from './fixtures';

async function main() {
  const credentials = JSON.parse(readFileSync('.runtime/dev-credentials.json', 'utf8'));
  let token = '';
  async function request(resource: string, data?: any) {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:13000/api/${resource}`, { method: data ? 'POST' : 'GET', headers: {
      'Content-Type': 'application/json', 'X-Authenticator': 'basic', ...(token ? { Authorization: `Bearer ${token}`, 'X-Role': 'root' } : {}),
    }, body: data ? JSON.stringify(data) : undefined });
    const body = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body.errors)}`);
    return { data: body.data, ms: performance.now() - started };
  }
  token = (await request('auth:signIn', { account: credentials.admin_email, password: credentials.admin_password })).data.token;
  if (!(await request('finance:metadata')).data.demo_mode) throw new Error('Benchmark requires explicit demo mode');
  const saved = await request('finance:saveFund', { ...sampleFund(`BENCH-${Date.now()}`), request_key: randomUUID() });
  const fund = (await request(`finance:fund?id=${saved.data.fund_id}`)).data;
  const rows = ['日期,数值'];
  for (let i = 0; i < 10000; i++) {
    const date = new Date(Date.UTC(1990, 0, 1 + i)).toISOString().slice(0, 10);
    rows.push(`${date},123456789012345.12345678`);
  }
  const content = Buffer.from(rows.join('\n'));
  const started = performance.now();
  const stage = await request('finance:stageImport', { request_key: randomUUID(), original_name: '模拟一万行净值.csv', data_type: 'nav', share_class_id: fund.share_classes[0].id, content_base64: content.toString('base64') });
  let parsed: any;
  for (let i = 0; i < 300; i++) {
    parsed = (await request(`finance:importBatch?id=${stage.data.batch_id}`)).data;
    if (!['parsing', 'awaiting_file'].includes(parsed.batch.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (parsed.batch.status !== 'staged') throw new Error('Import did not finish parsing');
  const parseReady = performance.now() - started;
  const preview = await request('finance:previewImport', { request_key: randomUUID(), batch_id: stage.data.batch_id, technical_revision: parsed.batch.technical_revision, mapping: { date: '日期', value: '数值' } });
  if (preview.data.status !== 'ready') throw new Error(`Unexpected preview state: ${preview.data.status}`);
  const report = { at: new Date().toISOString(), platform: 'NocoBase 2.2.24', host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model, memory_gib: Math.round(os.totalmem() / 1024 ** 3) },
    rows: 10000, bytes: content.length, stage_ack_ms: Math.round(stage.ms), parse_ready_ms: Math.round(parseReady), preview_ms: Math.round(preview.ms), preview_target_ms: 30000, preview_target_met: preview.ms <= 30000,
    note: 'Single sample on local demo server. This does not cover 100k trades, 300k series rows, five sessions or P95 targets.', batch_id: stage.data.batch_id };
  writeFileSync('docs/verification/M4导入基准.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
