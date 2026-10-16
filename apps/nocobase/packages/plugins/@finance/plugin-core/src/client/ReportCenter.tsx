import React, { useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Drawer, Dropdown, Input, Modal, Progress, Select, Space, Spin, Switch, Table, Tag, Tooltip, Typography, message } from 'antd';
import { AuditOutlined, CheckCircleOutlined, ExclamationCircleOutlined, FileAddOutlined, FileTextOutlined, ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import { PageIntro, StatCard, TwoLine } from './ui';
import { RemoteSelect } from './RemoteSelect';
import { Counts, ReportDrawer, ReportStatus, downloadReport, errorText, money, pct, useReportPost } from './report-common';
import { TargetButton } from './report-targets';
import type { BoardStage, ReadinessItem, ReportTarget } from '../shared/report-center';

const { Text, Paragraph } = Typography;
const prefix = (label: string) => <span className="finance-prefix">{label}</span>;
const CATEGORIES = ['数据范围', '净值收益', '收益标注', '基金标签', '基准', '月报状态'];
const STAGE_META: Record<BoardStage, [string, string]> = {
  not_ready: ['数据未就绪', 'error'], ready_to_generate: ['待生成', 'default'], not_checked: ['未检查', 'default'],
  generating: ['生成中', 'processing'], failed: ['生成失败', 'error'], review: ['待复核', 'warning'], published: ['已发布', 'success'],
};
const BASIS_TEXT = { default: '未指定：使用报告月有点位的基准', explicit: '手动选择' };

export const StageTag = ({ stage }: { stage?: string }) => <Tag bordered={false} color={STAGE_META[stage as BoardStage]?.[1]}>{STAGE_META[stage as BoardStage]?.[0] || stage || '—'}</Tag>;

function targetLabel(code: string, kind: ReportTarget['kind']) {
  if (code === 'RETURN_UNLABELED') return '补填估算标记';
  if (code === 'RETURN_STALE' || code === 'RETURN_ESTIMATE_CURRENT') return '替换为实际值';
  if (code === 'TAG_MISSING') return '补充标签';
  if (code === 'TAG_NOT_ALLOWED') return '修改标签';
  return { nav: '补录净值', return: '录入收益率', fund: '修改标签', benchmark: '录入基准点位', trades: '去录入申赎', positions: '查看持仓', entity: '查看主体', options: '维护候选值' }[kind];
}

function ReadinessMarks({ readiness }: { readiness?: any }) {
  if (!readiness) return <Text type="secondary">—</Text>;
  const errors = readiness.counts?.错误 || 0;
  const warnings = readiness.counts?.警告 || 0;
  if (!errors && !warnings) return <Tag color="success" bordered={false}>已就绪</Tag>;
  return <Space size={4}>{errors > 0 && <Tag color="error" bordered={false}>错误 {errors}</Tag>}{warnings > 0 && <Tag color="warning" bordered={false}>警告 {warnings}</Tag>}</Space>;
}

export function ReadinessDrawer({ open, close, entityId, month, benchmarkIds, canWrite, canConfigure, refresh = 0, openTarget, onGenerated }: {
  open: boolean; close: () => void; entityId?: string; month?: string; benchmarkIds?: string[]; canWrite: boolean; canConfigure?: boolean; refresh?: number; openTarget?: (target: ReportTarget) => void; onGenerated?: () => void;
}) {
  const api = useAPIClient();
  const { post, busy } = useReportPost();
  const [data, setData] = useState<any>(); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [retry, setRetry] = useState(0);
  const seed = benchmarkIds?.length ? benchmarkIds.join(',') : '';
  const [picked, setPicked] = useState<string[] | null>(seed ? seed.split(',') : null);
  useEffect(() => { setPicked(current => ((current || []).join(',') === seed ? current : (seed ? seed.split(',') : null))); }, [entityId, month, seed]);
  const pickedKey = picked?.join(',') || '';
  const scopeRef = useRef('');
  useEffect(() => {
    const scope = `${entityId || ''}|${month || ''}`;
    if (!open || scopeRef.current !== scope) { setData(undefined); setError(''); }
    scopeRef.current = open ? scope : '';
    if (!open || !entityId || !month) return;
    let current = true; setLoading(true);
    const params: any = { entity_id: entityId, report_month: month };
    if (pickedKey) params.benchmark_ids = pickedKey;
    api.request({ url: 'finance:reportReadiness', params }).then(response => { if (current) { setData(response.data.data); setError(''); } })
      .catch(e => { if (current) setError(e.response?.data?.errors?.[0]?.message || '就绪检查失败'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [open, entityId, month, pickedKey, refresh, retry]);

  async function generate() {
    if (!entityId || !month) return;
    const payload: any = { report_month: month, entity_ids: [entityId] };
    if (picked?.length) payload.benchmark_ids = picked;
    const go = async () => {
      try { await post('requestReports', payload); message.success('已提交月报，生成完成后可复核'); onGenerated?.(); setRetry(value => value + 1); }
      catch (e) { message.error(errorText(e)); }
    };
    if (data?.status === 'blocked') Modal.confirm({ title: '仍要生成月报？', okText: '仍要生成', content: `仍有 ${data.counts?.错误 || 0} 项未就绪，生成后校验报告会出现错误。仍要生成？`, onOk: go });
    else await go();
  }
  const shown = picked ?? data?.benchmark_ids ?? [];
  const groups = CATEGORIES.map(category => ({ category, items: (data?.items || []).filter((item: ReadinessItem) => item.category === category) })).filter(group => group.items.length);
  const current = data?.entity?.id === entityId ? data : undefined;
  return <Drawer open={open} onClose={close} width={760} zIndex={999} destroyOnClose title={current?.entity ? `${current.entity.common_name || current.entity.legal_name} · ${month} 出报告前检查` : '出报告前检查'}
    footer={<Space><Button onClick={() => setRetry(value => value + 1)}>重新检查</Button><Button type="primary" disabled={!canWrite || !data || data.entity?.id !== entityId} loading={busy} onClick={generate}>生成月报</Button></Space>}>
    {error && <Alert type="error" showIcon message={error} action={<Button onClick={() => setRetry(value => value + 1)}>重试</Button>} />}
    {current && <>
      {current.status === 'blocked' && <Alert type="error" showIcon message={`有 ${current.counts?.错误 || 0} 项必须先处理，否则生成的月报校验会出现错误`} />}
      {current.status === 'warning' && <Alert type="warning" showIcon message={`可以生成，有 ${current.counts?.警告 || 0} 项需要留意`} />}
      {current.status === 'ready' && <Alert type="success" showIcon message="数据已就绪，可以生成月报" />}
      <div style={{ margin: '16px 0' }}>
        <RemoteSelect aria-label="就绪检查基准" resource="benchmarks" mode="multiple" maxCount={20} style={{ width: '100%' }} value={shown}
          onChange={(value: string[]) => setPicked(value?.length ? value : null)} placeholder="基准" />
        <Text type="secondary">{BASIS_TEXT[current.benchmark_basis] || BASIS_TEXT.default}</Text>
      </div>
      {current.forecast && <Paragraph>按当前数据预计：<Counts counts={current.forecast.counts} /><Text type="secondary"> 仅供参考，以生成后的校验报告为准</Text></Paragraph>}
      {loading && <Spin />}
      {!loading && <>
      <Text strong>持仓基金覆盖</Text>
      <Table size="small" pagination={false} rowKey="key" style={{ margin: '8px 0 16px' }} dataSource={current.funds || []} locale={{ emptyText: '没有持仓基金' }} columns={[
        { title: '基金', dataIndex: 'key' }, { title: '币种', dataIndex: 'currency', width: 80 },
        { title: '月末持有', dataIndex: 'holding', width: 90, render: (value: boolean) => value ? '是' : '否' },
        { title: '当月净值', dataIndex: 'month_nav', width: 90, render: (value: boolean) => value ? '已录入' : '—' },
        { title: '当月收益', dataIndex: 'month_return', width: 90, render: (value: string) => value === '估算' ? <Tag color="orange" bordered={false}>估算</Tag> : value === '正式' ? '正式' : '—' },
      ]} />
      {!current.items?.length && <Alert type="success" message="全部检查项通过" />}
      {groups.map(group => <div key={group.category} style={{ marginBottom: 12 }}>
        <Text type="secondary">{group.category}</Text>
        {group.items.map((item: ReadinessItem, index: number) => <div key={`${item.code}-${item.fund || ''}-${item.month || ''}-${index}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 8 }}>
          <div style={{ flex: 1 }}><Space wrap><Tag bordered={false} color={item.level === '错误' ? 'error' : item.level === '警告' ? 'warning' : 'processing'}>{item.level}</Tag><Text strong>{item.title}</Text></Space><div><Text type="secondary">{item.detail}</Text></div></div>
          <TargetButton target={item.target} label={targetLabel(item.code, item.target.kind)} canWrite={canWrite} canConfigure={canConfigure} openTarget={openTarget} />
        </div>)}
      </div>)}
      </>}
    </>}
    {loading && !current && <Spin />}
  </Drawer>;
}

export function ReportBoard({ active, canWrite, canConfigure, month, setMonth, refresh, openTarget }: {
  active: boolean; canWrite: boolean; canConfigure?: boolean; month: string; setMonth: (month: string) => void; refresh: number; openTarget?: (target: ReportTarget) => void;
}) {
  const api = useAPIClient();
  const { post, busy, tick, bump } = useReportPost();
  const [search, setSearch] = useState(''); const [stage, setStage] = useState<string>(); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(20);
  const [result, setResult] = useState<any>(); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string>(); const [check, setCheck] = useState<string>();
  useEffect(() => {
    if (!active) return;
    let current = true; setLoading(true);
    api.request({ url: 'finance:reportBoard', params: { report_month: month, search: search || undefined, stage: stage || undefined, page, page_size: pageSize } }).then(response => { if (current) { setResult(response.data.data); setError(''); } })
      .catch(e => { if (current) setError(e.response?.data?.errors?.[0]?.message || '读取失败'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [active, month, search, stage, page, pageSize, refresh, tick]);
  useEffect(() => {
    if (!active || !result?.counts?.generating) return;
    const timer = setTimeout(() => bump(), 4000);
    return () => clearTimeout(timer);
  }, [active, result]);

  function chooseStage(next?: string) { setStage(old => old === next ? undefined : next); setPage(1); }
  async function generateOne(row: any) {
    try { const outcome = await post('requestReports', { report_month: month, entity_ids: [row.entity_id] }); message.success(`已提交 ${outcome.run_ids.length} 份月报`); }
    catch (e) { message.error(errorText(e)); }
  }
  function askGenerate(row: any) {
    if (row.stage === 'not_ready') { Modal.confirm({ title: '仍要生成月报？', okText: '仍要生成', content: `仍有 ${row.readiness?.counts?.错误 || 0} 项未就绪，生成后校验报告会出现错误。仍要生成？`, onOk: () => generateOne(row) }); return; }
    if (row.stage === 'published') { Modal.confirm({ title: '重新生成月报？', okText: '重新生成', content: '将生成新版本，复核发布后替代当前已发布版本。', onOk: () => generateOne(row) }); return; }
    return generateOne(row);
  }
  async function batch() {
    const rows: any[] = [];
    let pageNo = 1; let total = 0;
    try {
      do {
        const data = (await api.request({ url: 'finance:reportBoard', params: { report_month: month, stage: 'ready_to_generate', with_readiness: '1', page: pageNo, page_size: 200 } })).data.data;
        rows.push(...(data.rows || [])); total = data.count || 0; pageNo += 1;
      } while (rows.length < total && pageNo <= 20);
    } catch (e) { message.error(errorText(e)); return; }
    if (!rows.length) { message.info('没有数据就绪的主体'); return; }
    const warnings = rows.filter(row => row.readiness?.status === 'warning').length;
    Modal.confirm({ title: '批量生成月报', okText: '开始生成', content: `将为 ${rows.length} 个数据就绪的主体生成 ${month} 月报（其中 ${warnings} 个有警告）。生成在后台排队，完成后进入复核队列。`, onOk: async () => {
      const ids = rows.map(row => row.entity_id);
      let submitted = 0; const failed: string[] = []; let lastError: unknown;
      for (let index = 0; index < ids.length; index += 50) {
        const slice = ids.slice(index, index + 50);
        try {
          const outcome = await post('requestReports', { report_month: month, entity_ids: slice });
          submitted += outcome.run_ids.length;
        } catch (e) { failed.push(...slice); lastError = e; }
      }
      if (failed.length) message.error(`已提交 ${submitted} 份，${failed.length} 个主体提交失败。${errorText(lastError)}`);
      else message.success(`已提交 ${submitted} 份`);
      bump();
    } });
  }
  const counts = result?.counts;
  const cards = [
    { key: 'scope', label: '应出月报', value: counts?.scope, unit: '个主体', hint: '月末有持仓或当月有申赎', tone: 'default', icon: <FileTextOutlined />, stage: undefined as string | undefined },
    { key: 'not_ready', label: '数据未就绪', value: counts?.not_ready, hint: '生成前需补录数据', tone: 'danger', icon: <ExclamationCircleOutlined />, stage: 'not_ready' },
    { key: 'ready', label: '待生成', value: counts ? counts.ready_to_generate + counts.not_checked : undefined, hint: `其中有警告 ${counts?.ready_with_warnings ?? '—'}`, tone: 'default', icon: <FileAddOutlined />, stage: 'ready_to_generate,not_checked' },
    { key: 'running', label: '生成中 / 失败', value: counts ? counts.generating + counts.failed : undefined, hint: `失败 ${counts?.failed ?? '—'}`, tone: counts?.failed ? 'danger' : 'default', icon: <SyncOutlined />, stage: 'generating,failed' },
    { key: 'review', label: '待复核', value: counts?.review, hint: `其中含错误 ${counts?.review_with_errors ?? '—'}`, tone: 'warning', icon: <AuditOutlined />, stage: 'review' },
    { key: 'published', label: '已发布', value: counts?.published, hint: <Progress percent={counts?.scope ? Math.round(counts.published / counts.scope * 100) : 0} size="small" />, tone: 'success', icon: <CheckCircleOutlined />, stage: 'published' },
  ];
  const columns: any[] = [
    { title: '投资主体', dataIndex: 'legal_name', width: 240, render: (_: string, row: any) => <div><TwoLine main={row.common_name || row.legal_name} sub={`客户编号 ${row.client_code}`} />{row.entity_deleted && <Tag bordered={false}>主体已删除</Tag>}{row.scope_reason === 'run_only' && <Tag bordered={false}>仅有月报记录</Tag>}</div> },
    { title: '进度', dataIndex: 'stage', width: 140, render: (value: string, row: any) => <div><StageTag stage={value} />{value === 'review' && row.published_run && <div><Text type="secondary" style={{ fontSize: 12 }}>已有发布版本</Text></div>}</div> },
    { title: '就绪检查', width: 150, render: (_: unknown, row: any) => <ReadinessMarks readiness={row.readiness} /> },
    { title: '最新月报', width: 240, render: (_: unknown, row: any) => row.latest_run ? <Space direction="vertical" size={0}><Space size={4}><ReportStatus value={row.latest_run.status} /><Text type="secondary" style={{ fontSize: 12 }}>{new Date(row.latest_run.created_at).toLocaleString('zh-CN')}</Text></Space>{row.latest_run.counts && <Counts counts={row.latest_run.counts} />}{row.latest_run.status === 'failed' && row.latest_run.error && <Text type="danger" style={{ fontSize: 12 }}>{row.latest_run.error}</Text>}</Space> : <Text type="secondary">—</Text> },
    { title: '发布', width: 200, render: (_: unknown, row: any) => row.published_run ? `${row.published_run.publisher_name || '—'} · ${row.published_run.published_at ? new Date(row.published_run.published_at).toLocaleString('zh-CN') : '—'}` : '—' },
    { title: '操作', width: 220, fixed: 'right', render: (_: unknown, row: any) => {
      if (row.stage === 'generating') return <Text type="secondary">{row.latest_run?.status === 'running' ? '计算中' : '排队中'}</Text>;
      const checkButton = <Button type="link" size="small" onClick={() => setCheck(row.entity_id)}>就绪检查</Button>;
      if (row.stage === 'review') return <Space size={0}><Button type="link" size="small" onClick={() => setOpenId(row.latest_run?.id)}>复核</Button>{checkButton}</Space>;
      if (row.stage === 'published') return <Space size={0}><Button type="link" size="small" onClick={() => setOpenId(row.published_run?.id)}>查看</Button><Button type="link" size="small" disabled={!canWrite || busy} onClick={() => askGenerate(row)}>重新生成</Button></Space>;
      if (row.stage === 'failed') return <Space size={0} wrap>{checkButton}<Button type="link" size="small" disabled={!canWrite || busy || !row.latest_run} onClick={() => post('retryReport', { id: row.latest_run.id, technical_revision: row.latest_run.technical_revision }).catch(e => message.error(errorText(e)))}>重试</Button><Button type="link" size="small" disabled={!canWrite || busy} onClick={() => askGenerate(row)}>重新生成</Button></Space>;
      return <Space size={0}>{checkButton}<Button type="link" size="small" disabled={!canWrite || busy} onClick={() => askGenerate(row)}>生成</Button></Space>;
    } },
  ];
  const empty = error ? '读取失败' : !result ? '读取中' : counts?.scope === 0 ? `${month} 没有需要出月报的主体（月末无持仓且当月无申赎）` : '没有符合条件的主体';
  return <div data-finance-report-board>
    <PageIntro description="按报告月份跟踪每个投资主体的出报告进度：数据就绪 → 生成 → 复核 → 发布。范围为月末有持仓或当月有申赎的有效主体，以及当月已有月报的主体。" extra={<>
      <Input aria-label="报告月份" type="month" prefix={prefix('报告月份')} style={{ width: 220 }} value={month} onChange={event => { if (event.target.value) { setMonth(event.target.value); setPage(1); } }} />
      <Button icon={<ReloadOutlined />} onClick={bump}>刷新</Button>
      <Button type="primary" disabled={!canWrite || !(counts?.ready_to_generate > 0)} loading={busy} onClick={batch}>批量生成就绪主体</Button>
    </>} />
    <div className="finance-stats is-compact">
      {cards.map(card => <StatCard key={card.key} label={card.label} value={card.value} unit={card.unit} hint={card.hint} tone={card.tone} icon={card.icon} active={card.key === 'scope' ? !stage : stage === card.stage} onClick={() => card.key === 'scope' ? chooseStage(undefined) : chooseStage(card.stage)} />)}
    </div>
    {result?.readiness_truncated && <Alert style={{ marginBottom: 12 }} type="info" showIcon message="主体较多，部分主体未自动检查，可逐个点击“就绪检查”" />}
    {error && <Alert style={{ marginBottom: 12 }} type="error" showIcon message={error} />}
    <Card className="finance-panel">
      <div className="finance-toolbar">
        <div className="finance-toolbar-filters">
          <Input.Search aria-label="搜索主体" placeholder="搜索主体名称或客户编号" allowClear style={{ width: 240 }} onSearch={value => { setSearch(value); setPage(1); }} />
          <Select aria-label="进度筛选" allowClear placeholder="全部进度" style={{ minWidth: 160 }} value={stage && STAGE_META[stage as BoardStage] ? stage : undefined} onChange={value => { setStage(value); setPage(1); }} options={Object.entries(STAGE_META).map(([value, [label]]) => ({ value, label }))} />
        </div>
        <div className="finance-toolbar-meta"><Text type="secondary">共 {result?.count ?? 0} 个主体</Text><Text type="secondary">卡片统计全月范围，不随搜索变化</Text></div>
      </div>
      <Table className="finance-table" rowKey="entity_id" size="middle" loading={loading} dataSource={result?.rows || []} columns={columns} scroll={{ x: 1200 }} locale={{ emptyText: empty }}
        pagination={{ current: page, pageSize, total: result?.count || 0, showSizeChanger: true, onChange: (next, size) => { setPage(size !== pageSize ? 1 : next); setPageSize(size); } }} />
    </Card>
    <ReportDrawer id={openId} close={() => setOpenId(undefined)} canWrite={canWrite} post={post} busy={busy} tick={tick} openTarget={openTarget} canConfigure={canConfigure} />
    <ReadinessDrawer open={!!check} close={() => setCheck(undefined)} entityId={check} month={month} canWrite={canWrite} canConfigure={canConfigure} refresh={refresh} openTarget={openTarget} onGenerated={bump} />
  </div>;
}

function useRunList(active: boolean, query: any, tick: number, refresh: number) {
  const api = useAPIClient();
  const [result, setResult] = useState<any>({ rows: [], count: 0 }); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    let current = true; setLoading(true);
    api.request({ url: 'finance:reportRuns', params: query }).then(response => { if (current) { setResult(response.data.data); setError(''); } })
      .catch(e => { if (current) setError(e.response?.data?.errors?.[0]?.message || '读取失败'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [active, JSON.stringify(query), tick, refresh]);
  return { result, loading, error };
}

export function ReviewQueue({ active, canWrite, refresh, openTarget, canConfigure }: { active: boolean; canWrite: boolean; refresh: number; openTarget?: (target: ReportTarget) => void; canConfigure?: boolean }) {
  const { post, busy, tick, bump } = useReportPost();
  const [search, setSearch] = useState(''); const [month, setMonth] = useState(''); const [latest, setLatest] = useState(true); const [order, setOrder] = useState('errors');
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(20); const [openId, setOpenId] = useState<string>(); const [initialTab, setInitialTab] = useState('report');
  const query = { status: 'ready', order, latest_only: latest ? '1' : undefined, search: search || undefined, report_month: month || undefined, page, page_size: pageSize };
  const { result, loading, error } = useRunList(active, query, tick, refresh);
  const columns: any[] = [
    { title: '投资主体', dataIndex: 'legal_name', width: 220, render: (value: string, row: any) => <TwoLine main={<Button className="finance-text-link" type="link" onClick={() => { setInitialTab('report'); setOpenId(row.id); }}>{row.common_name || value}</Button>} sub={`客户编号 ${row.client_code}`} /> },
    { title: '报告月份', dataIndex: 'report_month', width: 110, render: (value: string) => <span className="finance-date">{value}</span> },
    { title: '校验', width: 220, render: (_: unknown, row: any) => <Counts counts={row.summary?.counts} /> },
    { title: '复核进度', width: 140, render: (_: unknown, row: any) => row.review?.needs_fix ? `需修改 ${row.review.needs_fix}` : row.review?.open_errors ? `未处理错误 ${row.review.open_errors}` : '已处理' },
    { title: '版本', width: 180, render: (_: unknown, row: any) => <Space direction="vertical" size={0}>{row.is_latest === false && <Tooltip title="同主体同月已有更新的月报，建议复核最新版本"><Tag color="warning" bordered={false}>有更新版本</Tag></Tooltip>}{row.has_published && <Tag bordered={false}>将替代已发布版本</Tag>}</Space> },
    { title: '生成', width: 180, render: (_: unknown, row: any) => <TwoLine main={row.owner_name || '—'} sub={new Date(row.created_at).toLocaleString('zh-CN')} /> },
    { title: '操作', width: 160, fixed: 'right', render: (_: unknown, row: any) => <Space size={0}><Button type="link" size="small" onClick={() => { setInitialTab('report'); setOpenId(row.id); }}>复核</Button>{row.has_published && <Button type="link" size="small" onClick={() => { setInitialTab('compare'); setOpenId(row.id); }}>对比已发布</Button>}</Space> },
  ];
  return <div data-finance-report-review>
    <PageIntro description="已生成、等待复核发布的月报。错误多的排在前面；打开后可预览、追溯计算并发布。" />
    <Card className="finance-panel">
      <div className="finance-toolbar">
        <div className="finance-toolbar-filters">
          <Input.Search aria-label="复核搜索" placeholder="主体/客户编号" allowClear style={{ width: 220 }} onSearch={value => { setSearch(value); setPage(1); }} />
          <Input aria-label="复核月份" type="month" prefix={prefix('月份')} style={{ width: 200 }} value={month} onChange={event => { setMonth(event.target.value); setPage(1); }} />
          <span>仅最新版本 <Switch checked={latest} onChange={value => { setLatest(value); setPage(1); }} /></span>
          <Select aria-label="复核排序" style={{ width: 160 }} value={order} onChange={value => { setOrder(value); setPage(1); }} options={[{ value: 'errors', label: '错误多的优先' }, { value: 'oldest', label: '最早生成优先' }, { value: 'newest', label: '最新生成优先' }]} />
        </div>
        <div className="finance-toolbar-meta"><Text type="secondary">共 {result.count ?? 0} 份待复核</Text><Button aria-label="刷新复核队列" icon={<ReloadOutlined />} onClick={bump} /></div>
      </div>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Table className="finance-table" rowKey="id" size="middle" loading={loading} dataSource={result.rows} columns={columns} scroll={{ x: 1000 }} locale={{ emptyText: error ? '读取失败' : '没有待复核的月报' }}
        pagination={{ current: page, pageSize, total: result.count, showSizeChanger: true, onChange: (next, size) => { setPage(size !== pageSize ? 1 : next); setPageSize(size); } }} />
    </Card>
    <ReportDrawer id={openId} close={() => setOpenId(undefined)} canWrite={canWrite} post={post} busy={busy} tick={tick} openTarget={openTarget} canConfigure={canConfigure} initialTab={initialTab} />
  </div>;
}

export function ReportArchive({ active, canWrite = false, refresh, openTarget, canConfigure }: { active: boolean; canWrite?: boolean; refresh: number; openTarget?: (target: ReportTarget) => void; canConfigure?: boolean }) {
  const api = useAPIClient();
  const { post, busy, tick, bump } = useReportPost();
  const [search, setSearch] = useState(''); const [entityId, setEntityId] = useState<string>(); const [clientCode, setClientCode] = useState('');
  const [monthFrom, setMonthFrom] = useState(''); const [monthTo, setMonthTo] = useState(''); const [status, setStatus] = useState('published,superseded');
  const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(20); const [openId, setOpenId] = useState<string>();
  const query = { status, order: 'published', search: search || undefined, entity_id: entityId || undefined, client_code: clientCode.trim() || undefined, month_from: monthFrom || undefined, month_to: monthTo || undefined, page, page_size: pageSize };
  const { result, loading, error } = useRunList(active, query, tick, refresh);
  const filtered = !!(search || entityId || clientCode.trim() || monthFrom || monthTo || status !== 'published,superseded');
  const columns: any[] = [
    { title: '投资主体', dataIndex: 'legal_name', width: 220, render: (value: string, row: any) => <TwoLine main={<Button className="finance-text-link" type="link" onClick={() => setOpenId(row.id)}>{row.common_name || value}</Button>} sub={`客户编号 ${row.client_code}`} /> },
    { title: '报告月份', dataIndex: 'report_month', width: 110, render: (value: string) => <span className="finance-date">{value}</span> },
    { title: '状态', dataIndex: 'status', width: 110, render: (value: string) => <ReportStatus value={value} /> },
    { title: '发布', width: 200, render: (_: unknown, row: any) => row.published_at ? `${row.publisher_name || '—'} · ${new Date(row.published_at).toLocaleString('zh-CN')}` : '—' },
    { title: '复核说明', dataIndex: 'review_note', width: 180, ellipsis: true, render: (value: string) => value ? <Tooltip title={value}><span>{value}</span></Tooltip> : '—' },
    { title: '校验', width: 220, render: (_: unknown, row: any) => <Counts counts={row.summary?.counts} /> },
    { title: 'YTD', width: 90, align: 'right', render: (_: unknown, row: any) => <span className="finance-num">{pct(row.summary?.ytd)}</span> },
    { title: 'IRR', width: 90, align: 'right', render: (_: unknown, row: any) => <span className="finance-num">{pct(row.summary?.irr)}</span> },
    { title: '期末净值', width: 140, align: 'right', render: (_: unknown, row: any) => <span className="finance-num">{money(row.summary?.total_nav)}</span> },
    { title: '操作', width: 140, fixed: 'right', render: (_: unknown, row: any) => <Space size={0}>
      <Button type="link" size="small" onClick={() => setOpenId(row.id)}>查看</Button>
      <Dropdown menu={{ items: [
        { key: 'report', label: '月报' }, { key: 'checks', label: '校验报告' },
        { key: 'workbook', disabled: !row.has_trace, label: row.has_trace ? '复核工作簿' : <Tooltip title="该月报生成于计算追溯上线之前，重新生成后可下载"><span>复核工作簿</span></Tooltip> },
        { key: 'snapshot', label: '数据快照' },
      ], onClick: ({ key }) => downloadReport(api, row, key).catch(() => message.error('下载失败，请重试')) }}><Button type="link" size="small">下载</Button></Dropdown>
    </Space> },
  ];
  return <div data-finance-report-archive>
    <PageIntro description="已发布和已被替代的月报。发布版本固定为生成时的数据快照，可随时下载各项产物。" />
    <Card className="finance-panel">
      <div className="finance-toolbar">
        <div className="finance-toolbar-filters">
          <Input.Search aria-label="归档搜索" placeholder="主体/客户编号" allowClear style={{ width: 200 }} onSearch={value => { setSearch(value); setPage(1); }} />
          <RemoteSelect aria-label="归档主体" prefix={prefix('主体')} placeholder="全部" resource="investment_entities" params={{ state: 'all' }} allowClear value={entityId} onChange={(value: string) => { setEntityId(value); setPage(1); }} style={{ width: 220 }} />
          <Input aria-label="归档客户编号" placeholder="客户编号" maxLength={30} style={{ width: 140 }} value={clientCode} onChange={event => { setClientCode(event.target.value); setPage(1); }} />
          <Input aria-label="月份从" type="month" prefix={prefix('月份从')} style={{ width: 190 }} value={monthFrom} onChange={event => { setMonthFrom(event.target.value); setPage(1); }} />
          <Input aria-label="月份至" type="month" prefix={prefix('月份至')} style={{ width: 190 }} value={monthTo} onChange={event => { setMonthTo(event.target.value); setPage(1); }} />
          <Select aria-label="归档状态" style={{ width: 150 }} value={status} onChange={value => { setStatus(value); setPage(1); }} options={[{ value: 'published,superseded', label: '全部归档' }, { value: 'published', label: '当前发布版本' }, { value: 'superseded', label: '已被替代' }]} />
        </div>
        <div className="finance-toolbar-meta"><Text type="secondary">共 {result.count ?? 0} 份</Text><Button aria-label="刷新归档" icon={<ReloadOutlined />} onClick={bump} /></div>
      </div>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Table className="finance-table" rowKey="id" size="middle" loading={loading} dataSource={result.rows} columns={columns} scroll={{ x: 1500 }} locale={{ emptyText: error ? '读取失败' : filtered ? '没有符合条件的月报' : '还没有已发布的月报' }}
        pagination={{ current: page, pageSize, total: result.count, showSizeChanger: true, onChange: (next, size) => { setPage(size !== pageSize ? 1 : next); setPageSize(size); } }} />
    </Card>
    <ReportDrawer id={openId} close={() => setOpenId(undefined)} canWrite={canWrite} post={post} busy={busy} tick={tick} openTarget={openTarget} canConfigure={canConfigure} />
  </div>;
}
