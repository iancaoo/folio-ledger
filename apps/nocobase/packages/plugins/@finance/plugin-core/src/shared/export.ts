import { fields, TABLE_TITLES } from './models';
import { FinanceError } from './values';
import { tradeImportFields } from './trade-import';

export const exportTables = ['funds', 'share_classes', 'third_party_fund_details', 'proprietary_fund_details', 'third_party_class_terms', 'proprietary_class_terms', 'client_groups', 'investment_entities', 'entity_agreements', 'entity_products', 'transactions', 'fund_navs', 'fund_returns', 'composition_snapshots', 'composition_items', 'benchmarks', 'benchmark_values', 'fund_documents', 'positions'];
export const exchangeSheet = 'Finance交换信息';
export const exchangeFormat = 'finance-business-v1';
export const exchangeSeries = { fund_navs: 'nav', fund_returns: 'returns', benchmark_values: 'benchmark' };
export const exchangeMainTables = exportTables.filter(table => !Object.hasOwn(exchangeSeries, table) && !['transactions', 'positions'].includes(table));
export const exchangeImportTypes = { ...Object.fromEntries(exchangeMainTables.map(table => [table, 'exchange'])), ...exchangeSeries, transactions: 'transactions' };
export const exportTitle = (table: string) => table === 'positions' ? '持仓核对（只读）' : TABLE_TITLES[table];
export type ExportColumn = { key: string; label: string; type: string; role: 'identity' | 'fact' | 'readonly'; unit: string };
const labels = { id: '记录 ID', fund_id: '基金 ID', share_class_id: '份额 ID', client_group_id: '客户分组 ID', entity_id: '主体 ID', parent_fund_id: '自营基金 ID', snapshot_id: '成分清单 ID', child_share_class_id: '成分份额 ID', benchmark_id: '基准 ID', technical_revision: '技术修订号', is_deleted: '已删除或停用', is_void: '已撤销', created_at: '创建时间', updated_at: '更新时间', source_batch_id: '来源批次 ID', source_sheet: '来源工作表', source_row: '来源原行号', _isin: '关联 ISIN', _currency: '关联份额币种', _fund_name: '基金简称', _entity_name: '主体名称', _client_code: '客户编号', _benchmark_name: '基准名称', next_cdd_deadline: '下次 CDD 截止日', _nav_date: '使用净值日期', _nav_per_unit: '使用单位净值', _market_value: '成分市值', _weight: '已列示成分市值权重', _issues: '成分计算缺口' };
const protectedFields = new Set(['technical_revision', 'business_version', 'saved_at', 'is_deleted', 'is_void', 'voided_at', 'void_reason', 'deleting', 'original_name', 'size_bytes', 'uploaded_at', 'source_batch_id', 'source_sheet', 'source_row', 'created_at', 'updated_at']);
const noExport = new Set(['storage_key', 'file_id']);
const extra: Record<string, string[]> = {
  funds: [], share_classes: ['_fund_name'], third_party_fund_details: ['_fund_name'], proprietary_fund_details: ['_fund_name'],
  third_party_class_terms: ['_fund_name', '_isin', '_currency'], proprietary_class_terms: ['_fund_name', '_isin', '_currency'],
  investment_entities: ['_client_code', 'next_cdd_deadline'], entity_agreements: ['_entity_name', '_client_code'], entity_products: ['_entity_name', '_client_code'],
  transactions: ['_fund_name', '_isin', '_currency', '_entity_name', '_client_code'], fund_navs: ['_fund_name', '_isin', '_currency'], fund_returns: ['_fund_name', '_isin', '_currency'],
  composition_snapshots: ['_fund_name'], composition_items: ['_fund_name', '_isin', '_currency', '_nav_date', '_nav_per_unit', '_market_value', '_weight', '_issues'],
  benchmark_values: ['_benchmark_name'], fund_documents: ['_fund_name'],
};
function unit(key: string, type: string) {
  if (['mtd_return', 'fee_rate', '_weight'].includes(key)) return '比例值；0.02 = 2%';
  if (key === 'size_100m_usd') return '亿美元';
  if (key.endsWith('_million_usd')) return '百万美元';
  if (key.startsWith('minimum_') && key.endsWith('_amount')) return `本行 ${key.replace(/_amount$/, '_currency')} 指定币种`;
  if (key.endsWith('_offset')) return `本行 ${key.replace(/_offset$/, '_day_unit')} 指定天／工作日`;
  if (key === 'index_value') return '基准原数值；原字段未定义货币单位';
  if (key === 'units' || key === 'confirmed_units') return '份';
  if (['amount', 'fee'].includes(key)) return '本行 currency 指定币种';
  if (['nav_per_unit', 'confirmed_nav', '_nav_per_unit'].includes(key)) return '份额币种／份';
  if (key === '_market_value' || key === 'market_value') return '本行币种；未换汇';
  if (type === 'dateOnly') return 'YYYY-MM-DD';
  if (type === 'date') return 'UTC，ISO 8601';
  if (type === 'decimal') return '原字段单位；精确十进制文本';
  return '';
}
function column(key: string, type: string, title?: string, role?: ExportColumn['role']): ExportColumn {
  return { key, label: `${labels[key] || title || key}（${key}）`, type,
    role: role || (protectedFields.has(key) ? 'readonly' : key === 'id' || key === 'fund_kind' || key.endsWith('_id') && !key.endsWith('_user_id') ? 'identity' : 'fact'), unit: unit(key, type) };
}
export function exportColumns(table: string): ExportColumn[] {
  if (!exportTables.includes(table)) throw new FinanceError('INVALID_EXPORT', '请选择允许导出的业务表', 'table', 403);
  if (table === 'positions') return Object.entries({ entity_id: '主体 ID', share_class_id: '份额 ID', entity_name: '主体名称', client_code: '客户编号', fund_name: '基金简称', fund_kind: '基金类型', isin: 'ISIN', class_label: '份额名称', currency: '币种', units: '持仓份额', nav_per_unit: '使用单位净值', nav_date: '使用净值日期', market_value: '持仓市值', entity_deleted: '主体已删除', fund_deleted: '基金已删除', class_deleted: '份额已停用' }).map(([key, title]) => column(key, ['units', 'nav_per_unit', 'market_value'].includes(key) ? 'decimal' : 'text', title, 'readonly'));
  return [...fields[table].filter(field => !noExport.has(field.name)).sort((a, b) => a.name === 'id' ? -1 : b.name === 'id' ? 1 : 0).map(field => column(field.name, field.type, field.title)), column('created_at', 'date'), column('updated_at', 'date'), ...(extra[table] || []).map(key => column(key, key === 'next_cdd_deadline' || key === '_nav_date' ? 'dateOnly' : ['_weight', '_market_value', '_nav_per_unit'].includes(key) ? 'decimal' : 'text', undefined, 'readonly'))];
}
// Text cells plus an explicit null token preserve NULL, empty strings, leading zeros,
// formula-like text and literal backslashes without Excel's number coercion.
export function exchangeText(value: any): string {
  if (value === null || value === undefined) return '\\N';
  const text = value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (text.length > 32767 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new FinanceError('EXCEL_CELL_LIMIT', '有字段超过 Excel 单元格限制或含不支持的控制字符，无法无损导出；请缩小范围并核对原记录');
  return text.startsWith('\\') ? `\\${text}` : text;
}
export function exchangeValue(value: string): string | null {
  if (value === '\\N') return null;
  if (value.startsWith('\\\\')) return value.slice(1);
  if (value.startsWith('\\')) throw new FinanceError('INVALID_EXCHANGE_VALUE', '交换文件中的反斜杠需写成两个；空值使用 \\N');
  return value;
}
export function exchangeMapping(table: string) {
  const names = Object.fromEntries(exportColumns(table).map(column => [column.key, column.label]));
  if (table === 'transactions') return { ...Object.fromEntries(tradeImportFields.map(field => [field.key, names[field.key === 'isin' ? '_isin' : field.key]])), fee_rate_mode: 'ratio' };
  if (exchangeMainTables.includes(table)) return Object.fromEntries(exportColumns(table).filter(column => column.role !== 'readonly').map(column => [column.key, column.label]));
  if (!Object.hasOwn(exchangeSeries, table)) return null;
  const type = exchangeSeries[table];
  return { id: names.id, ...(type === 'benchmark' ? { benchmark_id: names.benchmark_id } : { isin: names._isin }), date: names[type === 'nav' ? 'nav_date' : type === 'returns' ? 'return_date' : 'value_date'], value: names[type === 'nav' ? 'nav_per_unit' : type === 'returns' ? 'mtd_return' : 'index_value'], ...(type === 'returns' ? { estimate: names.estimate_label, value_mode: 'ratio' } : {}) };
}
