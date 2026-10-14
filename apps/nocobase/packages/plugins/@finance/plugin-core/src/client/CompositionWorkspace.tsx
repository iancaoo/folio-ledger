import React, { useEffect, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Empty, Form, Input, Progress, Select, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Decimal } from '../shared/values';
import { RemoteSelect } from './RemoteSelect';
import { DateText, Num, TwoLine, numColumn } from './ui';

export const compositionDraft = list => ({ id: list.id, valuation_date: list.valuation_date || null,
  items: (list.items || []).map(row => ({ child_share_class_id: row.child_share_class_id, units: row.units ?? null, remarks: row.remarks ?? null })),
});

export function CompositionEditor({ form }: any) {
  const values = Form.useWatch('compositions', form) || [];
  return <>
    <Typography.Title level={4}>成分完整清单</Typography.Title>
    <Typography.Paragraph type="secondary">每组代表一个估值日期的完整清单，与本次基金资料一起保存并增加一个版本。日期、份额可暂留空；缺数或跨币种时整组权重不计算。</Typography.Paragraph>
    <Form.List name="compositions">{(groups, { add, remove }) => <>
      {groups.map((group, index) => <Card size="small" key={group.key} title={`成分清单 ${index + 1}`} style={{ marginBottom: 16 }} extra={!values[index]?.id && <Button danger type="link" onClick={() => remove(group.name)}>移除未保存清单</Button>}>
        <Form.Item name={[group.name, 'id']} hidden><Input /></Form.Item>
        <Form.Item name={[group.name, 'valuation_date']} label={`第 ${index + 1} 组估值日期`} extra="统一用于本组所有行。为空时可保存资料，但不计算权重。"><Input type="date" style={{ maxWidth: 250 }} /></Form.Item>
        <Form.List name={[group.name, 'items']}>{(rows, controls) => <>
          {rows.map((row, i) => <Space key={row.key} align="start" wrap>
            <Form.Item name={[row.name, 'child_share_class_id']} label={`第 ${index + 1} 组成分份额 ${i + 1}`} rules={[{ required: true, message: '请选择三方基金份额' }]} style={{ width: 330 }}><RemoteSelect resource="share_classes" params={{ fund_kind: 'third_party' }} /></Form.Item>
            <Form.Item name={[row.name, 'units']} label="成分份额" style={{ width: 160 }}><Input inputMode="decimal" placeholder="可空，保留原精度" /></Form.Item>
            <Form.Item name={[row.name, 'remarks']} label="成分备注" style={{ width: 220 }}><Input /></Form.Item>
            <Form.Item label="本行日期"><Typography.Text>{values[index]?.valuation_date || '未填写'}</Typography.Text></Form.Item>
            <Form.Item label=" "><Button danger onClick={() => controls.remove(row.name)}>移除成分行</Button></Form.Item>
          </Space>)}
          <Button block onClick={() => controls.add({})}>为第 {index + 1} 组添加成分行</Button>
        </>}</Form.List>
      </Card>)}
      <Button block onClick={() => add({ valuation_date: null, items: [{}] })}>添加一组成分清单</Button>
    </>}</Form.List>
  </>;
}

