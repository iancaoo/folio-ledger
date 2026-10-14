export const seriesImportTypes = ['nav', 'returns', 'benchmark'];
export const seriesValueField = (type: string) => type === 'nav' ? 'nav_per_unit' : type === 'returns' ? 'mtd_return' : 'index_value';
export function seriesImportFields(type: string, targetMode = 'columns') {
  return [
    ...(targetMode === 'columns' ? [{ key: type === 'benchmark' ? 'benchmark_id' : 'isin', label: type === 'benchmark' ? '基准 ID' : 'ISIN', required: true }] : []),
    { key: 'date', label: '日期', required: true },
    { key: 'value', label: type === 'nav' ? '单位净值' : type === 'returns' ? 'MTD收益（比例值）' : '基准数值', required: true },
    ...(type === 'returns' ? [{ key: 'estimate', label: '是否预估值', required: false }] : []),
    { key: 'id', label: '记录 ID（修改时填写）', required: false },
  ];
}
