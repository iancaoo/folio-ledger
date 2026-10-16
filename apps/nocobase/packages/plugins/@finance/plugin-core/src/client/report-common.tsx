import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Descriptions, Drawer, Empty, Input, Modal, Segmented, Space, Switch, Tabs, Tag, Tooltip, Typography, message } from 'antd';
import { TracePanel } from './TracePanel';
import { TargetButton } from './report-targets';
import type { ReportTarget } from '../shared/report-center';

const { Text, Paragraph } = Typography;
const statusLabels = { queued: ['排队中', 'processing'], running: ['计算中', 'processing'], ready: ['待复核', 'warning'], failed: ['生成失败', 'error'], published: ['已发布', 'success'], superseded: ['已被替代', 'default'] };
const levelColors = { 错误: 'error', 警告: 'warning', 提示: 'processing' };
export const pct = (value: any, digits = 2) => typeof value === 'number' ? `${(value * 100).toFixed(digits)}%` : '—';
export const money = (value: any) => typeof value === 'number' ? Math.round(value).toLocaleString('en-US') : '—';
export const errorText = (e: any) => e.response?.data?.errors?.[0]?.message || '请求未完成，请重试；同一次提交不会重复生成';
export const reportStatusOptions = Object.entries(statusLabels).map(([value, [label]]) => ({ value, label }));

export const ReportStatus = ({ value }: { value: string }) => <Tag bordered={false} color={statusLabels[value]?.[1]}>{statusLabels[value]?.[0] || value}</Tag>;
export function Counts({ counts }: any) {
  if (!counts) return <Text type="secondary">—</Text>;
  return <Space size={4}>{Object.entries(levelColors).map(([level, color]) => <Tag key={level} bordered={false} color={counts[level] ? color : 'default'}>{level} {counts[level] ?? 0}</Tag>)}</Space>;
}

export function useReportPost() {
  const api = useAPIClient();
  const pendingKey = useRef<{ body: string; key: string }>();
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const bump = useCallback(() => setTick(value => value + 1), []);
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
  return { post, busy, tick, bump };
}

const REVIEW_LABEL = { confirmed: '已确认', needs_fix: '需修改', not_applicable: '不适用' };
function FindingReview({ finding, review, runId, locked, canWrite, post }: any) {
  const [choice, setChoice] = useState<string | undefined>(review?.status || undefined);
  const [text, setText] = useState(review?.note || '');
  useEffect(() => { setChoice(review?.status || undefined); setText(review?.note || ''); }, [review?.revision, review?.status, review?.note]);
  const enabled = canWrite && !locked;
  const required = finding.level === '错误' || choice === 'needs_fix' || choice === 'not_applicable';
  async function submit(status: string | null) {
    const note = (status === null ? text || review?.note || '' : text).trim();
    if ((finding.level === '错误' || status === 'needs_fix' || status === 'not_applicable') && !note) { message.warning('请填写复核说明'); return; }
    try { await post('reviewFinding', { id: runId, finding_key: finding.key, status, note, expected_revision: review?.revision || 0 }); }
    catch (error: any) { message.error(error.response?.data?.errors?.[0]?.message || '复核没有保存'); }
  }
  const controls = <Space direction="vertical" size={4} style={{ marginTop: 8 }}>
    <Space wrap>
      <Segmented disabled={!enabled} value={choice} options={[{ label: '已确认', value: 'confirmed' }, { label: '需修改', value: 'needs_fix' }, { label: '不适用', value: 'not_applicable' }]} onChange={value => setChoice(String(value))} />
      {review?.status && <Button type="link" size="small" disabled={!enabled} onClick={() => submit(null)}>撤回</Button>}
    </Space>
    {choice && <>
      <Input.TextArea rows={2} maxLength={500} disabled={!enabled} value={text} placeholder={required ? '复核说明（必填）' : '复核说明（选填）'} onChange={event => setText(event.target.value)} />
      <Button size="small" disabled={!enabled} onClick={() => submit(choice)}>保存结论</Button>
    </>}
    {review?.status && <Text type="secondary">{review.by_name || '复核人'} · {new Date(review.at).toLocaleString('zh-CN')} · {REVIEW_LABEL[review.status]}{review.note ? ` · ${review.note}` : ''}</Text>}
  </Space>;
  return canWrite ? controls : <Tooltip title="当前角色只读"><span>{controls}</span></Tooltip>;
}

