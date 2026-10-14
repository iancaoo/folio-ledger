import catalog from './field-catalog.json';

export const issueCategories = {
  missing_nav: '持仓无净值', unknown_estimate: '收益标记缺失', options: '枚举待确认',
  imports: '导入错误', composition: '成分缺数', future: '未来日期数据',
};

export function issueFieldLabel(path: string) {
  const labels = { 'compositions.valuation_date':'成分估值日期', 'compositions.items':'成分清单', 'compositions.items.units':'成分份额', 'compositions.items.currency':'成分币种', 'import_rows':'导入行', 'import_batches.file':'原文件', date:'日期', value:'数值' };
  if (Object.hasOwn(labels,path)) return labels[path];
  const field=path.split('.').pop(); const table=path.split('.')[0];
  const match=catalog.fields.find(row=>row.logical_table===table && row.mapping.split('；')[0].split(' + ').some(part=>(part.includes('.')?part.split('.')[1]:part)===field));
  return match?.label || '导入行字段';
}
