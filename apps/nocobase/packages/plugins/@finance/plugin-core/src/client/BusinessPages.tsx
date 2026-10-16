import React, { useEffect, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Alert, Badge, Button, Card, Descriptions, Empty, Input, Pagination, Progress, Select, Skeleton, Space, Table, Tabs, Tag, Typography } from 'antd';
import { DatabaseOutlined, ExclamationCircleOutlined, FileTextOutlined, ImportOutlined, LineChartOutlined } from '@ant-design/icons';
import { BatchStatus, DateText, FundKind, Num, PageIntro, ShareCell, StatCard, TwoLine, numColumn } from './ui';
import { QueryTable, dateControls } from './QueryTable';
import { FileWorkspace } from './FileWorkspace';
import { CompositionWorkspace } from './CompositionWorkspace';
import { issueCategories } from '../shared/issues';

const { Title, Text } = Typography;
export const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const lastMonth = () => { const [y, m] = localToday().split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const batchLabels = { awaiting_file: '等待文件', parsing: '解析中', staged: '待匹配', ready: '可提交', needs_correction: '需纠错', committed: '已提交', failed: '解析失败', cancelled: '已取消' };
function useRead(action: string, params: any, refresh: number, enabled = true) {
  const api = useAPIClient(); const [result, setResult] = useState<any>(); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let current = true; setLoading(true); setError(''); setResult(undefined);
    api.request({ url: `finance:${action}`, params }).then(response => { if (current) setResult(action === 'list' ? { rows: response.data.data, ...response.data.meta } : response.data.data); })
      .catch(error => { if (current) setError(error.response?.data?.errors?.[0]?.message || '读取失败，请重试'); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [action, JSON.stringify(params), refresh, retry, enabled]);
  return { result, loading, error, retry: () => setRetry(value => value + 1) };
}
function LoadError({ state }: any) { return state.error ? <Alert type="error" showIcon message={state.error} action={<Button onClick={state.retry}>重试</Button>} /> : null; }
const navState = (value: any) => value === null ? <Tag color="orange">该日未录入</Tag> : <Tag color="green">已录入</Tag>;

const issueTones = { missing_nav: 'warning', unknown_estimate: 'warning', options: 'default', imports: 'error', composition: 'warning', future: 'processing' };
const openBatchStatuses = new Set(['awaiting_file', 'parsing', 'staged', 'ready', 'needs_correction', 'failed']);

export function Workbench({ date, setDate, refresh, active, openFund, navigate, openQuality, openBatch, resolve, canWrite, canConfigure, summary }: any) {
  const [page, setPage] = useState(1);
  const coverage = useRead('navCoverage', { as_of: date, status: 'missing', page, page_size: 6 }, refresh, active);
  const quality = useRead('issues', { as_of: date, page: 1, page_size: 3 }, refresh, active);
  const counts = coverage.result?.summary;
  const recent = quality.result?.recent_imports || [];
  const pendingBatches = recent.filter(row => openBatchStatuses.has(row.status)).length;
  const reportMonth = lastMonth();
  const reports = useRead('reportBoard', { report_month: reportMonth, with_readiness: '0', page_size: 1 }, refresh, active);
  const reportCounts = reports.result?.counts;
  const reportHint = reports.error ? '月报进度读取失败' : reportCounts
    ? `待复核 ${reportCounts.review} · 未生成 ${reportCounts.not_ready + reportCounts.ready_to_generate + reportCounts.not_checked} · 失败 ${reportCounts.failed}`
    : '正在读取';
  useEffect(() => { if (coverage.result) setPage(current => Math.min(current, Math.max(1, Math.ceil(coverage.result.count / 6)))); }, [coverage.result]);
  return <div className="finance-home" data-finance-home>
    <PageIntro description="从待核对事项开始：先补净值，再处理校验问题和导入批次。" extra={<>
      <Input type="date" aria-label="净值核对日" prefix={<span className="finance-prefix">净值核对日</span>} style={{ width: 230 }} value={date} onChange={event => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) { setDate(event.target.value); setPage(1); } }} />
      <Button onClick={() => navigate('imports')}>批量导入</Button><Button type="primary" onClick={() => navigate('funds')}>进入基金中心</Button>
    </>} />
    <div className="finance-stats">
      <StatCard label="核对日未录入净值" tone={counts?.missing ? 'warning' : 'success'} icon={<LineChartOutlined />} value={counts?.missing} unit="个份额"
        hint={counts ? <><Progress percent={counts.total ? Math.round(counts.recorded / counts.total * 100) : 100} size="small" showInfo={false} />{counts.recorded} / {counts.total} 个有效份额已录入 · 未录入不代表逾期</> : '正在读取'} />
      <StatCard label="当前校验问题" tone={quality.result?.count ? 'danger' : 'success'} icon={<ExclamationCircleOutlined />} value={quality.result?.count} unit="项" hint="点击查看数据质量" onClick={() => openQuality()} />
      <StatCard label="我最近的导入" tone={pendingBatches ? 'warning' : 'default'} icon={<ImportOutlined />} value={quality.result ? pendingBatches : undefined} unit="个待处理" hint={`最近 ${recent.length} 个批次 · 点击进入导入中心`} onClick={() => navigate('imports')} />
      <StatCard label={`${reportMonth} 月报`} tone={reportCounts?.review ? 'warning' : 'default'} icon={<FileTextOutlined />} value={reports.error ? '—' : reportCounts?.published} unit={reportCounts ? `/ ${reportCounts.scope} 已发布` : undefined} hint={reportHint} onClick={() => navigate('report-board')} />
      <StatCard label="资料总览" icon={<DatabaseOutlined />} value={summary.funds} unit="只基金" hint={`${summary.investment_entities ?? '—'} 个投资主体 · 含历史停用记录`} />
    </div>
    <div className="finance-split">
      <Card className="finance-panel" title="待核对净值" extra={<Text type="secondary">核对日 {date}</Text>}>
        <LoadError state={coverage} />
        <Table<any> className="finance-table" rowKey="id" size="middle" loading={coverage.loading} dataSource={coverage.result?.rows || []} pagination={false} scroll={{ x: 500 }} locale={{ emptyText: coverage.error ? '读取失败' : '当前有效份额均已有该日净值' }} columns={[
          { title: '基金 / 份额', render: (_, row: any) => <div className="finance-cell"><Button className="finance-text-link" type="link" onClick={() => openFund(row.fund_id, 'nav', row.id)}>{row.fund_name}</Button><span className="finance-cell-sub">{row.class_label || row.isin} · {row.currency}</span></div> },
          { title: '最近可用净值', dataIndex: 'latest_date', width: 150, render: (value, row: any) => value ? <div className="finance-cell"><span className="finance-date">{value}</span><span className="finance-cell-sub"><Num value={row.latest_nav} /></span></div> : <Text type="secondary">暂无历史净值</Text> },
          { title: '操作', width: 110, render: (_, row: any) => <Button size="small" onClick={() => openFund(row.fund_id, 'nav', row.id)}>进入核对</Button> },
        ]} />
        <Pagination size="small" current={page} pageSize={6} total={coverage.result?.count || 0} showSizeChanger={false} onChange={setPage} showTotal={total => `共 ${total} 个份额`} />
      </Card>
      <Card className="finance-panel" title="校验问题分布" extra={<Button type="link" onClick={() => openQuality()}>全部问题</Button>}>
        <LoadError state={quality} />
        {quality.loading ? <Skeleton active paragraph={{ rows: 6 }} /> : <div className="finance-category-list">
          {Object.entries(issueCategories).map(([key, label]) => { const value = quality.result?.summary?.[key] || 0; return <button type="button" key={key} className="finance-category-item" disabled={!value} onClick={() => openQuality(key)}>
            <Badge status={value ? issueTones[key] as any : 'success'} text={label} /><Space size={8}><strong>{value}</strong>{value > 0 && <Text type="secondary">→</Text>}</Space>
          </button>; })}
        </div>}
        {!quality.loading && !!quality.result?.rows?.length && <>
          <Text type="secondary" className="finance-issue-caption">问题示例</Text>
          {quality.result.rows.map(issue => <div className="finance-issue" key={issue.id}>
            <Tag bordered={false}>{issueCategories[issue.category]}</Tag><Text strong>{issue.object_name}</Text><p>{issue.reason}</p>
            <Button type="link" disabled={issue.category === 'options' ? !canConfigure : !canWrite} onClick={() => resolve(issue)}>{issue.code === 'MISSING_NAV' ? '补录净值' : '查看并处理'} →</Button>
          </div>)}
        </>}
      </Card>
    </div>
    <Card className="finance-panel" title="我最近的导入" extra={<Button type="link" onClick={() => navigate('imports')}>进入导入中心</Button>}>
      <Table<any> className="finance-table" rowKey="id" size="small" loading={quality.loading} pagination={false} dataSource={recent} scroll={{ x: 580 }} columns={[
        { title: '原文件', dataIndex: 'original_name' }, { title: '状态', dataIndex: 'status', width: 120, render: value => <BatchStatus value={value} labels={batchLabels} /> },
        { title: '接收时间', dataIndex: 'created_at', width: 200, render: value => <span className="finance-date">{new Date(value).toLocaleString('zh-CN')}</span> },
        { title: '操作', width: 110, render: (_, row: any) => <Button type="link" size="small" onClick={() => openBatch(row)}>打开批次</Button> },
      ]} locale={{ emptyText: quality.error ? '读取失败' : '还没有导入批次' }} />
    </Card>
  </div>;
}

