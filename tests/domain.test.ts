import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal, FinanceError, decimal, dateOnly, cddDeadline, replayUnits, canonical } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/values';
import { catalog, collections, fields } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/models';
import { findingTargets } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/report/targets';
import { renderChecks } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/report/render';
import { traceLeafTarget } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/trace-source';
import type { Finding } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/report/checks';
import { findingFingerprint, findingKey, noteRequired, reviewGate } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/report-review';
import { compareReports } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/server/report/compare';
import { FinanceError as ReportError } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/values';

const trade = (id: string, type: string, units: string, date = '2026-08-01') => ({
  id, entity_id: 'entity-1', share_class_id: 'class-1', confirmation_date: date,
  transaction_type: type, confirmed_units: units,
});

test('domain: subscription 100, redemption 30, NAV 1.25', () => {
  const units = replayUnits([trade('1', '初次申购', '100'), trade('2', '赎回', '30', '2026-08-02')]);
  assert.equal(units['entity-1:class-1'], '70');
  assert.equal(new Decimal(units['entity-1:class-1']).times('1.25').toFixed(2), '87.50');
});
test('domain: voiding initial subscription cannot leave a later redemption', () => {
  assert.throws(() => replayUnits([
    { ...trade('1', '初次申购', '100'), is_void: true }, trade('2', '赎回', '30', '2026-08-02'),
  ]), (error: FinanceError) => error.code === 'NEGATIVE_HISTORICAL_UNITS' && error.details?.conflict_date === '2026-08-02');
});
test('domain: a later subscription cannot repair an earlier negative date', () => {
  assert.throws(() => replayUnits([
    trade('1', '追加申购', '100', '2026-08-03'), trade('2', '赎回', '30', '2026-08-02'),
  ]), (error: FinanceError) => error.details?.conflict_date === '2026-08-02');
});
test('domain: same-day aggregation is independent of file row order', () => {
  const records = [trade('1', '赎回', '30'), trade('2', '初次申购', '100')];
  assert.deepEqual(replayUnits(records), replayUnits([...records].reverse()));
  assert.equal(replayUnits(records)['entity-1:class-1'], '70');
});
test('domain: investment entities never share their balances', () => {
  assert.throws(() => replayUnits([
    trade('1', '初次申购', '100'), { ...trade('2', '赎回', '30'), entity_id: 'entity-2' },
  ]), (error: FinanceError) => error.details?.account_key === 'entity-2:class-1');
});
test('domain: decimal facts and arithmetic never use binary floats', () => {
  assert.equal(new Decimal('0.1').plus('0.2').toFixed(), '0.3');
  assert.throws(() => decimal(0.1, 'amount'), (error: FinanceError) => error.code === 'DECIMAL_STRING_REQUIRED');
  assert.equal(decimal('000.1200', 'amount'), '0.12');
  assert.equal(decimal('0', 'amount'), '0');
  assert.equal(decimal('', 'amount'), null);
});
test('domain: high precision facts, multiplication and addition remain exact', () => {
  const amount = '123456789012345.12345678';
  assert.equal(decimal(amount, 'amount'), amount);
  assert.equal(new Decimal(amount).plus('0.00000001').toFixed(), '123456789012345.12345679');
  assert.equal(new Decimal(amount).times('0.00000001').toFixed(), '1234567.8901234512345678');
  for (const bad of ['NaN', 'Infinity', '-Infinity', '0xff', '1e20', 'n/a']) assert.throws(() => decimal(bad, 'amount'));
  assert.throws(() => decimal('1.12345', 'confirmed_nav', { scale: 4 }));
  assert.equal(decimal('1.2500', 'confirmed_nav', { scale: 4 }), '1.25');
  for (const bad of ['0', '-1']) assert.throws(() => decimal(bad, 'confirmed_units', { positive: true }));
});
test('business dates are actual calendar dates, including leap years', () => {
  assert.equal(dateOnly('2024-02-29', 'date'), '2024-02-29');
  for (const bad of ['2023-02-29', '2026-02-30', '2026-13-01', 'Hold', '0000-01-01']) assert.throws(() => dateOnly(bad, 'date'));
  assert.equal(dateOnly(null, 'date'), null);
});
test('domain: EDATE +36 months then minus one day, with month-end clamping', () => {
  assert.equal(cddDeadline('2024-02-29'), '2027-02-27');
  assert.equal(cddDeadline('2026-10-13'), '2029-10-12');
  assert.equal(cddDeadline('2026-01-01'), '2028-12-31');
  assert.equal(cddDeadline(null), null);
});
test('request fingerprint canonicalization preserves content and ignores object key order', () => {
  assert.equal(canonical({ b: ['1', '2'], a: '0.1' }), canonical({ a: '0.1', b: ['1', '2'] }));
  assert.notEqual(canonical({ a: '1' }), canonical({ a: '2' }));
});
test('mapping layer: all 161 source rows are retained; disputed text fields remain text', () => {
  assert.equal(catalog.fields.length, 161);
  assert.equal(new Set(catalog.fields.map(f => f.source_key)).size, 161);
  assert.equal(fields.proprietary_fund_details.find(f => f.name === 'cash_balance_text')!.type, 'text');
  assert.equal(fields.third_party_class_terms.find(f => f.name === 'management_fee_text')!.type, 'text');
  assert.equal(fields.transactions.find(f => f.name === 'amount')!.type, 'decimal');
  assert.equal(fields.transactions.find(f => f.name === 'entity_id')!.allowNull, false);
  assert.equal(fields.transactions.find(f => f.name === 'share_class_id')!.allowNull, false);
  assert.ok(collections.every(c => c.createdBy === false && c.updatedBy === false));
  assert.ok(!fields.funds.some(f => f.name === 'nav_per_unit'));
});

