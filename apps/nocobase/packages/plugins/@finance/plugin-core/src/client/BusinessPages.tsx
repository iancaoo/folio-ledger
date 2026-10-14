import React, { useEffect, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Descriptions, Empty, Input, Pagination, Select, Skeleton, Space, Table, Tabs, Tag, Typography } from 'antd';
import { QueryTable, dateControls } from './QueryTable';
import { FileWorkspace } from './FileWorkspace';
import { CompositionWorkspace } from './CompositionWorkspace';
import { issueCategories } from '../shared/issues';

const { Title, Text } = Typography;
export const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
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

export function Workbench({ date, setDate, refresh, active, openFund, navigate, openBatch, resolve, canWrite, canConfigure, summary }: any) {
  const [page, setPage] = useState(1);
  const coverage = useRead('navCoverage', { as_of: date, status: 'missing', page, page_size: 5 }, refresh, active);
  const quality = useRead('issues', { as_of: date, page: 1, page_size: 4 }, refresh, active);
  const counts = coverage.result?.summary;
  useEffect(() => { if (coverage.result) setPage(current => Math.min(current, Math.max(1, Math.ceil(coverage.result.count / 5)))); }, [coverage.result]);
  return <div className="finance-home" data-finance-home>
    <div className="finance-page-heading"><div><Text type="secondary">日常数据维护 / {date.slice(0, 7)}</Text><Title level={2}>工作台</Title><Text type="secondary">从待核对事项开始，进入基金即可补录。</Text></div><Space><Button onClick={() => navigate('imports')}>批量导入</Button><Button type="primary" onClick={() => navigate('funds')}>进入基金中心</Button></Space></div>
    <div className="finance-period"><div><Text strong>净值核对日</Text><Input type="date" aria-label="净值核对日" value={date} onChange={event => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) { setDate(event.target.value); setPage(1); } }} /></div><Text type="secondary">按指定日期核对有效份额。未录入表示该日没有记录，不代表逾期；请按基金实际披露日补录。</Text></div>
    <div className="finance-overview-grid">
      <Card size="small"><Text type="secondary">核对日未录入净值</Text><div className="finance-number">{counts?.missing ?? '—'}<small>份额</small></div><Text type="secondary">{counts ? `${counts.recorded} / ${counts.total} 个有效份额已录入` : '正在读取'}</Text></Card>
      <Card size="small"><Text type="secondary">当前校验问题</Text><div className="finance-number">{quality.result?.count ?? '—'}<small>项</small></div><Button type="link" onClick={() => navigate('quality')}>查看数据质量 →</Button></Card>
      <Card size="small"><Text type="secondary">资料总览</Text><div className="finance-number">{summary.funds ?? '—'}<small>基金记录</small></div><Text type="secondary">{summary.investment_entities ?? '—'} 个投资主体 · 含历史停用记录</Text></Card>
    </div>
    <div className="finance-home-grid">
      <Card title="待核对净值" extra={<Text type="secondary">{date}</Text>}>
        <LoadError state={coverage} />
        <Table<any> rowKey="id" size="middle" loading={coverage.loading} dataSource={coverage.result?.rows || []} pagination={false} scroll={{ x: 500 }} locale={{ emptyText: coverage.error ? '读取失败' : '当前有效份额均已有该日净值' }} columns={[
          { title: '基金 / 份额', render: (_, row: any) => <><Button className="finance-text-link" type="link" onClick={() => openFund(row.fund_id, 'nav', row.id)}>{row.fund_name}</Button><div><Text type="secondary">{row.class_label || row.isin} · {row.currency}</Text></div></> },
          { title: '最近可用净值日', dataIndex: 'latest_date', render: value => value || '暂无历史净值' },
          { title: '操作', width: 110, render: (_, row: any) => <Button onClick={() => openFund(row.fund_id, 'nav', row.id)}>进入核对</Button> },
        ]} />
        <Pagination size="small" current={page} pageSize={5} total={coverage.result?.count || 0} showSizeChanger={false} onChange={setPage} showTotal={total => `共 ${total} 个份额`} />
      </Card>
      <Card title="校验问题" extra={<Button type="link" onClick={() => navigate('quality')}>全部问题</Button>}>
        <LoadError state={quality} />
        {quality.loading ? <Skeleton active paragraph={{ rows: 4 }} /> : (quality.result?.rows || []).map(issue => <div className="finance-issue" key={issue.id}>
          <Tag>{issueCategories[issue.category]}</Tag><Text strong>{issue.object_name}</Text><p>{issue.reason}</p>
          <Button type="link" disabled={issue.category === 'options' ? !canConfigure : !canWrite} onClick={() => resolve(issue)}>{issue.code === 'MISSING_NAV' ? '补录净值' : '查看并处理'} →</Button>
        </div>)}
        {!quality.loading && !quality.error && !quality.result?.rows?.length && <Empty description="未发现当前规则覆盖的问题" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
      </Card>
    </div>
    <Card title="我最近的导入" extra={<Button type="link" onClick={() => navigate('imports')}>进入导入中心</Button>}>
      <Table<any> rowKey="id" size="small" loading={quality.loading} pagination={false} dataSource={quality.result?.recent_imports || []} scroll={{ x: 580 }} columns={[
        { title: '原文件', dataIndex: 'original_name' }, { title: '状态', dataIndex: 'status', render: value => <Tag color={value === 'committed' ? 'green' : 'default'}>{batchLabels[value] || value}</Tag> },
        { title: '接收时间', dataIndex: 'created_at', render: value => new Date(value).toLocaleString('zh-CN') },
        { title: '操作', render: (_, row: any) => <Button type="link" onClick={() => openBatch(row)}>打开批次</Button> },
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
  const schemaItems = (table: string, row: any) => fields(table, fund?.fund_kind).map(field => ({ key: field.name, label: field.label, children: typeof row?.[field.name] === 'object' && row?.[field.name] ? JSON.stringify(row[field.name]) : String(row?.[field.name] ?? '—') }));
  return <div data-finance-fund-center>
    <div className="finance-page-heading"><div><Text type="secondary">围绕一只基金维护资料与时序数据</Text><Title level={2}>基金中心</Title></div><Button type="primary" disabled={!writable} onClick={newFund}>新建基金</Button></div>
    <div className="finance-fund-layout">
      <aside className="finance-fund-list" aria-label="基金列表">
        <Input.Search aria-label="基金中心搜索" placeholder="搜索基金简称或 LEI" allowClear onSearch={search => setQuery(old => ({ ...old, search, page: 1 }))} />
        <Select aria-label="基金中心状态" value={query.state} style={{ width: '100%', margin: '12px 0' }} options={[{ value: 'active', label: '有效基金' }, { value: 'inactive', label: '已删除基金' }, { value: 'all', label: '全部基金' }]} onChange={state => setQuery(old => ({ ...old, state, page: 1 }))} />
        <LoadError state={funds} />
        {fund && !funds.result?.rows?.some(row => row.id === fundId) && <div className="finance-current-fund"><Text type="secondary">当前查看</Text><button type="button" className="finance-fund-item is-selected" aria-pressed="true" onClick={() => openFund(fundId, section, selectedShare)}><strong>{fund.short_name}</strong><span>{fund.fund_kind === 'third_party' ? '三方基金' : '自营基金'}</span></button></div>}
        {funds.loading ? <Skeleton active /> : (funds.result?.rows || []).map(row => <button type="button" className={`finance-fund-item ${row.id === fundId ? 'is-selected' : ''}`} key={row.id} aria-pressed={row.id === fundId} onClick={() => openFund(row.id, 'info')}><strong>{row.short_name}</strong><span>{row.fund_kind === 'third_party' ? '三方基金' : '自营基金'} · {(row._share_classes || []).filter(share => !share.is_deleted).length} 个有效份额</span>{row.is_deleted && <Tag>已删除</Tag>}</button>)}
        {!funds.loading && !funds.error && !funds.result?.rows?.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有匹配基金" />}
        <Pagination size="small" simple current={query.page} pageSize={8} showSizeChanger={false} total={funds.result?.count || 0} onChange={page => setQuery(old => ({ ...old, page }))} />
        <Text type="secondary">共 {funds.result?.count ?? '—'} 只基金</Text>
      </aside>
      <section className="finance-fund-detail" aria-label="基金详情">
        {!fundId ? <Card><Empty description="从左侧选择基金，查看资料或补录净值" image={Empty.PRESENTED_IMAGE_SIMPLE} /></Card> : <>
          <LoadError state={detail} />
          {detail.loading ? <Card><Skeleton active paragraph={{ rows: 8 }} /></Card> : fund && <>
            <Card className="finance-fund-summary"><div className="finance-page-heading"><div><Space wrap><Tag color="blue">{fund.fund_kind === 'third_party' ? '三方基金' : '自营基金'}</Tag>{fund.is_deleted && <Tag>已删除</Tag>}<Text type="secondary">资料 V{fund.business_version}</Text></Space><Title level={3}>{fund.short_name}</Title><Text type="secondary">{fund.full_name || '全名未填写'}</Text></div><Space wrap><Button onClick={() => versions(fund)}>历史版本</Button><Button disabled={!writable || fund.is_deleted} onClick={() => editFund(fund)}>编辑资料</Button></Space></div><div className="finance-fund-facts"><span>LEI <strong>{fund.lei || '—'}</strong></span><span>有效份额 <strong>{aggregate.share_classes.filter(share => !share.is_deleted).length}</strong></span><span>净值核对日 <strong>{date}</strong></span></div></Card>
            <Card className="finance-detail-tabs"><Tabs activeKey={section} onChange={key => openFund(fundId, key)} items={[
              { key: 'info', label: '基本信息', children: <><Descriptions title="基金资料" column={{ xs: 1, sm: 2, xl: 3 }} layout="vertical" items={schemaItems('funds', fund)} /><Descriptions title={fund.fund_kind === 'third_party' ? '三方基金信息' : '自营基金信息'} column={{ xs: 1, sm: 2, xl: 3 }} layout="vertical" items={schemaItems(`${fund.fund_kind}_fund_details`, aggregate.details)} /></> },
              { key: 'classes', label: '份额类别', children: <><Space style={{ marginBottom: 12 }}><Text type="secondary">条款与份额信息在“编辑资料”中统一维护。</Text><Button onClick={() => classes(fund)}>份额状态</Button></Space><Table<any> rowKey="id" dataSource={aggregate.share_classes} pagination={{ pageSize: 8 }} scroll={{ x: 600 }} columns={[{ title: '份额', dataIndex: 'class_label' }, { title: 'ISIN', dataIndex: 'isin' }, { title: '币种', dataIndex: 'currency' }, { title: '状态', dataIndex: 'is_deleted', render: value => value ? '已停用' : '有效' }, { title: '操作', render: (_, share: any) => <Button type="link" onClick={() => openFund(fundId, 'nav', share.id)}>查看净值</Button> }]} /></> },
              { key: 'nav', label: '净值', children: <><div className="finance-nav-toolbar"><div><Text strong>按份额核对净值</Text><p><Text type="secondary">查看已保存原值，选择份额后录入；同日修改需再次确认。</Text></p></div><Input type="date" aria-label="基金净值核对日" value={date} onChange={event => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setDate(event.target.value); }} /></div><Select aria-label="净值份额筛选" style={{ minWidth: 230, marginBottom: 16 }} allowClear placeholder="全部有效份额" value={selectedShare || undefined} onChange={id => openFund(fundId, 'nav', id)} options={aggregate.share_classes.filter(share => !share.is_deleted).map(share => ({ value: share.id, label: `${share.class_label || share.isin} · ${share.currency}` }))} /><LoadError state={coverage} /><Table<any> rowKey="id" size="middle" loading={coverage.loading} dataSource={coverage.result?.rows || []} pagination={{ current: navPage, pageSize: 5, total: coverage.result?.count || 0, showSizeChanger: false, onChange: setNavPage }} scroll={{ x: 650 }} rowClassName={row => row.id === selectedShare ? 'finance-target-row' : ''} columns={[
                { title: '份额 / 币种', render: (_, row: any) => <><Text strong>{row.class_label || row.isin} · {row.currency}</Text><div><Text type="secondary">{row.isin}</Text></div></> }, { title: '核对日净值', dataIndex: 'exact_nav', render: value => value ?? '—' }, { title: '状态', dataIndex: 'exact_nav', render: navState }, { title: '最近可用记录', render: (_, row: any) => <>{row.latest_date || '无记录'}<div><Text type="secondary">{row.latest_nav ?? '—'}</Text></div></> },
                { title: '操作', render: (_, row: any) => <Button type={row.id === selectedShare ? 'primary' : 'default'} disabled={!writable || fund.is_deleted} onClick={() => enterNav({ ...row, fund_name: fund.short_name }, date)}>{row.exact_nav === null ? '录入该日净值' : '修改该日净值'}</Button> },
              ]} locale={{ emptyText: coverage.error ? '读取失败' : '没有可录入的有效份额' }} />
                <Title level={5}>历史净值</Title><QueryTable key={fundId} table="fund_navs" title="基金历史净值" fixed={{ fund_id: fundId, share_class_id: selectedShare || undefined, order: 'date_desc' }} refresh={refresh} controls={dateControls} columns={[{ title: '份额', dataIndex: '_share_label' }, { title: '净值日期', dataIndex: 'nav_date' }, { title: '单位净值', dataIndex: 'nav_per_unit' }]} />
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
