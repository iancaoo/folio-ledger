import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Modal, Space, Tag, Typography, message } from 'antd';
import { draftLabels } from '../shared/drafts';
import { QueryTable } from './QueryTable';

const clean = value => JSON.parse(JSON.stringify(value));
const contentOf = (form, editing) => ({ values: clean(form.getFieldsValue(true)), ...(editing ? { editing: clean(Object.fromEntries(['id', 'technical_revision', 'business_version', 'is_deleted', 'next_cdd_deadline', 'original_compositions'].filter(key => editing[key] !== undefined).map(key => [key, editing[key]]))) } : {}) });

export function useEntryDraft({ api, forms, dialog, editing, canWrite, busy, setBusy, setError, close, refresh }: any) {
  const reference = useRef<any>(); const pending = useRef<any>(); const baseline = useRef('');
  const [draft, setDraft] = useState<any>(); const [leaving, setLeaving] = useState(false);
  const form = forms[dialog];
  const changed = () => !!form && JSON.stringify(clean(form.getFieldsValue(true))) !== baseline.current;
  useEffect(() => { if (form) baseline.current = JSON.stringify(clean(form.getFieldsValue(true))); }, [dialog]);
  useEffect(() => {
    const before = event => { if (canWrite && changed()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before);
  }, [dialog, canWrite]);
  const setReference = value => { reference.current = value; setDraft(value); };
  const reset = () => { setReference(undefined); pending.current = undefined; setLeaving(false); };
  async function saveDraft() {
    if (!form || !canWrite || busy) return;
    const content = contentOf(form, editing);
    const payload = { form_type: dialog, content, ...(reference.current || {}) }; const body = JSON.stringify(payload);
    if (pending.current?.body !== body) pending.current = { body, key: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      const result = (await api.request({ skipNotify: true, url: 'finance:saveDraft', method: 'post', data: { ...payload, request_key: pending.current.key } })).data.data;
      setReference({ id: result.id, technical_revision: result.technical_revision }); pending.current = undefined;
      baseline.current = JSON.stringify(content.values); setLeaving(false); close(); refresh();
      message.success('已保存到个人草稿，可在“个人草稿”中继续填写');
    } catch (error: any) {
      setLeaving(false); setError(error.response?.data?.errors?.[0]?.message || '连接中断，请重试保存草稿；同一次请求不会创建两份');
    } finally { setBusy(false); }
  }
  const cancel = () => { if (busy) return; if (canWrite && changed()) setLeaving(true); else close(); };
  const controls = <Space wrap style={{ margin: '12px 0' }}><Button disabled={!canWrite || busy || editing?.is_deleted} onClick={saveDraft}>保存草稿并关闭</Button><Typography.Text type="secondary">{draft ? '已恢复个人草稿。正式保存成功后移除草稿。' : '未填完整也可存草稿，刷新前请先保存。'}</Typography.Text></Space>;
  const leaveDialog = <Modal open={leaving} title="表单尚未保存" closable={false} maskClosable={false} footer={<Space><Button disabled={busy} onClick={() => setLeaving(false)}>继续填写</Button><Button danger disabled={busy} onClick={() => { setLeaving(false); close(); }}>放弃本次修改</Button><Button type="primary" loading={busy} onClick={saveDraft}>保存草稿并关闭</Button></Space>}>
    <p>可保存未填写完整的内容，下次从个人草稿继续。</p>{draft && <p>放弃本次修改时，之前保存的草稿仍会保留。</p>}
  </Modal>;
  return { reference, setReference, reset, cancel, controls, leaveDialog };
}

export function DraftWorkspace({ read, save, resume, refresh, canWrite }: any) {
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  async function open(row) {
    setLoading(true); setError('');
    try { await resume(await read('draft', { id: row.id })); }
    catch (error: any) { setError(error.response?.data?.errors?.[0]?.message || '草稿读取失败，请刷新列表后重试'); }
    finally { setLoading(false); }
  }
  return <Card title="个人草稿">
    <Alert type="info" showIcon message="仅本人可见。草稿不产生正式记录，也不计入持仓或报告。" description="正式保存仍会校验必填项、原记录修订号和全部业务规则；校验失败时保留草稿。" />
    {error && <Alert type="error" message={error} />}
    <QueryTable action="drafts" title="草稿" refresh={refresh} controls={[{ key: 'form_type', label: '表单类型', options: Object.entries(draftLabels).map(([value, label]) => ({ value, label })) }]} columns={[
      { title: '草稿名称', dataIndex: 'title' }, { title: '表单', dataIndex: 'form_type', render: value => draftLabels[value] },
      { title: '操作类型', dataIndex: 'is_edit', render: value => <Tag>{value ? '修改已有记录' : '录入记录'}</Tag> },
      { title: '保存时间', dataIndex: 'updated_at', render: value => new Date(value).toLocaleString() },
      { title: '操作', render: (_, row) => <Space><Button type="link" disabled={!canWrite || loading} onClick={() => open(row)}>继续填写</Button><Button type="link" danger disabled={!canWrite || loading} onClick={() => Modal.confirm({ title: '删除个人草稿', content: '只删除这份未提交的草稿，正式业务记录不受影响。', okText: '删除草稿', onOk: () => save('discardDraft', { id: row.id, technical_revision: row.technical_revision }) })}>删除草稿</Button></Space> },
    ]} />
  </Card>;
}
