import { createHash } from 'node:crypto';
import { Op } from 'sequelize';
import { canonical, Decimal, FinanceError } from '../shared/values';
import { seriesImportFields, seriesValueField } from '../shared/series-import';
import { FinanceService, uuid } from './service';
import { FinanceOptions } from './options';
import { writeOptions } from './write-scope';
import { exchangeMapping, exchangeValue } from '../shared/export';

const digest = (value: any) => createHash('sha256').update(canonical(value)).digest('hex');
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
const detail = (error: FinanceError) => ({ code: error.code, message: error.message, field_path: error.field_path });

export class SeriesImports {
  constructor(public service: FinanceService) {}
  async prepare(batch: any, mapping: any, corrections: any[], transaction: any) {
    const type = batch.get('data_type'); const context = batch.get('context');
    const mode = context.target_mode || 'single';
    const definitions = seriesImportFields(type, mode);
    const allowed = [...definitions.map(field => field.key), ...(type === 'returns' ? ['value_mode'] : [])];
    if (!object(mapping) || Object.keys(mapping).some(key => !allowed.includes(key))) throw new FinanceError('FIELD_NOT_WRITABLE', '映射包含不适用于当前导入模式的字段', 'mapping');
    if (definitions.some(field => field.required && !context.headers.includes(mapping[field.key])) || Object.entries(mapping).some(([key, value]) => key !== 'value_mode' && (typeof value !== 'string' || !context.headers.includes(value)))) throw new FinanceError('MAPPING_REQUIRED', '请为日期、数值及对象选择原文件中的有效列', 'mapping');
    if (type === 'returns' && !['percent', 'ratio'].includes(mapping.value_mode)) throw new FinanceError('VALUE_MODE_REQUIRED', '请确认收益列是百分数还是比例值', 'mapping.value_mode');
    if (context.exchange && canonical(mapping) !== canonical(exchangeMapping(context.exchange.table))) throw new FinanceError('EXCHANGE_MAPPING', '交换文件使用固定字段映射及比例值。只读字段不能映射为业务事实，记录 ID 不能移除', 'mapping');
    const mappedColumns = definitions.flatMap(field => mapping[field.key] ? [mapping[field.key]] : []);
    if (new Set(mappedColumns).size !== mappedColumns.length) throw new FinanceError('AMBIGUOUS_MAPPING', '同一列不能同时作为不同业务字段，请核对映射', 'mapping');
    const [table, parent, date] = this.service.seriesConfig(type); const valueField = seriesValueField(type);
    const rows = await this.service.model('import_rows').findAll({ where: { batch_id: batch.id }, order: [['row_index', 'ASC']], ...writeOptions(transaction) });
    const rowIds = new Set(rows.map(row => row.id));
    if (!Array.isArray(corrections) || corrections.some(change => !object(change) || !rowIds.has(change.id) || Object.keys(change).some(key => !['id', 'corrected', 'selected'].includes(key))) || new Set(corrections.map(change => change.id)).size !== corrections.length) throw new FinanceError('INVALID_CORRECTION', '修正行必须唯一并属于当前批次', 'corrections');
    const changes = new Map(corrections.map(change => [change.id, change]));
    const prepared: any[] = rows.map(row => {
      const change = changes.get(row.id); const corrected = change?.corrected ?? row.get('corrected') ?? {};
      const selected = change?.selected ?? row.get('selected');
      if (typeof selected !== 'boolean' || !object(corrected) || Object.entries(corrected).some(([key, value]) => !context.headers.includes(key) || typeof value !== 'string')) throw new FinanceError('INVALID_CORRECTION', '修正值必须对应原始列，并保留文本格式', 'corrections');
      let raw = { ...row.get('raw'), ...corrected }; const errors = [];
      if (context.exchange) {
        try { raw = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, exchangeValue(value as string)])); }
        catch (error) { if (!(error instanceof FinanceError)) throw error; errors.push(detail(error)); }
      }
      return { row, corrected, selected, raw, errors, warnings: [], normalized: null, existing: null };
    });
    // Identity locks precede aggregate locks, as in fund imports. A matching name is never an identity.
    const isins = mode === 'columns' && type !== 'benchmark' ? [...new Set(prepared.map(item => item.raw[mapping.isin]?.trim()).filter(Boolean))] as string[] : [];
    await this.service.lock(isins.map(isin => `isin:${isin}`), transaction);
    const shares = isins.length ? await this.service.model('share_classes').findAll({ where: { isin: { [Op.in]: isins } }, ...writeOptions(transaction) }) : [];
    const shareByIsin = new Map<string, any>(shares.map(row => [row.get('isin'), row]));
    for (const item of prepared) {
      try {
        item.suppliedId = mapping.id && item.raw[mapping.id]?.trim() ? uuid(item.raw[mapping.id].trim(), 'id') : null;
        if (context.exchange && !item.suppliedId) throw new FinanceError('EXCHANGE_ID_REQUIRED', '交换文件必须保留记录 ID。新增记录请使用录入模板', 'id');
        item.isin = mode === 'columns' && type !== 'benchmark' ? item.raw[mapping.isin]?.trim() : null;
        item.parentId = mode === 'single' ? context[parent] : type === 'benchmark' ? uuid(item.raw[mapping.benchmark_id]?.trim(), 'benchmark_id') : shareByIsin.get(item.isin)?.id;
        if (!item.parentId) throw new FinanceError('IDENTITY_NOT_FOUND', 'ISIN 未匹配到已有份额，请修正或先建立份额', 'isin');
        uuid(item.parentId, parent);
      } catch (error) { if (!(error instanceof FinanceError)) throw error; item.errors.push(detail(error)); }
    }
    const references = await this.service.seriesParents(type, prepared.flatMap(item => item.parentId ? [item.parentId] : []), transaction);
    const keys = new Map<string, any[]>();
    for (const item of prepared) {
      if (item.errors.length) continue;
      try {
        const reference = references.get(item.parentId);
        this.service.checkSeriesParent(type, reference);
        if (item.isin && item.isin !== reference.record.get('isin')) throw new FinanceError('PREVIEW_STALE', 'ISIN 对应的份额已变化，请重新预览', 'isin', 409);
        let value = item.raw[mapping.value]?.trim();
        if (type === 'returns' && mapping.value_mode === 'percent') {
          value = value?.replace(/%$/, '');
          if (!value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new FinanceError('INVALID_PERCENT', '请填写百分数，例如 2 或 2%', valueField);
          value = new Decimal(value.replace(/^\+/, '')).times('0.01').toFixed();
        }
        const input: any = { [parent]: item.parentId, [date]: item.raw[mapping.date], [valueField]: value };
        // A missing estimate column means unknown, including on overwrite. Never retain an old formal label silently.
        if (type === 'returns') input.estimate_label = mapping.estimate ? item.raw[mapping.estimate] : null;
        item.values = await this.service.normalize(table, input, transaction);
        item.targetLabel = type === 'benchmark' ? reference.record.get('name') : `${reference.fund.get('short_name')} · ${reference.record.get('isin')} · ${reference.record.get('currency')}`;
        item.key = `${item.parentId}:${item.values[date]}`;
        if (item.selected) keys.set(item.key, [...(keys.get(item.key) || []), item]);
      } catch (error) { if (!(error instanceof FinanceError)) throw error; item.errors.push(detail(error)); }
    }
    const normalized = prepared.filter(item => item.values);
    await this.service.lock(normalized.map(item => `series:${table}:${item.key}`), transaction);
    const existingRows = normalized.length ? await this.service.model(table).findAll({ where: { [parent]: { [Op.in]: [...new Set(normalized.map(item => item.parentId))] }, [date]: { [Op.in]: [...new Set(normalized.map(item => item.values[date]))] } }, ...writeOptions(transaction) }) : [];
    const byKey = new Map(existingRows.map(row => [`${row.get(parent)}:${row.get(date)}`, row]));
    for (const item of normalized) {
      const existing: any = byKey.get(item.key); item.existing = existing;
      if (item.suppliedId && item.suppliedId !== existing?.id) item.errors.push({ code: 'RECORD_ID_MISMATCH', message: '记录 ID 与对象、日期不一致，或原记录已被删除。不能把带 ID 的行作为另一条新记录导入', field_path: 'id' });
      const old = existing ? Object.fromEntries(Object.keys(item.values).map(key => [key, existing.get(key) ?? null])) : null;
      item.operation = !existing ? 'insert' : canonical(old) === canonical(item.values) ? 'unchanged' : 'overwrite';
      if (type === 'returns') {
        if (existing?.get('estimate_label') === '否' && item.values.estimate_label !== '否') item.warnings.push(item.values.estimate_label === '是' ? '将把正式值覆盖为预估值，请核对。' : '将把正式值覆盖为未分类值，请核对。');
        if (!['是', '否'].includes(item.values.estimate_label)) item.warnings.push('估算标记未填写或尚未分类，保留原值；后续报告不能自动按正式值使用。');
      }
      if (item.values[date] > new Date().toISOString().slice(0, 10)) item.warnings.push('日期在未来，不参与当前持仓估值。');
      item.normalized = { values: item.values, expected_revision: existing?.get('technical_revision') ?? null, existing_id: existing?.id ?? null, existing_value: existing?.get(valueField) ?? null,
        existing_values: old, isin: type === 'benchmark' ? null : references.get(item.parentId).record.get('isin'), target_label: item.targetLabel, warnings: item.warnings };
    }
    for (const duplicate of keys.values()) if (duplicate.length > 1) for (const item of duplicate) item.errors.push({ code: 'DUPLICATE_FILE_KEY', message: '同对象同日存在多行，请明确取消选择或修正冲突行', field_path: date });
    const selected = prepared.filter(item => item.selected);
    const referenceIds = [...new Set(selected.filter(item => item.values).map(item => item.parentId))].sort();
    const dependencies = { parents: referenceIds.map(id => {
      const { record, fund } = references.get(id);
      return { id, revision: record.get('technical_revision'), fund_id: fund?.id ?? null, fund_revision: fund?.get('technical_revision') ?? null };
    }), targets: selected.filter(item => item.values).map(item => ({ key: item.key, id: item.existing?.id ?? null, revision: item.existing?.get('technical_revision') ?? null })).sort((a, b) => a.key.localeCompare(b.key)) };
    return { prepared, selected, dependencies, table, parent, valid: selected.length > 0 && selected.every(item => !item.errors.length) };
  }
  async preview(batch: any, mapping: any, corrections: any[], transaction: any) {
    const state = await this.prepare(batch, mapping, corrections, transaction);
    for (const item of state.prepared) await item.row.update({ corrected: item.corrected, selected: item.selected, normalized: item.normalized, errors: item.errors, operation: item.operation || null }, writeOptions(transaction));
    await batch.update({ mapping, status: state.valid ? 'ready' : 'needs_correction', technical_revision: batch.get('technical_revision') + 1, preview_revision: batch.get('preview_revision') + 1,
      preview: { series_version: 1, token: digest({ dependencies: state.dependencies, mapping, rows: state.prepared.map(item => ({ id: item.row.id, selected: item.selected, values: item.values || null })) }),
        rules_revision: await new FinanceOptions(this.service).revision(transaction), dependencies: state.dependencies, selected_count: state.selected.length,
        error_count: state.selected.filter(item => item.errors.length).length, warning_count: state.selected.filter(item => item.warnings.length).length } }, writeOptions(transaction));
  }
  async commit(batch: any, transaction: any) {
    const state = await this.prepare(batch, batch.get('mapping'), [], transaction);
    const preview = batch.get('preview');
    if (!state.valid || preview.series_version !== 1 || canonical(preview.dependencies) !== canonical(state.dependencies)) throw new FinanceError('PREVIEW_STALE', '关联对象或同日记录已变化，请重新预览并核对旧值', 'batch_id', 409);
    const result = { batch_id: batch.id, committed_count: state.selected.length, inserted_count: 0, overwritten_count: 0, unchanged_count: 0, record_ids: [] as string[] };
    for (const item of state.selected) {
      let id = item.existing?.id;
      if (item.operation !== 'unchanged') {
        const saved = await this.service.saveSeries({ data_type: batch.get('data_type'), values: item.values, expected_revision: item.normalized.expected_revision }, transaction); id = saved.id;
        await this.service.model(state.table).update({ source_batch_id: batch.id, source_sheet: item.row.get('source_sheet'), source_row: item.row.get('source_row') }, { where: { id }, ...writeOptions(transaction) });
      }
      result.record_ids.push(id);
      result[item.operation === 'insert' ? 'inserted_count' : item.operation === 'overwrite' ? 'overwritten_count' : 'unchanged_count']++;
    }
    await batch.update({ status: 'committed', result, technical_revision: batch.get('technical_revision') + 1 }, writeOptions(transaction));
    return result;
  }
}
