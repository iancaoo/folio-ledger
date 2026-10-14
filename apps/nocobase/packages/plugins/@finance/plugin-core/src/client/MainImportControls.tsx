import React from 'react';
import { Alert, Collapse, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import { MainImportField } from '../shared/main-import';

const show = (value: any) => value === null || value === undefined ? '—' : Array.isArray(value) ? value.join('、') || '空' : typeof value === 'object' ? JSON.stringify(value) : String(value);
export function MainMapping({ fields, mapping, headers, busy, onChange }: { fields: MainImportField[]; mapping: any; headers: string[]; busy: boolean; onChange: (value: any) => void }) {
  const sections = [...new Set(fields.map(field => field.section))];
  return <Collapse style={{ width: '100%' }} defaultActiveKey={['识别']} items={sections.map(section => ({ key: section, label: `${section} · ${fields.filter(field => field.section === section && mapping[field.key]).length} 列已映射`, children: <Space wrap align="start">
    {fields.filter(field => field.section === section).map(field => <div key={field.key} style={{ width: 240 }}><p>{field.label}{field.required ? '（新增时必填）' : ''}</p><Select aria-label={`${field.label}映射`} style={{ width: '100%' }} showSearch allowClear disabled={busy} value={mapping[field.key]} options={headers.map(value => ({ value, label: value }))} onChange={value => { const next = { ...mapping }; if (value) next[field.key] = value; else delete next[field.key]; onChange(next); }} /></div>)}
  </Space> }))} />;
}
export function inspectMainRow(row: any, fields: MainImportField[], mapping: any) {
  Modal.info({ title: `核对原文件第 ${row.source_row} 行`, width: 1100, okText: '关闭', content: <>
    {row.normalized.target_label && <Typography.Paragraph>基金：{row.normalized.target_label}。该基金本次共 {row.normalized.group_row_count} 行，统一保存一个资料版本。</Typography.Paragraph>}
    <Typography.Paragraph>空白保留已有值；“#清空”清空选填项。新记录的必填项仍须完整填写。</Typography.Paragraph>
    <Table<Record<string, any>> rowKey="key" size="small" pagination={false} scroll={{ y: 440 }} columns={[
      { title: '字段', dataIndex: 'label', width: 190 }, { title: '原文件值', dataIndex: 'original' }, { title: '修正后输入', dataIndex: 'input' }, { title: '转换值／处理', dataIndex: 'value' }, { title: '当前旧值', dataIndex: 'old' },
    ]} dataSource={fields.filter(field => mapping[field.key]).map(field => ({ key: field.key, label: field.label, original: show(row.raw[mapping[field.key]]), input: show(row.corrected?.[mapping[field.key]] ?? row.raw[mapping[field.key]]), value: field.key in row.normalized.values ? row.normalized.values[field.key] === null ? '清空' : show(row.normalized.values[field.key]) : '未填写，保留已有值', old: show(row.normalized.existing_value?.[field.key]) }))} />
    {'next_cdd_deadline' in row.normalized && <Typography.Paragraph style={{ marginTop: 12 }}><Tag>只读计算</Tag>下次 CDD 截止日期：{show(row.normalized.next_cdd_deadline)}</Typography.Paragraph>}
  </> });
}
export function confirmCompositionReplacement(row: any, onConfirm: () => Promise<any>) {
  const diff = row.normalized.list_diff;
  const ids = [...new Set([...diff.before, ...diff.after].map(item => item.child_share_class_id))];
  const changes = ids.map(id => {
    const old = diff.before.find(item => item.child_share_class_id === id); const next = diff.after.find(item => item.child_share_class_id === id);
    return { id, isin: next?.isin || old?.isin, operation: !old ? '新增' : !next ? '移除' : old.units !== next.units || old.remarks !== next.remarks ? '修改' : '不变', old_units: show(old?.units), new_units: show(next?.units), old_remarks: show(old?.remarks), new_remarks: show(next?.remarks) };
  });
  Modal.confirm({ title: diff.patch ? '核对成分清单修改' : '核对完整成分清单替换', width: 1000, okText: diff.patch ? '确认修改选中成分' : '确认替换完整清单', cancelText: '返回核对', content: <>
    <Alert type="warning" message={diff.patch ? '以下展示完整清单的前后差异。本次只修改选中记录，未选中的成分继续保留；不会因文件缺行而移除成分。' : '本次选中行将替换这一组的完整清单，未列出的原成分会被移除。'} />
    <Typography.Paragraph>估值日期：{show(diff.old_date)} → {show(diff.new_date)}</Typography.Paragraph>
    <Table<Record<string, any>> rowKey="id" size="small" pagination={false} scroll={{ y: 400 }} dataSource={changes} columns={[
      { title: '成分 ISIN', dataIndex: 'isin' }, { title: '操作', dataIndex: 'operation', render: value => <Tag color={value === '移除' ? 'red' : value === '新增' ? 'green' : undefined}>{value}</Tag> },
      { title: '原份额', dataIndex: 'old_units' }, { title: '新份额', dataIndex: 'new_units' }, { title: '原备注', dataIndex: 'old_remarks' }, { title: '新备注', dataIndex: 'new_remarks' },
    ]} />
  </>, onOk: onConfirm });
}
