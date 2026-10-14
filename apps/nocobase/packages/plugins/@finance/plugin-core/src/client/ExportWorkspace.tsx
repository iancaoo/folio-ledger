import React, { useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Form, Input, Select, Space, Typography } from 'antd';
import { exportTables, exportTitle } from '../shared/export';
import { RemoteSelect } from './RemoteSelect';
import { DownloadOutlined } from '@ant-design/icons';

export function ExportWorkspace() {
  const api = useAPIClient(); const [form] = Form.useForm();
  const table = Form.useWatch('table', form) || 'funds';
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [result, setResult] = useState<any>();
  const hasFund = !['client_groups', 'investment_entities', 'entity_agreements', 'entity_products', 'benchmarks', 'benchmark_values'].includes(table);
  const hasEntity = ['investment_entities', 'entity_agreements', 'entity_products', 'transactions', 'positions'].includes(table);
  const hasDate = ['transactions', 'fund_navs', 'fund_returns', 'composition_snapshots', 'composition_items', 'benchmark_values'].includes(table);
  const hasState = ['funds', 'share_classes', 'third_party_fund_details', 'proprietary_fund_details', 'third_party_class_terms', 'proprietary_class_terms', 'investment_entities', 'entity_agreements', 'entity_products', 'transactions'].includes(table);
  async function download(values: any) {
    setBusy(true); setError(''); setResult(undefined);
    const params = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '' && value !== undefined));
    try {
      const response = await api.request({ skipNotify: true, url: 'finance:exportData', params, responseType: 'blob' });
      const extension = String(response.headers['content-type'] || '').includes('application/zip') ? 'zip' : 'xlsx';
      const url = URL.createObjectURL(response.data); const link = document.createElement('a'); link.href = url; link.download = `Finance-${table}.${extension}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setResult({ count: response.headers['x-finance-count'], parts: response.headers['x-finance-parts'], label: exportTitle(table), extension });
    } catch (error: any) {
      let text = '导出失败，请检查筛选条件后重试';
      if (error.response?.data instanceof Blob) { try { text = JSON.parse(await error.response.data.text()).errors?.[0]?.message || text; } catch {} }
      else text = error.response?.data?.errors?.[0]?.message || text;
      setError(text);
    } finally { setBusy(false); }
  }
  return <Card title="业务数据导出" data-finance-export>
    <Typography.Paragraph type="secondary">按业务表下载符合筛选条件的全部当前记录，包含稳定 ID、业务标识、日期及字段单位。金额、份额和比例以文本保留全部小数位。</Typography.Paragraph>
    <div className="finance-split">
    <div className="finance-panel">
    <Typography.Title level={5} className="finance-section-title">选择数据与筛选条件</Typography.Title>
    <Form form={form} layout="vertical" initialValues={{ table: 'funds' }} onFinish={download} disabled={busy}>
      <Form.Item name="table" label="导出业务表" rules={[{ required: true }]} extra={`当前：${exportTitle(table)}。未填写的筛选条件表示不限。`}><Select aria-label="导出业务表" onChange={value => { form.resetFields(); form.setFieldValue('table', value); setError(''); setResult(undefined); }} options={exportTables.map(value => ({ value, label: exportTitle(value) }))} /></Form.Item>
      <Space wrap align="start">
        {hasFund && <Form.Item name="fund_id" label="限定基金" preserve={false}><RemoteSelect resource="funds" params={{ state: 'all' }} style={{ width: 350 }} aria-label="限定导出基金" placeholder="全部基金（含已删除）" allowClear /></Form.Item>}
        {hasEntity && <Form.Item name="entity_id" label="限定主体" preserve={false}><RemoteSelect resource="investment_entities" params={{ state: 'all' }} style={{ width: 350 }} aria-label="限定导出主体" placeholder="全部主体（含已删除）" allowClear /></Form.Item>}
        {['benchmarks', 'benchmark_values'].includes(table) && <Form.Item name="benchmark_id" label="限定基准" preserve={false}><RemoteSelect resource="benchmarks" style={{ width: 350 }} aria-label="限定导出基准" placeholder="全部基准" allowClear /></Form.Item>}
        {hasDate && <><Form.Item name="date_from" label="业务开始日期" preserve={false}><Input type="date" /></Form.Item><Form.Item name="date_to" label="业务结束日期" preserve={false}><Input type="date" /></Form.Item></>}
        {table === 'positions' && <Form.Item name="as_of" label="持仓截止日期" preserve={false} tooltip="留空使用当前 UTC 日期，下载文件中记录实际截止日"><Input type="date" /></Form.Item>}
        {hasState && <Form.Item name="state" label="记录状态" preserve={false}><Select style={{ width: 220 }} placeholder="全部状态" allowClear options={[{ value: 'all', label: '全部状态' }, { value: 'active', label: table === 'transactions' ? '有效交易' : '使用中' }, { value: 'inactive', label: table === 'transactions' ? '已撤销' : '已删除／停用' }]} /></Form.Item>}
      </Space>
      <Form.Item style={{ marginBottom: 0 }}><Button type="primary" icon={<DownloadOutlined />} htmlType="submit" loading={busy}>下载业务数据</Button></Form.Item>
    </Form>
    {error && <Alert type="error" showIcon message={error} style={{ marginTop: 16 }} />}
    {result && <Alert type="success" showIcon style={{ marginTop: 16 }} message={`${result.label}：已下载 ${result.count} 条，共 ${result.parts} 个 Excel 文件`} description={result.extension === 'zip' ? '请解压后按 manifest.json 核对分片数量和行数，再逐个处理。' : '字段说明、空值规则和导出时点均保存在工作簿内。'} />}
    </div>
    <div className="finance-panel">
      <Typography.Title level={5} className="finance-section-title">文件说明</Typography.Title>
      <ul className="finance-notes">
        <li><b>只读结果和空值有明确标记</b>：持仓、市值、权重和 CDD 截止日用于核对，不能覆盖事实。</li>
        <li>文件中的 <Typography.Text code>\N</Typography.Text> 表示空值；<Typography.Text code>0.02</Typography.Text> 表示 2%。</li>
        <li>每份 Excel 最多 10,000 条，超出时自动打包为 ZIP。</li>
      </ul>
      <Typography.Title level={5} className="finance-section-title">再次导入</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>18 个业务表均可在导入中心选择“业务交换文件”再次导入，系统自动识别类型。保留原记录 ID 和固定关联，只修改选中行。成分修改前展示完整差异；文档元数据仅允许修改分类，原文件从文档页面下载。持仓为只读结果。</Typography.Paragraph>
    </div>
    </div>
  </Card>;
}
