import React, { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Form, Input, Modal, Space, Table, Tag, Typography } from 'antd';

export function OptionsWorkspace({ options, save, reload, target }: any) {
  const [editing, setEditing] = useState<any>();
  const [form] = Form.useForm();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!target) return;
    const row = options.find(row => row.source_key === target.source_key);
    if (row && !row.fixed) { setError(''); setEditing(row); form.resetFields(); form.setFieldsValue({ confirmed: row.confirmed, values: row.values }); }
  }, [target]);
  return <>
    <Alert type="info" showIcon message="只维护候选值，不修改字段 schema" description="原表已明确的选项已初始化。待确认项保留原候选值；空白和历史示例不自动转为正式业务决定。配置保存后，旧导入预览需要重新生成。" style={{ marginBottom: 16 }} />
    <Table<any> rowKey="source_key" dataSource={options} pagination={{ pageSize: 12 }} columns={[
      { title: '来源', dataIndex: 'source_sheet', filters: [...new Set<string>(options.map(row => row.source_sheet))].map(text => ({ text, value: text })), onFilter: (value, row) => row.source_sheet === value },
      { title: '字段', dataIndex: 'label', render: (text, row) => <Space>{text}<Typography.Text type="secondary">第 {row.source_row} 行</Typography.Text></Space> },
      { title: '候选值', dataIndex: 'values', render: values => values.length ? values.map(value => value.label).join(' / ') : '待补充' },
      { title: '状态', dataIndex: 'confirmed', render: value => <Tag color={value ? 'green' : 'orange'}>{value ? '已明确' : '待确认'}</Tag> },
      { title: '配置版本', dataIndex: 'technical_revision' },
      { title: '操作', render: (_, row) => row.fixed ? '固定业务规则' : <Button type="link" onClick={() => { setError(''); setEditing(row); form.setFieldsValue({ confirmed: row.confirmed, values: row.values }); }}>维护候选值</Button> },
    ]} />
    <Modal open={!!editing} title={editing?.label} width={760} footer={null} onCancel={() => setEditing(undefined)} destroyOnClose>
      {error && <Alert type="error" message={error} />}
      <Typography.Paragraph type="secondary">{editing?.source_sheet} 第 {editing?.source_row} 行：{editing?.notes}</Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={async values => {
        setBusy(true);
        try { await save('saveOptions', { ...values, source_key: editing.source_key, technical_revision: editing.technical_revision }); await reload(); setEditing(undefined); }
        catch (error: any) { setError(error.response?.data?.errors?.[0]?.message || '保存未成功，请保留输入重试'); }
        finally { setBusy(false); }
      }}>
        <Form.List name="values">{(items, { add, remove }) => <>
          {items.map(item => <Space key={item.key} align="baseline">
            <Form.Item name={[item.name, 'code']} rules={[{ required: true }]}><Input placeholder="编码（保存在业务记录中）" /></Form.Item>
            <Form.Item name={[item.name, 'label']} rules={[{ required: true }]}><Input placeholder="显示名称" /></Form.Item>
            <Button danger type="link" onClick={() => remove(item.name)}>移除</Button>
          </Space>)}
          <Button block onClick={() => add({ code: '', label: '' })}>添加候选值</Button>
        </>}</Form.List>
        <Form.Item name="confirmed" valuePropName="checked" style={{ marginTop: 16 }}><Checkbox>候选集已由业务确认，可用于正式录入</Checkbox></Form.Item>
        <Button type="primary" htmlType="submit" loading={busy}>保存配置</Button>
      </Form>
    </Modal>
  </>;
}
