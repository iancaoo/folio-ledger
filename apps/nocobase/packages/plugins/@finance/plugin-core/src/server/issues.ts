import { QueryTypes } from 'sequelize';
import { FinanceService, uuid } from './service';
import { pagination } from './queries';
import { dateOnly, FinanceError } from '../shared/values';
import { issueCategories } from '../shared/issues';
import { optionDefinitions } from '../shared/options';

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const types = { id: 'text', category: 'text', code: 'text', object_name: 'text', field_path: 'text', reason: 'text', record_table: 'text', record_id: 'text', fund_id: 'uuid', entity_id: 'uuid', share_class_id: 'uuid', business_date: 'date', context: 'jsonb', source_batch_id: 'uuid', source_sheet: 'text', source_row: 'integer' };
// These fragments are built only from code-owned definitions. User filters use
// SQL parameters, and import errors are filtered by owner before expansion.
const branch = (fields: Record<string, string>, from: string, where = 'TRUE') => `SELECT ${Object.entries(types).map(([key, type]) => `(${fields[key] || (key === 'context' ? "'{}'" : 'NULL')})::${type} AS ${key}`).join(',')} FROM ${from} WHERE ${where}`;
const shareName = "concat_ws(' · ',f.short_name,s.class_label,s.isin,s.currency)";
const source = { source_batch_id: 't.source_batch_id', source_sheet: 't.source_sheet', source_row: 't.source_row' };

