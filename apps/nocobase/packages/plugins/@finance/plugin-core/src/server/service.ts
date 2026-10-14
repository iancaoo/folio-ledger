import { createHash, randomUUID } from 'node:crypto';
import { Op, QueryTypes } from 'sequelize';
import { catalog, fields } from '../shared/models';
import { canonical, cddDeadline, dateOnly, decimal, Decimal, FinanceError, replayUnits, TRANSACTION_TYPES } from '../shared/values';
import { domainWrite, writeOptions } from './write-scope';
import { receiptOutcome } from './receipts';
import { configurationLock } from './options';
import { optionDefinition } from '../shared/options';
import { tradeDuplicateCriteria } from '../shared/trade-import';
import { FinanceQueries } from './queries';

const TECHNICAL = new Set(['id', 'technical_revision', 'business_version', 'saved_at', 'is_deleted', 'is_void', 'voided_at', 'void_reason', 'source_batch_id', 'source_sheet', 'source_row']);
const plain = (row: any) => row?.get ? row.get({ plain: true }) : row;
const missing = (v: any) => v === null || v === undefined || v === '';
function allowedKeys(value: any, keys: string[], path: string) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new FinanceError('INVALID_OBJECT', '请填写记录字段', path);
  const unexpected = Object.keys(value).find(key => !keys.includes(key));
  if (unexpected) throw new FinanceError('FIELD_NOT_WRITABLE', '此字段不可直接写入', `${path}.${unexpected}`);
}
export const uuid = (value: any, path: string) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new FinanceError('INVALID_ID', '请选择有效的关联记录', path);
  }
  return value.toLowerCase();
};

