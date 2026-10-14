import { Op, QueryTypes } from 'sequelize';
import { FinanceError, dateOnly, Decimal } from '../shared/values';
import { FinanceService, uuid } from './service';

const literalSearch = (value: string) => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
export function pagination(input: any) {
  const page = input.page === undefined ? 1 : Number(input.page);
  const size = input.page_size === undefined ? 20 : Number(input.page_size);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger((page - 1) * Math.min(size, 200))) throw new FinanceError('INVALID_PAGINATION', '页码和每页条数必须为正整数');
  return { page, page_size: Math.min(size, 200), offset: (page - 1) * Math.min(size, 200) };
}
const joins = ` JOIN finance_share_classes s ON s.id=t.share_class_id JOIN finance_funds f ON f.id=s.fund_id`;
const shareLabel = `concat_ws(' · ',f.short_name,s.class_label,s.isin,s.currency)`;
const definitions: Record<string, any> = {
  funds: { joins: '', select: '', search: ['t.short_name', 't.full_name', 't.lei'], state: 't.is_deleted', kind: 't.fund_kind', fund: 't.id' },
  share_classes: { joins: ' JOIN finance_funds f ON f.id=t.fund_id', select: ",f.short_name AS _fund_name,f.fund_kind AS _fund_kind,f.is_deleted AS _fund_deleted,concat_ws(' · ',f.short_name,t.class_label,t.isin,t.currency) AS _share_label", search: ['t.isin','t.class_label','f.short_name','f.full_name'], state: '(t.is_deleted OR f.is_deleted)', kind: 'f.fund_kind', fund: 't.fund_id', currency: 't.currency' },
  client_groups: { joins: '', select: '', search: ['t.client_code'] },
  investment_entities: { joins: ' JOIN finance_client_groups g ON g.id=t.client_group_id', select: ',g.client_code AS _client_code', search: ['t.legal_name','t.common_name','g.client_code'], state: 't.is_deleted', entity: 't.id', client: 'g.client_code' },
  transactions: { joins: joins + ' JOIN finance_investment_entities e ON e.id=t.entity_id JOIN finance_client_groups g ON g.id=e.client_group_id', select: `,${shareLabel} AS _share_label,e.legal_name AS _entity_name,g.client_code AS _client_code`, search: ['f.short_name','s.isin','e.legal_name','g.client_code'], state: 't.is_void', date: 'confirmation_date', fund: 'f.id', share: 's.id', entity: 'e.id', currency: 't.currency' },
  fund_navs: { joins, select: `,${shareLabel} AS _share_label`, search: ['f.short_name','s.isin','s.class_label'], date: 'nav_date', fund: 'f.id', share: 's.id', currency: 's.currency' },
  fund_returns: { joins, select: `,${shareLabel} AS _share_label`, search: ['f.short_name','s.isin','s.class_label'], date: 'return_date', fund: 'f.id', share: 's.id', currency: 's.currency' },
  benchmarks: { joins: '', select: '', search: ['t.name','t.category'], benchmark: 't.id' },
  benchmark_values: { joins: ' JOIN finance_benchmarks b ON b.id=t.benchmark_id', select: ',b.name AS _benchmark_name', search: ['b.name','b.category'], date: 'value_date', benchmark: 't.benchmark_id' },
  fund_versions: { joins: ' JOIN finance_funds f ON f.id=t.fund_id', select: ',f.short_name AS _fund_name', search: ['f.short_name'], fund: 't.fund_id' },
};
export class FinanceQueries {
  constructor(public service: FinanceService) {}
  async sql(text: string, replacements: any, transaction?: any): Promise<any[]> {
    return this.service.db.sequelize.query(text, { replacements, transaction, type: QueryTypes.SELECT });
  }
  search(input: any, columns: string[], where: string[], params: any) {
    if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200)) throw new FinanceError('INVALID_SEARCH', '搜索文本最多 200 字');
    if (input.search?.trim()) { params.search = literalSearch(input.search.trim()); where.push(`(${columns.map(column => `${column} ILIKE :search`).join(' OR ')})`); }
  }
  async list(input: any) {
    const table = input.table; const definition = Object.hasOwn(definitions, table) ? definitions[table] : null;
    if (!definition) throw new FinanceError('INVALID_RESOURCE', '此列表不可直接读取', 'table', 403);
    if (input.filter !== undefined || input.sort !== undefined || input.appends !== undefined) throw new FinanceError('INVALID_FILTER', '请使用 Finance 支持的筛选条件');
    const paging = pagination(input); const params: any = { ...paging }; const where = ['TRUE'];
    this.search(input, definition.search, where, params);
    for (const [key, column] of Object.entries({ fund_id: definition.fund, share_class_id: definition.share, entity_id: definition.entity, benchmark_id: definition.benchmark })) if (input[key]) {
      if (!column) throw new FinanceError('INVALID_FILTER', '该列表不支持此关联筛选', key);
      params[key] = uuid(input[key], key); where.push(`${column}=:${key}`);
    }
    if (input.id) { params.id = uuid(input.id, 'id'); where.push('t.id=:id'); }
    if (input.ids !== undefined) {
      const ids = typeof input.ids === 'string' ? input.ids.split(',') : input.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 50) throw new FinanceError('INVALID_ID', '一次最多查询 50 个明确标识', 'ids');
      params.ids = ids.map(id => uuid(id, 'ids')); where.push('t.id IN (:ids)');
    }
    if (input.state && input.state !== 'all') {
      if (!definition.state || !['active','inactive'].includes(input.state)) throw new FinanceError('INVALID_FILTER', '请选择有效、已删除／撤销或全部', 'state');
      where.push(`${definition.state}=${input.state === 'inactive' ? 'TRUE' : 'FALSE'}`);
    }
    if (input.fund_kind) {
      if (!definition.kind || !['third_party','proprietary'].includes(input.fund_kind)) throw new FinanceError('INVALID_FILTER', '请选择三方或自营基金', 'fund_kind');
      params.kind = input.fund_kind; where.push(`${definition.kind}=:kind`);
    }
    if (input.currency) {
      if (!definition.currency || typeof input.currency !== 'string' || input.currency.length > 30) throw new FinanceError('INVALID_FILTER', '该列表不支持此币种筛选', 'currency');
      params.currency = input.currency; where.push(`${definition.currency}=:currency`);
    }
    if (input.client_code) { if (!definition.client || typeof input.client_code !== 'string') throw new FinanceError('INVALID_FILTER','该列表不支持客户编号筛选'); params.client_code=input.client_code; where.push(`${definition.client}=:client_code`); }
    for (const [key, operator] of [['date_from','>='],['date_to','<=']]) if (input[key]) {
      if (!definition.date) throw new FinanceError('INVALID_FILTER', '该列表没有可筛选的业务日期', key);
      params[key] = dateOnly(input[key], key, true); where.push(`t.${definition.date}${operator}:${key}`);
    }
    if (params.date_from && params.date_to && params.date_from > params.date_to) throw new FinanceError('INVALID_DATE_ORDER', '开始日期不能晚于结束日期');
    if (input.transaction_type) { if (table !== 'transactions' || !['初次申购','追加申购','赎回'].includes(input.transaction_type)) throw new FinanceError('INVALID_FILTER','交易类型无效'); params.transaction_type=input.transaction_type; where.push('t.transaction_type=:transaction_type'); }
    if (input.estimate) {
      if (table !== 'fund_returns' || !['是','否','unknown'].includes(input.estimate)) throw new FinanceError('INVALID_FILTER','估算标记筛选无效');
      if (input.estimate === 'unknown') where.push("(t.estimate_label IS NULL OR t.estimate_label NOT IN ('是','否'))");
      else { params.estimate=input.estimate; where.push('t.estimate_label=:estimate'); }
    }
    const order = input.order || 'newest';
    if (!['newest','oldest','date_desc','date_asc'].includes(order) || order.startsWith('date_') && !definition.date) throw new FinanceError('INVALID_SORT', '该列表不支持此排序');
    const ordering = order.startsWith('date_') ? `t.${definition.date} ${order === 'date_desc' ? 'DESC' : 'ASC'},t.id ASC` : `t.created_at ${order === 'oldest' ? 'ASC' : 'DESC'},t.id ASC`;
    const from = `FROM finance_${table} t${definition.joins} WHERE ${where.join(' AND ')}`;
    return this.service.db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async transaction => {
      const [{ count }] = await this.sql(`SELECT count(*)::int AS count ${from}`, params, transaction);
      const rows = await this.sql(`SELECT t.*${definition.select} ${from} ORDER BY ${ordering} LIMIT :page_size OFFSET :offset`, params, transaction);
      if (table === 'funds' && rows.length) {
        const shares = await this.service.model('share_classes').findAll({ where: { fund_id: { [Op.in]: rows.map(row => row.id) } }, order: [['isin','ASC']], transaction });
        for (const row of rows) row._share_classes = shares.filter(share => share.get('fund_id') === row.id).map(share => share.toJSON());
      }
      return { rows, count, page: paging.page, page_size: paging.page_size };
    });
  }
  async summary() {
    const [row] = await this.sql(`SELECT (SELECT count(*)::int FROM finance_funds) AS funds,(SELECT count(*)::int FROM finance_share_classes) AS share_classes,(SELECT count(*)::int FROM finance_investment_entities) AS investment_entities,(SELECT count(*)::int FROM finance_transactions WHERE NOT is_void) AS transactions`, {});
    return row;
  }
  // Exact-date coverage is a check, not an inferred reporting deadline.
  async navCoverage(input: any) {
    const params: any = { ...pagination(input), as_of: dateOnly(input.as_of, 'as_of', true) };
    const where = ['NOT s.is_deleted', 'NOT f.is_deleted'];
    if (input.fund_id) { params.fund_id = uuid(input.fund_id, 'fund_id'); where.push('f.id=:fund_id'); }
    if (input.share_class_id) { params.share_class_id = uuid(input.share_class_id, 'share_class_id'); where.push('s.id=:share_class_id'); }
    this.search(input, ['f.short_name', 's.class_label', 's.isin'], where, params);
    if (input.status && !['all', 'missing', 'recorded'].includes(input.status)) throw new FinanceError('INVALID_FILTER', '请选择全部、未录入或已录入', 'status');
    const from = `FROM finance_share_classes s JOIN finance_funds f ON f.id=s.fund_id
      LEFT JOIN finance_fund_navs exact ON exact.share_class_id=s.id AND exact.nav_date=:as_of
      WHERE ${where.join(' AND ')}`;
    const status = input.status === 'missing' ? ' AND exact.id IS NULL' : input.status === 'recorded' ? ' AND exact.id IS NOT NULL' : '';
    return this.service.db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async transaction => {
      const [summary] = await this.sql(`SELECT count(*)::int AS total, count(exact.id)::int AS recorded,
        count(*) FILTER (WHERE exact.id IS NULL)::int AS missing ${from}`, params, transaction);
      const rows = await this.sql(`SELECT s.id,s.fund_id,s.class_label,s.isin,s.currency,f.short_name AS fund_name,
        f.fund_kind,exact.nav_per_unit::text AS exact_nav,
        (SELECT n.nav_date::text FROM finance_fund_navs n WHERE n.share_class_id=s.id AND n.nav_date<=:as_of ORDER BY n.nav_date DESC LIMIT 1) AS latest_date,
        (SELECT n.nav_per_unit::text FROM finance_fund_navs n WHERE n.share_class_id=s.id AND n.nav_date<=:as_of ORDER BY n.nav_date DESC LIMIT 1) AS latest_nav
        ${from}${status} ORDER BY f.short_name,f.id,s.class_label,s.id LIMIT :page_size OFFSET :offset`, params, transaction);
      return { rows, summary, as_of: params.as_of, count: input.status === 'missing' ? summary.missing : input.status === 'recorded' ? summary.recorded : summary.total, page: params.page, page_size: params.page_size };
    });
  }
  async lookup(input: any) {
    const resource = input.resource;
    if (!['funds','share_classes','investment_entities','benchmarks'].includes(resource)) throw new FinanceError('INVALID_RESOURCE','请选择允许的关联类型','resource',403);
    const state = ['funds','share_classes','investment_entities'].includes(resource) ? input.state || 'active' : undefined;
    const result = await this.list({ ...input, table: resource, state: input.ids ? 'all' : state });
    return { ...result, rows: result.rows.map(row => ({ value: row.id, label: resource === 'share_classes' ? row._share_label : resource === 'funds' ? `${row.short_name} · ${row.lei || row.id}` : resource === 'investment_entities' ? `${row.legal_name} · ${row._client_code}` : `${row.name} · ${row.id}`,
      disabled: state === 'active' && !!(row.is_deleted || row._fund_deleted), record: row })) };
  }
  async seriesAt(input: any) {
    const [table, parent, date] = this.service.seriesConfig(input.data_type);
    const value = await this.service.model(table).findOne({ where: { [parent]: uuid(input.parent_id,parent), [date]: dateOnly(input.date,'date',true) } });
    return value?.toJSON() || null;
  }
  async userLookup(input: any) {
    const paging = pagination(input);
    if (input.group && !['all','product'].includes(input.group)) throw new FinanceError('INVALID_FILTER','负责人范围无效');
    if (input.search && (typeof input.search !== 'string' || input.search.length > 200)) throw new FinanceError('INVALID_SEARCH','姓名最多 200 字');
    const memberships = input.group === 'product' && !this.service.demoMode ? await this.service.db.getModel('rolesUsers').findAll({ where: { roleName: 'finance_product' }, attributes: ['userId'] }) : null;
    const memberIds = memberships?.map(row => String(row.get('userId')));
    let ids;
    if (input.ids !== undefined) {
      ids = typeof input.ids === 'string' ? input.ids.split(',') : input.ids;
      if (!Array.isArray(ids) || ids.length > 50 || !ids.length || ids.some(id => !/^\d+$/.test(String(id)))) throw new FinanceError('INVALID_ID','负责人标识无效');
    }
    const { count, rows } = await this.service.db.getModel('users').findAndCountAll({ attributes: ['id','nickname','username'],
      where: { ...(ids || memberIds ? { id: { [Op.in]: ids || memberIds } } : {}), ...(input.search ? { [Op.or]: [{ nickname: { [Op.iLike]: literalSearch(input.search) } }, { username: { [Op.iLike]: literalSearch(input.search) } }] } : {}) },
      order: [['id','ASC']], limit: paging.page_size, offset: paging.offset });
    return { count, page: paging.page, page_size: paging.page_size, rows: rows.map(row => ({ value: String(row.id), label: `${row.get('nickname') || row.get('username') || '用户'} · ${row.id}`, disabled: !!memberIds && !memberIds.includes(String(row.id)), record: row.toJSON() })) };
  }
  async positions(input: any, unpaged = false, snapshot?: any) {
    const params: any = { ...pagination(input), as_of: dateOnly(input.as_of || new Date().toISOString().slice(0,10),'as_of',true) };
    const where = ['TRUE'];
    for (const [key, column] of [['entity_id','e.id'],['share_class_id','s.id'],['fund_id','f.id']]) if (input[key]) { params[key]=uuid(input[key],key); where.push(`${column}=:${key}`); }
    this.search(input,['e.legal_name','g.client_code','f.short_name','s.isin'],where,params);
    if (input.currency) { if (typeof input.currency !== 'string' || input.currency.length > 30) throw new FinanceError('INVALID_FILTER','币种筛选无效'); params.currency=input.currency; where.push('s.currency=:currency'); }
    if (input.balance && !['all','positive','zero'].includes(input.balance)) throw new FinanceError('INVALID_FILTER','请选择全部、有持仓或零持仓');
    if (input.balance === 'positive') where.push('b.units>0'); if (input.balance === 'zero') where.push('b.units=0');
    const cte = `WITH balances AS (SELECT entity_id,share_class_id,sum(CASE WHEN transaction_type='赎回' THEN -confirmed_units ELSE confirmed_units END) AS units FROM finance_transactions WHERE NOT is_void AND confirmation_date<=:as_of${input.entity_id ? ' AND entity_id=:entity_id' : ''} GROUP BY entity_id,share_class_id)`;
    const from = `FROM balances b JOIN finance_investment_entities e ON e.id=b.entity_id JOIN finance_client_groups g ON g.id=e.client_group_id JOIN finance_share_classes s ON s.id=b.share_class_id JOIN finance_funds f ON f.id=s.fund_id`;
    const read = async (transaction: any) => {
      const [{ count }] = await this.sql(`${cte} SELECT count(*)::int AS count ${from} WHERE ${where.join(' AND ')}`,params,transaction);
      const rows = await this.sql(`${cte} SELECT e.id AS entity_id,s.id AS share_class_id,e.legal_name AS entity_name,g.client_code AS client_code,f.short_name AS fund_name,f.fund_kind,s.isin,s.class_label,s.currency,b.units::text,nav.nav_per_unit::text,nav.nav_date::text,(b.units*nav.nav_per_unit)::text AS market_value,e.is_deleted AS entity_deleted,f.is_deleted AS fund_deleted,s.is_deleted AS class_deleted ${from} LEFT JOIN LATERAL (SELECT n.nav_per_unit,n.nav_date FROM finance_fund_navs n WHERE n.share_class_id=s.id AND n.nav_date<=:as_of ORDER BY n.nav_date DESC LIMIT 1) nav ON TRUE WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC,e.id ASC,s.id ASC${unpaged ? '' : ' LIMIT :page_size OFFSET :offset'}`,params,transaction);
      for (const row of rows) for (const key of ['units','nav_per_unit','market_value']) if (row[key] !== null) row[key]=new Decimal(row[key]).toFixed();
      return { rows, count, page: params.page, page_size: params.page_size };
    };
    return snapshot ? read(snapshot) : this.service.db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, read);
  }
}
