import { createHash } from 'node:crypto';
import { canonical, Decimal, FinanceError, replayUnits } from '../shared/values';
import { tradeDuplicateCriteria, tradeImportFields } from '../shared/trade-import';
import { FinanceService, uuid } from './service';
import { FinanceOptions } from './options';
import { writeOptions } from './write-scope';
import { exchangeMapping, exchangeValue, exportColumns } from '../shared/export';

const hash = (value: any) => createHash('sha256').update(canonical(value)).digest('hex');
const keys = (value: any, allowed: string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new FinanceError('FIELD_NOT_WRITABLE', '导入参数包含不可直接写入的字段');
};
const problem = (error: FinanceError) => ({ code: error.code, field_path: error.field_path, message: error.message, details: error.details });
const emptyContext = () => ({ existing: new Map(), guards: [], history: [], shares: [], entities: [], dependencies: null });

/** The preview and commit inspect the same final set, including all edited old accounts. */
function inspectSet(plans: any[], context: any) {
  const replaced = new Set(plans.filter(plan => plan.id).map(plan => plan.id));
  const outside = context.history.filter(row => !replaced.has(row.id));
  const future = [...outside, ...plans.map(plan => ({ ...plan.values, id: plan.id || plan.key }))];
  replayUnits(future);
  const groups = new Map<string, any[]>();
  const add = (key: string, value: any) => { if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(value); };
  for (const row of outside) {
    const key = canonical(tradeDuplicateCriteria(row));
    add(key, { id: row.id, revision: row.technical_revision });
  }
  for (const plan of plans) {
    const key = canonical(tradeDuplicateCriteria(plan.values));
    add(key, { row_id: plan.key, id: plan.id || null, revision: context.existing.get(plan.id)?.get('technical_revision') ?? null });
  }
  const summaries = new Map<string, any>();
  for (const [key, members] of groups) if (members.length > 1) {
    const matches = members.sort((a, b) => canonical(a).localeCompare(canonical(b)));
    summaries.set(key, { token: hash({ criteria: JSON.parse(key), matches }), count: matches.length, matches: matches.slice(0, 20) });
  }
  return new Map(plans.map(plan => {
    return [plan.key, summaries.get(canonical(tradeDuplicateCriteria(plan.values))) || null];
  }));
}

