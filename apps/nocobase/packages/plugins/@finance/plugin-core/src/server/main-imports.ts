import { createHash } from 'node:crypto';
import { Op } from 'sequelize';
import { canonical, cddDeadline, dateOnly, decimal, FinanceError } from '../shared/values';
import { mainImportFields, MainImportField } from '../shared/main-import';
import { FinanceService, uuid } from './service';
import { FinanceOptions } from './options';
import { writeOptions } from './write-scope';

const hash = (value: any) => createHash('sha256').update(canonical(value)).digest('hex');
const errorInfo = (error: FinanceError) => ({ code: error.code, message: error.message, field_path: error.field_path });
const revision = (row: any) => ({ id: row.id, revision: row.get('technical_revision') });
const sorted = (rows: any[]) => rows.map(revision).sort((a, b) => a.id.localeCompare(b.id));
const get = (value: any, key: string) => key.split('.').reduce((item, part) => item?.[part], value);
function set(value: any, key: string, item: any) {
  const parts = key.split('.'); let at = value;
  for (const part of parts.slice(0, -1)) { at[part] = { ...at[part] }; at = at[part]; }
  at[parts[parts.length - 1]] = item;
}
function pick(definitions: MainImportField[], prefix: string, value: any) {
  const out: any = {};
  for (const field of definitions.filter(field => field.key.startsWith(`${prefix}.`))) {
    const key = field.key.slice(prefix.length + 1); const item = get(value, key);
    if (item !== undefined) set(out, key, item);
  }
  return out;
}
function patch(base: any, values: any, prefix: string) {
  const out = { ...base };
  for (const [key, value] of Object.entries(values)) if (key.startsWith(`${prefix}.`)) set(out, key.slice(prefix.length + 1), value);
  return out;
}
function mergeRows(items: any[], prefixes: string[]) {
  const merged: any = {};
  for (const item of items) for (const [key, value] of Object.entries(item.values)) if (prefixes.some(prefix => key.startsWith(`${prefix}.`))) {
    if (key in merged && canonical(merged[key]) !== canonical(value)) throw new FinanceError('CONFLICTING_FUND_FIELD', '同一基金的公共字段在多行中不一致，请修正后再保存', key);
    merged[key] = value;
  }
  return merged;
}