export async function downloadReport(api: any, run: { id: string; client_code: string; report_month: string; status: string }, kind: string) {
  const response = await api.request({ skipNotify: true, url: 'finance:reportDocument', params: { id: run.id, kind, download: '1' }, responseType: 'blob' });
  const url = URL.createObjectURL(response.data); const link = document.createElement('a');
  const name = { report: '投资组合回顾', checks: '校验报告', snapshot: '月报数据快照', workbook: '复核工作簿' }[kind];
  const ext = { snapshot: 'json', workbook: 'xlsx' }[kind] || 'html';
  link.href = url; link.download = `${name}_${run.client_code}_${run.report_month}${kind === 'workbook' && run.status !== 'published' ? '_草稿' : ''}.${ext}`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ReportDrawer({ id, close, canWrite, post, busy, tick, openTarget, canConfigure, initialTab }: any) {
  const api = useAPIClient();
  const [run, setRun] = useState<any>(); const [html, setHtml] = useState<Record<string, string>>({}); const [error, setError] = useState('');
  const [note, setNote] = useState(''); const [confirming, setConfirming] = useState(false);
  const [trace, setTrace] = useState<any>(); const [traceNote, setTraceNote] = useState(''); const [picked, setPicked] = useState<string[]>();
  const [tab, setTab] = useState('report');
  const [onlyOpen, setOnlyOpen] = useState(false);
  const jump = (target: ReportTarget) => {
    if (!openTarget) return;
    if (['nav', 'trades', 'positions', 'options'].includes(target.kind)) close();
    openTarget(target);
  };
  useEffect(() => {
    if (!id) { setRun(undefined); setHtml({}); setTrace(undefined); setTraceNote(''); setPicked(undefined); setTab('report'); return; }
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
  useEffect(() => { if (id) setTab(initialTab || 'report'); }, [id, initialTab]);
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
    try { await downloadReport(api, run, kind); }
    catch { message.error('下载失败，请重试'); }
  }
  async function publish() {
    try { await post('publishReport', { id: run.id, technical_revision: run.technical_revision, ...(note.trim() ? { review_note: note.trim() } : {}) }); message.success('月报已发布'); setConfirming(false); setNote(''); }
    catch (e: any) { message.error(errorText(e)); }
  }
  const counts = run?.summary?.counts; const ready = run && ['ready', 'published', 'superseded'].includes(run.status);
  const frame = (doc?: string) => doc ? <iframe title="月报预览" sandbox="" srcDoc={doc} style={{ width: '100%', height: '72vh', border: '1px solid var(--finance-border)', borderRadius: 6, background: '#eef1f5' }} /> : <Empty description="月报尚未生成" />;
  return <Drawer zIndex={999} open={!!id} onClose={close} width="min(1320px, 96vw)" destroyOnClose title={run ? <Space>{run.common_name || run.legal_name}<Text type="secondary">{run.report_month}</Text><ReportStatus value={run.status} /></Space> : '月报'}
    extra={ready && <Space>
      <Button onClick={() => download('report')}>下载月报</Button><Button onClick={() => download('checks')}>下载校验报告</Button>
      <Tooltip title={run.summary?.trace ? 'Excel：每一步计算都是公式，并列出系统值与差异，供逐项复核' : '该月报生成于计算追溯上线之前，重新生成后可下载'}>
        <Button disabled={!run.summary?.trace} onClick={() => download('workbook')}>下载复核工作簿</Button>
      </Tooltip>
      {run.status === 'ready' && <Button type="primary" disabled={!canWrite} onClick={() => setConfirming(true)}>复核并发布</Button>}
    </Space>}>
    {error && <Alert type="error" showIcon message={error} />}
    {run && !ready && <Alert type={run.status === 'failed' ? 'error' : 'info'} showIcon message={run.status === 'failed' ? `生成失败：${run.error}` : '正在读取数据快照并计算，完成后自动刷新'} />}
    {ready && <Tabs activeKey={tab} onChange={setTab} items={[
      { key: 'report', label: '月报预览', children: <>
        {run.status !== 'published' && <Alert style={{ marginBottom: 12 }} type="warning" showIcon message="未发布的月报带“草稿”水印；复核后发布即可去除" />}
        {trace ? <Alert style={{ marginBottom: 12 }} type="info" showIcon message="点击月报中的任意数字，右侧展开它的计算过程和原始数据；右上角带红角的数字挂有校验提示" />
          : traceNote && <Alert style={{ marginBottom: 12 }} type="info" showIcon message={traceNote} />}
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>{html.report
            ? <iframe ref={previewRef} title="月报预览" sandbox="allow-same-origin" srcDoc={html.report} onLoad={event => linkCells(event.currentTarget)} style={{ width: '100%', height: '72vh', border: '1px solid var(--finance-border)', borderRadius: 6, background: '#eef1f5' }} />
            : <Empty description="月报尚未生成" />}</div>
          {trace && picked && <div style={{ width: 460, flex: 'none' }}><TracePanel trace={trace} ids={picked} onClose={() => setPicked(undefined)} entityId={run.entity_id} canWrite={canWrite} canConfigure={canConfigure} openTarget={jump} /></div>}
        </div>
      </> },
      { key: 'checks', label: <Space size={4}>校验结果<Counts counts={counts} /></Space>, children: <>
        {run.status !== 'ready' && <Alert style={{ marginBottom: 12 }} type="info" showIcon message="已发布的月报复核记录不可修改" />}
        {!!run.findings?.length && <Space style={{ marginBottom: 12 }}>{(() => {
          const errors = run.findings.filter((item: any) => item.level === '错误');
          const reviews = run.finding_reviews?.items || {};
          const handled = errors.filter((item: any) => ['confirmed', 'not_applicable'].includes(reviews[item.key]?.status)).length;
          const fixing = errors.filter((item: any) => reviews[item.key]?.status === 'needs_fix').length;
          return <Text>错误 {errors.length} 项：已处理 {handled}，需修改 {fixing}，未处理 {errors.length - handled - fixing}</Text>;
        })()}<span>只看未处理 <Switch checked={onlyOpen} onChange={setOnlyOpen} /></span></Space>}
        {!run.findings?.length && <Alert type="success" showIcon message="全部检查项通过" />}
        {run.findings?.map((f, i) => {
          const review = run.finding_reviews?.items?.[f.key];
          if (onlyOpen && review?.status) return null;
          const node = trace?.findings?.[i]?.node;
          return <Alert key={f.key || i} style={{ marginBottom: 8 }} type={f.level === '错误' ? 'error' : f.level === '警告' ? 'warning' : 'info'} showIcon
            message={<Space wrap><Tag bordered={false}>{f.category}</Tag><Text strong>{f.title}</Text></Space>}
            description={<><Paragraph style={{ marginBottom: 4 }}>{f.detail}</Paragraph>{f.suggestion && <Text type="success">建议：{f.suggestion}</Text>}
              <div>{Array.isArray(f.targets) && f.targets.map((item: { label: string; target: ReportTarget }, index: number) => <TargetButton key={index} target={item.target} label={item.label} canWrite={canWrite} canConfigure={canConfigure} openTarget={jump} />)}
                {node && <Button type="link" size="small" onClick={() => { setTab('report'); setPicked([node]); }}>查看计算过程</Button>}
                {!Array.isArray(f.targets) && !node && <Text type="secondary">该月报生成于跳转功能上线之前，重新生成后可直接跳到记录</Text>}</div>
              <FindingReview finding={f} review={review} runId={run.id} locked={run.status !== 'ready'} canWrite={canWrite} post={post} /></>} />;
        })}
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
    <Modal open={confirming} title="复核并发布月报" okText="确认发布" confirmLoading={busy} onOk={publish} onCancel={() => setConfirming(false)} okButtonProps={{ disabled: !canWrite || (run?.review_gate?.blockers || []).some((item: any) => item.code !== 'REVIEW_NOTE_REQUIRED') || (!!counts?.错误 && !note.trim()) }}>
      <p>发布后客户可见版本固定为本次生成的内容。同一主体同一月份此前发布的月报会标记为“已被替代”。</p>
      {(run?.review_gate?.blockers || []).map((item: any) => <Alert key={item.code} style={{ marginBottom: 12 }} type="error" showIcon message={item.message} />)}
      {counts?.错误 > 0 && !(run?.review_gate) && <Alert style={{ marginBottom: 12 }} type="error" showIcon message={`校验报告仍有 ${counts.错误} 项错误`} description="请先在 Finance 中修正数据并重新生成；确需发布时，填写复核说明。" />}
      <Input.TextArea rows={3} maxLength={2000} placeholder={counts?.错误 ? '复核说明（必填）' : '复核说明（选填）'} value={note} onChange={event => setNote(event.target.value)} />
    </Modal>
  </Drawer>;
}
