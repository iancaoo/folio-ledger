import React, { useEffect, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Input, Radio, Select, Space, Table, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { RemoteSelect } from './RemoteSelect';
import { PageIntro, TwoLine } from './ui';
import { lastMonth } from './BusinessPages';
import { ReadinessDrawer } from './ReportCenter';
import { Counts, ReportDrawer, ReportStatus, errorText, money, pct, reportStatusOptions, useReportPost } from './report-common';
import type { ReportTarget } from '../shared/report-center';

const { Text } = Typography;
const prefix = (label: string) => <span className="finance-prefix">{label}</span>;

export function ReportWorkspace({ active, canWrite, entityId, refresh = 0, openTarget, canConfigure = false }: { active: boolean; canWrite: boolean; entityId?: string; refresh?: number; openTarget?: (target: ReportTarget) => void; canConfigure?: boolean }) {
  const api = useAPIClient();
  const [scope, setScope] = useState<'entity' | 'client'>('entity');
  const [target, setTarget] = useState<any>({ entity_id: entityId, report_month: lastMonth() });
  const [query, setQuery] = useState<any>({ page: 1, page_size: 10, entity_id: entityId });
  const [result, setResult] = useState<any>({ rows: [], count: 0 });
  const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string>(); const [checkOpen, setCheckOpen] = useState(false);
  const { post, busy, tick, bump } = useReportPost();
  useEffect(() => { if (entityId) { setTarget(old => ({ ...old, entity_id: entityId })); setQuery(old => ({ ...old, entity_id: entityId, page: 1 })); } }, [entityId]);
  const working = result.rows.some(row => ['queued', 'running'].includes(row.status));
  useEffect(() => {
    if (!active) return;
    let current = true; if (!working) setLoading(true);
    api.request({ url: 'finance:reportRuns', params: query }).then(response => { if (current) { setResult(response.data.data); setError(''); } })
      .catch(e => { if (current) setError(e.response?.data?.errors?.[0]?.message || '月报列表读取失败，请重试'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [active, JSON.stringify(query), tick]);
  useEffect(() => {
    if (!active || !working) return;
    const timer = setTimeout(() => bump(), 2000);
    return () => clearTimeout(timer);
  }, [active, working, result]);

  async function generate(payload: any) {
    try {
      const outcome = await post('requestReports', payload);
      message.success(`已提交 ${outcome.run_ids.length} 份月报，生成完成后可复核`);
      setQuery(old => ({ ...old, page: 1 }));
    } catch (e: any) { message.error(errorText(e)); }
  }
  const submit = () => generate({ report_month: target.report_month, ...(target.benchmark_ids?.length ? { benchmark_ids: target.benchmark_ids } : {}),
    ...(scope === 'entity' ? { entity_ids: target.entity_id ? [target.entity_id] : [] } : { client_code: target.client_code }) });
  const change = (name: string, value: any) => setQuery(old => ({ ...old, [name]: value || undefined, page: 1 }));

  const columns: any[] = [
    { title: '投资主体', dataIndex: 'legal_name', width: 220, render: (value, row) => <TwoLine main={<Button className="finance-text-link" type="link" onClick={() => setOpenId(row.id)}>{row.common_name || value}</Button>} sub={`客户编号 ${row.client_code}`} /> },
    { title: '报告月份', dataIndex: 'report_month', width: 100, render: value => <span className="finance-date">{value}</span> },
    { title: '状态', dataIndex: 'status', width: 100, render: (value, row) => <Space direction="vertical" size={0}><ReportStatus value={value} />{row.error && <Text type="danger" style={{ fontSize: 12 }}>{row.error}</Text>}</Space> },
    { title: 'YTD', width: 90, align: 'right', render: (_, row) => <span className="finance-num">{pct(row.summary?.ytd)}</span> },
    { title: 'IRR', width: 90, align: 'right', render: (_, row) => <span className="finance-num">{pct(row.summary?.irr)}</span> },
    { title: '期末净值', width: 150, align: 'right', render: (_, row) => <span className="finance-num">{money(row.summary?.total_nav)}{row.summary?.currency && <small> {row.summary.currency}</small>}</span> },
    { title: '校验', width: 220, render: (_, row) => <Counts counts={row.summary?.counts} /> },
    { title: '生成', width: 170, render: (_, row) => <TwoLine main={row.owner_name || '—'} sub={new Date(row.created_at).toLocaleString('zh-CN')} /> },
    { title: '操作', width: 170, fixed: 'right', render: (_, row) => <Space size={0} wrap>
      <Button type="link" size="small" onClick={() => setOpenId(row.id)}>查看</Button>
      {row.status === 'failed' && <Button type="link" size="small" disabled={!canWrite || busy} onClick={() => post('retryReport', { id: row.id, technical_revision: row.technical_revision }).catch(e => message.error(errorText(e)))}>重试</Button>}
      {['ready', 'published', 'superseded', 'failed'].includes(row.status) && <Button type="link" size="small" disabled={!canWrite || busy} onClick={() => generate({ report_month: row.report_month, entity_ids: [row.entity_id], ...(row.benchmark_ids?.length ? { benchmark_ids: row.benchmark_ids } : {}) })}>重新生成</Button>}
    </Space> },
  ];
  return <div data-finance-reports>
    <PageIntro description="按 Finance 中已录入的申赎、净值、收益和基准，计算投资主体的月报。每份月报固定使用生成时的一致数据快照；复核校验结果后发布；按月跟踪进度请到“本月看板”。" />
    <Card className="finance-panel" title="生成月报" style={{ marginBottom: 16 }}>
      <Space wrap align="start">
        <Radio.Group value={scope} onChange={event => setScope(event.target.value)} optionType="button" options={[{ value: 'entity', label: '按投资主体' }, { value: 'client', label: '按客户编号' }]} />
        {scope === 'entity'
          ? <RemoteSelect aria-label="月报投资主体" style={{ width: 300 }} resource="investment_entities" placeholder="选择投资主体" value={target.entity_id} onChange={value => setTarget(old => ({ ...old, entity_id: value }))} />
          : <Input aria-label="月报客户编号" style={{ width: 220 }} placeholder="客户编号，生成其下全部有效主体" value={target.client_code} onChange={event => setTarget(old => ({ ...old, client_code: event.target.value }))} />}
        <Input aria-label="报告月份" type="month" prefix={prefix('报告月份')} style={{ width: 220 }} value={target.report_month} onChange={event => setTarget(old => ({ ...old, report_month: event.target.value }))} />
        <RemoteSelect aria-label="月报基准" mode="multiple" maxCount={20} style={{ minWidth: 260 }} resource="benchmarks" placeholder="基准：默认取报告月有数值的基准" allowClear value={target.benchmark_ids} onChange={value => setTarget(old => ({ ...old, benchmark_ids: value }))} />
        <Button disabled={scope !== 'entity' || !target.entity_id || !target.report_month} onClick={() => setCheckOpen(true)}>就绪检查</Button>
        <Button type="primary" loading={busy} disabled={!canWrite || !target.report_month || (scope === 'entity' ? !target.entity_id : !target.client_code?.trim())} onClick={submit}>生成月报</Button>
      </Space>
      {!canWrite && <Alert style={{ marginTop: 12 }} type="info" message="当前角色只读，可以查看和下载月报，不能生成或发布" />}
    </Card>
    <Card className="finance-panel" title="月报记录">
      <div className="finance-toolbar">
        <div className="finance-toolbar-filters">
          <Input.Search aria-label="月报搜索" placeholder="搜索主体名称或客户编号" allowClear style={{ width: 240 }} onSearch={value => change('search', value)} />
          <RemoteSelect aria-label="月报筛选主体" prefix={prefix('主体')} placeholder="全部" resource="investment_entities" params={{ state: 'all' }} allowClear value={query.entity_id} onChange={value => change('entity_id', value)} style={{ width: 250 }} />
          <Input aria-label="月报筛选月份" type="month" prefix={prefix('月份')} style={{ width: 200 }} value={query.report_month || ''} onChange={event => change('report_month', event.target.value)} />
          <Select aria-label="月报筛选状态" prefix={prefix('状态')} placeholder="全部" allowClear style={{ minWidth: 150 }} value={query.status} onChange={value => change('status', value)} options={reportStatusOptions} />
        </div>
        <div className="finance-toolbar-meta"><Text type="secondary">共 {result.count ?? 0} 条</Text><Button aria-label="刷新月报" icon={<ReloadOutlined />} onClick={bump} /></div>
      </div>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Table className="finance-table" rowKey="id" size="middle" loading={loading} dataSource={result.rows} columns={columns} scroll={{ x: 1300 }} locale={{ emptyText: error ? '读取失败' : '还没有月报，先在上方选择主体和月份生成' }}
        pagination={{ current: query.page, pageSize: query.page_size, total: result.count, showSizeChanger: true, onChange: (page, page_size) => setQuery(old => ({ ...old, page: page_size !== old.page_size ? 1 : page, page_size })) }} />
    </Card>
    <ReportDrawer id={openId} close={() => setOpenId(undefined)} canWrite={canWrite} post={post} busy={busy} tick={tick} openTarget={openTarget} canConfigure={canConfigure} />
    <ReadinessDrawer open={checkOpen} close={() => setCheckOpen(false)} entityId={target.entity_id} month={target.report_month} benchmarkIds={target.benchmark_ids} canWrite={canWrite} canConfigure={canConfigure} refresh={refresh} openTarget={openTarget} onGenerated={bump} />
  </div>;
}
