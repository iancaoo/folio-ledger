import catalog from './field-catalog.json';

// Only choices explicitly present in the reviewed source are seeded. Incomplete
// and disputed sets stay unconfirmed; each source field keeps its own namespace.
const candidates: Record<string, string[]> = {
  '三方基金页面:9': ['开放式', '封闭式'],
  '三方基金页面:10': ['JPY', 'USD', 'Euro'],
  '三方基金页面:12': ['已上架', '已上架未投', '待上架'],
  '三方基金页面:26': ['否'],
  '三方基金页面:28': ['多策略', '量化', '固收', '股票多空', '股票多头', '商品', '宏观', '波动率', 'CTA', '事件驱动', '加密', '私募风投'],
  '三方基金页面:30': ['均衡', '进攻', '机会', '现金管理'],
  '三方基金页面:31': ['全球', '美国', '欧洲', '大中华', '泛亚洲', '韩国', '日本', '新兴市场'],
  '自营基金页面:9': ['一级', '二级'],
  '自营基金页面:10': ['JPY', 'USD'],
  '自营基金页面:11': ['已上架', '待补充'],
  '自营基金页面:24': ['多策略', '量化', '固收', '股票多空', '股票多头', '商品', '波动率'],
  '自营基金页面:25': [],
  '自营基金页面:26': ['均衡', '进攻', '机会'],
  '自营基金页面:27': ['全球', '美国', '欧洲', '大中华', '泛亚洲', '韩国', '日本'],
  '客户页面:5': ['Key Account', 'General', 'Single Fund Account', 'FF', 'Internal', 'Strategy', 'LPF Client', 'Other Accounts-no fee', 'Dormant Account', 'Legacy'],
  '客户页面:6': ['Institutional', 'Corporate', 'Individual'],
  '客户页面:8': ['Active', 'Fully redeemed'],
  '客户页面:9': ['IAA', 'LOA(EAM)', 'LOA(AEA)', 'n/a'],
  '客户页面:10': ['OFC', '3PFund', 'EAM', 'AEA'],
  '客户页面:14': ['已发', '已发，已催', 'No need to send', 'ourself'],
  '客户页面:17': ['Medium'],
  '客户页面:20': ['ok'],
};
export const optionDefinitions = catalog.fields.flatMap(source => {
  if (!source.logical_table || !/下拉|单选|多选/.test(source.source_type)) return [];
  const parts = source.mapping.split('；')[0].split(' + ');
  return parts.flatMap((part, index) => {
    const field = part.includes('.') ? part.split('.')[1] : part;
    if (field.endsWith('_id') || field === 'gate_raw' || source.source_type.startsWith('数值') && index === 0) return [];
    let values = candidates[source.source_key] || [];
    if (field.endsWith('_frequency')) values = ['日', '周', '月', '季'];
    if (field.endsWith('_day_rule')) values = ['第一个工作日', '第一个自然日', '最后一个工作日', '最后一个自然日'];
    if (field.endsWith('_day_unit')) values = ['天', '工作日'];
    if (source.logical_table === 'transactions' && field === 'currency') values = ['CNY', 'USD', 'HKD'];
    if (field === 'transaction_type') values = ['初次申购', '追加申购', '赎回'];
    if (field === 'document_type') values = ['基金合同', '基金Teaser', 'Pitchbook', 'Letter', '其他'];
    return [{ source_key: index === 0 ? source.source_key : `${source.source_key}#${field}`,
      original_source_key: source.source_key, source_sheet: source.source_sheet, source_row: source.source_row,
      table: source.logical_table, field, label: `${source.label}${index ? '（规则／单位）' : ''}`,
      notes: source.notes, values, multiple: source.source_type === '多选',
      fixed: field === 'transaction_type',
      confirmed: values.length > 0 && !source.needs_business_confirmation && source.source_key !== '三方基金页面:26',
    }];
  });
});
export const optionDefinition = (sourceKey: string, field: string) => optionDefinitions.find(item => item.original_source_key === sourceKey && item.field === field);
