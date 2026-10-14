import React, { useEffect, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Input, Select, Space, Table } from 'antd';
import { RemoteSelect } from './RemoteSelect';

export function QueryTable({ table, action = 'list', columns, refresh, controls = [], initial = {}, fixed = {}, title, rowKey = 'id' }: any) {
  const api = useAPIClient();
  const [query, setQuery] = useState<any>({ ...initial, page: 1, page_size: 10 });
  const [result, setResult] = useState<any>({ rows: [], count: 0 }); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const [retry, setRetry] = useState(0); const key = JSON.stringify({ query, fixed });
  useEffect(() => {
    let current = true; setLoading(true); setError('');
    api.request({ url: `finance:${action}`, params: { ...query, ...fixed, ...(table ? { table } : {}) } }).then(response => {
      if (!current) return;
      const body = response.data; const result = action === 'list' ? { rows: body.data, ...body.meta } : body.data;
      if (query.page > 1 && !result.rows.length && result.count <= (query.page - 1) * query.page_size) { setQuery(old => ({ ...old, page: Math.max(1, Math.ceil(result.count / query.page_size)) })); return; }
      setResult(result);
    }).catch(error => { if (current) setError(error.response?.data?.errors?.[0]?.message || '列表读取失败，请重试'); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [table, action, key, refresh, retry]);
  const change = (name, value) => setQuery(old => ({ ...old, [name]: value || undefined, page: 1 }));
  return <div data-finance-table={table || action}>
    <Space wrap size={[12, 12]} style={{ margin: '12px 0' }} align="end">
      <Input.Search aria-label={`${title}搜索`} placeholder="搜索名称、ISIN 或客户编号" allowClear style={{ width: 270 }} onSearch={value => change('search', value)} />
      {controls.map(control => <div key={control.key}><div style={{ marginBottom: 4 }}>{control.label}</div>{control.resource ? <RemoteSelect aria-label={`${title}${control.label}`} resource={control.resource} params={control.params} allowClear value={query[control.key]} onChange={value => change(control.key, value)} style={{ width: 235 }} /> : control.type === 'date' ? <Input aria-label={`${title}${control.label}`} type="date" value={query[control.key] || ''} onChange={event => change(control.key, event.target.value)} /> : control.type === 'text' ? <Input.Search aria-label={`${title}${control.label}`} style={{ width: 130 }} allowClear onSearch={value => change(control.key, value)} /> : <Select aria-label={`${title}${control.label}`} allowClear style={{ minWidth: 120 }} value={query[control.key]} options={control.options} onChange={value => change(control.key, value)} />}</div>)}
      <Button onClick={() => setRetry(value => value + 1)}>刷新列表</Button>
    </Space>
    {error && <Alert type="error" message={error} action={<Button onClick={() => setRetry(value => value + 1)}>重试</Button>} />}
    <Table rowKey={rowKey} size="middle" dataSource={result.rows} columns={columns} loading={loading} scroll={{ x: 900 }} pagination={{ current: query.page, pageSize: query.page_size, total: result.count, showSizeChanger: true, pageSizeOptions: [10,20,50,100], showTotal: count => `共 ${count} 条`, onChange: (page, page_size) => setQuery(old => ({ ...old, page: page_size !== old.page_size ? 1 : page, page_size })) }} locale={{ emptyText: error ? '读取失败' : '暂无匹配记录' }} />
  </div>;
}
export const stateControl = (inactive = '已删除') => ({ key: 'state', label: '状态', options: [{ value: 'all', label: '全部' }, { value: 'active', label: '有效' }, { value: 'inactive', label: inactive }] });
export const dateControls = [{ key: 'date_from', label: '开始日期', type: 'date' }, { key: 'date_to', label: '结束日期', type: 'date' }];
