import catalog from './field-catalog.json';

export const TABLE_TITLES: Record<string, string> = {
  funds: '基金', share_classes: '份额类别', third_party_fund_details: '三方基金资料',
  proprietary_fund_details: '自营基金资料', third_party_class_terms: '三方份额条款',
  proprietary_class_terms: '自营份额条款', fund_versions: '基金资料版本',
  client_groups: '客户编号', investment_entities: '投资主体', entity_agreements: '主体协议',
  entity_products: '主体产品', transactions: '申赎记录', fund_navs: '基金净值',
  fund_returns: 'MTD 收益', composition_snapshots: '成分清单', composition_items: '成分明细',
  benchmarks: '基准', benchmark_values: '基准数值', fund_documents: '基金文档',
  option_sets: '字段候选集', option_values: '字段候选值', request_receipts: '请求凭据',
  position_write_guards: '持仓写入控制', import_batches: '导入批次', import_rows: '导入暂存行',
  entry_drafts: '个人草稿', file_operations: '文件处理任务', file_records: '受保护文件元数据',
  report_runs: '客户月报',
};

export type FieldDefinition = {
  name: string; type: string; title?: string; allowNull?: boolean; defaultValue?: unknown;
  primaryKey?: boolean; autoFill?: boolean; unique?: boolean; [key: string]: any;
};
export const fields: Record<string, FieldDefinition[]> = Object.fromEntries(Object.keys(TABLE_TITLES).map(name => [name, []]));
function add(table: string, field: FieldDefinition) {
  const index = fields[table].findIndex(f => f.name === field.name);
  if (index >= 0) fields[table][index] = { ...fields[table][index], ...field };
  else fields[table].push(field);
}
// NocoBase fills every UUID by default, including nullable foreign keys.
// Only record identity may be generated; absence of a relation must remain null.
const column = (table: string, name: string, type: string, rest: Record<string, any> = {}) => add(table, { name, type, ...(type === 'uuid' ? { autoFill: false } : {}), ...rest });

// The catalogue retains rules and unknown definitions. Only explicit column mappings become columns.
for (const source of catalog.fields) {
  if (!source.logical_table || !fields[source.logical_table]) continue;
  const mapping = source.mapping.split('；')[0];
  const components = mapping.split(' + ');
  for (let i = 0; i < components.length; i++) {
    const component = components[i];
    const [table, name] = component.includes('.') ? component.split('.') : [source.logical_table, component];
    if (!fields[table]) continue;
    let type = source.source_type.startsWith('数值') ? 'decimal'
      : source.source_type === '日期' ? 'dateOnly'
      : source.source_type === '整数' ? 'integer'
      : source.source_type === '布尔' ? 'boolean'
      : source.source_type === '时间' ? 'date' : 'text';
    if (components.length > 1 && i > 0 && !component.includes('.')) type = 'text';
    if (source.source_type === '单选') type = 'text';
    if (name.endsWith('_user_id')) type = 'bigInt';
    if (name.endsWith('_id') && !name.endsWith('_user_id')) type = 'uuid';
    if (name === 'gate_raw') type = 'json';
    // Requiredness may depend on fund kind: source metadata is enforced by the aggregate validator.
    column(table, name, type, { title: source.label });
  }
}