export class MainImports {
  constructor(public service: FinanceService) {}
  decode(batch: any, mapping: any, rows: any[], corrections: any[]) {
    const definitions = mainImportFields(batch.get('data_type'), batch.get('context').fund_kind);
    const headers = batch.get('context').headers;
    if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object' || Object.entries(mapping).some(([key, value]) => !definitions.some(field => field.key === key) || !headers.includes(value))) throw new FinanceError('INVALID_MAPPING', '列映射应对应模板字段和当前文件表头', 'mapping');
    const ids = new Set(rows.map(row => row.id));
    if (!Array.isArray(corrections) || corrections.some(change => !change || Array.isArray(change) || typeof change !== 'object' || !ids.has(change.id) || Object.keys(change).some(key => !['id', 'corrected', 'selected', 'replacement_confirmation'].includes(key))) || new Set(corrections.map(change => change.id)).size !== corrections.length) throw new FinanceError('INVALID_CORRECTION', '修正行无效或不属于本批次');
    const changes = new Map(corrections.map(change => [change.id, change]));
    return rows.map(row => {
      const change: any = changes.get(row.id);
      const corrected = change?.corrected ?? row.get('corrected') ?? {};
      const selected = change?.selected ?? row.get('selected');
      const confirmation = change?.replacement_confirmation ?? row.get('normalized')?.replacement_confirmation ?? null;
      if (typeof selected !== 'boolean' || !corrected || Array.isArray(corrected) || typeof corrected !== 'object' || Object.entries(corrected).some(([key, value]) => !headers.includes(key) || typeof value !== 'string') || confirmation !== null && (typeof confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation))) throw new FinanceError('INVALID_CORRECTION', '修正值须为原列的文本，确认须来自当前清单预览');
      const raw = { ...row.get('raw'), ...corrected }; const values: any = {}; const errors = [];
      for (const field of definitions) {
        const input = mapping[field.key] && raw[mapping[field.key]];
        if (input === undefined || input.trim() === '') continue;
        try {
          let value: any = input.trim() === '#清空' ? null : input === '##清空' ? '#清空' : input;
          if (field.type === 'decimal') value = decimal(value, field.key);
          else if (field.type === 'dateOnly') value = dateOnly(value?.trim() ?? null, field.key);
          else if (field.type === 'multiple') value = value === null ? [] : value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
          else if (!field.key.endsWith('remarks') && field.type !== 'text') value = value?.trim() ?? null;
          values[field.key] = value;
        } catch (error) { if (!(error instanceof FinanceError)) throw error; errors.push(errorInfo(error)); }
      }
      return { row, selected, corrected, values, errors, confirmation, normalized: null, operation: 'insert' };
    });
  }
  async entityGroups(items: any[], transaction: any, definitions: MainImportField[]) {
    const initial = new Map<string, any>(); const clientCodes = new Set<string>();
    for (const item of items) {
      if (item.values.id) {
        const id = uuid(item.values.id, 'id'); item.values.id = id;
        if (initial.has(id)) throw new FinanceError('DUPLICATE_FILE_KEY', '同一主体 ID 在文件中出现多次，请保留一行', 'id');
        const aggregate = await this.service.entityAggregate(id, transaction); initial.set(id, aggregate); clientCodes.add(aggregate.client_code);
      }
      if (item.values.client_code) clientCodes.add(item.values.client_code);
    }
    await this.service.lock([...clientCodes].map(code => `client:${code}`), transaction);
    await this.service.lock([...initial.keys()].map(id => `entity:${id}`), transaction);
    const groups = []; const references = [];
    for (const item of items) {
      const old = initial.get(item.values.id);
      if (old) {
        const current = await this.service.requiredRow('investment_entities', old.entity.id, transaction, true);
        this.service.revision(current, old.entity.technical_revision); references.push(current);
      }
      const payload = {
        ...(old ? { id: old.entity.id, technical_revision: old.entity.technical_revision } : {}),
        client_code: 'client_code' in item.values ? item.values.client_code : old?.client_code,
        entity: patch(pick(definitions, 'entity', old?.entity), item.values, 'entity'),
        agreements: item.values.agreements ?? old?.agreements ?? [], products: item.values.products ?? old?.products ?? [],
      };
      try {
        const checked = await this.service.prepareEntity(payload, transaction);
        payload.entity = checked.values;
        item.normalized = { validated: true, values: item.values, existing_value: old ? { id: old.entity.id, client_code: old.client_code, ...Object.fromEntries(definitions.filter(field => field.key.startsWith('entity.')).map(field => [field.key, get(old, field.key)])), agreements: old.agreements, products: old.products } : null, next_cdd_deadline: cddDeadline(checked.values.latest_cdd_approval_date), replacement_confirmation: item.confirmation };
        const same = old && canonical({ entity: pick(definitions, 'entity', old.entity), client_code: old.client_code, agreements: [...old.agreements].sort(), products: [...old.products].sort() }) === canonical({ entity: checked.values, client_code: payload.client_code, agreements: [...payload.agreements].sort(), products: [...payload.products].sort() });
        item.operation = old ? same ? 'unchanged' : 'overwrite' : 'insert';
        groups.push({ key: item.row.id, items: [item], payload, unchanged: !!same });
      } catch (error) { if (!(error instanceof FinanceError)) throw error; item.errors.push(errorInfo(error)); }
    }
    return { groups, dependencies: { entities: sorted(references) } };
  }
  async fundGroups(batch: any, items: any[], transaction: any, definitions: MainImportField[]) {
    const kind = batch.get('context').fund_kind; const type = batch.get('data_type');
    const isins = new Set<string>(); const before = new Map<string, any>(); const fundIds = new Set<string>();
    for (const item of items) {
      const value = item.values;
      if (value.fund_id) { value.fund_id = uuid(value.fund_id, 'fund_id'); fundIds.add(value.fund_id); }
      for (const key of ['share.isin', 'child_isin']) if (value[key]) isins.add(value[key]);
      if (value.share_id) { value.share_id = uuid(value.share_id, 'share_id'); const share = await this.service.requiredRow('share_classes', value.share_id, transaction); before.set(share.id, share); isins.add(share.get('isin')); fundIds.add(share.get('fund_id')); }
    }
    await this.service.lock([...isins].map(isin => `isin:${isin}`), transaction);
    const matches = await this.service.model('share_classes').findAll({ where: { isin: { [Op.in]: [...isins] } }, ...writeOptions(transaction) });
    for (const share of matches) { if (!before.has(share.id)) before.set(share.id, share); fundIds.add(share.get('fund_id')); }
    const initialFunds = await this.service.model('funds').findAll({ where: { id: { [Op.in]: [...fundIds] } }, ...writeOptions(transaction) });
    for (const fundKind of ['proprietary', 'third_party']) await this.service.lock(initialFunds.filter(row => row.get('fund_kind') === fundKind).map(row => `fund:${row.id}`), transaction);
    const shares = new Map<string, any>();
    for (const [id, prior] of before) { const current = await this.service.requiredRow('share_classes', id, transaction); this.service.revision(current, prior.get('technical_revision')); shares.set(id, current); }
    const fundRows = [];
    for (const id of fundIds) fundRows.push(await this.service.requiredRow('funds', id, transaction));
    const byIsin = new Map([...shares.values()].map(row => [row.get('isin'), row]));
    const grouped = new Map<string, any>();
    for (const item of items) {
      const value = item.values;
      const rowType = value.row_type || (type === 'compositions' ? '成分' : '份额'); item.rowType = rowType;
      if (!['基金资料', '份额', '成分', '清空成分'].includes(rowType) || type === 'compositions' && !['成分', '清空成分'].includes(rowType)) throw new FinanceError('INVALID_ROW_TYPE', '行类型应为基金资料、份额、成分或清空成分', 'row_type');
      if (rowType !== '份额' && Object.keys(value).some(key => key.startsWith('share.') || key.startsWith('terms.') || key === 'share_id')) throw new FinanceError('FIELD_NOT_APPLICABLE', '份额字段只能填写在“份额”行，避免遗漏保存', 'row_type');
      if (!['成分', '清空成分'].includes(rowType) && ['child_isin', 'units', 'remarks', 'valuation_date', 'list_id', 'list_key'].some(key => key in value)) throw new FinanceError('FIELD_NOT_APPLICABLE', '成分字段只能填写在“成分”或“清空成分”行', 'row_type');
      const knownShare = value.share_id ? shares.get(value.share_id) : byIsin.get(value['share.isin']);
      const id = value.fund_id || (!value.fund_key && knownShare?.get('fund_id'));
      if (id && value.fund_key) throw new FinanceError('AMBIGUOUS_FUND', '已有基金使用基金 ID；新基金使用分组键，请勿同时填写', 'fund_key');
      if (!id && (!value.fund_key || type === 'compositions')) throw new FinanceError('FUND_IDENTITY_REQUIRED', '请填写已有基金 ID，或为新基金填写本文件内唯一分组键', 'fund_id');
      if (value.fund_key && knownShare) throw new FinanceError('ISIN_EXISTS', '该 ISIN 已存在，请选择已有基金修改，不能归入新基金', 'share.isin');
      const key = id ? `id:${id}` : `new:${value.fund_key}`;
      if (!grouped.has(key)) grouped.set(key, { key, id, items: [] });
      grouped.get(key).items.push(item);
    }
    const groups = []; const changedShares = new Set<string>(); const changedIsins = new Set<string>(); const usedLists = [];
    for (const group of grouped.values()) {
      try {
        const old = group.id ? await this.service.fundAggregate(group.id, transaction) : null;
        if (old?.fund.is_deleted) throw new FinanceError('RESTORE_REQUIRED', '请先恢复该基金，再导入资料', 'fund_id');
        if (old && old.fund.fund_kind !== kind) throw new FinanceError('WRONG_FUND_KIND', '目标基金类型与本批次不一致', 'fund_id');
        const common = mergeRows(group.items, ['fund', 'details']);
        const payload: any = { ...(old ? { id: old.fund.id, technical_revision: old.fund.technical_revision } : {}), fund_kind: kind,
          fund: patch(pick(mainImportFields('funds', kind), 'fund', old?.fund), common, 'fund'),
          details: patch(pick(mainImportFields('funds', kind), 'details', old?.details), common, 'details'), share_classes: [] };
        for (const item of group.items.filter(item => item.rowType === '份额')) {
          const value = item.values; const existing = value.share_id ? shares.get(value.share_id) : byIsin.get(value['share.isin']);
          const oldClass = existing && old?.share_classes.find(row => row.id === existing.id);
          if (existing && !oldClass) throw new FinanceError('WRONG_PARENT', 'ISIN 或份额 ID 属于其他基金', 'share.isin');
          const values = patch(pick(definitions, 'share', oldClass), value, 'share');
          if (byIsin.has(values.isin) && byIsin.get(values.isin).id !== existing?.id) throw new FinanceError('ISIN_EXISTS', '该 ISIN 已被另一份额使用', 'share.isin');
          const identity = existing?.id || values.isin;
          if (changedShares.has(identity)) throw new FinanceError('DUPLICATE_FILE_KEY', '同一份额或 ISIN 在选中集合出现多次，请保留一行', 'share.isin');
          changedShares.add(identity);
          if (changedIsins.has(values.isin)) throw new FinanceError('DUPLICATE_FILE_KEY', '两个份额不能写入同一 ISIN，请修正识别值', 'share.isin');
          changedIsins.add(values.isin);
          payload.share_classes.push({ ...(oldClass ? { id: oldClass.id } : {}), values, terms: patch(pick(definitions, 'terms', oldClass?.terms), value, 'terms') });
          item.oldClass = oldClass;
        }
        const lists = new Map<string, any>();
        for (const item of group.items.filter(item => ['成分', '清空成分'].includes(item.rowType))) {
          if (kind !== 'proprietary') throw new FinanceError('PROPRIETARY_REQUIRED', '成分清单仅适用于自营基金');
          const value = item.values;
          let existing;
          if (value.list_id) {
            uuid(value.list_id, 'list_id'); existing = old?.compositions.find(row => row.id === value.list_id);
            if (!existing) throw new FinanceError('WRONG_PARENT', '成分清单 ID 不属于当前基金', 'list_id');
          } else if (value.valuation_date) existing = old?.compositions.find(row => row.valuation_date === value.valuation_date);
          const date = 'valuation_date' in value ? value.valuation_date : existing?.valuation_date ?? null;
          if (!existing && !date && !value.list_key) throw new FinanceError('LIST_KEY_REQUIRED', '新清单没有日期时，请填写清单分组键', 'list_key');
          const key = existing?.id || date || `new:${value.list_key}`;
          if (!lists.has(key)) lists.set(key, { id: existing?.id, valuation_date: date, items: [], source: [], existing, clear: false });
          const list = lists.get(key);
          if (list.valuation_date !== date) throw new FinanceError('CONFLICTING_LIST_DATE', '同一清单的估值日期不一致', 'valuation_date');
          list.source.push(item);
          if (item.rowType === '清空成分') {
            if (!existing || value.child_isin || 'units' in value || 'remarks' in value) throw new FinanceError('INVALID_CLEAR', '清空成分须明确指定已有清单，且不填写成分明细');
            list.clear = true;
          } else {
            const share = byIsin.get(value.child_isin);
            if (!share) throw new FinanceError('ISIN_NOT_FOUND', '成分 ISIN 未匹配已有三方份额，请先建立基金份额', 'child_isin');
            const prior = existing?.items.find(row => row.child_share_class_id === share.id);
            item.oldComposition = { list_id: existing?.id ?? null, valuation_date: existing?.valuation_date ?? null, child_isin: prior?.child_isin ?? null, units: prior?.units ?? null, remarks: prior?.remarks ?? null };
            list.items.push({ child_share_class_id: share.id, units: 'units' in value ? value.units : prior?.units ?? null, remarks: 'remarks' in value ? value.remarks : prior?.remarks ?? null });
          }
        }
        if (lists.size) payload.compositions = [...lists.values()].map(list => {
          if (list.clear && list.source.length !== 1) throw new FinanceError('CONFLICTING_CLEAR', '清空清单不能与同组其他行一起提交');
          if (list.existing) usedLists.push(list.existing);
          return { ...(list.id ? { id: list.id } : {}), valuation_date: list.valuation_date, items: list.items };
        });
        const checked = await this.service.prepareFund(payload, transaction);
        payload.fund = checked.fundValues; payload.details = checked.detailValues;
        payload.share_classes = checked.shares.map(row => ({ ...(row.oldClass ? { id: row.oldClass.id } : {}), values: row.classValues, terms: row.termValues }));
        for (const item of group.items) {
          const oldFields = { ...Object.fromEntries(definitions.filter(field => field.key.startsWith('fund.') || field.key.startsWith('details.')).map(field => [field.key, get(old, field.key) ?? null])),
            ...Object.fromEntries(definitions.filter(field => field.key.startsWith('share.') || field.key.startsWith('terms.')).map(field => [field.key, get(field.key.startsWith('share.') ? { share: item.oldClass } : { terms: item.oldClass?.terms }, field.key) ?? null])), ...item.oldComposition };
          item.normalized = { validated: true, values: item.values, existing_value: old ? oldFields : null, target_label: payload.fund.short_name, target_id: old?.fund.id ?? null, group_key: group.key, group_row_count: group.items.length, replacement_confirmation: item.confirmation };
          item.operation = item.rowType === '份额' ? item.oldClass ? 'overwrite' : 'insert' : old ? 'overwrite' : 'insert';
        }
        for (const list of lists.values()) for (const item of list.source) item.operation = list.existing ? 'overwrite' : 'insert';
        for (const list of lists.values()) if (list.existing) {
          const beforeItems = list.existing.items.map(row => ({ child_share_class_id: row.child_share_class_id, units: row.units, remarks: row.remarks ?? null })).sort((a, b) => a.child_share_class_id.localeCompare(b.child_share_class_id));
          const afterItems = [...list.items].sort((a, b) => a.child_share_class_id.localeCompare(b.child_share_class_id));
          if (canonical(beforeItems) === canonical(afterItems) && list.existing.valuation_date === list.valuation_date) continue;
          const token = hash({ fund_revision: old.fund.technical_revision, list_id: list.id, before: beforeItems, after: afterItems, date: list.valuation_date, selected: list.source.map(item => item.row.id).sort() });
          const lead = list.source[0];
          const display = rows => rows.map(row => ({ ...row, isin: shares.get(row.child_share_class_id)?.get('isin') || old.compositions.flatMap(list => list.items).find(item => item.child_share_class_id === row.child_share_class_id)?.child_isin }));
          lead.normalized.list_diff = { before: display(beforeItems), after: display(afterItems), old_date: list.existing.valuation_date, new_date: list.valuation_date };
          lead.normalized.required_confirmation = token;
          if (!list.source.some(item => item.confirmation === token)) lead.errors.push(errorInfo(new FinanceError('COMPOSITION_CONFIRMATION_REQUIRED', '本次会替换该日期的完整成分清单，请核对新增、修改及移除的成分后确认', 'compositions')));
        }
        groups.push({ ...group, payload });
      } catch (error) { if (!(error instanceof FinanceError)) throw error; for (const item of group.items) item.errors.push(errorInfo(error)); }
    }
    return { groups, dependencies: { funds: sorted(fundRows), shares: sorted([...shares.values()]), lists: usedLists.map(row => ({ id: row.id, revision: row.technical_revision })).sort((a, b) => a.id.localeCompare(b.id)), identities: [...isins].sort().map(isin => ({ isin, id: byIsin.get(isin)?.id ?? null })) } };
  }
  async prepare(batch: any, mapping: any, rows: any[], corrections: any[], transaction: any) {
    const items = this.decode(batch, mapping, rows, corrections); const selected = items.filter(item => item.selected);
    let prepared: any = { groups: [], dependencies: null };
    if (selected.length && selected.every(item => !item.errors.length)) try {
      const definitions = mainImportFields(batch.get('data_type'), batch.get('context').fund_kind);
      prepared = batch.get('data_type') === 'entities' ? await this.entityGroups(selected, transaction, definitions) : await this.fundGroups(batch, selected, transaction, definitions);
    } catch (error) { if (!(error instanceof FinanceError)) throw error; for (const item of selected) item.errors.push(errorInfo(error)); }
    return { items, selected, ...prepared };
  }
  async preview(batch: any, mapping: any, corrections: any[], transaction: any) {
    const rows = await this.service.model('import_rows').findAll({ where: { batch_id: batch.id }, order: [['row_index', 'ASC']], ...writeOptions(transaction) });
    const prepared = await this.prepare(batch, mapping, rows, corrections, transaction);
    for (const item of prepared.items) await item.row.update({ corrected: item.corrected, selected: item.selected, normalized: item.normalized || { validated: false, values: item.values, replacement_confirmation: item.confirmation }, errors: item.errors, operation: item.operation }, writeOptions(transaction));
    const valid = prepared.selected.length > 0 && prepared.selected.every(item => !item.errors.length);
    const token = hash(prepared.items.map(item => ({ id: item.row.id, values: item.values, selected: item.selected, normalized: item.normalized })));
    await batch.update({ mapping, status: valid ? 'ready' : 'needs_correction', technical_revision: batch.get('technical_revision') + 1, preview_revision: batch.get('preview_revision') + 1,
      preview: { token, dependencies: prepared.dependencies, rules_revision: await new FinanceOptions(this.service).revision(transaction), selected_count: prepared.selected.length, object_count: prepared.groups.length, error_count: prepared.selected.filter(item => item.errors.length).length } }, writeOptions(transaction));
  }
  async commit(batch: any, transaction: any) {
    const rows = await this.service.model('import_rows').findAll({ where: { batch_id: batch.id }, order: [['row_index', 'ASC']], ...writeOptions(transaction) });
    const prepared = await this.prepare(batch, batch.get('mapping'), rows, [], transaction);
    if (prepared.selected.some(item => item.errors.length) || canonical(prepared.dependencies) !== canonical(batch.get('preview').dependencies)) throw new FinanceError('PREVIEW_STALE', '主数据、识别关系或成分清单已变化，请重新预览并核对', 'batch_id', 409);
    const objects = []; const type = batch.get('data_type');
    for (const group of prepared.groups) {
      if (type === 'entities') {
        const saved = group.unchanged ? { id: group.payload.id } : await this.service.saveEntity(group.payload, transaction);
        objects.push({ type: 'entity', id: saved.id, row_ids: group.items.map(item => item.row.id) });
      } else {
        const saved = await this.service.saveFund(group.payload, transaction);
        objects.push({ type: 'fund', id: saved.fund.id, version_no: saved.fund.business_version, row_ids: group.items.map(item => item.row.id) });
      }
    }
    const result = { batch_id: batch.id, committed_count: prepared.selected.length, object_count: objects.length, record_ids: objects.map(row => row.id), objects,
      inserted_count: prepared.groups.filter(group => !group.payload.id).length,
      overwritten_count: prepared.groups.filter(group => group.payload.id && !group.unchanged).length,
      unchanged_count: prepared.groups.filter(group => group.unchanged).length,
    };
    await batch.update({ status: 'committed', result, technical_revision: batch.get('technical_revision') + 1 }, writeOptions(transaction));
    return result;
  }
}
