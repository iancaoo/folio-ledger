import { randomUUID, createHash } from 'node:crypto';
import { optionDefinitions } from '../shared/options';
import { canonical, FinanceError } from '../shared/values';
import { domainWrite, writeOptions } from './write-scope';

export async function configurationLock(db: any, transaction: any, exclusive = false) {
  await db.sequelize.query(`SELECT pg_advisory_xact_lock${exclusive ? '' : '_shared'}(hashtextextended('finance:configuration', 0))`, { transaction });
}
export async function initializeOptions(db: any) {
  await domainWrite(() => db.sequelize.transaction(async (transaction: any) => {
    await configurationLock(db, transaction, true);
    const sets = db.getModel('finance_option_sets');
    const values = db.getModel('finance_option_values');
    for (const definition of optionDefinitions) {
      if (await sets.findOne({ where: { source_key: definition.source_key }, ...writeOptions(transaction) })) continue;
      const set = await sets.create({ id: randomUUID(), source_key: definition.source_key, confirmed: definition.confirmed }, writeOptions(transaction));
      for (const code of definition.values) await values.create({ id: randomUUID(), option_set_id: set.id, code, label: code }, writeOptions(transaction));
    }
  }));
}
export class FinanceOptions {
  constructor(public service: any) {}
  async list(transaction?: any) {
    const sets = await this.service.model('option_sets').findAll(writeOptions(transaction));
    const values = await this.service.model('option_values').findAll({ order: [['created_at', 'ASC'], ['code', 'ASC']], ...writeOptions(transaction) });
    return optionDefinitions.map(definition => {
      const set = sets.find(row => row.get('source_key') === definition.source_key);
      return { ...definition, id: set?.id, confirmed: set?.get('confirmed') ?? false, technical_revision: set?.get('technical_revision'),
        values: values.filter(row => row.get('option_set_id') === set?.id).map(row => ({ code: row.get('code'), label: row.get('label') })) };
    });
  }
  async revision(transaction?: any) {
    const sets = await this.service.model('option_sets').findAll({ order: [['source_key', 'ASC']], ...writeOptions(transaction) });
    return createHash('sha256').update(canonical(sets.map(row => [row.get('source_key'), row.get('technical_revision')]))).digest('hex');
  }
  async save(payload: any, transaction: any) {
    if (Object.keys(payload).some(key => !['source_key', 'technical_revision', 'confirmed', 'values'].includes(key))) throw new FinanceError('FIELD_NOT_WRITABLE', '只能维护候选值及确认状态');
    const definition = optionDefinitions.find(item => item.source_key === payload.source_key);
    if (!definition || definition.fixed) throw new FinanceError('CONFIG_NOT_EDITABLE', '该字段规则由需求定义，不能修改', 'source_key');
    if (typeof payload.confirmed !== 'boolean' || !Array.isArray(payload.values) || payload.values.length > 500 || payload.values.some(value => !value || Object.keys(value).some(key => !['code', 'label'].includes(key)) || typeof value.code !== 'string' || !value.code.trim() || value.code.length > 200 || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 200) || new Set(payload.values.map(value => value.code)).size !== payload.values.length) throw new FinanceError('INVALID_OPTIONS', '候选值必须有唯一编码和名称，且均为非空文本', 'values');
    if (payload.confirmed && !payload.values.length) throw new FinanceError('EMPTY_OPTIONS', '候选集为空，不能标为已确认', 'values');
    const set = await this.service.model('option_sets').findOne({ where: { source_key: payload.source_key }, ...writeOptions(transaction) });
    if (!set) throw new FinanceError('CONFIG_UNINITIALIZED', '请先运行配置初始化', 'source_key');
    this.service.revision(set, payload.technical_revision);
    await this.service.model('option_values').destroy({ where: { option_set_id: set.id }, ...writeOptions(transaction) });
    for (const value of payload.values) await this.service.model('option_values').create({ id: randomUUID(), option_set_id: set.id, ...value }, writeOptions(transaction));
    await set.update({ confirmed: payload.confirmed, technical_revision: set.get('technical_revision') + 1 }, writeOptions(transaction));
    return { id: set.id, technical_revision: set.get('technical_revision') };
  }
}
