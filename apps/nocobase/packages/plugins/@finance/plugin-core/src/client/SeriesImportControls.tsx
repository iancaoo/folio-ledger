import React from 'react';
import { Alert, Modal, Select, Table, Typography } from 'antd';
import { seriesImportFields, seriesValueField } from '../shared/series-import';

export function SeriesMapping({ type, mode, headers, mapping, busy, onChange }: any) {
  const set = (key, value) => { const updated = { ...mapping }; if (value) updated[key] = value; else delete updated[key]; onChange(updated); };
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>{seriesImportFields(type, mode).map(field => <div key={field.key}><p>{type === 'returns' && field.key === 'value' ? 'MTD 收益' : field.label}列{field.required ? ' *' : ''}</p>
    <Select disabled={busy} aria-label={`${type === 'returns' && field.key === 'value' ? 'MTD 收益' : field.label}映射`} style={{ width: 190 }} allowClear={!field.required} value={mapping[field.key]} options={headers.map(value => ({ value, label: value }))} onChange={value => set(field.key, value)} />
  </div>)}{type === 'returns' && <div><p>收益列口径</p><Select disabled={busy} aria-label="收益列口径" style={{ width: 250 }} value={mapping.value_mode} onChange={value => set('value_mode', value)} options={[{ value: 'percent', label: '百分数：2 或 2% 表示 2%' }, { value: 'ratio', label: '比例值：0.02 表示 2%' }]} /></div>}</div>;
}

export function inspectSeriesRow(row: any, type: string, mode: string, mapping: any) {
  const date = type === 'nav' ? 'nav_date' : type === 'returns' ? 'return_date' : 'value_date';
  const columns = { date, value: seriesValueField(type), estimate: 'estimate_label', isin: 'share_class_id', benchmark_id: 'benchmark_id' };
  Modal.info({ title: `核对原文件第 ${row.source_row} 行`, width: 1000, okText: '关闭', content: <>
    <Typography.Paragraph>目标对象：{row.normalized.target_label}</Typography.Paragraph>
    {type === 'returns' && <Typography.Paragraph>将保存的收益为比例值：0.02 表示 2%。估算标记未映射或留空时保存为未知。</Typography.Paragraph>}
    <Table rowKey="key" size="small" pagination={false} scroll={{ x: 850 }} columns={[
      { title: '字段', dataIndex: 'label' }, { title: '原文件值', dataIndex: 'original' }, { title: '修正后输入', dataIndex: 'input' }, { title: '将保存的新值', dataIndex: 'value' }, { title: '当前旧值', dataIndex: 'old' },
    ]} dataSource={seriesImportFields(type, mode).map(field => ({ key: field.key, label: field.label, original: row.raw[mapping[field.key]] ?? '未映射', input: row.corrected?.[mapping[field.key]] ?? row.raw[mapping[field.key]] ?? '未映射', value: field.key === 'id' ? row.normalized.existing_id || '新增' : field.key === 'isin' ? row.normalized.isin : row.normalized.values[columns[field.key]] ?? '空', old: field.key === 'id' ? row.normalized.existing_id || '—' : field.key === 'isin' ? row.normalized.existing_values ? row.normalized.isin : '—' : row.normalized.existing_values?.[columns[field.key]] ?? '—' }))} />
    {row.normalized.warnings?.map(text => <Alert key={text} type="warning" message={text} style={{ marginTop: 8 }} />)}
  </> });
}
