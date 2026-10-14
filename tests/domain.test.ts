import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal, FinanceError, decimal, dateOnly, cddDeadline, replayUnits, canonical } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/values';
import { catalog, collections, fields } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/models';

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