const jumpDs = {
  asOf: '2026-08',
  refs: {
    funds: {
      示例基金A: { fund_id: '00000000-0000-4000-8000-0000000000a1', share_class_id: '00000000-0000-4000-8000-0000000000b1', fund_kind: 'proprietary', currency: 'USD' },
      示例基金B: { fund_id: '00000000-0000-4000-8000-0000000000a2', share_class_id: '00000000-0000-4000-8000-0000000000b2', fund_kind: 'third_party', currency: 'USD' },
    },
    benchmarks: { 示例基准: '00000000-0000-4000-8000-0000000000c1' },
  },
  returnSelections: { 示例基金A: { '2026-08': [{ used: true, date: '2026-08-28' }] } },
} as any;
const entity = '00000000-0000-4000-8000-0000000000e1';
const jump = (code: string, extra: Partial<Finding> = {}) => findingTargets(jumpDs, entity, { level: '警告', category: '测试', title: '示例', detail: '', suggestion: '', fund: '示例基金A', month: '2026年8月', code, loc: { month: '2026-08' }, ...extra });

test('domain: every finding code maps to the record it came from', () => {
  assert.deepEqual(jump('RECON_MISMATCH').map(item => item.target.kind), ['nav', 'return', 'trades']);
  assert.equal((jump('RECON_MISMATCH')[1].target as any).date, '2026-08-28');
  assert.deepEqual(jump('ESTIMATE_MONTH', { fund: '', loc: { month: '2026-07', funds: ['示例基金A'] } }).map(item => item.label), ['示例基金A：替换为实际值']);
  assert.deepEqual(jump('ESTIMATE_MONTH', { fund: '', loc: { month: '2026-08', funds: ['示例基金B'] } }).map(item => item.label), ['示例基金B：录入收益率']);
  assert.equal(jump('ESTIMATE_MONTH', { fund: '', loc: { month: '2026-08', funds: Array.from({ length: 12 }, () => '示例基金A') } }).length, 10);
  assert.equal(jump('RETURN_UNLABELED', { loc: { month: '2026-08', date: '2026-08-15' } })[0].label, '补填估算标记');
  assert.equal((jump('RETURN_NOT_MONTH_END', { loc: { month: '2026-08', date: '2026-08-15' } })[0].target as any).date, '2026-08-15');
  assert.equal(jump('ESTIMATE_STALE')[0].label, '替换为实际值');
  assert.equal(jump('ESTIMATE_POINT')[0].label, '录入收益率');
  assert.equal(jump('BIG_MOVE')[0].target.kind, 'return');
  assert.equal(jump('DATA_MISSING')[0].label, '补录净值');
  assert.equal(jump('DATA_MISSING', { fund: '示例基金B' })[0].label, '录入收益率');
  assert.deepEqual(jump('TAG_MISSING', { loc: { field: 'strategy', source_key: 'fund_strategy' } })[0].target, { kind: 'options', source_key: 'fund_strategy' });
  assert.deepEqual(jump('TAG_NOT_ALLOWED', { loc: { field: 'strategy' } })[0].target, { kind: 'fund', fund_id: '00000000-0000-4000-8000-0000000000a1', field: 'strategy' });
  assert.deepEqual(jump('BENCHMARK_GAP', { fund: '示例基准', loc: { month: '2026-07', benchmark: '示例基准' } })[0].target, { kind: 'benchmark', benchmark_id: '00000000-0000-4000-8000-0000000000c1', date: '2026-07-31' });
  assert.equal(jump('CURRENCY_MIXED', { fund: '' })[0].target.kind, 'positions');
  for (const code of ['RECON_SYSTEMATIC', 'TOTAL_WEIGHT', 'TOTAL_ALLOC', 'PROVENANCE_DEMO', 'PROVENANCE_DERIVED']) assert.deepEqual(jump(code), []);
  assert.deepEqual(jump(''), []);
});

