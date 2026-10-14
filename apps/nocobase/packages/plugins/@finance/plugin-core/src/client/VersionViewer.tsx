import React, { useState } from 'react';
import { Alert, Collapse, Descriptions, Select, Space, Table, Typography } from 'antd';
import catalog from '../shared/field-catalog.json';

function Facts({ table, values, kind }: any) {
  const seen = new Set<string>();
  const items = catalog.fields.flatMap(source => {
    if (source.logical_table !== table || ['三方基金页面', '自营基金页面'].includes(source.source_sheet) && source.source_sheet !== (kind === 'third_party' ? '三方基金页面' : '自营基金页面')) return [];
    return source.mapping.split('；')[0].split(' + ').flatMap((part, index) => {
      const [target, name] = part.includes('.') ? part.split('.') : [table, part];
      if (target !== table || seen.has(name) || ['business_version', 'saved_at'].includes(name)) return [];
      seen.add(name);
      const value = values?.[name];
      return [{ key: name, label: `${source.label}${name === 'size_100m_usd' ? '（亿美元）' : index ? '（规则／单位）' : ''}`, children: value === null || value === undefined || value === '' ? '—' : typeof value === 'boolean' ? value ? '已删除／停用' : '有效' : typeof value === 'object' ? Object.values(value).join(' / ') : String(value) }];
    });
  });
  return <Descriptions size="small" bordered column={2} items={items} contentStyle={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} />;
}
export function VersionViewer({ versions }: any) {
  const [selected, setSelected] = useState<number>();
  const current = versions.find(row => row.version_no === selected) || versions[0];
  if (!current) return <Alert type="info" message="暂无资料版本" />;
  const snapshot = current.snapshot;
  const kind = snapshot.fund.fund_kind;
  return <>
    <Alert type="info" showIcon message="保存时的基金资料，只读查看" description="此处不提供自动回滚。净值、收益、文档及动态计算结果不属于基金资料版本。" style={{ marginBottom: 16 }} />
    <Space style={{ marginBottom: 16 }}><Select value={current.version_no} onChange={setSelected} style={{ minWidth: 300 }} options={versions.map(row => ({ value: row.version_no, label: `V${row.version_no} · ${new Date(row.saved_at).toISOString()}` }))} /><Typography.Text>UTC 保存时间</Typography.Text></Space>
    <Collapse defaultActiveKey={['fund']} items={[
      { key: 'fund', label: '基金资料', children: <Facts table="funds" values={snapshot.fund} kind={kind} /> },
      { key: 'details', label: '分类资料与联系人', children: <Facts table={`${kind}_fund_details`} values={snapshot.details} kind={kind} /> },
      ...snapshot.share_classes.map(share => ({ key: share.id, label: `${share.class_label || share.isin} · ${share.currency}${share.is_deleted ? ' · 已停用' : ''}`, children: <><Facts table="share_classes" values={share} kind={kind} /><Facts table={`${kind}_class_terms`} values={share.terms} kind={kind} /></> })),
      ...(snapshot.compositions || []).map(list => ({ key: list.id, label: `成分清单 · ${list.valuation_date || '日期未填写'}`, children: <Table<Record<string, any>> rowKey="id" size="small" pagination={false} dataSource={list.items} columns={[
        { title: '成分子基金', render: (_, row) => row.child_name ? `${row.child_name} · ${row.child_class_label || row.child_isin}` : row.child_share_class_id },
        { title: '份额', dataIndex: 'units', render: value => value ?? '—' }, { title: '币种', dataIndex: 'child_currency' }, { title: '备注', dataIndex: 'remarks' },
      ]} /> })),
    ]} />
  </>;
}