function issueQuery() {
  const queries = [
    branch({ id: "'missing_nav:'||b.entity_id||':'||b.share_class_id", category: "'missing_nav'", code: "'MISSING_NAV'", object_name: `e.legal_name||' / '||${shareName}`, field_path: "'fund_navs.nav_per_unit'", reason: "'截至 '||CAST(:as_of AS text)||' 持有 '||b.units::text||' 份，没有不晚于检查日的净值'", record_table: "'share_classes'", record_id: 's.id', fund_id: 'f.id', entity_id: 'e.id', share_class_id: 's.id', business_date: ':as_of', context: "jsonb_build_object('units',b.units::text,'currency',s.currency,'deleted',f.is_deleted OR s.is_deleted OR e.is_deleted)" },
      'balances b JOIN finance_investment_entities e ON e.id=b.entity_id JOIN finance_share_classes s ON s.id=b.share_class_id JOIN finance_funds f ON f.id=s.fund_id',
      'b.units>0 AND NOT EXISTS (SELECT 1 FROM finance_fund_navs n WHERE n.share_class_id=s.id AND n.nav_date<=:as_of)'),
    branch({ id: "'unknown_estimate:'||t.id", category: "'unknown_estimate'", code: "'UNKNOWN_ESTIMATE'", object_name: shareName, field_path: "'fund_returns.estimate_label'", reason: "'估算标记未填写，当前保留为未知；不会自动当作正式值'", record_table: "'fund_returns'", record_id: 't.id', fund_id: 'f.id', share_class_id: 's.id', business_date: 't.return_date', context: "jsonb_build_object('mtd_return',t.mtd_return::text,'currency',s.currency,'deleted',f.is_deleted OR s.is_deleted)", ...source },
      'finance_fund_returns t JOIN finance_share_classes s ON s.id=t.share_class_id JOIN finance_funds f ON f.id=s.fund_id', "NULLIF(btrim(t.estimate_label),'') IS NULL"),
    branch({ id: "'options:'||d.source_key", category: "'options'", code: "'OPTIONS_UNCONFIRMED'", object_name: "d.source_sheet||' · '||d.label", field_path: "d.table_name||'.'||d.field", reason: "CASE WHEN o.id IS NULL THEN '候选集尚未初始化' WHEN NOT EXISTS(SELECT 1 FROM finance_option_values v WHERE v.option_set_id=o.id) THEN '候选值为空，需补齐并确认' ELSE '已有候选值尚待业务确认' END", record_table: "'option_sets'", record_id: 'o.id', context: "jsonb_build_object('source_key',d.source_key,'source_sheet',d.source_sheet,'source_row',d.source_row)" },
      'jsonb_to_recordset(CAST(:definitions AS jsonb)) AS d(source_key text,source_sheet text,source_row int,label text,table_name text,field text) LEFT JOIN finance_option_sets o ON o.source_key=d.source_key',
      'o.id IS NULL OR NOT o.confirmed OR NOT EXISTS(SELECT 1 FROM finance_option_values v WHERE v.option_set_id=o.id)'),
    branch({ id: "'import_error:'||r.id||':'||err.ordinality", category: "'imports'", code: "COALESCE(err.value->>'code','IMPORT_ERROR')", object_name: "b.original_name||' · '||r.source_sheet||' 第 '||r.source_row||' 行'", field_path: "COALESCE(err.value->>'field_path','import_rows')", reason: "COALESCE(err.value->>'message','该行需重新核对')", record_table: "'import_rows'", record_id: 'r.id', context: "jsonb_build_object('batch_id',b.id,'row_index',r.row_index,'status',b.status)", source_batch_id: 'b.id', source_sheet: 'r.source_sheet', source_row: 'r.source_row' },
      "finance_import_batches b JOIN finance_import_rows r ON r.batch_id=b.id CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.errors::jsonb,'[]'::jsonb)) WITH ORDINALITY err(value,ordinality)",
      "b.owner_id=:actor AND b.status IN ('staged','ready','needs_correction') AND r.selected"),
    branch({ id: "'import_failed:'||b.id", category: "'imports'", code: "'PARSE_FAILED'", object_name: 'b.original_name', field_path: "'import_batches.file'", reason: "COALESCE(b.context->>'parse_error','文件解析失败，可从原批次重试')", record_table: "'import_batches'", record_id: 'b.id', context: "jsonb_build_object('batch_id',b.id,'status',b.status)", source_batch_id: 'b.id' },
      'finance_import_batches b', "b.owner_id=:actor AND b.status='failed'"),
  ];
  const groupBase = { category: "'composition'", object_name: "c.parent_name||' · '||COALESCE(c.valuation_date::text,'未填日期')", record_table: "'composition_snapshots'", record_id: 'c.id', fund_id: 'c.parent_fund_id', business_date: 'c.valuation_date', context: "jsonb_build_object('composition_id',c.id)" };
  for (const [code, field, reason, condition] of [
    ['MISSING_DATE', 'compositions.valuation_date', '未填写统一估值日期，整组权重为空', 'c.valuation_date IS NULL'],
    ['EMPTY_COMPOSITION', 'compositions.items', '清单没有成分行', 'c.item_count=0'],
    ['MIXED_CURRENCIES', 'compositions.items.currency', '成分包含不同币种，第一阶段不换汇，整组权重为空', 'c.currency_count>1'],
    ['NON_POSITIVE_TOTAL', 'compositions.items.units', '成分总市值不大于零，不能计算权重', 'c.valuation_date IS NOT NULL AND c.item_count>0 AND c.missing_units=0 AND c.missing_nav=0 AND c.currency_count=1 AND c.total<=0'],
  ]) queries.push(branch({ ...groupBase, id: `${literal('composition:'+code+':')}||c.id`, code: literal(code), field_path: literal(field), reason: literal(reason) }, 'composition_groups c', condition));
  for (const [code, field, reason, condition] of [
    ['MISSING_UNITS', 'compositions.items.units', '缺少成分份额，整组权重为空', 'c.units IS NULL'],
    ['MISSING_NAV', 'fund_navs.nav_per_unit', '没有不晚于成分估值日的净值，整组权重为空', 'c.valuation_date IS NOT NULL AND c.nav_date IS NULL'],
  ]) queries.push(branch({ ...groupBase, id: `${literal('composition:'+code+':')}||c.item_id`, code: literal(code), field_path: literal(field), reason: literal(reason), object_name: "c.parent_name||' / '||c.child_name", share_class_id: 'c.share_class_id', context: "jsonb_build_object('composition_id',c.id,'item_id',c.item_id,'child_fund_id',c.child_fund_id,'currency',c.currency)" }, 'composition_rows c', `c.item_id IS NOT NULL AND ${condition}`));
  for (const [table, date] of [['transactions','confirmation_date'],['fund_navs','nav_date'],['fund_returns','return_date'],['benchmark_values','value_date']]) {
    const benchmark = table === 'benchmark_values', trade = table === 'transactions';
    queries.push(branch({ id: `${literal('future:'+table+':')}||t.id`, category: "'future'", code: "'FUTURE_DATE'", object_name: benchmark ? 'b.name' : trade ? `e.legal_name||' / '||${shareName}` : shareName, field_path: literal(`${table}.${date}`), reason: "'日期 '||t."+date+"::text||' 晚于检查日 '||CAST(:as_of AS text)||'，请核对是否按计划录入'", record_table: literal(table), record_id: 't.id', fund_id: benchmark ? 'NULL' : 'f.id', entity_id: trade ? 'e.id' : 'NULL', share_class_id: benchmark ? 'NULL' : 's.id', business_date: `t.${date}`, context: benchmark ? "jsonb_build_object('benchmark_id',t.benchmark_id)" : `jsonb_build_object('currency',s.currency,'deleted',f.is_deleted OR s.is_deleted${trade ? ' OR e.is_deleted' : ''})`, ...source },
      `finance_${table} t `+(benchmark ? 'JOIN finance_benchmarks b ON b.id=t.benchmark_id' : 'JOIN finance_share_classes s ON s.id=t.share_class_id JOIN finance_funds f ON f.id=s.fund_id'+(trade ? ' JOIN finance_investment_entities e ON e.id=t.entity_id' : '')), `t.${date}>:as_of${trade ? ' AND NOT t.is_void' : ''}`));
  }
  queries.push(branch({ ...groupBase, id: "'future:composition:'||c.id", category: "'future'", code: "'FUTURE_DATE'", field_path: "'compositions.valuation_date'", reason: "'成分估值日期晚于检查日，请核对日期'" }, 'composition_groups c', 'c.valuation_date>:as_of'));
  return `WITH balances AS (SELECT entity_id,share_class_id,sum(CASE WHEN transaction_type='赎回' THEN -confirmed_units ELSE confirmed_units END) AS units FROM finance_transactions WHERE NOT is_void AND confirmation_date<=:as_of GROUP BY entity_id,share_class_id),
  composition_rows AS MATERIALIZED (SELECT c.id,c.parent_fund_id,c.valuation_date,p.short_name AS parent_name,i.id AS item_id,i.units,s.id AS share_class_id,s.fund_id AS child_fund_id,s.currency,concat_ws(' · ',f.short_name,s.class_label,s.isin,s.currency) AS child_name,n.nav_date,n.nav_per_unit FROM finance_composition_snapshots c JOIN finance_funds p ON p.id=c.parent_fund_id LEFT JOIN finance_composition_items i ON i.snapshot_id=c.id LEFT JOIN finance_share_classes s ON s.id=i.child_share_class_id LEFT JOIN finance_funds f ON f.id=s.fund_id LEFT JOIN LATERAL (SELECT nav_date,nav_per_unit FROM finance_fund_navs WHERE share_class_id=s.id AND nav_date<=c.valuation_date ORDER BY nav_date DESC LIMIT 1) n ON TRUE),
  composition_groups AS (SELECT id,parent_fund_id,valuation_date,parent_name,count(item_id) AS item_count,count(DISTINCT currency) AS currency_count,count(*) FILTER(WHERE item_id IS NOT NULL AND units IS NULL) AS missing_units,count(*) FILTER(WHERE item_id IS NOT NULL AND nav_date IS NULL) AS missing_nav,sum(units*nav_per_unit) AS total FROM composition_rows GROUP BY id,parent_fund_id,valuation_date,parent_name),
  issues AS MATERIALIZED (${queries.join(' UNION ALL ')})`;
}

