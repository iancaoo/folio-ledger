import { catalog } from './models';
import { FinanceError } from './values';

export const draftLabels = { fund: '基金及份额', entity: '投资主体', trade: '申赎', series: '净值／收益', benchmark: '基准定义', benchmarkValue: '基准数值' };
const internal = new Set(['business_version', 'version_no', 'saved_at', 'is_deleted']);
function object(value: any, keys: string[], path: string) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new FinanceError('INVALID_DRAFT', '草稿内容格式不正确', path);
  const unexpected = Object.keys(value).find(key => !keys.includes(key));
  if (unexpected) throw new FinanceError('FIELD_NOT_WRITABLE', '此字段不可写入草稿', `${path}.${unexpected}`);
}
function textFields(value: any, keys: string[], path: string) {
  object(value, keys, path);
  for (const [key, item] of Object.entries(value)) if (item !== null && typeof item !== 'string') throw new FinanceError('INVALID_DRAFT', '草稿字段应保留原文本', `${path}.${key}`);
}
function sourceFields(table: string, value: any, path: string) {
  if (value === undefined) return;
  const keys = catalog.fields.filter(field => field.logical_table === table).flatMap(field => field.mapping.split('；')[0].split(' + ').map(part => part.includes('.') ? part.split('.')[1] : part)).filter(key => !internal.has(key));
  const { gate_raw, ...rest } = value || {};
  if (gate_raw !== undefined && keys.includes('gate_raw')) textFields(gate_raw, ['value', 'unit'], `${path}.gate_raw`);
  else if (gate_raw !== undefined) throw new FinanceError('FIELD_NOT_WRITABLE', '此字段不可写入草稿', `${path}.gate_raw`);
  object(value, keys, path); textFields(rest, keys, path);
}
function array(value: any, path: string, check: (item: any, path: string) => void) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 2000) throw new FinanceError('INVALID_DRAFT', '草稿明细应为列表，最多 2000 行', path);
  value.forEach((item, index) => check(item, `${path}.${index}`));
}
function compositions(value: any, path: string) {
  array(value, path, (list, path) => {
    object(list, ['id', 'valuation_date', 'items'], path);
    const { items, ...rest } = list; textFields(rest, ['id', 'valuation_date'], path);
    array(items, `${path}.items`, (row, path) => textFields(row, ['child_share_class_id', 'units', 'remarks'], path));
  });
}

// Drafts retain incomplete and invalid business text. Only the form structure is
// checked here; required fields and business rules run at formal submission.
export function validateDraft(type: string, content: any) {
  if (!Object.hasOwn(draftLabels, type)) throw new FinanceError('INVALID_DRAFT', '不支持的草稿表单类型', 'form_type');
  object(content, ['values', 'editing'], 'content');
  const values = content.values;
  object(values, Object.keys(values || {}), 'content.values');
  if (type === 'fund') {
    object(values, ['fund_kind', 'fund', 'details', 'share_classes', 'compositions'], 'content.values');
    if (!['third_party', 'proprietary'].includes(values.fund_kind)) throw new FinanceError('INVALID_DRAFT', '请选择基金类型', 'content.values.fund_kind');
    sourceFields('funds', values.fund, 'content.values.fund'); sourceFields(`${values.fund_kind}_fund_details`, values.details, 'content.values.details');
    array(values.share_classes, 'content.values.share_classes', (row, path) => {
      object(row, ['id', 'values', 'terms'], path); textFields(row.id === undefined ? {} : { id: row.id }, ['id'], path);
      sourceFields('share_classes', row.values, `${path}.values`); sourceFields(`${values.fund_kind}_class_terms`, row.terms, `${path}.terms`);
    });
    compositions(values.compositions, 'content.values.compositions');
  } else if (type === 'entity') {
    object(values, ['client_code', 'entity', 'agreements', 'products'], 'content.values');
    textFields(values.client_code === undefined ? {} : { client_code: values.client_code }, ['client_code'], 'content.values');
    sourceFields('investment_entities', values.entity, 'content.values.entity');
    for (const name of ['agreements', 'products']) array(values[name], `content.values.${name}`, (value, path) => { if (typeof value !== 'string') throw new FinanceError('INVALID_DRAFT', '选项应为文本', path); });
  } else if (type === 'trade') {
    const { entity_id, ...rest } = values || {}; sourceFields('transactions', rest, 'content.values');
    textFields(entity_id === undefined ? {} : { entity_id }, ['entity_id'], 'content.values');
  } else if (type === 'benchmark') sourceFields('benchmarks', values, 'content.values');
  else textFields(values, type === 'series' ? ['data_type', 'share_class_id', 'date', 'value', 'estimate_label'] : ['benchmark_id', 'value_date', 'index_value'], 'content.values');
  if (content.editing != null) {
    const editing = content.editing;
    if (!['fund', 'entity', 'trade', 'benchmark'].includes(type)) throw new FinanceError('INVALID_DRAFT', '此表单不使用记录编辑上下文', 'content.editing');
    object(editing, ['id', 'technical_revision', 'business_version', 'is_deleted', 'next_cdd_deadline', 'original_compositions'], 'content.editing');
    if (typeof editing.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(editing.id) || !Number.isSafeInteger(editing.technical_revision) || editing.technical_revision < 1) throw new FinanceError('INVALID_DRAFT', '编辑草稿需保留原记录标识及修订号', 'content.editing');
    if (editing.business_version !== undefined && (!Number.isSafeInteger(editing.business_version) || editing.business_version < 1)) throw new FinanceError('INVALID_DRAFT', '资料版本格式不正确');
    if (editing.is_deleted !== undefined && typeof editing.is_deleted !== 'boolean') throw new FinanceError('INVALID_DRAFT', '记录状态格式不正确');
    textFields(editing.next_cdd_deadline === undefined ? {} : { next_cdd_deadline: editing.next_cdd_deadline }, ['next_cdd_deadline'], 'content.editing');
    compositions(editing.original_compositions, 'content.editing.original_compositions');
  }
}
