import React, { useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Descriptions, Drawer, Empty, Input, Modal, Radio, Select, Space, Table, Tabs, Tag, Typography, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { RemoteSelect } from './RemoteSelect';
import { PageIntro, TwoLine } from './ui';
import { localToday } from './BusinessPages';
import { TracePanel } from './TracePanel';

const { Text, Paragraph } = Typography;
const prefix = (label: string) => <span className="finance-prefix">{label}</span>;
const statusLabels = { queued: ['排队中', 'processing'], running: ['计算中', 'processing'], ready: ['待复核', 'warning'], failed: ['生成失败', 'error'], published: ['已发布', 'success'], superseded: ['已被替代', 'default'] };
const levelColors = { 错误: 'error', 警告: 'warning', 提示: 'processing' };
const pct = (value: any, digits = 2) => typeof value === 'number' ? `${(value * 100).toFixed(digits)}%` : '—';
const money = (value: any) => typeof value === 'number' ? Math.round(value).toLocaleString('en-US') : '—';
const lastMonth = () => { const [y, m] = localToday().split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const errorText = (e: any) => e.response?.data?.errors?.[0]?.message || '请求未完成，请重试；同一次提交不会重复生成';

export const ReportStatus = ({ value }: { value: string }) => <Tag bordered={false} color={statusLabels[value]?.[1]}>{statusLabels[value]?.[0] || value}</Tag>;
function Counts({ counts }: any) {
  if (!counts) return <Text type="secondary">—</Text>;
  return <Space size={4}>{Object.entries(levelColors).map(([level, color]) => <Tag key={level} bordered={false} color={counts[level] ? color : 'default'}>{level} {counts[level] ?? 0}</Tag>)}</Space>;
}

export function ReportWorkspace({ active, canWrite, entityId }: { active: boolean; canWrite: boolean; entityId?: string }) {
  const api = useAPIClient();
  const [scope, setScope] = useState<'entity' | 'client'>('entity');
  const [target, setTarget] = useState<any>({ entity_id: entityId, report_month: lastMonth() });
  const [query, setQuery] = useState<any>({ page: 1, page_size: 10, entity_id: entityId });
  const [result, setResult] = useState<any>({ rows: [], count: 0 });
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0); const [openId, setOpenId] = useState<string>();
  const pendingKey = useRef<{ body: string; key: string }>();
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
    const timer = setTimeout(() => setTick(value => value + 1), 2000);
    return () => clearTimeout(timer);
  }, [active, working, result]);

  async function post(action: string, payload: any) {
    const body = `${action}:${JSON.stringify(payload)}`;
    if (pendingKey.current?.body !== body) pendingKey.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    try {
      const response = await api.request({ skipNotify: true, url: `finance:${action}`, method: 'post', data: { ...payload, request_key: pendingKey.current.key } });
      pendingKey.current = undefined; setTick(value => value + 1);
      return response.data.data;
    } finally { setBusy(false); }
  }
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
    <PageIntro description="按 Finance 中已录入的申赎、净值、收益和基准，计算投资主体的月报。每份月报固定使用生成时的一致数据快照；复核校验结果后发布。" />
    <Card className="finance-panel" title="生成月报" style={{ marginBottom: 16 }}>
      <Space wrap align="start">
        <Radio.Group value={scope} onChange={event => setScope(event.target.value)} optionType="button" options={[{ value: 'entity', label: '按投资主体' }, { value: 'client', label: '按客户编号' }]} />
        {scope === 'entity'
          ? <RemoteSelect aria-label="月报投资主体" style={{ width: 300 }} resource="investment_entities" placeholder="选择投资主体" value={target.entity_id} onChange={value => setTarget(old => ({ ...old, entity_id: value }))} />
          : <Input aria-label="月报客户编号" style={{ width: 220 }} placeholder="客户编号，生成其下全部有效主体" value={target.client_code} onChange={event => setTarget(old => ({ ...old, client_code: event.target.value }))} />}
        <Input aria-label="报告月份" type="month" prefix={prefix('报告月份')} style={{ width: 220 }} value={target.report_month} onChange={event => setTarget(old => ({ ...old, report_month: event.target.value }))} />
        <RemoteSelect aria-label="月报基准" mode="multiple" maxCount={20} style={{ minWidth: 260 }} resource="benchmarks" placeholder="基准：默认取报告月有数值的基准" allowClear value={target.benchmark_ids} onChange={value => setTarget(old => ({ ...old, benchmark_ids: value }))} />
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
          <Select aria-label="月报筛选状态" prefix={prefix('状态')} placeholder="全部" allowClear style={{ minWidth: 150 }} value={query.status} onChange={value => change('status', value)} options={Object.entries(statusLabels).map(([value, [label]]) => ({ value, label }))} />
        </div>
        <div className="finance-toolbar-meta"><Text type="secondary">共 {result.count ?? 0} 条</Text><Button aria-label="刷新月报" icon={<ReloadOutlined />} onClick={() => setTick(value => value + 1)} /></div>
      </div>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      <Table className="finance-table" rowKey="id" size="middle" loading={loading} dataSource={result.rows} columns={columns} scroll={{ x: 1300 }} locale={{ emptyText: error ? '读取失败' : '还没有月报，先在上方选择主体和月份生成' }}
        pagination={{ current: query.page, pageSize: query.page_size, total: result.count, showSizeChanger: true, onChange: (page, page_size) => setQuery(old => ({ ...old, page: page_size !== old.page_size ? 1 : page, page_size })) }} />
    </Card>
    <ReportDrawer id={openId} close={() => setOpenId(undefined)} canWrite={canWrite} post={post} busy={busy} tick={tick} />
  </div>;
}