export class FinanceIssues {
  constructor(public service: FinanceService) {}
  async list(input: any, actor: string) {
    const paging = pagination(input);
    const params: any = { ...paging, actor, as_of: dateOnly(input.as_of || new Date().toISOString().slice(0,10), 'as_of', true), definitions: JSON.stringify(optionDefinitions.map(row => ({ ...row, table_name: row.table }))) };
    if (input.category && !Object.hasOwn(issueCategories, input.category)) throw new FinanceError('INVALID_FILTER', '请选择支持的问题类型', 'category');
    if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 200)) throw new FinanceError('INVALID_SEARCH', '搜索文本最多 200 字');
    if (['filter','sort','appends','owner_id'].some(key => input[key] !== undefined)) throw new FinanceError('INVALID_FILTER', '请使用质量工作台的筛选条件');
    const where = ['TRUE'];
    for (const key of ['fund_id','entity_id']) if (input[key]) { params[key] = uuid(input[key], key); where.push(`${key}=:${key}`); }
    if (input.search?.trim()) { params.search = `%${input.search.trim().replace(/[\\%_]/g,'\\$&')}%`; where.push('(object_name ILIKE :search OR field_path ILIKE :search OR reason ILIKE :search)'); }
    params.category = input.category || null;
    return this.service.db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async transaction => {
      const [result]: any = await this.service.db.sequelize.query(`${issueQuery()}, scoped AS MATERIALIZED (SELECT * FROM issues WHERE ${where.join(' AND ')}), filtered AS (SELECT * FROM scoped WHERE :category IS NULL OR category=:category)
      SELECT (SELECT count(*)::int FROM filtered) AS count, (SELECT COALESCE(jsonb_object_agg(category,total),'{}'::jsonb) FROM (SELECT category,count(*)::int AS total FROM scoped GROUP BY category) totals) AS summary,
      (SELECT COALESCE(jsonb_agg(to_jsonb(recent) ORDER BY recent.created_at DESC,recent.id DESC),'[]'::jsonb) FROM (SELECT id,original_name,status,created_at FROM finance_import_batches WHERE owner_id=:actor ORDER BY created_at DESC,id DESC LIMIT 5) recent) AS recent_imports,
      (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.category,r.business_date DESC NULLS LAST,r.id),'[]'::jsonb) FROM (SELECT i.*,COALESCE(b.owner_id=:actor,FALSE) AS source_access,CASE WHEN b.owner_id=:actor THEN b.original_name ELSE NULL END AS source_name FROM filtered i LEFT JOIN finance_import_batches b ON b.id=i.source_batch_id ORDER BY i.category,i.business_date DESC NULLS LAST,i.id LIMIT :page_size OFFSET :offset) r) AS rows`, { replacements: params, type: QueryTypes.SELECT, transaction });
      return { ...result, page: paging.page, page_size: paging.page_size, as_of: params.as_of };
    });
  }
}
