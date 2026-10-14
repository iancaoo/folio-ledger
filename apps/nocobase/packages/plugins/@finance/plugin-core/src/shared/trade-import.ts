/** Stable template names; mappings are explicit and never match names fuzzily. */
export const tradeImportFields = [
  { key: 'entity_id', label: '主体 ID', required: true },
  { key: 'isin', label: 'ISIN', required: true },
  { key: 'transaction_type', label: '交易类型', required: true },
  { key: 'confirmation_date', label: '确认日期', required: true },
  { key: 'amount', label: '金额', required: true },
  { key: 'currency', label: '币种', required: true },
  { key: 'confirmed_units', label: '确认份额', required: true },
  { key: 'confirmed_nav', label: '确认净值' },
  { key: 'fee_rate', label: '费率' },
  { key: 'fee', label: '费用' },
  { key: 'remarks', label: '备注' },
  { key: 'id', label: '交易 ID（修改时填写）' },
];

export const tradeDuplicateCriteria = (value: any) => Object.fromEntries(
  ['entity_id', 'share_class_id', 'confirmation_date', 'transaction_type', 'amount', 'confirmed_units'].map(key => [key, value[key]]),
);