for (const table of Object.keys(fields)) {
  column(table, 'id', 'uuid', { primaryKey: true, autoFill: true, allowNull: false });
  column(table, 'technical_revision', 'integer', { defaultValue: 1, allowNull: false });
}
column('funds', 'fund_kind', 'string', { allowNull: false });
column('funds', 'business_version', 'integer', { defaultValue: 1, allowNull: false });
column('funds', 'saved_at', 'date', { allowNull: false });
for (const table of ['funds', 'share_classes', 'investment_entities']) column(table, 'is_deleted', 'boolean', { defaultValue: false, allowNull: false });
column('fund_versions', 'snapshot', 'json', { allowNull: false });
column('fund_versions', 'version_no', 'integer', { allowNull: false });
column('fund_versions', 'saved_at', 'date', { allowNull: false });
column('share_classes', 'isin', 'string', { allowNull: false, unique: true });
column('client_groups', 'client_code', 'string', { allowNull: false, unique: true });
column('transactions', 'is_void', 'boolean', { allowNull: false, defaultValue: false });
column('transactions', 'voided_at', 'date');
column('transactions', 'void_reason', 'text');
for (const table of ['transactions', 'fund_navs', 'fund_returns', 'benchmark_values']) {
  column(table, 'source_batch_id', 'uuid');
  column(table, 'source_sheet', 'text');
  column(table, 'source_row', 'integer');
}
column('position_write_guards', 'write_revision', 'integer', { defaultValue: 0, allowNull: false });
for (const name of ['actor_id', 'operation', 'request_key', 'payload_hash']) column('request_receipts', name, 'string', { allowNull: false });
column('request_receipts', 'result', 'json', { allowNull: false });
column('option_sets', 'source_key', 'string', { unique: true, allowNull: false });
column('option_sets', 'confirmed', 'boolean', { defaultValue: false, allowNull: false });
column('option_values', 'code', 'text', { allowNull: false });
column('option_values', 'label', 'text', { allowNull: false });
for (const name of ['owner_id', 'data_type', 'status', 'original_name', 'storage_key']) column('import_batches', name, 'text', { allowNull: false });
for (const name of ['context', 'mapping', 'preview', 'result']) column('import_batches', name, 'json');
column('import_batches', 'preview_revision', 'integer', { defaultValue: 0, allowNull: false });
for (const name of ['source_row', 'row_index']) column('import_rows', name, 'integer', { allowNull: false });
column('import_rows', 'source_sheet', 'text', { allowNull: false });
for (const name of ['raw', 'corrected', 'normalized', 'errors']) column('import_rows', name, 'json');
column('import_rows', 'selected', 'boolean', { defaultValue: true, allowNull: false });
column('import_rows', 'operation', 'text');
for (const name of ['owner_id', 'form_type']) column('entry_drafts', name, 'text', { allowNull: false });
column('entry_drafts', 'content', 'json', { allowNull: false });
for (const name of ['operation', 'status', 'storage_key']) column('file_operations', name, 'text', { allowNull: false });
column('file_operations', 'error', 'text');
column('file_operations', 'owner_id', 'text');
column('file_operations', 'context', 'json');
column('file_operations', 'result', 'json');
for (const name of ['title', 'filename', 'extname', 'mimetype', 'path', 'url']) column('file_records', name, 'text');
column('file_records', 'storageId', 'bigInt');
column('file_records', 'size', 'integer');
column('file_records', 'meta', 'json');
column('fund_documents', 'size_bytes', 'bigInt', { allowNull: false });
column('fund_documents', 'uploaded_at', 'date', { allowNull: false });
column('fund_documents', 'deleting', 'boolean', { defaultValue: false, allowNull: false });
for (const name of ['report_month', 'status', 'owner_id']) column('report_runs', name, 'text', { allowNull: false });
column('report_runs', 'report_date', 'dateOnly', { allowNull: false });
column('report_runs', 'attempts', 'integer', { defaultValue: 0, allowNull: false });
for (const name of ['engine_version', 'snapshot_sha256', 'report_html', 'check_html', 'error', 'review_note', 'published_by']) column('report_runs', name, 'text');
for (const name of ['snapshot_at', 'published_at']) column('report_runs', name, 'date');
for (const name of ['benchmark_ids', 'claim', 'snapshot', 'summary', 'findings', 'trace', 'finding_reviews']) column('report_runs', name, 'json');

