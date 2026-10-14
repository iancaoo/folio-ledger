import { randomUUID } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import { FinanceService, uuid } from './service';
import { FinanceError } from '../shared/values';
import { draftLabels, validateDraft } from '../shared/drafts';
import { pagination } from './queries';
import { writeOptions } from './write-scope';

export class FinanceDrafts {
  constructor(public service: FinanceService) {}
  async get(id: string, actor: string, transaction?: any) {
    const row = await this.service.model('entry_drafts').findOne({ where: { id: uuid(id, 'draft.id'), owner_id: actor }, transaction });
    if (!row) throw new FinanceError('DRAFT_NOT_FOUND', '草稿不存在、已处理或不属于当前用户', 'draft.id', 404);
    return row;
  }
  async list(input: any, actor: string) {
    const paging = pagination(input); const where = ['owner_id=:actor']; const params: any = { ...paging, actor };
    if (input.form_type) {
      if (!Object.hasOwn(draftLabels, input.form_type)) throw new FinanceError('INVALID_DRAFT', '不支持的草稿类型');
      where.push('form_type=:form_type'); params.form_type = input.form_type;
    }
    const title = "COALESCE(content->'values'->'fund'->>'short_name',content->'values'->'entity'->>'legal_name',content->'values'->>'name',content->'values'->>'remarks','未命名草稿')";
    if (input.search) {
      if (typeof input.search !== 'string' || input.search.length > 200) throw new FinanceError('INVALID_SEARCH', '搜索文本最多 200 字');
      params.search = `%${input.search.replace(/[\\%_]/g, '\\$&')}%`; where.push(`${title} ILIKE :search`);
    }
    return this.service.db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async transaction => {
      const query = (sql: string) => this.service.db.sequelize.query(sql, { replacements: params, type: QueryTypes.SELECT, transaction });
      const [{ count }] = await query(`SELECT count(*)::int AS count FROM finance_entry_drafts WHERE ${where.join(' AND ')}`);
      const rows = await query(`SELECT id,technical_revision,form_type,updated_at,left(${title},120) AS title,(content->'editing'->>'id') IS NOT NULL AS is_edit FROM finance_entry_drafts WHERE ${where.join(' AND ')} ORDER BY updated_at DESC,id DESC LIMIT :page_size OFFSET :offset`);
      return { rows, count, page: paging.page, page_size: paging.page_size };
    });
  }
  async save(input: any, actor: string, transaction: any) {
    this.keys(input, ['id', 'technical_revision', 'form_type', 'content']);
    if (Buffer.byteLength(JSON.stringify(input.content) || '') > 1024 * 1024) throw new FinanceError('DRAFT_TOO_LARGE', '单份草稿最多 1 MB');
    validateDraft(input.form_type, input.content);
    if (!input.id) {
      if (input.technical_revision !== undefined) throw new FinanceError('INVALID_DRAFT', '新草稿不能指定修订号');
      return (await this.service.model('entry_drafts').create({ id: randomUUID(), owner_id: actor, form_type: input.form_type, content: input.content }, writeOptions(transaction))).toJSON();
    }
    await this.service.lock([`draft:${uuid(input.id, 'id')}`], transaction);
    const row = await this.get(input.id, actor, transaction); this.service.revision(row, input.technical_revision);
    if (row.get('form_type') !== input.form_type) throw new FinanceError('INVALID_DRAFT', '不能更改已有草稿的表单类型');
    const old = row.get('content')?.editing, next = input.content.editing;
    if (old?.id !== next?.id || old?.technical_revision !== next?.technical_revision) throw new FinanceError('DRAFT_TARGET_CHANGED', '草稿需保留原编辑对象及修订号；请从当前资料重新开始编辑', 'content.editing', 409);
    await row.update({ content: input.content, technical_revision: row.get('technical_revision') + 1 }, writeOptions(transaction));
    return row.toJSON();
  }
  async discard(input: any, actor: string, transaction: any) {
    this.keys(input, ['id', 'technical_revision']);
    await this.service.lock([`draft:${uuid(input.id, 'id')}`], transaction);
    const row = await this.get(input.id, actor, transaction); this.service.revision(row, input.technical_revision);
    await row.destroy(writeOptions(transaction)); return { id: input.id, discarded: true };
  }
  async submit(reference: any, action: string, payload: any, actor: string, transaction: any, work: () => Promise<any>) {
    this.keys(reference, ['id', 'technical_revision']);
    await this.service.lock([`draft:${uuid(reference.id, 'draft.id')}`], transaction);
    const row = await this.get(reference.id, actor, transaction); this.service.revision(row, reference.technical_revision);
    const expected = { saveFund: 'fund', saveEntity: 'entity', saveTrade: 'trade', saveBenchmark: 'benchmark', saveSeries: payload.data_type === 'benchmark' ? 'benchmarkValue' : 'series' }[action];
    const content = row.get('content');
    if (expected !== row.get('form_type') || content.editing?.id !== payload.id || content.editing?.technical_revision !== payload.technical_revision) throw new FinanceError('DRAFT_TARGET_CHANGED', '草稿与本次保存的表单、对象或原修订号不一致', 'draft', 409);
    const result = await work(); await row.destroy(writeOptions(transaction)); return result;
  }
  keys(value: any, allowed: string[]) {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new FinanceError('INVALID_DRAFT', '草稿请求格式不正确');
    const key = Object.keys(value).find(key => !allowed.includes(key));
    if (key) throw new FinanceError('FIELD_NOT_WRITABLE', '此字段不可写入草稿', key);
  }
}