export class TradeImports {
  constructor(public service: FinanceService) {}
  async preview(batch: any, mapping: any, corrections: any[], transaction: any) {
    const headers = batch.get('context').headers;
    const exchange = batch.get('context').exchange;
    const exchangeColumns = exchange && Object.fromEntries(exportColumns('transactions').map(column => [column.key, column.label]));
    keys(mapping, [...tradeImportFields.map(field => field.key), 'fee_rate_mode']);
    if (tradeImportFields.some(field => field.required && !headers.includes(mapping[field.key])) || Object.entries(mapping).some(([key, value]) => key !== 'fee_rate_mode' && value && !headers.includes(value))) throw new FinanceError('MAPPING_REQUIRED', '请为交易必填项选择原文件列，主体使用内部 ID、基金份额使用 ISIN', 'mapping');
    if (mapping.fee_rate && !['percent', 'ratio'].includes(mapping.fee_rate_mode)) throw new FinanceError('VALUE_MODE_REQUIRED', '请确认费率列为百分数还是比例值', 'mapping.fee_rate_mode');
    if (exchange && canonical(mapping) !== canonical(exchangeMapping('transactions'))) throw new FinanceError('EXCHANGE_MAPPING', '交易交换文件使用固定映射及比例费率，不能移除记录 ID 或改用只读列', 'mapping');
    const rows = await this.service.model('import_rows').findAll({ where: { batch_id: batch.id }, order: [['row_index', 'ASC']], ...writeOptions(transaction) });
    const rowIds = new Set(rows.map(row => row.id));
    if (!Array.isArray(corrections) || corrections.some(change => !change || typeof change !== 'object' || Array.isArray(change)) || new Set(corrections.map(change => change.id)).size !== corrections.length || corrections.some(change => !rowIds.has(change.id))) throw new FinanceError('INVALID_CORRECTION', '修正行不属于当前批次或重复指定');
    for (const change of corrections) keys(change, ['id', 'corrected', 'selected', 'duplicate_confirmation']);
    const changes = new Map(corrections.map(change => [change.id, change]));
    if (exchange) await this.service.lock(rows.flatMap(row => {
      const change: any = changes.get(row.id); if (!(change?.selected ?? row.get('selected'))) return [];
      const raw = { ...row.get('raw'), ...(change?.corrected ?? row.get('corrected') ?? {}) };
      try { return [`trade:${uuid(exchangeValue(raw[mapping.id]), 'id')}`]; } catch { return []; }
    }), transaction);
    const prepared: any[] = [];
    for (const row of rows) {
      const change: any = changes.get(row.id);
      const corrected = change?.corrected ?? row.get('corrected') ?? {};
      const selected = change?.selected ?? row.get('selected');
      const confirmation = change && 'duplicate_confirmation' in change ? change.duplicate_confirmation : row.get('normalized')?.duplicate_confirmation ?? null;
      if (typeof selected !== 'boolean' || !corrected || Array.isArray(corrected) || typeof corrected !== 'object' || Object.entries(corrected).some(([key, value]) => !headers.includes(key) || typeof value !== 'string') || confirmation !== null && (typeof confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation))) throw new FinanceError('INVALID_CORRECTION', '修正值必须对应原列并保留文本，重复确认应来自当前预览');
      const raw = { ...row.get('raw'), ...corrected };
      const item: any = { row, corrected, selected, errors: [], normalized: { values: null, duplicate_confirmation: confirmation, required_confirmation: null, warnings: [] } };
      try {
        const cells: any = Object.fromEntries(tradeImportFields.map(field => [field.key, mapping[field.key] ? exchange ? exchangeValue(raw[mapping[field.key]]) : raw[mapping[field.key]]?.trim() ?? '' : '']));
        const id = cells.id ? uuid(cells.id, 'id') : null;
        if (exchange && !id) throw new FinanceError('EXCHANGE_ID_REQUIRED', '交换文件必须保留交易 ID；新增交易请使用录入模板', 'id');
        const share = await this.service.model('share_classes').findOne({ where: { isin: cells.isin }, ...writeOptions(transaction) });
        if (!share) throw new FinanceError('ISIN_NOT_FOUND', 'ISIN 未对应已有份额，请先建立基金份额或修正 ISIN', 'isin');
        if (exchange && exchangeValue(raw[exchangeColumns.share_class_id]) !== share.id) throw new FinanceError('RECORD_ID_MISMATCH', '份额 ID 与 ISIN 不一致，请核对导出记录的关联标识', 'share_class_id');
        const { id: unusedId, isin, ...values } = cells;
        values.share_class_id = share.id;
        if (values.fee_rate && mapping.fee_rate_mode === 'percent') {
          const literal = values.fee_rate.replace(/%$/, '');
          if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(literal)) throw new FinanceError('INVALID_PERCENT', '费率应为百分数，例如 2 或 2%', 'fee_rate');
          values.fee_rate = new Decimal(literal).times('0.01').toFixed();
        }
        const existing = exchange ? await this.service.requiredRow('transactions', id, transaction) : null;
        if (existing && exchangeValue(raw[exchangeColumns.is_void]) !== String(existing.get('is_void'))) throw new FinanceError('EXCHANGE_STATE_MISMATCH', '撤销状态与当前记录不一致；交换导入不能改变撤销状态，请重新导出核对', 'is_void');
        const original = existing ? Object.fromEntries(Object.keys(values).map(key => [key, existing.get(key) ?? null])) : null;
        // Exact verification performs no business write, so a retired option must
        // not force historical facts to change merely to pass current entry rules.
        const normalized = existing && canonical(original) === canonical(values) ? original : await this.service.normalizeTrade(values, transaction);
        item.normalized = { ...item.normalized, id, isin, values: normalized, expected_revision: null, existing_value: null };
        if (exchange) {
          const old = Object.fromEntries(Object.keys(normalized).map(key => [key, existing.get(key) ?? null]));
          const unchanged = canonical(old) === canonical(normalized);
          if (existing.get('is_void') && !unchanged) throw new FinanceError('TRADE_VOIDED', '已撤销交易只允许核对原值，不能通过交换导入修改或恢复', 'id');
          Object.assign(item.normalized, { exchange_unchanged: unchanged, expected_revision: existing.get('technical_revision'), existing_value: old, existing_isin: unchanged ? isin : null });
          if (unchanged) { item.operation = 'unchanged'; item.normalized.warnings.push(existing.get('is_void') ? '已撤销交易：仅核对，不恢复、不改写来源。' : '与原记录一致：仅核对，不新增交易或改写来源。'); }
        }
        if (normalized.currency !== share.get('currency')) item.normalized.warnings.push('交易币种与份额币种不同；保留原金额，不推测汇率');
        if (normalized.confirmed_nav !== null && !new Decimal(normalized.amount).eq(new Decimal(normalized.confirmed_units).times(normalized.confirmed_nav))) item.normalized.warnings.push('金额与份额 × 确认净值不同；保留独立填写的金额');
      } catch (error) {
        if (!(error instanceof FinanceError)) throw error;
        item.errors.push(problem(error));
      }
      prepared.push(item);
    }
    const selected = prepared.filter(item => item.selected);
    const byId = new Map<string, any[]>();
    for (const item of selected) if (item.normalized.id) byId.set(item.normalized.id, [...(byId.get(item.normalized.id) || []), item]);
    for (const group of byId.values()) if (group.length > 1) for (const item of group) item.errors.push(problem(new FinanceError('DUPLICATE_FILE_KEY', '同一交易 ID 在文件中出现多次，请明确保留一行', 'id')));
    let dependencies = null;
    if (selected.length && selected.every(item => item.errors.length === 0)) {
      const changed = selected.filter(item => !item.normalized.exchange_unchanged);
      const plans = changed.map(item => ({ key: item.row.id, ...item.normalized }));
      try {
        const context = plans.length ? await this.service.tradeSetContext(plans, transaction) : emptyContext();
        dependencies = exchange ? { context: context.dependencies, verified: selected.filter(item => item.normalized.exchange_unchanged).map(item => ({ id: item.normalized.id, revision: item.normalized.expected_revision })).sort((a, b) => a.id.localeCompare(b.id)) } : context.dependencies;
        for (const item of changed) {
          const old = context.existing.get(item.normalized.id);
          item.normalized.expected_revision = old?.get('technical_revision') ?? null;
          item.normalized.existing_value = old ? Object.fromEntries(Object.keys(item.normalized.values).map(key => [key, old.get(key)])) : null;
          item.normalized.existing_isin = old ? context.shares.find(share => share.id === old.get('share_class_id'))?.get('isin') ?? null : null;
          item.operation = !old ? 'insert' : canonical(item.normalized.existing_value) === canonical(item.normalized.values) ? 'unchanged' : 'overwrite';
        }
        const duplicates = inspectSet(plans, context);
        for (const item of changed) {
          const duplicate: any = duplicates.get(item.row.id);
          if (!duplicate) continue;
          item.normalized.required_confirmation = duplicate.token;
          item.normalized.duplicate_matches = duplicate.matches;
          item.normalized.duplicate_count = duplicate.count;
          if (item.normalized.duplicate_confirmation !== duplicate.token) item.errors.push(problem(new FinanceError('DUPLICATE_TRADE', '疑似重复交易：请核对已有记录和本文件行，确认确为独立交易后继续', 'values')));
        }
      } catch (error) {
        if (!(error instanceof FinanceError)) throw error;
        // A history error can originate in an existing later trade, so include
        // the affected batch rows even when their own dates are earlier.
        for (const item of selected) {
          const related = !error.details?.account_key || [item.normalized.values, item.normalized.existing_value].some(value => value && `${value.entity_id}:${value.share_class_id}` === error.details.account_key);
          if (related && (!error.details?.row_id || error.details.row_id === item.row.id)) item.errors.push(problem(error));
        }
      }
    }
    for (const item of prepared) await item.row.update({ corrected: item.corrected, selected: item.selected, normalized: item.normalized, errors: item.errors, operation: item.operation || (item.normalized.id ? 'overwrite' : 'insert') }, writeOptions(transaction));
    const valid = selected.length > 0 && selected.every(item => item.errors.length === 0);
    await batch.update({ mapping, status: valid ? 'ready' : 'needs_correction', technical_revision: batch.get('technical_revision') + 1, preview_revision: batch.get('preview_revision') + 1,
      preview: { token: hash(prepared.map(item => ({ id: item.row.id, normalized: item.normalized, selected: item.selected }))), rules_revision: await new FinanceOptions(this.service).revision(transaction), dependencies, selected_count: selected.length, error_count: selected.filter(item => item.errors.length).length } }, writeOptions(transaction));
  }
  async commit(batch: any, transaction: any) {
    const rows = await this.service.model('import_rows').findAll({ where: { batch_id: batch.id, selected: true }, order: [['row_index', 'ASC']], ...writeOptions(transaction) });
    const exchange = batch.get('context').exchange;
    const plans = rows.filter(row => !row.get('normalized').exchange_unchanged).map(row => ({ key: row.id, ...row.get('normalized') }));
    let context;
    let dependencies;
    try {
      if (exchange) await this.service.lock(rows.map(row => `trade:${row.get('normalized').id}`), transaction);
      context = plans.length ? await this.service.tradeSetContext(plans, transaction) : emptyContext();
      const verified = [];
      if (exchange) for (const row of rows.filter(row => row.get('normalized').exchange_unchanged)) {
        const current = await this.service.requiredRow('transactions', row.get('normalized').id, transaction);
        verified.push({ id: current.id, revision: current.get('technical_revision') });
      }
      dependencies = exchange ? { context: context.dependencies, verified: verified.sort((a, b) => a.id.localeCompare(b.id)) } : context.dependencies;
    }
    catch (error) { if (!(error instanceof FinanceError)) throw error; throw new FinanceError('PREVIEW_STALE', `关联资料或交易已变化，请重新预览：${error.message}`, 'batch_id', 409); }
    if (canonical(dependencies) !== canonical(batch.get('preview').dependencies)) throw new FinanceError('PREVIEW_STALE', exchange ? '核对记录、关联资料或持仓历史已变化，请重新预览' : '关联资料或持仓历史已变化，请重新预览', 'batch_id', 409);
    const duplicates = inspectSet(plans, context);
    for (const plan of plans) if (duplicates.get(plan.key)?.token !== undefined && duplicates.get(plan.key)?.token !== plan.duplicate_confirmation) throw new FinanceError('PREVIEW_STALE', '疑似重复交易集合已变化，请重新预览并确认', 'batch_id', 409);
    const ids: string[] = [];
    let inserted = 0, overwritten = 0, unchanged = 0;
    const touched = new Set<string>();
    for (const row of rows) {
      const normalized = row.get('normalized');
      if (normalized.exchange_unchanged) { ids.push(normalized.id); unchanged++; continue; }
      const existing = context.existing.get(normalized.id);
      if (row.get('operation') === 'unchanged') { ids.push(existing.id); unchanged++; continue; }
      const saved = await this.service.persistTrade(normalized.values, existing, transaction, { batch_id: batch.id, sheet: row.get('source_sheet'), row: row.get('source_row') });
      ids.push(saved.id); existing ? overwritten++ : inserted++;
      for (const value of [normalized.values, ...(existing ? [normalized.existing_value] : [])]) touched.add(`${value.entity_id}:${value.share_class_id}`);
    }
    for (const guard of context.guards) if (touched.has(`${guard.get('entity_id')}:${guard.get('share_class_id')}`)) await guard.increment('write_revision', writeOptions(transaction));
    const result = { batch_id: batch.id, committed_count: ids.length, record_ids: ids, inserted_count: inserted, overwritten_count: overwritten, unchanged_count: unchanged };
    await batch.update({ status: 'committed', result, technical_revision: batch.get('technical_revision') + 1 }, writeOptions(transaction));
    return result;
  }
}