export function CompositionWorkspace({ refresh: externalRefresh, fundId, setFundId, read, editFund, canWrite, active }: any) {
  const [result, setResult] = useState<any>();
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [noFund, setNoFund] = useState(false);
  const api = useAPIClient();

  useEffect(() => {
    if (!active || fundId) return;
    let current = true;
    api.request({ url: 'finance:lookup', params: { resource: 'funds', fund_kind: 'proprietary', page_size: 1 } }).then(response => {
      const first = response.data.data.rows[0];
      if (!current) return;
      if (first) setFundId(first.value, { replace: true }); else setNoFund(true);
    }).catch(() => {});
    return () => { current = false; };
  }, [active, fundId]);

  useEffect(() => {
    let current = true;
    setResult(undefined); setError('');
    if (fundId && active) read('compositions', { fund_id: fundId }).then(value => { if (current) setResult(value); }).catch(e => { if (current) setError(e.response?.data?.errors?.[0]?.message || '成分读取失败，请刷新重试'); });
    return () => { current = false; };
  }, [fundId, active, refresh, externalRefresh]);
  const fund = result?.fund;
  return <Card title="自营基金成分" extra={<Space><Button icon={<ReloadOutlined />} disabled={!fundId} onClick={() => setRefresh(value => value + 1)}>刷新成分</Button><Button type="primary" disabled={!fund || fund.is_deleted || !canWrite} onClick={() => editFund(fund)}>编辑基金及成分</Button></Space>}>
    <div className="finance-toolbar">
      <div className="finance-toolbar-filters"><RemoteSelect aria-label="成分所属基金" resource="funds" params={{ state: 'all', fund_kind: 'proprietary' }} value={fundId} onChange={setFundId} prefix={<span className="finance-prefix">自营基金</span>} placeholder="选择自营基金" style={{ width: 420 }} /></div>
      <div className="finance-toolbar-meta">{result && <Typography.Text type="secondary">共 {result.compositions.length} 组清单</Typography.Text>}</div>
    </div>
    <Typography.Paragraph type="secondary">权重以已列示成分的市值合计为分母，现金余额不计入。各日期单独计算，不进行汇率换算。</Typography.Paragraph>
    {error && <Alert type="error" showIcon message={error} />}
    {!fundId && <Empty description={noFund ? '还没有自营基金，请先在基金中心新建自营基金' : '请选择一只自营基金查看成分'} />}
    {result && !result.compositions.length && <Empty description="尚无成分清单，可在基金资料中添加" />}
    {result?.compositions.map((list, index) => <Card size="small" key={list.id} title={<Space size={8}><span>清单 {index + 1}</span><Tag bordered={false}>{list.valuation_date ? `估值日 ${list.valuation_date}` : '日期未填写'}</Tag><Typography.Text type="secondary">{list.items.length} 个成分</Typography.Text></Space>} style={{ marginTop: 16 }} extra={list.total_market_value !== null && <Typography.Text>成分总市值 <Num value={list.total_market_value} suffix={list.currency} /></Typography.Text>}>
      {list.issues.length > 0 && <Alert type="warning" showIcon message="整组权重暂不计算" description={list.issues.map((issue, i) => <div key={i}>{issue.message}</div>)} style={{ marginBottom: 12 }} />}
      <Table<Record<string, any>> className="finance-table" rowKey="id" size="middle" dataSource={list.items} pagination={false} scroll={{ x: 1050 }} columns={[
        { title: '成分基金份额', render: (_, row) => <TwoLine main={<>{row.fund_name}{(row.fund_deleted || row.class_deleted) && <Tag style={{ marginLeft: 6 }}>已删除／停用</Tag>}</>} sub={row.class_label || row.isin} /> },
        numColumn({ title: '份额', dataIndex: 'units', width: 140 }),
        { title: '实际净值日期', dataIndex: 'nav_date', width: 120, render: value => <DateText value={value} /> },
        numColumn({ title: '单位净值', dataIndex: 'nav_per_unit', width: 130 }),
        { title: '币种', dataIndex: 'currency', width: 70 },
        numColumn({ title: '成分市值', dataIndex: 'market_value', width: 150, render: value => value === null || value === undefined ? '—' : <Num value={new Decimal(value).toFixed(2)} rawValue={value} /> }),
        { title: '市值权重', dataIndex: 'weight', width: 180, render: value => value === null || value === undefined ? '—' : <Space size={8} style={{ width: '100%' }} title={value}><Progress percent={Math.min(100, Number(new Decimal(value).times('100').toFixed(2)))} showInfo={false} size="small" style={{ width: 80, margin: 0 }} /><span className="finance-num">{new Decimal(value).times('100').toFixed(2)}%</span></Space> },
        { title: '备注', dataIndex: 'remarks', render: value => value || '—' },
      ]} locale={{ emptyText: '本清单尚无成分行' }} />
    </Card>)}
  </Card>;
}
