import { catalog, fields } from '../apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/models';

/** Clearly labelled synthetic data. No real client or investment facts are inferred. */
export function sampleValues(table: string, kind?: string) {
  const result: any = {};
  for (const source of catalog.fields) {
    if (source.logical_table !== table || !source.required) continue;
    if (kind && ['三方基金页面', '自营基金页面'].includes(source.source_sheet) && source.source_sheet !== (kind === 'third_party' ? '三方基金页面' : '自营基金页面')) continue;
    for (const part of source.mapping.split('；')[0].split(' + ')) {
      const name = part.includes('.') ? part.split('.')[1] : part;
      const field = fields[table].find(field => field.name === name);
      if (!field) continue;
      result[name] = field.type === 'decimal' ? '1' : field.type === 'dateOnly' ? '2026-01-01' : field.type === 'json' ? { value: '10', unit: '模拟单位' } : field.type === 'bigInt' ? '1' : '模拟值';
    }
  }
  return result;
}
export function sampleFund(prefix: string) {
  return { fund_kind: 'third_party',
    fund: { ...sampleValues('funds', 'third_party'), short_name: `模拟基金 ${prefix}`, full_name: `模拟基金全称 ${prefix}`, lei: `DEMO-${prefix}`, size_100m_usd: '123456789012345.12345678' },
    details: sampleValues('third_party_fund_details', 'third_party'),
    share_classes: ['A', 'B'].map(label => ({ values: { ...sampleValues('share_classes', 'third_party'), isin: `DEMO-${prefix}-${label}`, currency: 'USD', class_label: label }, terms: { ...sampleValues('third_party_class_terms', 'third_party'), management_fee_text: '第一档 1.5%\n第二档按协议执行' } })),
  };
}
export function sampleEntity(code: string, name: string) {
  return { client_code: code, entity: { ...sampleValues('investment_entities'), legal_name: `模拟主体 ${name}`, latest_cdd_approval_date: '2024-02-29' }, agreements: ['n/a'], products: [] };
}
export function sampleProprietary(prefix: string) {
  return { fund_kind: 'proprietary',
    fund: { ...sampleValues('funds', 'proprietary'), short_name: `模拟自营 ${prefix}`, full_name: `模拟自营全称 ${prefix}`, lei: `DEMO-P-${prefix}` },
    details: sampleValues('proprietary_fund_details', 'proprietary'),
    share_classes: ['A', 'B'].map(label => ({ values: { ...sampleValues('share_classes', 'proprietary'), isin: `DEMO-P-${prefix}-${label}`, currency: 'USD' }, terms: sampleValues('proprietary_class_terms', 'proprietary') })),
  };
}
