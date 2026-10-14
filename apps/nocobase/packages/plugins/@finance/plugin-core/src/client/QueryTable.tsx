import React, { useEffect, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Input, Select, Table, Tooltip, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { RemoteSelect } from './RemoteSelect';

const prefix = (label: string) => <span className="finance-prefix">{label}</span>;

export function QueryTable({ table, action = 'list', columns, refresh, controls = [], initial = {}, fixed = {}, title, rowKey = 'id', searchPlaceholder = '搜索名称、ISIN 或客户编号' }: any) {
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
  return <div className="finance-query" data-finance-table={table || action}>
    <div className="finance-toolbar">
      <div className="finance-toolbar-filters">
        <Input.Search aria-label={`${title}搜索`} placeholder={searchPlaceholder} allowClear style={{ width: 260 }} onSearch={value => change('search', value)} />
        {controls.map(control => <React.Fragment key={control.key}>{control.resource
          ? <RemoteSelect aria-label={`${title}${control.label}`} prefix={prefix(control.label)} placeholder="全部" resource={control.resource} params={control.params} allowClear value={query[control.key]} onChange={value => change(control.key, value)} style={{ width: 250 }} />
          : control.type === 'date' ? <Input aria-label={`${title}${control.label}`} prefix={prefix(control.label)} type="date" value={query[control.key] || ''} onChange={event => change(control.key, event.target.value)} style={{ width: 210 }} />
          : control.type === 'text' ? <Input.Search aria-label={`${title}${control.label}`} placeholder={control.label} style={{ width: 130 }} allowClear onSearch={value => change(control.key, value)} />
          : <Select aria-label={`${title}${control.label}`} prefix={prefix(control.label)} placeholder="全部" allowClear style={{ minWidth: 140 }} value={query[control.key]} options={control.options} onChange={value => change(control.key, value)} />}</React.Fragment>)}
      </div>
      <div className="finance-toolbar-meta">
        <Typography.Text type="secondary">共 {result.count ?? 0} 条</Typography.Text>
        <Tooltip title="刷新列表"><Button aria-label="刷新列表" icon={<ReloadOutlined />} onClick={() => setRetry(value => value + 1)} /></Tooltip>
      </div>
    </div>
    {error && <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => setRetry(value => value + 1)}>重试</Button>} style={{ marginBottom: 12 }} />}
    <Table className="finance-table" rowKey={rowKey} size="middle" dataSource={result.rows} columns={columns} loading={loading} scroll={{ x: 900 }} pagination={{ current: query.page, pageSize: query.page_size, total: result.count, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100], showTotal: count => `共 ${count} 条`, onChange: (page, page_size) => setQuery(old => ({ ...old, page: page_size !== old.page_size ? 1 : page, page_size })) }} locale={{ emptyText: error ? '读取失败' : '暂无匹配记录' }} />
  </div>;
}
export const stateControl = (inactive = '已删除') => ({ key: 'state', label: '状态', options: [{ value: 'all', label: '全部' }, { value: 'active', label: '有效' }, { value: 'inactive', label: inactive }] });
export const dateControls = [{ key: 'date_from', label: '开始日期', type: 'date' }, { key: 'date_to', label: '结束日期', type: 'date' }];