test('domain: trace leaves resolve through stored row ids', () => {
  const refs = {
    share_classes: { '00000000-0000-4000-8000-0000000000b1': { fund_id: '00000000-0000-4000-8000-0000000000a1' } },
    fund_navs: { nav1: { share_class_id: '00000000-0000-4000-8000-0000000000b1', fund_id: '00000000-0000-4000-8000-0000000000a1', date: '2026-08-31' } },
    fund_returns: { ret1: { share_class_id: '00000000-0000-4000-8000-0000000000b1', date: '2026-08-28' } },
  };
  assert.deepEqual(traceLeafTarget({ table: 'finance_fund_navs', id: 'nav1' }, entity, refs), { kind: 'nav', fund_id: '00000000-0000-4000-8000-0000000000a1', share_class_id: '00000000-0000-4000-8000-0000000000b1', date: '2026-08-31' });
  assert.deepEqual(traceLeafTarget({ table: 'finance_fund_returns', id: 'ret1' }, entity, refs), { kind: 'return', share_class_id: '00000000-0000-4000-8000-0000000000b1', date: '2026-08-28' });
  assert.deepEqual(traceLeafTarget({ table: 'finance_transactions', id: 't1' }, entity, refs), { kind: 'trades', entity_id: entity });
  assert.deepEqual(traceLeafTarget({ table: 'finance_benchmark_values', id: '00000000-0000-4000-8000-0000000000c1', date: '2026-08-31' }, entity, refs), { kind: 'benchmark', benchmark_id: '00000000-0000-4000-8000-0000000000c1', date: '2026-08-31' });
  assert.deepEqual(traceLeafTarget({ table: 'finance_funds', id: '00000000-0000-4000-8000-0000000000a1', col: 'strategy' }, entity, refs), { kind: 'fund', fund_id: '00000000-0000-4000-8000-0000000000a1', field: 'strategy' });
  assert.equal(traceLeafTarget({ table: 'finance_funds', id: '00000000-0000-4000-8000-0000000000a1', col: 'name' }, entity, refs), null);
  assert.equal(traceLeafTarget({}, entity, refs), null);
});

test('domain: extra finding fields do not change the check report', () => {
  const base = { level: '错误' as const, category: '数据缺失', title: '示例基金A 2026年8月：缺少收益率和净值', detail: '说明', suggestion: '补录数据。', fund: '示例基金A', month: '2026年8月' };
  const ds = { client: '示例主体', asOf: '2026-08' } as any;
  const res = { ytd: 0.01, irr: 0.02, totalNav: { '2026-08': 100 } } as any;
  const plain = renderChecks(ds, res, [base], [['数据缺失', 1]]);
  const extra = renderChecks(ds, res, [{ ...base, code: 'DATA_MISSING', loc: { month: '2026-08' }, targets: [{ label: '补录净值', target: { kind: 'nav' } }] } as any], [['数据缺失', 1]]);
  assert.equal(plain, extra);
});

test('domain: finding reviews block publish only for open errors and needs-fix', () => {
  const error = { level: '错误', category: '数据缺失', title: '示例基金A 2026年8月：缺少数据', detail: '说明', suggestion: '', fund: '示例基金A', month: '2026年8月' };
  const warning = { level: '警告', category: '基金标签', title: '示例基金A：标签不合规', detail: '', suggestion: '', fund: '示例基金A', month: '' };
  const keyed = [error, warning].map((item, index) => ({ ...item, key: findingKey(index, item) }));
  assert.equal(findingKey(0, error), findingKey(0, { ...error }));
  assert.notEqual(findingKey(0, error), findingKey(1, error));
  assert.equal(noteRequired('错误', 'confirmed'), true);
  assert.equal(noteRequired('警告', 'confirmed'), false);
  assert.equal(noteRequired('警告', 'not_applicable'), true);
  assert.equal(reviewGate(keyed, null, '').blockers.map(item => item.code).join(','), 'REVIEW_INCOMPLETE,REVIEW_NOTE_REQUIRED');
  const confirmed = { items: { [keyed[0].key]: { status: 'confirmed' as const } } };
  assert.equal(reviewGate(keyed, confirmed, '').blockers[0].code, 'REVIEW_NOTE_REQUIRED');
  assert.equal(reviewGate(keyed, confirmed, '已核对').ok, true);
  const fixing = { items: { [keyed[1].key]: { status: 'needs_fix' as const }, [keyed[0].key]: { status: 'confirmed' as const } } };
  assert.equal(reviewGate(keyed, fixing, '已核对').blockers[0].code, 'REVIEW_NEEDS_FIX');
  assert.equal(findingFingerprint({ ...error, code: 'DATA_MISSING', loc: { date: '2026-08-31' } }), 'DATA_MISSING|示例基金A|2026年8月|2026-08-31');
  assert.equal(findingFingerprint({ ...error, title: '示例 12 项' }), '数据缺失|示例基金A|2026年8月|示例 # 项');
});

