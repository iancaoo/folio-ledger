import React from 'react';
import { Alert, Modal, Table, Typography } from 'antd';
import { exportColumns, exportTitle } from '../shared/export';

const show = (value: any) => value === null || value === undefined ? '空值' : typeof value === 'object' ? JSON.stringify(value) : String(value);
export function MainExchangeMapping({ table }: { table: string }) {
  return <Alert type="info" message={`${exportTitle(table)}：已按原字段自动映射`} description="记录 ID 和固定关联不可修改。空值使用 \N；文本以反斜杠开头时写两个反斜杠。只提交选中行，文件外及未选中记录保留。" />;
}
export function inspectExchangeRow(row: any, table: string) {
  Modal.info({ title: `核对原文件第 ${row.source_row} 行`, width: 1100, okText: '关闭', content: <>
    {row.normalized.target_label && <Typography.Paragraph>基金：{row.normalized.target_label}。本基金选中 {row.normalized.group_row_count} 行，统一保存一个资料版本。</Typography.Paragraph>}
    <Typography.Paragraph>下表列出可保存的事实。ID、固定关联、状态及计算结果不由交换文件更改。</Typography.Paragraph>
    <Table<Record<string, any>> rowKey="key" size="small" pagination={false} scroll={{ y: 440 }} columns={[
      { title: '字段', dataIndex: 'label' }, { title: '原文件值', dataIndex: 'original' }, { title: '修正后输入', dataIndex: 'input' }, { title: '将保存的新值', dataIndex: 'value' }, { title: '当前旧值', dataIndex: 'old' },
    ]} dataSource={exportColumns(table).filter(column => column.role === 'fact').map(column => ({ key: column.key, label: column.label, original: show(row.raw[column.label]), input: show(row.corrected?.[column.label] ?? row.raw[column.label]), value: show(row.normalized.values?.[column.key]), old: show(row.normalized.existing_value?.[column.key]) }))} />
  </> });
}
export function confirmClientRename(row: any, onConfirm: () => Promise<any>) {
  const diff = row.normalized.client_diff;
  Modal.confirm({ title: '核对客户编号改名', okText: '确认改名及影响范围', cancelText: '返回核对', content: <>
    <Typography.Paragraph>客户编号：{diff.before} → {diff.after}</Typography.Paragraph>
    <Alert type="warning" message={`此分组下 ${diff.entity_count} 个主体将显示新编号，主体 ID 和历史交易保持原关联。已打开的旧表单需重新核对。`} />
  </>, onOk: onConfirm });
}
