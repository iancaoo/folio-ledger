import React, { useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { RemoteSelect } from './RemoteSelect';
import { Alert, Button, Card, Form, Modal, Select, Space, Table, Tag, Typography, Upload, message } from 'antd';

const encode = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(new Error('文件读取失败，请重新选择'));
  reader.onload = () => resolve(String(reader.result).split(',')[1]);
  reader.readAsDataURL(file);
});
const errorText = error => error.response?.data?.errors?.[0]?.message || error.message || '连接中断，请保留输入后重试';
const statusLabel = { pending: '处理中', awaiting_upload: '需重新选择原文件', failed: '未完成，可重试', complete: '已完成', cancelled: '已取消并清理' };

export function FileWorkspace({ metadata, fundId, setFundId, active }: any) {
  const api = useAPIClient();
  const [form] = Form.useForm();
  const [documents, setDocuments] = useState<any[]>([]);
  const [tasks, setTasks] = useState<any[]>([]);
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<{ body: string; key: string }>();
  const generation = useRef(0);
  const [fund, setFund] = useState<any>();
  const canWrite = metadata?.permissions?.write === true;
  const types = metadata?.options?.find(row => row.source_key === '净值与文档:13');
  const configured = metadata?.demo_mode || types?.confirmed;
  const read = async (action, params) => (await api.request({ url: `finance:${action}`, params })).data.data;
  async function reload() {
    if (!fundId) return;
    const current = generation.current;
    try {
      const [docs, jobs] = await Promise.all([read('documents', { fund_id: fundId }), read('fileTasks', { fund_id: fundId })]);
      if (generation.current === current) { setDocuments(docs); setTasks(jobs); }
    } catch (e) { if (generation.current === current) setError(errorText(e)); }
  }
  useEffect(() => {
    generation.current++;
    setDocuments([]); setTasks([]); setError('');
    if (!active || !fundId) return;
    void reload();
    const interval = setInterval(() => void reload(), 4000);
    return () => { generation.current++; clearInterval(interval); };
  }, [fundId, active]);
  async function mutate(action, payload) {
    const body = `${action}:${JSON.stringify(payload)}`;
    if (request.current?.body !== body) request.current = { body, key: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const result = (await api.request({ skipNotify: true, url: `finance:${action}`, method: 'post', data: { ...payload, request_key: request.current.key } })).data.data;
      request.current = undefined;
      if (result.status === 'cancelled') message.success({ key: 'finance-file', content: '上传已取消，暂存文件已清理' });
      else if (result.status === 'complete') message.success({ key: 'finance-file', content: action === 'deleteDocument' ? '文档及文件已删除' : '文件任务已完成' });
      else message.warning({ key: 'finance-file', content: '文件任务尚未完成，可在下方查看状态并重试' });
      await reload();
      return result;
    } catch (e) { setError(errorText(e)); throw e; }
    finally { setBusy(false); }
  }
  function checkFile(value: File) {
    if (!value.size || value.size > 10 * 1024 * 1024) { setError('请选择非空文件，大小不超过 10 MB'); return false; }
    setError(''); return true;
  }
  async function download(row) {
    try {
      const response = await api.request({ skipNotify: true, url: 'finance:downloadDocument', params: { id: row.id }, responseType: 'blob' });
      const url = URL.createObjectURL(response.data);
      const link = document.createElement('a'); link.href = url; link.download = row.original_name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setError('文件暂时无法下载，请刷新后查看文件状态或联系维护者'); }
  }
  return <Card title="基金文档" extra={<Button onClick={() => void reload()} disabled={!fundId}>刷新文档</Button>}>
    <Form layout="vertical" form={form} onFinish={async values => {
      if (!file || !fundId) { setError('请选择基金和文档'); return; }
      try {
        const result = await mutate('uploadDocument', { fund_id: fundId, document_type: values.document_type, original_name: file.name, content_base64: await encode(file) });
        if (result.status === 'complete') setFile(undefined);
      } catch {}
    }}>
      <Form.Item label="文档所属基金" required><RemoteSelect aria-label="文档所属基金" resource="funds" params={{ state: 'all' }} value={fundId} onChange={setFundId} onRecord={setFund} placeholder="选择基金查看文档" /></Form.Item>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      {fundId && <>
        {fund?.is_deleted && <Alert type="info" message="基金已删除，文档仍可查看和删除。恢复基金后可继续上传。" style={{ marginBottom: 16 }} />}
        {canWrite && !fund?.is_deleted && <Space align="start" wrap>
          <Form.Item name="document_type" label={<span>文档类型 {!types?.confirmed && <Tag color="orange">待确认{metadata?.demo_mode ? ' · 可模拟' : ''}</Tag>}</span>} rules={[{ required: true, message: '请选择文档类型' }]} style={{ width: 220 }}><Select aria-label="文档类型" options={(types?.values || []).map(row => ({ value: row.code, label: row.label }))} disabled={!configured} /></Form.Item>
          <Form.Item label="上传文件"><Upload maxCount={1} fileList={file ? [{ uid: 'finance-document', name: file.name, status: 'done' }] : []} accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.gif,.webp,.csv,.txt" beforeUpload={value => { if (checkFile(value)) setFile(value); return false; }} onRemove={() => setFile(undefined)}><Button disabled={busy}>选择文档（最多 10 MB）</Button></Upload></Form.Item>
          <Form.Item label=" "><Button type="primary" htmlType="submit" loading={busy} disabled={!file || !configured}>上传并关联</Button></Form.Item>
        </Space>}
      </>}
    </Form>
    {fundId && <>
      <Typography.Paragraph type="secondary">文档单独维护，不增加基金资料版本。下载需要登录并拥有 Finance 查看权限。</Typography.Paragraph>
      <Table rowKey="id" dataSource={documents} pagination={{ pageSize: 10 }} columns={[
        { title: '文件名', dataIndex: 'original_name' }, { title: '类型', dataIndex: 'document_type' },
        { title: '大小', dataIndex: 'size_bytes', render: value => `${(Number(value) / 1024).toFixed(1)} KB` },
        { title: '上传时间', dataIndex: 'uploaded_at', render: value => new Date(value).toLocaleString() },
        { title: '状态', render: (_, row) => <Tag color={row.deleting ? 'orange' : 'green'}>{row.deleting ? '删除未完成' : '可用'}</Tag> },
        { title: '操作', render: (_, row) => <Space><Button type="link" disabled={row.deleting} onClick={() => void download(row)}>下载</Button><Button type="link" danger disabled={!canWrite || busy || row.deleting} onClick={() => Modal.confirm({ title: `删除文档“${row.original_name}”？`, content: `所属基金：${fund?.short_name}。文档和文件会永久删除；只有两者都清除后才会显示完成。`, okText: '确认删除', cancelText: '取消', onOk: () => mutate('deleteDocument', { id: row.id, technical_revision: row.technical_revision }) })}>删除</Button></Space> },
      ]} locale={{ emptyText: '该基金暂无文档' }} />
      <Typography.Title level={5}>我的最近文件任务</Typography.Title>
      <Typography.Paragraph type="secondary">刷新页面后可继续查看。未完成的删除会保留状态并禁止下载；可重试。重新补传必须选择原文件。未完成的上传默认保留 7 天后自动取消并清理（可由维护者配置）。</Typography.Paragraph>
      <Table rowKey="task_id" size="small" dataSource={tasks} pagination={{ pageSize: 5 }} columns={[
        { title: '任务', render: (_, row) => `${row.operation === 'upload' ? '上传' : row.operation === 'cancel_upload' ? '取消上传' : '删除'}${row.original_name ? ` · ${row.original_name}` : ''}` },
        { title: '状态', dataIndex: 'status', render: value => <Tag color={value === 'complete' ? 'green' : 'orange'}>{statusLabel[value] || value}</Tag> },
        { title: '说明', dataIndex: 'error' },
        { title: '操作', render: (_, row) => !['complete', 'cancelled'].includes(row.status) && canWrite && <Space><Button disabled={busy} onClick={() => mutate('retryFile', { task_id: row.task_id }).catch(() => {})}>重试</Button>{row.operation === 'upload' && <Upload showUploadList={false} beforeUpload={async value => { if (checkFile(value)) { try { await mutate('retryFile', { task_id: row.task_id, content_base64: await encode(value) }); } catch {} } return false; }}><Button disabled={busy}>重新选择原文件</Button></Upload>}{row.operation === 'upload' && <Button danger disabled={busy} onClick={() => Modal.confirm({ title: '取消上传并清理暂存文件？', okText: '取消上传', cancelText: '返回', onOk: () => mutate('cancelUpload', { task_id: row.task_id }) })}>取消上传</Button>}</Space> },
      ]} locale={{ emptyText: '暂无本人发起的文件任务' }} />
    </>}
  </Card>;
}