export class FinanceService {
  constructor(public db: any, public demoMode = false) {}
  model(table: string) { return this.db.getModel(`finance_${table}`); }
  async lock(keys: string[], transaction: any) {
    for (const key of [...new Set(keys)].sort()) {
      await this.db.sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))',
        { replacements: { key: `finance:${key}` }, transaction, type: QueryTypes.SELECT });
    }
  }
  async requiredRow(table: string, id: string, transaction: any, active = false) {
    uuid(id, `${table}.id`);
    const row = await this.model(table).findByPk(id, writeOptions(transaction));
    if (!row) throw new FinanceError('NOT_FOUND', '记录不存在或已被删除', table, 404);
    if (active && row.get('is_deleted')) throw new FinanceError('RESTORE_REQUIRED', '请先恢复已删除的基金或投资主体，再录入新数据', table);
    return row;
  }
  revision(row: any, expected: any) {
    if (!Number.isInteger(expected) || row.get('technical_revision') !== expected) {
      throw new FinanceError('STALE_REVISION', '记录已变化，请刷新后重新核对', 'technical_revision', 409);
    }
  }
  async write(actor: string, operation: string, key: string, payload: any, work: (transaction: any) => Promise<any>) {
    if (typeof key !== 'string' || key.length < 8 || key.length > 160) {
      throw new FinanceError('REQUEST_KEY_REQUIRED', '保存操作需要有效的幂等请求标识', 'request_key');
    }
    const hash = createHash('sha256').update(canonical(payload)).digest('hex');
    return domainWrite(async () => this.db.sequelize.transaction(async (transaction: any) => {
      await configurationLock(this.db, transaction, operation === 'saveOptions');
      await this.lock([`request:${actor}:${operation}:${key}`], transaction);
      const receipts = this.model('request_receipts');
      const found = await receipts.findOne({ where: { actor_id: actor, operation, request_key: key }, ...writeOptions(transaction) });
      if (found) {
        if (found.get('payload_hash') !== hash) throw new FinanceError('REQUEST_KEY_REUSED', '同一请求标识不能用于不同内容', 'request_key', 409);
        return found.get('result');
      }
      const result = receiptOutcome(await work(transaction));
      await receipts.create({ id: randomUUID(), actor_id: actor, operation, request_key: key, payload_hash: hash, result }, writeOptions(transaction));
      return result;
    }));
  }
  sources(table: string, fundKind?: string) {
    return catalog.fields.filter(source => source.logical_table === table &&
      (!['三方基金页面', '自营基金页面'].includes(source.source_sheet) || !fundKind || source.source_sheet === (fundKind === 'third_party' ? '三方基金页面' : '自营基金页面')));
  }
  sourceValues(table: string, row: any, fundKind?: string) {
    const names = new Set(this.sources(table, fundKind).flatMap(source => source.mapping.split('；')[0].split(' + ').map(part => part.includes('.') ? part.split('.')[1] : part)));
    return Object.fromEntries([...names].filter(name => !TECHNICAL.has(name) && fields[table].some(field => field.name === name)).map(name => [name, row[name] ?? null]));
  }
  sameValues(table: string, row: any, values: any) {
    return Object.entries(values).every(([key, value]) => {
      const old = row[key] ?? null; const type = fields[table].find(field => field.name === key)?.type;
      return canonical(type === 'bigInt' && value !== null ? String(value) : value) === canonical(type === 'bigInt' && old !== null ? String(old) : old);
    });
  }
  async normalize(table: string, input: any, transaction: any, fundKind?: string) {
    if (!input || Array.isArray(input) || typeof input !== 'object') throw new FinanceError('INVALID_OBJECT', '请填写记录字段', table);
    const output: any = {};
    const sources = this.sources(table, fundKind);
    const allowed = new Set(sources.flatMap(source => source.mapping.split('；')[0].split(' + ').map(part => part.includes('.') ? part.split('.')[1] : part)));
    const contextFields: Record<string, string[]> = { transactions: ['entity_id'], fund_navs: ['share_class_id'], fund_returns: ['share_class_id'], benchmark_values: ['benchmark_id'] };
    for (const name of contextFields[table] || []) allowed.add(name);
    for (const [name, value] of Object.entries(input)) {
      const definition = fields[table].find(field => field.name === name);
      if (!definition || TECHNICAL.has(name) || !allowed.has(name)) throw new FinanceError('FIELD_NOT_WRITABLE', '此字段不可直接写入', `${table}.${name}`);
      const path = `${table}.${name}`;
      if (definition.type === 'decimal') output[name] = decimal(value, path, { scale: name === 'confirmed_nav' ? 4 : undefined, positive: name === 'confirmed_units' });
      else if (definition.type === 'dateOnly') output[name] = dateOnly(value, path);
      else if (definition.type === 'uuid') output[name] = uuid(value, path);
      else if (definition.type === 'json') {
        if (typeof value !== 'object' || !value || Array.isArray(value)) throw new FinanceError('INVALID_COMPOSITE', '请填写复合值及原单位', path);
        if (name === 'gate_raw') {
          const gate: any = value;
          if (Object.keys(gate).some(key => !['value', 'unit'].includes(key)) || typeof gate.unit !== 'string' || !gate.unit.trim()) throw new FinanceError('INVALID_COMPOSITE', '请完整填写赎回金额限制的原数值和原单位／规则', path);
          decimal(gate.value, `${path}.value`, { required: true });
        }
        output[name] = value;
      } else if (definition.type === 'bigInt') {
        if (!missing(value) && !/^\d+$/.test(String(value))) throw new FinanceError('INVALID_USER', '请选择有效的负责人', path);
        output[name] = missing(value) ? null : String(value);
      } else {
        if (!missing(value) && typeof value !== 'string') throw new FinanceError('TEXT_REQUIRED', '请保留文本格式', path);
        output[name] = missing(value) ? null : value;
      }
    }
    for (const source of sources) {
      const name = source.logical_field;
      if (!name || !fields[table].some(field => field.name === name) || TECHNICAL.has(name)) continue;
      const components = source.mapping.split('；')[0].split(' + ').map(part => part.includes('.') ? part.split('.')[1] : part);
      for (const component of components) {
        if ((source.required || components.some(key => !missing(output[key]))) && missing(output[component])) throw new FinanceError('REQUIRED', `请完整填写${source.label}及单位／规则`, `${table}.${component}`);
        const definition = optionDefinition(source.source_key, component);
        if (definition && !missing(output[component])) await this.validateOption(definition.source_key, output[component], transaction, `${table}.${component}`);
      }
      if (!missing(output[name]) && name.endsWith('_user_id') && this.db.hasCollection('users')) {
        if (!await this.db.getModel('users').findByPk(output[name], writeOptions(transaction))) throw new FinanceError('INVALID_USER', '所选负责人不存在', `${table}.${name}`);
        if (!this.demoMode && name === 'coverage_owner_user_id' && !await this.db.getModel('rolesUsers').findOne({ where: { userId: output[name], roleName: 'finance_product' }, ...writeOptions(transaction) })) throw new FinanceError('INVALID_USER_GROUP', '追踪负责人须属于产品组，请由管理员配置产品组成员', `${table}.${name}`);
      }
    }
    for (const [name, value] of Object.entries(output)) {
      if (!missing(value) && (name.endsWith('_email') || name === 'email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) throw new FinanceError('INVALID_EMAIL', '请填写有效邮箱', `${table}.${name}`);
    }
    return output;
  }
  async validateOption(sourceKey: string, value: string, transaction: any, path: string) {
    if (this.demoMode) return;
    const set = await this.model('option_sets').findOne({ where: { source_key: sourceKey }, ...writeOptions(transaction) });
    if (!set?.get('confirmed')) throw new FinanceError('CONFIG_UNCONFIRMED', '此字段的候选项尚未确认，请先完成字段配置', path);
    const option = await this.model('option_values').findOne({ where: { option_set_id: set.id, code: value }, ...writeOptions(transaction) });
    if (!option) throw new FinanceError('INVALID_OPTION', '请选择已配置的候选值', path);
  }

  async prepareFund(payload: any, transaction: any) {
    allowedKeys(payload, ['id', 'technical_revision', 'fund_kind', 'fund', 'details', 'share_classes', 'compositions'], 'fund');
    const { id, technical_revision, fund_kind, fund, details, share_classes } = payload;
    if (!['third_party', 'proprietary'].includes(fund_kind)) throw new FinanceError('INVALID_FUND_KIND', '请选择三方或自营基金', 'fund_kind');
    if (!Array.isArray(share_classes) || !id && !share_classes.length) throw new FinanceError('SHARE_CLASS_REQUIRED', '至少填写一个份额类别', 'share_classes');
    for (const item of share_classes) allowedKeys(item, ['id', 'values', 'terms'], 'share_classes');
    const fundId = id ? uuid(id, 'id') : randomUUID();
    // All writers acquire identity keys before fund locks; batch writers use the same order.
    await this.lock(share_classes.map(item => `isin:${item.values?.isin}`), transaction);
    await this.lock([`fund:${fundId}`], transaction);
    const existing = id && await this.requiredRow('funds', id, transaction, true);
    if (existing) {
      this.revision(existing, technical_revision);
      if (existing.get('fund_kind') !== fund_kind) throw new FinanceError('FUND_KIND_IMMUTABLE', '基金类型不能改变', 'fund_kind');
    }
    const detailTable = `${fund_kind}_fund_details`;
    const termTable = `${fund_kind}_class_terms`;
    const fundValues = await this.normalize('funds', fund, transaction, fund_kind);
    if (fundValues.inception_date && fundValues.maturity_date && fundValues.maturity_date < fundValues.inception_date) throw new FinanceError('INVALID_DATE_ORDER', '到期日不能早于成立日', 'funds.maturity_date');
    const detailValues = await this.normalize(detailTable, details || {}, transaction, fund_kind);
    const shares = [];
    for (const item of share_classes) {
      const classValues = await this.normalize('share_classes', item.values, transaction, fund_kind);
      const termValues = await this.normalize(termTable, item.terms || {}, transaction, fund_kind);
      const classId = item.id ? uuid(item.id, 'share_classes.id') : randomUUID();
      let oldClass;
      if (item.id) {
        oldClass = await this.requiredRow('share_classes', item.id, transaction, true);
        if (oldClass.get('fund_id') !== fundId) throw new FinanceError('WRONG_PARENT', '份额不属于当前基金', 'share_classes.id');
        if (oldClass.get('currency') !== classValues.currency) {
          const used = await Promise.all(['transactions', 'fund_navs', 'fund_returns', 'composition_items'].map(table => this.model(table).count({ where: { [table === 'composition_items' ? 'child_share_class_id' : 'share_class_id']: classId }, ...writeOptions(transaction) })));
          if (used.some(count => count > 0)) throw new FinanceError('CURRENCY_IN_USE', '此份额已有交易、净值或成分引用，不能改变其币种。请使用另一份额记录新币种业务', 'share_classes.currency');
        }
      }
      shares.push({ classId, oldClass, classValues, termValues });
    }
    const compositionPlans = payload.compositions !== undefined ? await this.prepareCompositionLists(fundId, fund_kind, payload.compositions, transaction) : [];
    return { fundId, existing, fund_kind, fundValues, detailValues, detailTable, termTable, shares, compositionPlans };
  }
  async saveFund(payload: any, transaction: any) {
    const { fundId, existing, fund_kind, fundValues, detailValues, detailTable, termTable, shares, compositionPlans } = await this.prepareFund(payload, transaction);
    const version = existing ? existing.get('business_version') + 1 : 1;
    const savedAt = new Date();
    const values = { ...fundValues, fund_kind, business_version: version, saved_at: savedAt, technical_revision: existing ? existing.get('technical_revision') + 1 : 1 };
    if (existing) await existing.update(values, writeOptions(transaction));
    else await this.model('funds').create({ id: fundId, ...values }, writeOptions(transaction));
    const detail = await this.model(detailTable).findOne({ where: { fund_id: fundId }, ...writeOptions(transaction) });
    if (detail) { if (!this.sameValues(detailTable, plain(detail), detailValues)) await detail.update(detailValues, writeOptions(transaction)); }
    else await this.model(detailTable).create({ id: randomUUID(), fund_id: fundId, ...detailValues }, writeOptions(transaction));
    for (const { classId, oldClass, classValues, termValues } of shares) {
      if (oldClass) await oldClass.update({ ...classValues, technical_revision: oldClass.get('technical_revision') + 1 }, writeOptions(transaction));
      else await this.model('share_classes').create({ id: classId, ...classValues, fund_id: fundId }, writeOptions(transaction));
      const terms = await this.model(termTable).findOne({ where: { share_class_id: classId }, ...writeOptions(transaction) });
      if (terms) { if (!this.sameValues(termTable, plain(terms), termValues)) await terms.update(termValues, writeOptions(transaction)); }
      else await this.model(termTable).create({ id: randomUUID(), share_class_id: classId, ...termValues }, writeOptions(transaction));
    }
    await this.persistCompositionLists(fundId, compositionPlans, transaction);
    const snapshot = await this.fundAggregate(fundId, transaction);
    await this.model('fund_versions').create({ id: randomUUID(), fund_id: fundId, version_no: version, saved_at: savedAt, snapshot }, writeOptions(transaction));
    return snapshot;
  }
  async fundAggregate(id: string, transaction?: any) {
    const fund = plain(await this.requiredRow('funds', id, transaction));
    const details = plain(await this.model(`${fund.fund_kind}_fund_details`).findOne({ where: { fund_id: id }, ...writeOptions(transaction) }));
    const classes = await this.model('share_classes').findAll({ where: { fund_id: id }, order: [['isin', 'ASC']], ...writeOptions(transaction) });
    const share_classes = [];
    for (const row of classes) {
      share_classes.push({ ...plain(row), terms: plain(await this.model(`${fund.fund_kind}_class_terms`).findOne({ where: { share_class_id: row.id }, ...writeOptions(transaction) })) });
    }
    const compositions = [];
    const lists = await this.model('composition_snapshots').findAll({ where: { parent_fund_id: id }, order: [['created_at', 'ASC']], ...writeOptions(transaction) });
    for (const list of lists) {
      const items = [];
      for (const item of await this.model('composition_items').findAll({ where: { snapshot_id: list.id }, order: [['created_at', 'ASC'], ['id', 'ASC']], ...writeOptions(transaction) })) {
        const share = await this.requiredRow('share_classes', item.get('child_share_class_id'), transaction);
        const child = await this.requiredRow('funds', share.get('fund_id'), transaction);
        // Freeze the chosen reference's display identity, never its mutable NAV.
        items.push({ ...plain(item), child_name: child.get('short_name'), child_isin: share.get('isin'), child_class_label: share.get('class_label'), child_currency: share.get('currency') });
      }
      compositions.push({ ...plain(list), items });
    }
    return { fund, details, share_classes, compositions };
  }
  async prepareCompositionLists(fundId: string, kind: string, lists: any, transaction: any) {
    if (kind !== 'proprietary') throw new FinanceError('PROPRIETARY_REQUIRED', '成分清单属于自营基金', 'compositions');
    if (!Array.isArray(lists)) throw new FinanceError('INVALID_COMPOSITION', '请提供完整成分清单', 'compositions');
    const childFunds = new Set<string>();
    for (const list of lists) {
      allowedKeys(list, ['id', 'valuation_date', 'items'], 'compositions');
      if (!Array.isArray(list.items)) throw new FinanceError('INVALID_COMPOSITION', '请提供该日期的全部成分行', 'compositions.items');
      for (const item of list.items) {
        const share = await this.requiredRow('share_classes', item?.child_share_class_id, transaction);
        const child = await this.requiredRow('funds', share.get('fund_id'), transaction);
        if (child.get('fund_kind') !== 'third_party') throw new FinanceError('THIRD_PARTY_REQUIRED', '成分子基金必须选择未删除的三方基金份额', 'compositions.items.child_share_class_id');
        childFunds.add(child.id);
      }
    }
    // Lock every child across all submitted lists in one sorted order. No
    // proprietary fund can be a child, so parent locks cannot form a cycle.
    await this.lock([...childFunds].map(id => `fund:${id}`), transaction);
    const plans = [];
    const dates = new Set<string>(); const ids = new Set<string>();
    for (const list of lists) {
      allowedKeys(list, ['id', 'valuation_date', 'items'], 'compositions');
      if (!Array.isArray(list.items)) throw new FinanceError('INVALID_COMPOSITION', '请提供该日期的全部成分行', 'compositions.items');
      const id = list.id ? uuid(list.id, 'compositions.id') : randomUUID();
      const date = dateOnly(list.valuation_date, 'compositions.valuation_date');
      if (ids.has(id) || date && dates.has(date)) throw new FinanceError('DUPLICATE_COMPOSITION', '一次保存中同一清单或同一日期只能出现一次', 'compositions');
      ids.add(id); if (date) dates.add(date);
      const existing = list.id && await this.requiredRow('composition_snapshots', id, transaction);
      if (existing && existing.get('parent_fund_id') !== fundId) throw new FinanceError('WRONG_PARENT', '成分清单不属于当前基金', 'compositions.id');
      if (date) {
        const sameDate = await this.model('composition_snapshots').findOne({ where: { parent_fund_id: fundId, valuation_date: date }, ...writeOptions(transaction) });
        if (sameDate && sameDate.id !== id) throw new FinanceError('COMPOSITION_DATE_EXISTS', '该日期已有完整清单，请选择原清单修改并核对差异', 'compositions.valuation_date', 409);
      }
      const items = []; const classes = new Set<string>();
      const retained = existing ? new Map((await this.model('composition_items').findAll({ where: { snapshot_id: id }, ...writeOptions(transaction) })).map(row => [row.get('child_share_class_id'), row])) : new Map();
      const normalized = [];
      for (const row of list.items) normalized.push(await this.normalize('composition_items', row, transaction, 'proprietary'));
      for (const row of normalized) {
        if (classes.has(row.child_share_class_id)) throw new FinanceError('DUPLICATE_COMPOSITION_CLASS', '同组内同一份额只能出现一次，请先合并重复行', 'compositions.items');
        classes.add(row.child_share_class_id);
        const share = await this.activeClass(row.child_share_class_id, transaction);
        const child = await this.requiredRow('funds', share.get('fund_id'), transaction, true);
        if (child.get('fund_kind') !== 'third_party') throw new FinanceError('THIRD_PARTY_REQUIRED', '成分子基金必须选择未删除的三方基金份额', 'compositions.items.child_share_class_id');
        items.push({ id: retained.get(row.child_share_class_id)?.id || randomUUID(), snapshot_id: id, ...row });
      }
      plans.push({ id, date, existing, items });
    }
    return plans;
  }
  async persistCompositionLists(fundId: string, plans: any[], transaction: any) {
    for (const { id, date, existing, items } of plans) {
      if (existing) {
        await existing.update({ valuation_date: date, technical_revision: existing.get('technical_revision') + 1 }, writeOptions(transaction));
      } else await this.model('composition_snapshots').create({ id, parent_fund_id: fundId, valuation_date: date }, writeOptions(transaction));
      const before = new Map<string, any>((await this.model('composition_items').findAll({ where: { snapshot_id: id }, ...writeOptions(transaction) })).map(row => [row.id, row]));
      for (const item of items) {
        const prior = before.get(item.id); before.delete(item.id);
        if (!prior) await this.model('composition_items').create(item, writeOptions(transaction));
        else if (['units', 'remarks'].some(key => canonical(prior.get(key) ?? null) !== canonical(item[key] ?? null))) await prior.update({ ...item, technical_revision: prior.get('technical_revision') + 1 }, writeOptions(transaction));
      }
      for (const prior of before.values()) await prior.destroy(writeOptions(transaction));
    }
  }
  async compositionValues(fundId: string, transaction?: any) {
    uuid(fundId, 'fund_id');
    if (!transaction) return this.db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ' }, tx => this.compositionValues(fundId, tx));
    const aggregate = await this.fundAggregate(fundId, transaction);
    const groups = [];
    for (const list of aggregate.compositions) {
      const rows = []; const currencies = new Set<string>(); const issues: any[] = [];
      if (!list.valuation_date) issues.push({ code: 'MISSING_DATE', message: '未填写统一估值日期' });
      if (!list.items.length) issues.push({ code: 'EMPTY_COMPOSITION', message: '尚未填写成分行' });
      let total = new Decimal('0');
      for (const item of list.items) {
        const share = await this.requiredRow('share_classes', item.child_share_class_id, transaction);
        const child = await this.requiredRow('funds', share.get('fund_id'), transaction);
        currencies.add(share.get('currency'));
        const nav = list.valuation_date && await this.model('fund_navs').findOne({ where: { share_class_id: share.id, nav_date: { [Op.lte]: list.valuation_date } }, order: [['nav_date', 'DESC']], ...writeOptions(transaction) });
        const missingUnits = item.units === null || item.units === undefined;
        if (missingUnits) issues.push({ code: 'MISSING_UNITS', child_share_class_id: share.id, message: `${child.get('short_name')} · ${share.get('class_label') || share.get('isin')} 缺少份额` });
        if (list.valuation_date && !nav) issues.push({ code: 'MISSING_NAV', child_share_class_id: share.id, message: `${child.get('short_name')} · ${share.get('class_label') || share.get('isin')} 没有不晚于估值日的净值` });
        const value = !missingUnits && nav ? new Decimal(item.units).times(nav.get('nav_per_unit')) : null;
        if (value) total = total.plus(value);
        rows.push({ ...item, fund_name: child.get('short_name'), class_label: share.get('class_label'), isin: share.get('isin'), currency: share.get('currency'), fund_deleted: child.get('is_deleted'), class_deleted: share.get('is_deleted'), nav_date: nav ? nav.get('nav_date') : null, nav_per_unit: nav ? nav.get('nav_per_unit') : null, market_value: value?.toFixed() ?? null, weight: null });
      }
      if (currencies.size > 1) issues.push({ code: 'MIXED_CURRENCIES', message: '成分含不同币种；第一阶段不做汇率换算' });
      const totalAvailable = !issues.length;
      if (totalAvailable && !total.gt('0')) issues.push({ code: 'NON_POSITIVE_TOTAL', message: '成分总市值必须大于零才可计算权重' });
      if (!issues.length) for (const row of rows) row.weight = new Decimal(row.market_value).div(total).toFixed();
      groups.push({ id: list.id, valuation_date: list.valuation_date, technical_revision: list.technical_revision, currency: currencies.size === 1 ? [...currencies][0] : null, total_market_value: totalAvailable ? total.toFixed() : null, items: rows, issues });
    }
    return { fund: aggregate.fund, compositions: groups };
  }
  async prepareEntity(payload: any, transaction: any) {
    allowedKeys(payload, ['id', 'technical_revision', 'client_code', 'entity', 'agreements', 'products'], 'entity');
    const { id, technical_revision, client_code, entity, agreements = [], products = [] } = payload;
    if (typeof client_code !== 'string' || !client_code.trim()) throw new FinanceError('REQUIRED', '请填写客户编号', 'client_code');
    if (!this.demoMode && !/^AM\d{4}$/.test(client_code)) throw new FinanceError('INVALID_CLIENT_CODE', '客户编号应为 AM 加 4 位数字，例如 AM0601', 'client_code');
    const entityId = id ? uuid(id, 'id') : randomUUID();
    await this.lock([`client:${client_code}`, `entity:${entityId}`], transaction);
    const existing = id && await this.requiredRow('investment_entities', id, transaction, true);
    if (existing) this.revision(existing, technical_revision);
    const values = await this.normalize('investment_entities', entity, transaction);
    for (const [type, choices] of [['agreements', agreements], ['products', products]] as any) {
      if (!Array.isArray(choices) || choices.some(value => typeof value !== 'string') || new Set(choices).size !== choices.length) throw new FinanceError('INVALID_OPTIONS', '多选值不能重复且必须为文本', type);
      for (const choice of choices) await this.validateOption(type === 'agreements' ? '客户页面:9' : '客户页面:10', choice, transaction, type);
    }
    if (agreements.some(value => value.toLowerCase() === 'n/a') && agreements.length > 1) throw new FinanceError('EXCLUSIVE_NA', 'n/a 不能与其他协议同时选择', 'agreements');
    return { entityId, existing, values, client_code, agreements, products };
  }
  async saveEntity(payload: any, transaction: any) {
    const { entityId, existing, values, client_code, agreements, products } = await this.prepareEntity(payload, transaction);
    let group = await this.model('client_groups').findOne({ where: { client_code }, ...writeOptions(transaction) });
    if (!group) group = await this.model('client_groups').create({ id: randomUUID(), client_code }, writeOptions(transaction));
    const record = { ...values, client_group_id: group.id, technical_revision: existing ? existing.get('technical_revision') + 1 : 1 };
    if (existing) await existing.update(record, writeOptions(transaction));
    else await this.model('investment_entities').create({ id: entityId, ...record }, writeOptions(transaction));
    for (const [table, choices] of [['entity_agreements', agreements], ['entity_products', products]] as any) {
      const before = new Map<string, any>((await this.model(table).findAll({ where: { entity_id: entityId }, ...writeOptions(transaction) })).map(row => [row.get('option_code'), row]));
      for (const option_code of choices) {
        if (!before.has(option_code)) await this.model(table).create({ id: randomUUID(), entity_id: entityId, option_code }, writeOptions(transaction));
        before.delete(option_code);
      }
      for (const row of before.values()) await row.destroy(writeOptions(transaction));
    }
    return { ...plain(await this.requiredRow('investment_entities', entityId, transaction)), client_code, agreements, products, next_cdd_deadline: cddDeadline(values.latest_cdd_approval_date) };
  }
  async activeClass(id: string, transaction: any) {
    let row = await this.requiredRow('share_classes', id, transaction, true);
    if (transaction) {
      await this.lock([`fund:${row.get('fund_id')}`], transaction);
      row = await this.requiredRow('share_classes', id, transaction, true);
    }
    await this.requiredRow('funds', row.get('fund_id'), transaction, true);
    return row;
  }
  async prepareEntityChoices(payload: any, transaction: any) {
    allowedKeys(payload, ['id', 'technical_revision', 'table', 'changes'], 'choices');
    if (!['entity_agreements', 'entity_products'].includes(payload.table) || !Array.isArray(payload.changes)) throw new FinanceError('INVALID_OPTIONS', '请选择主体协议或产品及要修改的记录');
    const old = await this.entityAggregate(uuid(payload.id, 'id'), transaction);
    await this.lock([`client:${old.client_code}`], transaction);
    await this.lock([`entity:${payload.id}`], transaction);
    const current = await this.entityAggregate(payload.id, transaction);
    this.revision(await this.requiredRow('investment_entities', payload.id, transaction, true), payload.technical_revision);
    const rows = await this.model(payload.table).findAll({ where: { entity_id: payload.id }, ...writeOptions(transaction) });
    const changes = new Map<string, string>();
    for (const item of payload.changes) {
      allowedKeys(item, ['id', 'option_code'], 'choices.changes');
      const id = uuid(item.id, 'choices.id');
      if (!rows.some(row => row.id === id) || changes.has(id)) throw new FinanceError('WRONG_PARENT', '关联记录不属于此主体或重复指定', 'choices.id');
      changes.set(id, item.option_code);
    }
    const values = rows.map(row => changes.has(row.id) ? changes.get(row.id) : row.get('option_code'));
    const checked = await this.prepareEntity({ id: payload.id, technical_revision: payload.technical_revision, client_code: current.client_code,
      entity: this.sourceValues('investment_entities', current.entity), agreements: payload.table === 'entity_agreements' ? values : current.agreements, products: payload.table === 'entity_products' ? values : current.products }, transaction);
    return { checked, rows, changes };
  }
  async saveEntityChoices(payload: any, transaction: any) {
    const { checked, rows, changes } = await this.prepareEntityChoices(payload, transaction);
    const modified = rows.filter(row => changes.has(row.id) && row.get('option_code') !== changes.get(row.id));
    // Reinsert only modified associations with their original IDs so a valid
    // two-option swap never violates the immediate unique constraint halfway.
    for (const row of modified) await row.destroy(writeOptions(transaction));
    for (const row of modified) await this.model(payload.table).create({ id: row.id, entity_id: payload.id, option_code: changes.get(row.id), created_at: row.get('created_at'), technical_revision: row.get('technical_revision') + 1 }, writeOptions(transaction));
    if (modified.length) await checked.existing.update({ technical_revision: checked.existing.get('technical_revision') + 1 }, writeOptions(transaction));
    return { id: payload.id, technical_revision: checked.existing.get('technical_revision') };
  }
  async prepareClientGroup(payload: any, transaction: any) {
    allowedKeys(payload, ['id', 'technical_revision', 'client_code'], 'client_group');
    const id = uuid(payload.id, 'id'); const before = await this.requiredRow('client_groups', id, transaction);
    if (typeof payload.client_code !== 'string' || !payload.client_code.trim()) throw new FinanceError('REQUIRED', '请填写客户编号', 'client_code');
    if (!this.demoMode && !/^AM\d{4}$/.test(payload.client_code)) throw new FinanceError('INVALID_CLIENT_CODE', '客户编号应为 AM 加 4 位数字', 'client_code');
    await this.lock([`client:${before.get('client_code')}`, `client:${payload.client_code}`], transaction);
    const row = await this.requiredRow('client_groups', id, transaction); this.revision(row, payload.technical_revision);
    const conflict = await this.model('client_groups').findOne({ where: { client_code: payload.client_code }, ...writeOptions(transaction) });
    if (conflict && conflict.id !== id) throw new FinanceError('CLIENT_CODE_EXISTS', '此客户编号已属于另一分组，不能通过改名合并', 'client_code');
    let entities = await this.model('investment_entities').findAll({ where: { client_group_id: id }, ...writeOptions(transaction) });
    await this.lock(entities.map(entity => `entity:${entity.id}`), transaction);
    entities = await this.model('investment_entities').findAll({ where: { client_group_id: id }, ...writeOptions(transaction) });
    return { row, entities };
  }
  async saveClientGroup(payload: any, transaction: any) {
    const { row, entities } = await this.prepareClientGroup(payload, transaction);
    if (row.get('client_code') !== payload.client_code) {
      await row.update({ client_code: payload.client_code, technical_revision: row.get('technical_revision') + 1 }, writeOptions(transaction));
      for (const entity of entities) await entity.update({ technical_revision: entity.get('technical_revision') + 1 }, writeOptions(transaction));
    }
    return plain(row);
  }
  async prepareDocumentMetadata(payload: any, transaction: any) {
    allowedKeys(payload, ['id', 'technical_revision', 'document_type'], 'document');
    const id = uuid(payload.id, 'id'); await this.lock([`document:${id}`], transaction);
    const row = await this.requiredRow('fund_documents', id, transaction); this.revision(row, payload.technical_revision);
    if (row.get('deleting')) throw new FinanceError('FILE_UNAVAILABLE', '文档正在删除，不能修改分类', 'id', 409);
    await this.lock([`fund:${row.get('fund_id')}`], transaction); await this.requiredRow('funds', row.get('fund_id'), transaction, true);
    if (typeof payload.document_type !== 'string' || !payload.document_type.trim()) throw new FinanceError('REQUIRED', '请选择文档类型', 'document_type');
    await this.validateOption('净值与文档:13', payload.document_type, transaction, 'document_type');
    return row;
  }
  async saveDocumentMetadata(payload: any, transaction: any) {
    const row = await this.prepareDocumentMetadata(payload, transaction);
    if (row.get('document_type') !== payload.document_type) await row.update({ document_type: payload.document_type, technical_revision: row.get('technical_revision') + 1 }, writeOptions(transaction));
    return plain(row);
  }
  async normalizeTrade(input: any, transaction: any) {
    const value = await this.normalize('transactions', input, transaction);
    uuid(value.entity_id, 'entity_id');
    uuid(value.share_class_id, 'share_class_id');
    if (!TRANSACTION_TYPES.includes(value.transaction_type)) throw new FinanceError('INVALID_TRANSACTION_TYPE', '请选择初次申购、追加申购或赎回', 'transaction_type');
    return value;
  }
  async prepareTrade(input: any, transaction: any) {
    const value = await this.normalizeTrade(input, transaction);
    await this.lock([`entity:${value.entity_id}`], transaction);
    await this.requiredRow('investment_entities', value.entity_id, transaction, true);
    await this.activeClass(value.share_class_id, transaction);
    // Transaction currency is a manual fact. A difference from class currency
    // is a warning; it must not invent FX or prevent saving the source fact.
    return value;
  }
  async accountGuards(accounts: Array<{ entity_id: string; share_class_id: string }>, transaction: any) {
    const distinct = new Map(accounts.map(({ entity_id, share_class_id }) => [`${entity_id}:${share_class_id}`, { entity_id, share_class_id }]));
    await this.lock([...distinct.keys()].map(key => `account:${key}`), transaction);
    const guards = [];
    for (const [, where] of [...distinct.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const [guard] = await this.model('position_write_guards').findOrCreate({ where, defaults: { id: randomUUID() }, ...writeOptions(transaction) });
      guards.push(guard);
    }
    return guards;
  }
  async replayAccounts(accounts: any[], transaction: any) {
    const rows = await this.model('transactions').findAll({ where: { [Op.or]: accounts.map(({ entity_id, share_class_id }) => ({ entity_id, share_class_id })), is_void: false }, ...writeOptions(transaction) });
    return replayUnits(rows.map(plain));
  }
  /** Lock the complete set before checking it, so file order never determines validity. */
  async tradeSetContext(plans: any[], transaction: any) {
    await this.lock(plans.filter(plan => plan.id).map(plan => `trade:${plan.id}`), transaction);
    const existing = new Map<string, any>();
    for (const plan of plans) if (plan.id) {
      const row = await this.requiredRow('transactions', plan.id, transaction);
      if (row.get('is_void')) throw new FinanceError('TRADE_VOIDED', '已撤销记录不能修改，请重新录入', 'id', 422, { row_id: plan.key });
      existing.set(plan.id, row);
    }
    const accounts = [...plans.map(plan => plan.values), ...[...existing.values()].map(plain)];
    await this.lock(accounts.map(value => `entity:${value.entity_id}`), transaction);
    const entities = await this.model('investment_entities').findAll({ where: { id: { [Op.in]: [...new Set(accounts.map(value => value.entity_id))] } }, ...writeOptions(transaction) });
    let shares = await this.model('share_classes').findAll({ where: { id: { [Op.in]: [...new Set(accounts.map(value => value.share_class_id))] } }, ...writeOptions(transaction) });
    let funds = await this.model('funds').findAll({ where: { id: { [Op.in]: [...new Set(shares.map(row => row.get('fund_id')))] } }, ...writeOptions(transaction) });
    // Composition saves lock a proprietary parent before its third-party children.
    for (const kind of ['proprietary', 'third_party']) await this.lock(funds.filter(row => row.get('fund_kind') === kind).map(row => `fund:${row.id}`), transaction);
    shares = await this.model('share_classes').findAll({ where: { id: { [Op.in]: shares.map(row => row.id) } }, ...writeOptions(transaction) });
    funds = await this.model('funds').findAll({ where: { id: { [Op.in]: funds.map(row => row.id) } }, ...writeOptions(transaction) });
    for (const plan of plans) {
      const entity = entities.find(row => row.id === plan.values.entity_id);
      const share = shares.find(row => row.id === plan.values.share_class_id);
      const fund = share && funds.find(row => row.id === share.get('fund_id'));
      if (!entity || !share || !fund) throw new FinanceError('NOT_FOUND', '主体或基金份额不存在，请核对主体 ID 和 ISIN', 'entity_id', 422, { row_id: plan.key });
      if ([entity, share, fund].some(row => row.get('is_deleted'))) throw new FinanceError('RESTORE_REQUIRED', '请先恢复主体、基金和份额，再录入交易', 'entity_id', 422, { row_id: plan.key });
      if (plan.isin && plan.isin !== share.get('isin')) throw new FinanceError('PREVIEW_STALE', 'ISIN 对应的份额已变化，请重新预览', 'isin', 409, { row_id: plan.key });
    }
    const guards = await this.accountGuards(accounts, transaction);
    const history = (await this.model('transactions').findAll({ where: { [Op.or]: guards.map(row => ({ entity_id: row.get('entity_id'), share_class_id: row.get('share_class_id') })), is_void: false }, ...writeOptions(transaction) })).map(plain);
    const revisions = (rows: any[], column = 'technical_revision') => rows.map(row => ({ id: row.id, revision: row.get(column) })).sort((a, b) => a.id.localeCompare(b.id));
    return { existing, guards, history, shares, entities, dependencies: {
      entities: revisions(entities), shares: revisions(shares), funds: revisions(funds), accounts: revisions(guards, 'write_revision'), trades: revisions([...existing.values()]),
    } };
  }
  async persistTrade(value: any, existing: any, transaction: any, source?: any) {
    const record = { ...value, source_batch_id: source?.batch_id ?? null, source_sheet: source?.sheet ?? null, source_row: source?.row ?? null, technical_revision: existing ? existing.get('technical_revision') + 1 : 1 };
    return existing ? existing.update(record, writeOptions(transaction)) : this.model('transactions').create({ id: randomUUID(), ...record }, writeOptions(transaction));
  }
  async saveTrade(payload: any, transaction: any) {
    allowedKeys(payload, ['id', 'technical_revision', 'values', 'duplicate_confirmation'], 'transaction');
    const { id, technical_revision, values } = payload;
    if (id) await this.lock([`trade:${uuid(id, 'id')}`], transaction);
    const existing = id && await this.requiredRow('transactions', id, transaction);
    if (existing) {
      this.revision(existing, technical_revision);
      if (existing.get('is_void')) throw new FinanceError('TRADE_VOIDED', '已撤销记录不能修改，请重新录入', 'id');
    }
    const value = await this.prepareTrade(values, transaction);
    const accounts = [value, ...(existing ? [plain(existing)] : [])];
    const guards = await this.accountGuards(accounts, transaction);
    const result = await this.persistTrade(value, existing, transaction);
    await this.replayAccounts(accounts, transaction);
    const criteria = tradeDuplicateCriteria(value);
    const duplicates = await this.model('transactions').findAll({ where: { ...criteria, is_void: false, id: { [Op.ne]: result.id } }, attributes: ['id', 'technical_revision'], order: [['id', 'ASC']], ...writeOptions(transaction) });
    if (duplicates.length) {
      const records = duplicates.map(plain);
      const confirmation = createHash('sha256').update(canonical({ criteria, records })).digest('hex');
      if (payload.duplicate_confirmation !== confirmation) throw new FinanceError('DUPLICATE_TRADE', '发现主体、份额、日期、类型、金额和份额相同的交易。请核对是否为另一笔真实交易', 'values', 409, { confirmation_token: confirmation, records });
    }
    for (const guard of guards) await guard.increment('write_revision', writeOptions(transaction));
    return plain(result);
  }
  async voidTrade(payload: any, transaction: any) {
    allowedKeys(payload, ['id', 'technical_revision', 'reason'], 'transaction');
    const { id, technical_revision, reason } = payload;
    await this.lock([`trade:${uuid(id, 'id')}`], transaction);
    const row = await this.requiredRow('transactions', id, transaction);
    this.revision(row, technical_revision);
    if (row.get('is_void')) throw new FinanceError('TRADE_VOIDED', '该记录已撤销', 'id');
    if (!missing(reason) && typeof reason !== 'string') throw new FinanceError('TEXT_REQUIRED', '撤销说明应为文本', 'reason');
    const guards = await this.accountGuards([plain(row)], transaction);
    await row.update({ is_void: true, void_reason: reason || null, voided_at: new Date(), technical_revision: row.get('technical_revision') + 1 }, writeOptions(transaction));
    await this.replayAccounts([plain(row)], transaction);
    for (const guard of guards) await guard.increment('write_revision', writeOptions(transaction));
    return plain(row);
  }
  seriesConfig(type: string) {
    const configs = { nav: ['fund_navs', 'share_class_id', 'nav_date'], returns: ['fund_returns', 'share_class_id', 'return_date'], benchmark: ['benchmark_values', 'benchmark_id', 'value_date'] };
    if (!Object.hasOwn(configs, type)) throw new FinanceError('INVALID_SERIES', '请选择净值、收益或基准', 'data_type');
    return configs[type] as string[];
  }
  async seriesParents(type: string, ids: string[], transaction: any) {
    const unique = [...new Set(ids)];
    if (type === 'benchmark') {
      await this.lock(unique.map(id => `benchmark:${id}`), transaction);
      const rows = await this.model('benchmarks').findAll({ where: { id: { [Op.in]: unique } }, ...writeOptions(transaction) });
      return new Map<string, any>(rows.map(record => [record.id, { record }]));
    }
    const initial = await this.model('share_classes').findAll({ where: { id: { [Op.in]: unique } }, ...writeOptions(transaction) });
    const fundIds = [...new Set(initial.map(row => row.get('fund_id')))];
    let funds = await this.model('funds').findAll({ where: { id: { [Op.in]: fundIds } }, ...writeOptions(transaction) });
    // Match aggregate writers: proprietary parents before third-party children.
    for (const kind of ['proprietary', 'third_party']) await this.lock(funds.filter(row => row.get('fund_kind') === kind).map(row => `fund:${row.id}`), transaction);
    const rows = await this.model('share_classes').findAll({ where: { id: { [Op.in]: unique } }, ...writeOptions(transaction) });
    funds = await this.model('funds').findAll({ where: { id: { [Op.in]: fundIds } }, ...writeOptions(transaction) });
    const byId = new Map(funds.map(row => [row.id, row]));
    return new Map<string, any>(rows.map(record => [record.id, { record, fund: byId.get(record.get('fund_id')) }]));
  }
  checkSeriesParent(type: string, reference: any) {
    if (!reference?.record || type !== 'benchmark' && !reference.fund) throw new FinanceError('NOT_FOUND', '对象不存在，请核对基准 ID 或基金份额', 'target', 404);
    if (reference.record.get('is_deleted') || reference.fund?.get('is_deleted')) throw new FinanceError('RESTORE_REQUIRED', '请先恢复已删除的基金或份额，再录入数据', 'target');
    if (type === 'returns' && reference.fund.get('fund_kind') !== 'third_party') throw new FinanceError('THIRD_PARTY_REQUIRED', '原字段表的 MTD 收益录入属于三方基金', 'share_class_id');
  }
  async saveSeries(payload: any, transaction: any) {
    allowedKeys(payload, ['data_type', 'values', 'expected_revision'], 'series');
    const [table, parent, date] = this.seriesConfig(payload.data_type);
    const values = await this.normalize(table, payload.values, transaction);
    uuid(values[parent], parent);
    const references = await this.seriesParents(payload.data_type, [values[parent]], transaction);
    this.checkSeriesParent(payload.data_type, references.get(values[parent]));
    await this.lock([`series:${table}:${values[parent]}:${values[date]}`], transaction);
    const existing = await this.model(table).findOne({ where: { [parent]: values[parent], [date]: values[date] }, ...writeOptions(transaction) });
    if (existing) this.revision(existing, payload.expected_revision);
    else if (payload.expected_revision !== null) throw new FinanceError('STALE_REVISION', '目标记录已变化，请重新预览', 'expected_revision', 409);
    const record = { ...values, source_batch_id: null, source_sheet: null, source_row: null, technical_revision: existing ? existing.get('technical_revision') + 1 : 1 };
    const row = existing ? await existing.update(record, writeOptions(transaction)) : await this.model(table).create({ id: randomUUID(), ...record }, writeOptions(transaction));
    return plain(row);
  }
  async entityAggregate(id: string, transaction?: any) {
    const entity = plain(await this.requiredRow('investment_entities', id, transaction));
    const group = await this.requiredRow('client_groups', entity.client_group_id, transaction);
    const agreements = await this.model('entity_agreements').findAll({ where: { entity_id: id }, ...writeOptions(transaction) });
    const products = await this.model('entity_products').findAll({ where: { entity_id: id }, ...writeOptions(transaction) });
    return { entity, client_code: group.get('client_code'), agreements: agreements.map(row => row.get('option_code')), products: products.map(row => row.get('option_code')), next_cdd_deadline: cddDeadline(entity.latest_cdd_approval_date) };
  }
  async saveBenchmark(payload: any, transaction: any) {
    allowedKeys(payload, ['id', 'technical_revision', 'values'], 'benchmark');
    const id = payload.id ? uuid(payload.id, 'id') : randomUUID();
    await this.lock([`benchmark:${id}`], transaction);
    const existing = payload.id && await this.requiredRow('benchmarks', id, transaction);
    if (existing) this.revision(existing, payload.technical_revision);
    const values = await this.normalize('benchmarks', payload.values, transaction);
    const data = { ...values, technical_revision: existing ? existing.get('technical_revision') + 1 : 1 };
    return plain(existing ? await existing.update(data, writeOptions(transaction)) : await this.model('benchmarks').create({ id, ...data }, writeOptions(transaction)));
  }
  async setDeleted(payload: any, transaction: any) {
    allowedKeys(payload, ['table', 'id', 'technical_revision', 'deleted'], 'deletion');
    if (!['funds', 'investment_entities'].includes(payload.table) || typeof payload.deleted !== 'boolean') throw new FinanceError('INVALID_DELETION', '仅基金和投资主体提供软删除及恢复', 'table');
    const id = uuid(payload.id, 'id');
    await this.lock([`${payload.table === 'funds' ? 'fund' : 'entity'}:${id}`], transaction);
    const row = await this.requiredRow(payload.table, id, transaction);
    this.revision(row, payload.technical_revision);
    if (row.get('is_deleted') === payload.deleted) return plain(row);
    await row.update({ is_deleted: payload.deleted, technical_revision: row.get('technical_revision') + 1 }, writeOptions(transaction));
    return plain(row);
  }
  async setClassDisabled(payload: any, transaction: any) {
    allowedKeys(payload, ['id', 'technical_revision', 'fund_revision', 'disabled'], 'share_class');
    if (typeof payload.disabled !== 'boolean') throw new FinanceError('INVALID_STATE', '请指定停用或恢复', 'disabled');
    let share = await this.requiredRow('share_classes', payload.id, transaction);
    await this.lock([`fund:${share.get('fund_id')}`], transaction);
    share = await this.requiredRow('share_classes', payload.id, transaction);
    const fund = await this.requiredRow('funds', share.get('fund_id'), transaction, true);
    this.revision(share, payload.technical_revision); this.revision(fund, payload.fund_revision);
    if (share.get('is_deleted') === payload.disabled) return this.fundAggregate(fund.id, transaction);
    await share.update({ is_deleted: payload.disabled, technical_revision: share.get('technical_revision') + 1 }, writeOptions(transaction));
    await fund.update({ business_version: fund.get('business_version') + 1, technical_revision: fund.get('technical_revision') + 1, saved_at: new Date() }, writeOptions(transaction));
    const snapshot = await this.fundAggregate(fund.id, transaction);
    await this.model('fund_versions').create({ id: randomUUID(), fund_id: fund.id, version_no: fund.get('business_version'), saved_at: fund.get('saved_at'), snapshot }, writeOptions(transaction));
    return snapshot;
  }
  async deleteSeries(payload: any, transaction: any) {
    allowedKeys(payload, ['data_type', 'id', 'technical_revision'], 'series');
    const [table, parent, date] = this.seriesConfig(payload.data_type);
    let row = await this.requiredRow(table, payload.id, transaction);
    await this.seriesParents(payload.data_type, [row.get(parent)], transaction);
    await this.lock([`series:${table}:${row.get(parent)}:${row.get(date)}`], transaction);
    row = await this.requiredRow(table, payload.id, transaction);
    this.revision(row, payload.technical_revision);
    await row.destroy(writeOptions(transaction));
    return { id: payload.id, technical_revision: payload.technical_revision, deleted: true };
  }
  async versions(id: string, transaction?: any) {
    await this.requiredRow('funds', id, transaction);
    return (await this.model('fund_versions').findAll({ where: { fund_id: id }, order: [['version_no', 'DESC']], ...writeOptions(transaction) })).map(plain);
  }
  async positions(entityId?: string, asOf?: string) {
    return (await new FinanceQueries(this).positions({ entity_id: entityId, as_of: asOf }, true)).rows;
  }
}
