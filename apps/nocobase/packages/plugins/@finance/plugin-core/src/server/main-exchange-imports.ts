import { createHash } from 'node:crypto';
import { Op } from 'sequelize';
import { canonical, dateOnly, decimal, FinanceError } from '../shared/values';
import { exchangeMainTables, exchangeMapping, exchangeValue, exportColumns } from '../shared/export';
import { FinanceService, uuid } from './service';
import { FinanceOptions } from './options';
import { writeOptions } from './write-scope';

const hash = (value: any) => createHash('sha256').update(canonical(value)).digest('hex');
const plain = (row: any) => row.get({ plain: true });
const errorInfo = (error: FinanceError) => ({ code: error.code, message: error.message, field_path: error.field_path });
const fundTables = new Set(['funds', 'share_classes', 'third_party_fund_details', 'proprietary_fund_details', 'third_party_class_terms', 'proprietary_class_terms', 'composition_snapshots', 'composition_items']);
const choicesTables = new Set(['entity_agreements', 'entity_products']);

/** A business exchange updates existing IDs. It never treats omitted rows as deletions. */
export class MainExchangeImports {
  constructor(public service: FinanceService) {}
  patchSource(table: string, current: any, facts: any, kind?: string) {
    const result = this.service.sourceValues(table, current, kind);
    for (const [key, value] of Object.entries(facts)) {
      if (Object.hasOwn(result, key)) result[key] = value;
      else if (canonical(value) !== canonical(current[key] ?? null)) throw new FinanceError('FIELD_NOT_APPLICABLE', '此字段不适用于当前基金类型', key);
    }
    return result;
  }
  decode(batch: any, mapping: any, rows: any[], corrections: any[]) {
    const table = batch.get('context').exchange?.table;
    if (!exchangeMainTables.includes(table)) throw new FinanceError('EXCHANGE_REQUIRED', '请选择有效的主数据交换文件');
    if (canonical(mapping) !== canonical(exchangeMapping(table))) throw new FinanceError('EXCHANGE_MAPPING', '交换文件使用固定字段映射，不能将只读列映射成业务事实', 'mapping');
    const columns = exportColumns(table); const headers = batch.get('context').headers;
    const ids = new Set(rows.map(row => row.id));
    if (!Array.isArray(corrections) || corrections.some(change => !change || Array.isArray(change) || typeof change !== 'object' || !ids.has(change.id) || Object.keys(change).some(key => !['id', 'corrected', 'selected', 'replacement_confirmation'].includes(key))) || new Set(corrections.map(change => change.id)).size !== corrections.length) throw new FinanceError('INVALID_CORRECTION', '修正行无效或不属于本批次');
    const changes = new Map(corrections.map(change => [change.id, change]));
    return rows.map(row => {
      const change: any = changes.get(row.id); const corrected = change?.corrected ?? row.get('corrected') ?? {};
      const selected = change?.selected ?? row.get('selected');
      const confirmation = change?.replacement_confirmation ?? row.get('normalized')?.replacement_confirmation ?? null;
      if (typeof selected !== 'boolean' || !corrected || Array.isArray(corrected) || typeof corrected !== 'object' || Object.entries(corrected).some(([key, value]) => !headers.includes(key) || typeof value !== 'string') || confirmation !== null && (typeof confirmation !== 'string' || !/^[a-f0-9]{64}$/.test(confirmation))) throw new FinanceError('INVALID_CORRECTION', '修正须为原列文本，确认须来自本次预览');
      const raw = { ...row.get('raw'), ...corrected }; const values: any = {}; const facts: any = {}; const errors = [];
      for (const column of columns) try {
        let value: any = exchangeValue(raw[column.label] ?? '');
        if (column.role === 'fact') {
          if (column.type === 'decimal') value = decimal(value, column.key);
          if (column.type === 'dateOnly') value = dateOnly(value, column.key);
          if (column.type === 'json' && value !== null) {
            try { value = JSON.parse(value); } catch { throw new FinanceError('INVALID_COMPOSITE', '复合字段须保留 JSON 对象及原数值、单位', column.key); }
          }
          facts[column.key] = value;
        }
        values[column.key] = value;
      } catch (error) { if (!(error instanceof FinanceError)) throw error; errors.push(errorInfo(error)); }
      if (!values.id) errors.push(errorInfo(new FinanceError('EXCHANGE_ID_REQUIRED', '交换文件须保留已有记录 ID；新增记录请使用录入模板', 'id')));
      return { row, values, facts, selected, corrected, confirmation, errors, normalized: null, operation: 'unchanged', record: null, target: null };
    });
  }
  async prepare(batch: any, mapping: any, rows: any[], corrections: any[], transaction: any) {
    const table = batch.get('context').exchange?.table; const items = this.decode(batch, mapping, rows, corrections);
    const selected = items.filter(item => item.selected); const groups = []; const references = new Map<string, any>();
    const remember = (name: string, row: any) => {
      const key = `${name}:${row.id}`; const before = references.get(key);
      if (before && canonical(before) !== canonical(plain(row))) throw new FinanceError('PREVIEW_STALE', '读取期间关联资料已变化，请重新预览', 'batch_id', 409);
      references.set(key, plain(row)); return row;
    };
    const read = async (name: string, id: string) => remember(name, await this.service.requiredRow(name, uuid(id, 'id'), transaction));
    if (selected.length && selected.every(item => !item.errors.length)) try {
      const seen = new Set<string>(); const fundIds = new Set<string>(); const entityIds = new Set<string>();
      if (table === 'client_groups' && new Set(selected.map(item => item.facts.client_code)).size !== selected.length) throw new FinanceError('CLIENT_CODE_EXISTS', '两个客户分组不能改为同一客户编号', 'client_code');
      const clients = new Set<string>(); const isins = new Set<string>(); const documentIds = []; const benchmarkIds = [];
      const targets = new Map<string, any>();
      for (const item of selected) {
        const id = uuid(item.values.id, 'id'); item.values.id = id;
        if (seen.has(id)) throw new FinanceError('DUPLICATE_FILE_KEY', '同一记录 ID 在选中集合中重复，请保留一行', 'id');
        seen.add(id); item.record = await read(table, id);
        for (const column of exportColumns(table).filter(column => column.role === 'identity' && column.key !== 'id')) {
          if (item.values[column.key] !== item.record.get(column.key)) throw new FinanceError('RECORD_ID_MISMATCH', '记录的固定关联或基金类型已改变，请保留原标识并核对当前记录', column.key);
        }
        for (const key of ['is_deleted', 'deleting']) if (Object.hasOwn(item.values, key) && item.values[key] !== String(item.record.get(key))) throw new FinanceError('EXCHANGE_STATE_MISMATCH', '交换文件不能更改删除或停用状态，请核对当前状态', key);
        if (fundTables.has(table)) {
          let fundId = table === 'funds' ? id : item.record.get('fund_id');
          if (table.endsWith('_class_terms')) fundId = (await read('share_classes', item.record.get('share_class_id'))).get('fund_id');
          if (table.startsWith('composition_')) {
            const list = table === 'composition_snapshots' ? item.record : await read('composition_snapshots', item.record.get('snapshot_id'));
            fundId = list.get('parent_fund_id');
            for (const child of await this.service.model('composition_items').findAll({ where: { snapshot_id: list.id }, ...writeOptions(transaction) })) {
              remember('composition_items', child);
              fundIds.add((await read('share_classes', child.get('child_share_class_id'))).get('fund_id'));
            }
          }
          item.target = fundId; fundIds.add(fundId);
          if (table === 'share_classes' || table.endsWith('_class_terms')) {
            const share = table === 'share_classes' ? item.record : await read('share_classes', item.record.get('share_class_id'));
            isins.add(share.get('isin')); isins.add(table === 'share_classes' ? item.facts.isin : share.get('isin'));
          }
        } else if (table === 'investment_entities' || choicesTables.has(table)) {
          item.target = table === 'investment_entities' ? id : item.record.get('entity_id'); entityIds.add(item.target);
        } else {
          item.target = id;
          if (table === 'client_groups') { clients.add(item.record.get('client_code')); clients.add(item.facts.client_code); }
          if (table === 'benchmarks') benchmarkIds.push(id);
          if (table === 'fund_documents') { documentIds.push(id); fundIds.add(item.record.get('fund_id')); }
        }
        if (!targets.has(item.target)) targets.set(item.target, { id: item.target, items: [] });
        targets.get(item.target).items.push(item);
      }
      for (const id of entityIds) {
        const entity = await read('investment_entities', id); const group = await read('client_groups', entity.get('client_group_id'));
        clients.add(group.get('client_code'));
      }
      // Same hierarchy as hand entry: identities, entities, proprietary parents,
      // third-party children. All keys of each kind are acquired as one sorted set.
      await this.service.lock(documentIds.map(id => `document:${id}`), transaction);
      await this.service.lock([...isins].map(isin => `isin:${isin}`), transaction);
      await this.service.lock([...clients].map(code => `client:${code}`), transaction);
      if (table === 'client_groups') for (const item of selected) for (const entity of await this.service.model('investment_entities').findAll({ where: { client_group_id: item.target }, ...writeOptions(transaction) })) {
        remember('investment_entities', entity); entityIds.add(entity.id);
      }
      await this.service.lock([...entityIds].map(id => `entity:${id}`), transaction);
      const funds = [];
      for (const id of fundIds) funds.push(await read('funds', id));
      for (const kind of ['proprietary', 'third_party']) await this.service.lock(funds.filter(row => row.get('fund_kind') === kind).map(row => `fund:${row.id}`), transaction);
      await this.service.lock(benchmarkIds.map(id => `benchmark:${id}`), transaction);
      for (const [key, before] of references) {
        const current = await this.service.requiredRow(key.split(':')[0], before.id, transaction);
        if (canonical(plain(current)) !== canonical(before)) throw new FinanceError('PREVIEW_STALE', '读取期间关联资料已变化，请重新预览', 'batch_id', 409);
      }
      // ISIN absence is a dependency too: another fund can claim a new ISIN after preview.
      const identities = [...isins].sort(); const matches = await this.service.model('share_classes').findAll({ where: { isin: { [Op.in]: identities } }, ...writeOptions(transaction) });
      for (const row of matches) remember('share_classes', row);
      for (const group of targets.values()) try {
        for (const item of group.items) {
          const old = plain(item.record);
          item.operation = this.service.sameValues(table, old, item.facts) ? 'unchanged' : 'overwrite';
          item.normalized = { validated: true, values: item.facts, existing_value: old, target_id: group.id, group_row_count: group.items.length, replacement_confirmation: item.confirmation };
        }
        const same = group.items.every(item => item.operation === 'unchanged');
        if (fundTables.has(table)) {
          const old = await this.service.fundAggregate(group.id, transaction); const kind = old.fund.fund_kind;
          const payload: any = { id: group.id, technical_revision: old.fund.technical_revision, fund_kind: kind, fund: this.service.sourceValues('funds', old.fund, kind), details: this.service.sourceValues(`${kind}_fund_details`, old.details, kind), share_classes: [] };
          let archived = old.fund.is_deleted;
          for (const item of group.items) {
            item.normalized.target_label = old.fund.short_name;
            if (table === 'funds') payload.fund = this.patchSource('funds', old.fund, item.facts, kind);
            else if (table.endsWith('_fund_details')) payload.details = this.patchSource(table, old.details, item.facts, kind);
            else if (table === 'share_classes' || table.endsWith('_class_terms')) {
              const share = old.share_classes.find(share => share.id === (table === 'share_classes' ? item.record.id : item.record.get('share_class_id')));
              archived ||= share.is_deleted;
              const values = this.service.sourceValues('share_classes', share, kind); const terms = this.service.sourceValues(`${kind}_class_terms`, share.terms, kind);
              if (table === 'share_classes') {
                const match = matches.find(row => row.get('isin') === item.facts.isin && row.id !== share.id);
                if (match || selected.some(other => other !== item && other.facts.isin === item.facts.isin)) throw new FinanceError('ISIN_EXISTS', '该 ISIN 已被另一份额使用', 'isin');
              }
              payload.share_classes.push({ id: share.id, values: table === 'share_classes' ? this.patchSource('share_classes', share, item.facts, kind) : values, terms: table.endsWith('_class_terms') ? this.patchSource(table, share.terms, item.facts, kind) : terms });
            }
          }
          if (table.startsWith('composition_')) {
            const lists = new Map<string, any>();
            for (const item of group.items) {
              const listId = table === 'composition_snapshots' ? item.record.id : item.record.get('snapshot_id');
              if (!lists.has(listId)) {
                const before = old.compositions.find(list => list.id === listId);
                lists.set(listId, { before, source: [], after: { id: listId, valuation_date: before.valuation_date, items: before.items.map(child => ({ child_share_class_id: child.child_share_class_id, units: child.units, remarks: child.remarks })) } });
              }
              const list = lists.get(listId); list.source.push(item);
              archived ||= list.before.items.some(child => {
                const share = references.get(`share_classes:${child.child_share_class_id}`);
                return share.is_deleted || references.get(`funds:${share.fund_id}`).is_deleted;
              });
              if (table === 'composition_snapshots') list.after.valuation_date = item.facts.valuation_date;
              else Object.assign(list.after.items.find(child => child.child_share_class_id === item.record.get('child_share_class_id')), item.facts);
            }
            payload.compositions = [...lists.values()].map(list => list.after);
            for (const list of lists.values()) {
              const before = list.before.items.map(child => ({ child_share_class_id: child.child_share_class_id, units: child.units, remarks: child.remarks }));
              if (canonical(before) === canonical(list.after.items) && list.before.valuation_date === list.after.valuation_date) continue;
              const token = hash({ revision: old.fund.technical_revision, before, after: list.after, rows: list.source.map(item => item.row.id).sort() });
              const lead = list.source[0]; const display = rows => rows.map(child => ({ ...child, isin: list.before.items.find(old => old.child_share_class_id === child.child_share_class_id).child_isin }));
              lead.normalized.list_diff = { patch: true, before: display(before), after: display(list.after.items), old_date: list.before.valuation_date, new_date: list.after.valuation_date };
              lead.normalized.required_confirmation = token;
              if (!list.source.some(item => item.confirmation === token)) lead.errors.push(errorInfo(new FinanceError('COMPOSITION_CONFIRMATION_REQUIRED', '请核对完整清单差异；本次只修改选中行，未选中的成分继续保留', 'compositions')));
            }
          }
          if (archived && !same) throw new FinanceError('RESTORE_REQUIRED', '请先恢复基金或份额，再修改资料');
          if (!archived) await this.service.prepareFund(payload, transaction);
          groups.push({ ...group, method: 'saveFund', payload, verifyOnly: archived && same });
        } else if (table === 'investment_entities' || choicesTables.has(table)) {
          const old = await this.service.entityAggregate(group.id, transaction);
          let payload: any; let method: string;
          if (choicesTables.has(table)) {
            payload = { id: group.id, technical_revision: old.entity.technical_revision, table, changes: group.items.map(item => ({ id: item.record.id, option_code: item.facts.option_code })) };
            method = 'saveEntityChoices'; if (!same) await this.service.prepareEntityChoices(payload, transaction);
          } else {
            payload = { id: group.id, technical_revision: old.entity.technical_revision, client_code: old.client_code, entity: { ...this.service.sourceValues(table, old.entity), ...group.items[0].facts }, agreements: old.agreements, products: old.products };
            method = 'saveEntity'; if (!same) await this.service.prepareEntity(payload, transaction);
          }
          groups.push({ ...group, payload, method, verifyOnly: same });
        } else {
          const item = group.items[0]; const payload: any = { id: group.id, technical_revision: item.record.get('technical_revision') };
          let method: string;
          if (table === 'client_groups') {
            Object.assign(payload, item.facts); method = 'saveClientGroup';
            if (!same) {
              const checked = await this.service.prepareClientGroup(payload, transaction);
              for (const row of checked.entities) remember('investment_entities', row);
              const token = hash({ id: group.id, revision: payload.technical_revision, client_code: payload.client_code, entities: checked.entities.map(row => [row.id, row.get('technical_revision')]).sort(), rows: [item.row.id] });
              item.normalized.client_diff = { before: item.record.get('client_code'), after: payload.client_code, entity_count: checked.entities.length };
              item.normalized.required_confirmation = token;
              if (item.confirmation !== token) item.errors.push(errorInfo(new FinanceError('CLIENT_RENAME_CONFIRMATION_REQUIRED', '客户编号改名会影响此分组下所有主体，请核对影响范围', 'client_code')));
            }
          } else if (table === 'fund_documents') {
            Object.assign(payload, item.facts); method = 'saveDocumentMetadata';
            if (!same) await this.service.prepareDocumentMetadata(payload, transaction);
          } else {
            payload.values = item.facts; method = 'saveBenchmark'; if (!same) await this.service.normalize('benchmarks', item.facts, transaction);
          }
          groups.push({ ...group, payload, method, verifyOnly: same });
        }
      } catch (error) { if (!(error instanceof FinanceError)) throw error; for (const item of group.items) item.errors.push(errorInfo(error)); }
    } catch (error) { if (!(error instanceof FinanceError)) throw error; for (const item of selected) item.errors.push(errorInfo(error)); }
    return { items, selected, groups, dependencies: hash([...references.entries()].sort(([a], [b]) => a.localeCompare(b))) };
  }
  async preview(batch: any, mapping: any, corrections: any[], transaction: any) {
    const rows = await this.service.model('import_rows').findAll({ where: { batch_id: batch.id }, order: [['row_index', 'ASC']], ...writeOptions(transaction) });
    const prepared = await this.prepare(batch, mapping, rows, corrections, transaction);
    for (const item of prepared.items) await item.row.update({ corrected: item.corrected, selected: item.selected, normalized: item.normalized || { validated: false, values: item.facts, replacement_confirmation: item.confirmation }, errors: item.errors, operation: item.operation }, writeOptions(transaction));
    const valid = prepared.selected.length > 0 && prepared.selected.every(item => !item.errors.length);
    await batch.update({ mapping, status: valid ? 'ready' : 'needs_correction', technical_revision: batch.get('technical_revision') + 1, preview_revision: batch.get('preview_revision') + 1,
      preview: { token: hash(prepared.items.map(item => ({ id: item.row.id, values: item.values, selected: item.selected, normalized: item.normalized }))), dependencies: prepared.dependencies, rules_revision: await new FinanceOptions(this.service).revision(transaction), selected_count: prepared.selected.length, object_count: prepared.groups.length, error_count: prepared.selected.filter(item => item.errors.length).length } }, writeOptions(transaction));
  }
  async commit(batch: any, transaction: any) {
    const rows = await this.service.model('import_rows').findAll({ where: { batch_id: batch.id }, order: [['row_index', 'ASC']], ...writeOptions(transaction) });
    const prepared = await this.prepare(batch, batch.get('mapping'), rows, [], transaction);
    if (!prepared.selected.length || prepared.selected.some(item => item.errors.length) || prepared.dependencies !== batch.get('preview').dependencies) throw new FinanceError('PREVIEW_STALE', '主数据或关联资料已变化，请重新预览并核对', 'batch_id', 409);
    const objects = [];
    for (const group of prepared.groups) {
      const saved = group.verifyOnly ? null : await this.service[group.method](group.payload, transaction);
      objects.push({ id: group.id, type: group.method === 'saveFund' ? 'fund' : batch.get('context').exchange.table, row_ids: group.items.map(item => item.row.id), ...(saved?.fund ? { version_no: saved.fund.business_version } : {}) });
    }
    const result = { batch_id: batch.id, committed_count: prepared.selected.length, object_count: objects.length, objects, record_ids: prepared.selected.map(item => item.record.id), inserted_count: 0, overwritten_count: prepared.selected.filter(item => item.operation === 'overwrite').length, unchanged_count: prepared.selected.filter(item => item.operation === 'unchanged').length, version_count: objects.filter(item => item.version_no).length };
    await batch.update({ status: 'committed', result, technical_revision: batch.get('technical_revision') + 1 }, writeOptions(transaction));
    return result;
  }
}