export function FundCenter({ fundId, section, selectedShare, openFund, date, setDate, refresh, active, metadata, editFund, newFund, enterNav, versions, classes, fields, read }: any) {
  const [query, setQuery] = useState<any>({ page: 1, search: '', state: 'active' });
  const funds = useRead('list', { table: 'funds', ...query, page_size: 8 }, refresh, active);
  const detail = useRead('fund', { id: fundId }, refresh, active && !!fundId);
  const aggregate = detail.result; const fund = aggregate?.fund;
  const writable = metadata?.permissions?.write === true;
  const [navPage, setNavPage] = useState(1);
  useEffect(() => { setNavPage(1); }, [fundId, date, selectedShare]);
  const coverage = useRead('navCoverage', { as_of: date, fund_id: fundId, share_class_id: selectedShare || undefined, page: navPage, page_size: 5 }, refresh, active && !!fundId && section === 'nav');
  useEffect(() => { if (coverage.result) setNavPage(current => Math.min(current, Math.max(1, Math.ceil(coverage.result.count / 5)))); }, [coverage.result]);
  const firstFund = funds.result?.rows?.[0]?.id;
  useEffect(() => { if (active && !fundId && firstFund) openFund(firstFund, 'info', undefined, { replace: true }); }, [active, fundId, firstFund]);
  const schemaItems = (table: string, row: any) => fields(table, fund?.fund_kind).map(field => ({ key: field.name, label: field.label, children: typeof row?.[field.name] === 'object' && row?.[field.name] ? JSON.stringify(row[field.name]) : String(row?.[field.name] ?? '—') }));
  return <div data-finance-fund-center>
    <PageIntro description="围绕一只基金维护资料、份额、净值、构成与附件。左侧选择基金，右侧切换标签处理。" extra={<Button type="primary" disabled={!writable} onClick={newFund}>新建基金</Button>} />
    <div className="finance-fund-layout">
      <aside className="finance-fund-list" aria-label="基金列表">
        <Input.Search aria-label="基金中心搜索" placeholder="搜索基金简称或 LEI" allowClear onSearch={search => setQuery(old => ({ ...old, search, page: 1 }))} />
        <Select aria-label="基金中心状态" value={query.state} style={{ width: '100%', margin: '12px 0' }} options={[{ value: 'active', label: '有效基金' }, { value: 'inactive', label: '已删除基金' }, { value: 'all', label: '全部基金' }]} onChange={state => setQuery(old => ({ ...old, state, page: 1 }))} />
        <LoadError state={funds} />
        {fund && !funds.result?.rows?.some(row => row.id === fundId) && <div className="finance-current-fund"><Text type="secondary">当前查看</Text><button type="button" className="finance-fund-item is-selected" aria-pressed="true" onClick={() => openFund(fundId, section, selectedShare)}><strong>{fund.short_name}</strong><span className="finance-fund-item-meta"><FundKind kind={fund.fund_kind} /></span></button></div>}
        {funds.loading ? <Skeleton active /> : (funds.result?.rows || []).map(row => <button type="button" className={`finance-fund-item ${row.id === fundId ? 'is-selected' : ''}`} key={row.id} aria-pressed={row.id === fundId} title={row.short_name} onClick={() => openFund(row.id, 'info')}><strong>{row.short_name}</strong><span className="finance-fund-item-meta"><FundKind kind={row.fund_kind} />{(row._share_classes || []).filter(share => !share.is_deleted).length} 个有效份额{row.is_deleted && <Tag bordered={false}>已删除</Tag>}</span></button>)}
        {!funds.loading && !funds.error && !funds.result?.rows?.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配基金" />}
        <Pagination size="small" simple current={query.page} pageSize={8} showSizeChanger={false} total={funds.result?.count || 0} onChange={page => setQuery(old => ({ ...old, page }))} />
        <Text type="secondary">共 {funds.result?.count ?? '—'} 只基金</Text>
      </aside>
      <section className="finance-fund-detail" aria-label="基金详情">
        {!fundId ? <Card><Empty description="从左侧选择基金，查看资料或补录净值" image={Empty.PRESENTED_IMAGE_SIMPLE} /></Card> : <>
          <LoadError state={detail} />
          {detail.loading ? <Card><Skeleton active paragraph={{ rows: 8 }} /></Card> : fund && <>
            <Card className="finance-fund-summary"><div className="finance-page-heading"><div><Space wrap><FundKind kind={fund.fund_kind} />{fund.is_deleted && <Tag bordered={false}>已删除</Tag>}<Text type="secondary">资料 V{fund.business_version}</Text></Space><Title level={3}>{fund.short_name}</Title><Text type="secondary">{fund.full_name || '全名未填写'}</Text></div><Space wrap><Button onClick={() => versions(fund)}>历史版本</Button><Button disabled={!writable || fund.is_deleted} onClick={() => editFund(fund)}>编辑资料</Button></Space></div><div className="finance-fund-facts"><span>LEI <strong>{fund.lei || '—'}</strong></span><span>有效份额 <strong>{aggregate.share_classes.filter(share => !share.is_deleted).length}</strong></span><span>净值核对日 <strong>{date}</strong></span></div></Card>
            <Card className="finance-detail-tabs"><Tabs activeKey={section} onChange={key => openFund(fundId, key)} items={[
              { key: 'info', label: '基本信息', children: <><Descriptions title="基金资料" column={{ xs: 1, sm: 2, xl: 3 }} layout="vertical" items={schemaItems('funds', fund)} /><Descriptions title={fund.fund_kind === 'third_party' ? '三方基金信息' : '自营基金信息'} column={{ xs: 1, sm: 2, xl: 3 }} layout="vertical" items={schemaItems(`${fund.fund_kind}_fund_details`, aggregate.details)} /></> },
              { key: 'classes', label: '份额类别', children: <><Space style={{ marginBottom: 12 }}><Text type="secondary">条款与份额信息在“编辑资料”中统一维护。</Text><Button onClick={() => classes(fund)}>份额状态</Button></Space><Table<any> rowKey="id" dataSource={aggregate.share_classes} pagination={{ pageSize: 8 }} scroll={{ x: 600 }} columns={[{ title: '份额', dataIndex: 'class_label' }, { title: 'ISIN', dataIndex: 'isin' }, { title: '币种', dataIndex: 'currency' }, { title: '状态', dataIndex: 'is_deleted', render: value => value ? '已停用' : '有效' }, { title: '操作', render: (_, share: any) => <Button type="link" onClick={() => openFund(fundId, 'nav', share.id)}>查看净值</Button> }]} /></> },
              { key: 'nav', label: '净值', children: <><div className="finance-nav-toolbar"><div><Text strong>按份额核对净值</Text><p><Text type="secondary">查看已保存原值，选择份额后录入；同日修改需再次确认。</Text></p></div><Input type="date" aria-label="基金净值核对日" value={date} onChange={event => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setDate(event.target.value); }} /></div><Select aria-label="净值份额筛选" style={{ minWidth: 230, marginBottom: 16 }} allowClear placeholder="全部有效份额" value={selectedShare || undefined} onChange={id => openFund(fundId, 'nav', id)} options={aggregate.share_classes.filter(share => !share.is_deleted).map(share => ({ value: share.id, label: `${share.class_label || share.isin} · ${share.currency}` }))} /><LoadError state={coverage} /><Table<any> rowKey="id" size="middle" loading={coverage.loading} dataSource={coverage.result?.rows || []} pagination={{ current: navPage, pageSize: 5, total: coverage.result?.count || 0, showSizeChanger: false, onChange: setNavPage }} scroll={{ x: 650 }} rowClassName={row => row.id === selectedShare ? 'finance-target-row' : ''} columns={[
                { title: '份额 / 币种', render: (_, row: any) => <TwoLine main={<Text strong>{row.class_label || row.isin} · {row.currency}</Text>} sub={row.isin} /> }, numColumn({ title: '核对日净值', dataIndex: 'exact_nav' }), { title: '状态', dataIndex: 'exact_nav', render: navState }, { title: '最近可用记录', render: (_, row: any) => row.latest_date ? <TwoLine main={<span className="finance-date">{row.latest_date}</span>} sub={<Num value={row.latest_nav} />} /> : <Text type="secondary">无记录</Text> },
                { title: '操作', render: (_, row: any) => <Button type={row.id === selectedShare ? 'primary' : 'default'} disabled={!writable || fund.is_deleted} onClick={() => enterNav({ ...row, fund_name: fund.short_name }, date)}>{row.exact_nav === null ? '录入该日净值' : '修改该日净值'}</Button> },
              ]} locale={{ emptyText: coverage.error ? '读取失败' : '没有可录入的有效份额' }} />
                <Title level={5}>历史净值</Title><QueryTable key={fundId} table="fund_navs" title="基金历史净值" fixed={{ fund_id: fundId, share_class_id: selectedShare || undefined, order: 'date_desc' }} refresh={refresh} controls={dateControls} columns={[{ title: '份额', dataIndex: '_share_label', render: value => <ShareCell label={value} /> }, { title: '净值日期', dataIndex: 'nav_date', width: 120, render: value => <DateText value={value} /> }, numColumn({ title: '单位净值', dataIndex: 'nav_per_unit', width: 200 })]} />
              </> },
              { key: 'compositions', label: '构成', children: fund.fund_kind === 'proprietary' ? <CompositionWorkspace key={fundId} refresh={refresh} fundId={fundId} setFundId={id => openFund(id, 'compositions')} read={read} editFund={editFund} canWrite={writable && !fund.is_deleted} active={active && section === 'compositions'} /> : <Empty description="构成清单适用于自营基金；三方基金条款在基本信息中维护" image={Empty.PRESENTED_IMAGE_SIMPLE} /> },
              { key: 'files', label: '附件', children: <FileWorkspace key={fundId} metadata={metadata} fundId={fundId} setFundId={id => openFund(id, 'files')} active={active && section === 'files'} /> },
            ]} /></Card>
          </>}
        </>}
      </section>
    </div>
  </div>;
}
