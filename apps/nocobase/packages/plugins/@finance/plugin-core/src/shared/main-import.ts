import { catalog, fields } from './models';

export type MainImportField = { key: string; label: string; table?: string; field?: string; part?: string; type?: string; required?: boolean; section?: string };
const system = new Set(['id', 'is_deleted', 'business_version', 'saved_at', 'technical_revision']);
export const mainImportTypes = ['entities', 'funds', 'compositions'];
export function sourceImportFields(table: string, prefix: string, section: string, kind?: string): MainImportField[] {
  const seen = new Set<string>();
  return catalog.fields.flatMap(source => {
    if (source.logical_table !== table || kind && ['三方基金页面', '自营基金页面'].includes(source.source_sheet) && source.source_sheet !== (kind === 'third_party' ? '三方基金页面' : '自营基金页面')) return [];
    return source.mapping.split('；')[0].split(' + ').flatMap((part, index) => {
      const name = part.includes('.') ? part.split('.')[1] : part;
      const definition = fields[table].find(field => field.name === name);
      if (!definition || system.has(name) || seen.has(name) || name.endsWith('_id') && !name.endsWith('_user_id')) return [];
      seen.add(name);
      const contact = name.startsWith('investment_team_') ? '投资团队 · ' : name.startsWith('ir_') ? 'IR · ' : name.startsWith('administrator_') ? '行政管理人 · ' : '';
      const label = `${section} · ${contact}${source.label}${index ? '（规则／单位）' : ''}${name.endsWith('_user_id') ? '（用户 ID）' : ''}`;
      if (name === 'gate_raw') return ['value', 'unit'].map(part => ({ key: `${prefix}.${name}.${part}`, label: `${label}（${part === 'value' ? '原数值' : '原单位／规则'}）`, table, field: name, part, type: 'text', required: source.required, section }));
      return [{ key: `${prefix}.${name}`, label, table, field: name, type: definition.type, required: source.required, section }];
    });
  });
}
export function mainImportFields(type: string, kind = 'third_party'): MainImportField[] {
  if (type === 'entities') return [
    { key: 'id', label: '主体 ID（修改时填写）', section: '识别' }, { key: 'client_code', label: '客户编号', required: true, section: '识别' },
    ...sourceImportFields('investment_entities', 'entity', '主体'),
    { key: 'agreements', label: '签署协议（每行一个选项）', type: 'multiple', section: '主体' },
    { key: 'products', label: '产品（每行一个选项）', type: 'multiple', section: '主体' },
  ];
  const identity: MainImportField[] = [
    { key: 'row_type', label: '行类型', section: '识别' }, { key: 'fund_id', label: '基金 ID', section: '识别' },
    { key: 'fund_key', label: '新基金分组键', section: '识别' },
  ];
  const composition: MainImportField[] = [
    { key: 'list_id', label: '成分清单 ID', section: '成分' }, { key: 'list_key', label: '无日期新清单分组键', section: '成分' },
    { key: 'valuation_date', label: '成分估值日期', type: 'dateOnly', section: '成分' },
    { key: 'child_isin', label: '成分 ISIN', section: '成分' }, { key: 'units', label: '成分份额', type: 'decimal', section: '成分' },
    { key: 'remarks', label: '成分备注', type: 'text', section: '成分' },
  ];
  if (type === 'compositions') return [...identity.filter(field => field.key !== 'fund_key'), ...composition];
  return [...identity, { key: 'share_id', label: '份额 ID（可选）', section: '识别' },
    ...sourceImportFields('funds', 'fund', '基金', kind), ...sourceImportFields(`${kind}_fund_details`, 'details', '基金详情', kind),
    ...sourceImportFields('share_classes', 'share', '份额', kind), ...sourceImportFields(`${kind}_class_terms`, 'terms', '份额条款', kind),
    ...(kind === 'proprietary' ? composition : []),
  ];
}