export const relations: Array<[string, string, string, string, boolean?]> = [
  ['share_classes', 'fund', 'funds', 'fund_id'],
  ['third_party_fund_details', 'fund', 'funds', 'fund_id'],
  ['proprietary_fund_details', 'fund', 'funds', 'fund_id'],
  ['third_party_class_terms', 'share_class', 'share_classes', 'share_class_id'],
  ['proprietary_class_terms', 'share_class', 'share_classes', 'share_class_id'],
  ['fund_versions', 'fund', 'funds', 'fund_id'],
  ['investment_entities', 'client_group', 'client_groups', 'client_group_id'],
  ['entity_agreements', 'entity', 'investment_entities', 'entity_id'],
  ['entity_products', 'entity', 'investment_entities', 'entity_id'],
  ['transactions', 'entity', 'investment_entities', 'entity_id'],
  ['transactions', 'share_class', 'share_classes', 'share_class_id'],
  ['fund_navs', 'share_class', 'share_classes', 'share_class_id'],
  ['fund_returns', 'share_class', 'share_classes', 'share_class_id'],
  ['composition_snapshots', 'parent_fund', 'funds', 'parent_fund_id'],
  ['composition_items', 'snapshot', 'composition_snapshots', 'snapshot_id'],
  ['composition_items', 'child_share_class', 'share_classes', 'child_share_class_id'],
  ['benchmark_values', 'benchmark', 'benchmarks', 'benchmark_id'],
  ['fund_documents', 'fund', 'funds', 'fund_id'],
  ['position_write_guards', 'entity', 'investment_entities', 'entity_id'],
  ['position_write_guards', 'share_class', 'share_classes', 'share_class_id'],
  ['option_values', 'option_set', 'option_sets', 'option_set_id'],
  ['import_rows', 'batch', 'import_batches', 'batch_id'],
  ['file_operations', 'document', 'fund_documents', 'document_id', true],
  ['file_operations', 'fund', 'funds', 'fund_id', true],
  ['report_runs', 'entity', 'investment_entities', 'entity_id'],
];
for (const [table, , , foreignKey, optional] of relations) column(table, foreignKey, 'uuid', { allowNull: !!optional });

export const uniqueKeys: Record<string, string[][]> = {
  third_party_fund_details: [['fund_id']], proprietary_fund_details: [['fund_id']],
  third_party_class_terms: [['share_class_id']], proprietary_class_terms: [['share_class_id']],
  fund_versions: [['fund_id', 'version_no']],
  entity_agreements: [['entity_id', 'option_code']], entity_products: [['entity_id', 'option_code']],
  fund_navs: [['share_class_id', 'nav_date']], fund_returns: [['share_class_id', 'return_date']],
  composition_snapshots: [['parent_fund_id', 'valuation_date']],
  composition_items: [['snapshot_id', 'child_share_class_id']],
  benchmark_values: [['benchmark_id', 'value_date']],
  position_write_guards: [['entity_id', 'share_class_id']],
  request_receipts: [['actor_id', 'operation', 'request_key']],
  option_values: [['option_set_id', 'code']], import_rows: [['batch_id', 'row_index']],
  fund_documents: [['storage_key']],
};

// Conditional requirements remain in the aggregate validator. A common column
// is NOT NULL only when both fund schemas explicitly require that same column.
for (const [table, columns] of Object.entries(fields)) {
  for (const field of columns) {
    const sources = catalog.fields.filter(source => source.logical_table === table && source.mapping.split('；')[0].split(' + ').some(part => (part.includes('.') ? part.split('.')[1] : part) === field.name));
    if (!sources.length || sources.some(source => !source.required)) continue;
    if (['funds', 'share_classes'].includes(table) && new Set(sources.map(source => source.source_sheet)).size !== 2) continue;
    field.allowNull = false;
  }
}

export const collections = Object.entries(fields).map(([name, columns]) => ({
  name: `finance_${name}`, title: TABLE_TITLES[name], autoGenId: false,
  ...(name === 'file_records' ? { template: 'file', storage: 'finance_private' } : {}),
  createdBy: false, updatedBy: false, timestamps: true, createdAt: 'created_at', updatedAt: 'updated_at',
  fields: [
    ...columns.map(field => ({ ...field, interface: field.type === 'decimal' ? 'input' : undefined,
      uiSchema: { title: field.title || field.name, 'x-component': 'Input' } })),
    ...relations.filter(([table]) => table === name).map(([, relation, target, foreignKey]) => ({
      name: relation, type: 'belongsTo', target: `finance_${target}`, foreignKey, targetKey: 'id',
      onDelete: 'RESTRICT', constraints: true,
    })),
  ],
  indexes: (uniqueKeys[name] || []).map((key, i) => ({ name: `finance_${name}_u${i}`, unique: true, fields: key })),
}));

export { catalog };