function compareRun(id: string, extra: any = {}) {
  return {
    id, entity_id: '00000000-0000-4000-8000-0000000000e1', report_month: '2026-08', status: 'ready', created_at: '2026-10-01',
    engine_version: 'finance-report/2', benchmark_ids: null, snapshot_sha256: 'same', summary: { currency: 'USD', ytd: 0.1, irr: 0.2, total_nav: 100, total_invested: 80, months: [{ month: '2026-08', nav: 100, flow: 0, return: 0.01 }], funds: [{ key: '示例基金A', weight: 1, nav: 100, invested: 80, ytd: 0.1 }] },
    findings: [], finding_reviews: { items: {} }, snapshot: { share_classes: [], transactions: [], fund_navs: [], fund_returns: [], benchmark_values: [] }, ...extra,
  };
}
test('domain: report compare matches leaves by record identity', () => {
  const leaf = (id: string, src: any, value: number, batch = 'b1') => ({ op: 'leaf', label: id, value, src: { ...src, batch, row: 1 } });
  const baseTrace = { schema: 'return-report.trace/v1', outputs: { ytd: 'out' }, nodes: { out: { op: 'sum', label: 'YTD', value: 0.1 }, a: leaf('a', { table: 'finance_transactions', id: 't1', col: 'amount' }, 10), b: leaf('b', { table: 'finance_transactions', id: 't2', col: 'amount' }, 20) } };
  const headTrace = { schema: 'return-report.trace/v1', outputs: { ytd: 'out' }, nodes: { out: { op: 'sum', label: 'YTD', value: 0.2 }, shifted: leaf('shifted', { table: 'finance_transactions', id: 't1', col: 'amount' }, 10), inserted: leaf('inserted', { table: 'finance_transactions', id: 't9', col: 'amount' }, 5), b: leaf('b', { table: 'finance_transactions', id: 't2', col: 'amount' }, 20, 'b2') } };
  const compared = compareReports(compareRun('base', { trace: baseTrace, findings: [{ level: '警告', category: '数据缺失', title: '示例 1', detail: '', suggestion: '', fund: '示例基金A', month: '' }] }), compareRun('head', { status: 'published', trace: headTrace, summary: { currency: 'USD', ytd: 0.2, irr: 0.2, total_nav: 100, total_invested: 80, months: [], funds: [] } }));
  assert.equal(compared.data.source, 'trace');
  assert.deepEqual(compared.data.leaves.map(item => item.change).sort(), ['added', 'source']);
  assert.equal(compared.metrics[0].key, 'ytd');
  assert.equal(compared.findings.removed.length, 1);
  assert.equal(compared.funds[0].change, 'removed');
  const missing = compareReports(compareRun('base', { trace: null, snapshot: { transactions: [{ id: 't1', confirmation_date: '2026-08-01', amount: 1 }] } }), compareRun('head', { trace: null, snapshot: { transactions: [{ id: 't1', confirmation_date: '2026-08-01', amount: 2 }, { id: 't2', confirmation_date: '2026-09-01', amount: 9 }] } }));
  assert.equal(missing.data.reason, 'both_no_trace');
  assert.deepEqual(missing.data.leaves.map(item => item.change), ['value']);
  const one = compareReports(compareRun('base', { trace: null }), compareRun('head', { trace: headTrace }));
  assert.equal(one.data.reason, 'base_no_trace');
  const mismatch = compareReports(compareRun('base', { trace: { ...baseTrace, schema: 'old' } }), compareRun('head', { trace: headTrace }));
  assert.equal(mismatch.data.reason, 'schema_mismatch');
  assert.throws(() => compareReports(compareRun('base', { entity_id: 'other' }), compareRun('head')), (error: ReportError) => error.code === 'COMPARE_SCOPE');
});