function ReportDrawer({ id, close, canWrite, post, busy, tick }: any) {
  const api = useAPIClient();
  const [run, setRun] = useState<any>(); const [html, setHtml] = useState<Record<string, string>>({}); const [error, setError] = useState('');
  const [note, setNote] = useState(''); const [confirming, setConfirming] = useState(false);
  const [trace, setTrace] = useState<any>(); const [traceNote, setTraceNote] = useState(''); const [picked, setPicked] = useState<string[]>();
  useEffect(() => {
    if (!id) { setRun(undefined); setHtml({}); setTrace(undefined); setTraceNote(''); setPicked(undefined); return; }
    let current = true;
    api.request({ url: 'finance:reportRun', params: { id } }).then(async response => {
      if (!current) return;
      const data = response.data.data; setRun(data); setError('');
      if (['ready', 'published', 'superseded'].includes(data.status)) {
        const [report, checks] = await Promise.all(['report', 'checks'].map(kind => api.request({ skipNotify: true, url: 'finance:reportDocument', params: { id, kind }, responseType: 'text' }).then(r => r.data)));
        if (current) setHtml({ report, checks });
        api.request({ skipNotify: true, url: 'finance:reportTrace', params: { id } })
          .then(r => { if (current) { setTrace(r.data.data); setTraceNote(''); } })
          .catch(e => { if (current) { setTrace(undefined); setTraceNote(e.response?.data?.errors?.[0]?.message || '计算追溯读取失败'); } });
      }
    }).catch(e => { if (current) setError(e.response?.data?.errors?.[0]?.message || '月报读取失败'); });
    return () => { current = false; };
  }, [id, tick]);
  // The preview runs no scripts; the drawer reads its cells (same-origin, script-free sandbox) to open the trace.
  const linkCells = (frameEl: HTMLIFrameElement | null) => {
    const doc = frameEl?.contentDocument;
    if (!doc || !trace || doc.body?.dataset.traceLinked) return;
    doc.body.dataset.traceLinked = '1';
    const style = doc.createElement('style');
    style.textContent = '[data-n]{cursor:pointer}[data-n]:hover{outline:2px solid #2e75b6;outline-offset:-2px}[data-n].trace-sel{outline:2px solid #c00000;outline-offset:-2px}'
      + '[data-n].trace-f{background-image:linear-gradient(225deg,#c00000 6px,transparent 6px)}';
    doc.head.appendChild(style);
    const flagged = new Set((trace.findings || []).map(f => f.node).filter(Boolean));
    doc.querySelectorAll<HTMLElement>('[data-n]').forEach(cell => {
      let ids: string[] = [];
      try { ids = JSON.parse(cell.dataset.n!).filter((n: string) => trace.nodes[n]); } catch { return; }
      if (!ids.length) return;
      if (ids.some(n => flagged.has(n))) cell.classList.add('trace-f');
      cell.title = '点击查看计算过程';
      cell.addEventListener('click', () => {
        doc.querySelectorAll('.trace-sel').forEach(e => e.classList.remove('trace-sel'));
        cell.classList.add('trace-sel'); setPicked(ids);
      });
    });
  };
  const previewRef = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => linkCells(previewRef.current), [trace, html.report]);
  async function download(kind: string) {
    try {
      const response = await api.request({ skipNotify: true, url: 'finance:reportDocument', params: { id, kind, download: '1' }, responseType: 'blob' });
      const url = URL.createObjectURL(response.data); const link = document.createElement('a');
      const name = { report: '投资组合回顾', checks: '校验报告', snapshot: '月报数据快照' }[kind];
      link.href = url; link.download = `${name}_${run.client_code}_${run.report_month}.${kind === 'snapshot' ? 'json' : 'html'}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { message.error('下载失败，请重试'); }
  }
  async function publish() {
    try { await post('publishReport', { id: run.id, technical_revision: run.technical_revision, ...(note.trim() ? { review_note: note.trim() } : {}) }); message.success('月报已发布'); setConfirming(false); setNote(''); }
    catch (e: any) { message.error(errorText(e)); }
  }
  const counts = run?.summary?.counts; const ready = run && ['ready', 'published', 'superseded'].includes(run.status);
  const frame = (doc?: string) => doc ? <iframe title="月报预览" sandbox="" srcDoc={doc} style={{ width: '100%', height: '72vh', border: '1px solid var(--finance-border)', borderRadius: 6, background: '#eef1f5' }} /> : <Empty description="月报尚未生成" />;
  return <Drawer open={!!id} onClose={close} width="min(1320px, 96vw)" destroyOnClose title={run ? <Space>{run.common_name || run.legal_name}<Text type="secondary">{run.report_month}</Text><ReportStatus value={run.status} /></Space> : '月报'}
    extra={ready && <Space>
      <Button onClick={() => download('report')}>下载月报</Button><Button onClick={() => download('checks')}>下载校验报告</Button>
      {run.status === 'ready' && <Button type="primary" disabled={!canWrite} onClick={() => setConfirming(true)}>复核并发布</Button>}
    </Space>}>
    {error && <Alert type="error" showIcon message={error} />}
    {run && !ready && <Alert type={run.status === 'failed' ? 'error' : 'info'} showIcon message={run.status === 'failed' ? `生成失败：${run.error}` : '正在读取数据快照并计算，完成后自动刷新'} />}
    {ready && <Tabs items={[
      { key: 'report', label: '月报预览', children: <>
        {run.status !== 'published' && <Alert style={{ marginBottom: 12 }} type="warning" showIcon message="未发布的月报带“草稿”水印；复核后发布即可去除" />}
        {trace ? <Alert style={{ marginBottom: 12 }} type="info" showIcon message="点击月报中的任意数字，右侧展开它的计算过程和原始数据；右上角带红角的数字挂有校验提示" />
          : traceNote && <Alert style={{ marginBottom: 12 }} type="info" showIcon message={traceNote} />}
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>{html.report
            ? <iframe ref={previewRef} title="月报预览" sandbox="allow-same-origin" srcDoc={html.report} onLoad={event => linkCells(event.currentTarget)} style={{ width: '100%', height: '72vh', border: '1px solid var(--finance-border)', borderRadius: 6, background: '#eef1f5' }} />
            : <Empty description="月报尚未生成" />}</div>
          {trace && picked && <div style={{ width: 460, flex: 'none' }}><TracePanel trace={trace} ids={picked} onClose={() => setPicked(undefined)} /></div>}
        </div>
      </> },
      { key: 'checks', label: <Space size={4}>校验结果<Counts counts={counts} /></Space>, children: <>
        {!run.findings?.length && <Alert type="success" showIcon message="全部检查项通过" />}
        {run.findings?.map((f, i) => <Alert key={i} style={{ marginBottom: 8 }} type={f.level === '错误' ? 'error' : f.level === '警告' ? 'warning' : 'info'} showIcon
          message={<Space wrap><Tag bordered={false}>{f.category}</Tag><Text strong>{f.title}</Text></Space>} description={<><Paragraph style={{ marginBottom: 4 }}>{f.detail}</Paragraph>{f.suggestion && <Text type="success">建议：{f.suggestion}</Text>}</>} />)}
      </> },
      { key: 'trace', label: '数据追溯', children: <Descriptions column={1} bordered size="small" items={[
        { key: 'client', label: '客户编号 / 主体', children: `${run.client_code} / ${run.legal_name}` },
        { key: 'snapshot', label: '数据快照时间', children: run.snapshot_at ? new Date(run.snapshot_at).toLocaleString('zh-CN') : '—' },
        { key: 'sha', label: '快照指纹（SHA-256）', children: <Space wrap><Text code copyable>{run.snapshot_sha256}</Text><Button size="small" onClick={() => download('snapshot')}>下载数据快照</Button></Space> },
        { key: 'engine', label: '计算版本', children: run.engine_version },
        { key: 'rules', label: '计算口径', children: run.summary?.trace ? `${run.summary.trace.rules.id}：${run.summary.trace.rules.range_value_text}` : '—' },
        { key: 'graph', label: '计算追溯', children: run.summary?.trace
          ? `${run.summary.trace.nodes} 个计算节点，其中原始数据 ${run.summary.trace.leaves} 项；生成时已逐节点复核，与计算结果一致`
          : '该月报生成于计算追溯上线之前，重新生成后可追溯' },
        { key: 'currency', label: '报告币种', children: run.summary?.currency },
        { key: 'owner', label: '生成人', children: `${run.owner_name || run.owner_id} · ${new Date(run.created_at).toLocaleString('zh-CN')}` },
        { key: 'publisher', label: '发布人', children: run.published_at ? `${run.publisher_name || run.published_by} · ${new Date(run.published_at).toLocaleString('zh-CN')}` : '未发布' },
        { key: 'note', label: '复核说明', children: run.review_note || '—' },
      ]} /> },
      { key: 'checks-html', label: '校验报告原文', children: frame(html.checks) },
    ]} />}
    <Modal open={confirming} title="复核并发布月报" okText="确认发布" confirmLoading={busy} onOk={publish} onCancel={() => setConfirming(false)} okButtonProps={{ disabled: !!counts?.错误 && !note.trim() }}>
      <p>发布后客户可见版本固定为本次生成的内容。同一主体同一月份此前发布的月报会标记为“已被替代”。</p>
      {counts?.错误 > 0 && <Alert style={{ marginBottom: 12 }} type="error" showIcon message={`校验报告仍有 ${counts.错误} 项错误`} description="请先在 Finance 中修正数据并重新生成；确需发布时，填写复核说明。" />}
      <Input.TextArea rows={3} maxLength={2000} placeholder={counts?.错误 ? '复核说明（必填）' : '复核说明（选填）'} value={note} onChange={event => setNote(event.target.value)} />
    </Modal>
  </Drawer>;
}
