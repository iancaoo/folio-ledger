import React, { forwardRef, useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Button, Select, Spin } from 'antd';

export const RemoteSelect = forwardRef<any, any>(function RemoteSelect({ resource, params = {}, onRecord, ...props }, ref) {
  const api = useAPIClient();
  const [search, setSearch] = useState(''); const [page, setPage] = useState(1);
  const [items, setItems] = useState<any[]>([]); const [selected, setSelected] = useState<any[]>([]);
  const [count, setCount] = useState(0); const [loading, setLoading] = useState(false); const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0); const generation = useRef(0); const selectedGeneration = useRef(0);
  const callback = useRef(onRecord); callback.current = onRecord;
  const context = JSON.stringify(params); const action = resource === 'users' ? 'userLookup' : 'lookup';
  useEffect(() => { setPage(1); setItems([]); setSearch(''); }, [resource, context]);
  useEffect(() => {
    const current = ++generation.current; setLoading(true); setError(false);
    const timer = setTimeout(() => api.request({ url: `finance:${action}`, params: { resource, ...params, search, page, page_size: 20 } }).then(response => {
      if (current !== generation.current) return;
      const result = response.data.data; setItems(old => page === 1 ? result.rows : [...new Map([...old, ...result.rows].map(row => [row.value, row])).values()]); setCount(result.count);
    }).catch(() => { if (current === generation.current) setError(true); }).finally(() => { if (current === generation.current) setLoading(false); }), search ? 200 : 0);
    return () => { generation.current++; clearTimeout(timer); };
  }, [resource, context, search, page, refresh]);
  const idKey = Array.isArray(props.value) ? props.value.filter(Boolean).join(',') : props.value ? String(props.value) : '';
  useEffect(() => {
    const current = ++selectedGeneration.current; setSelected([]);
    if (!idKey) { callback.current?.(undefined); return; }
    const idCount = idKey.split(',').filter(Boolean).length;
    api.request({ url: `finance:${action}`, params: { resource, ...params, ids: idKey, page_size: Math.min(50, idCount) } }).then(response => {
      if (current !== selectedGeneration.current) return;
      const rows = response.data.data.rows || []; setSelected(rows); callback.current?.(idCount === 1 ? rows[0]?.record : undefined);
    }).catch(() => { if (current === selectedGeneration.current) setError(true); });
    return () => { selectedGeneration.current++; };
  }, [resource, context, idKey, refresh]);
  const options = [...new Map([...items, ...selected].map(row => [row.value, row])).values()];
  return <Select {...props} ref={ref} showSearch filterOption={false} loading={loading} options={options} onSearch={value => { setSearch(value); setPage(1); setItems([]); }}
    onChange={(value, option: any) => { callback.current?.(option?.record); props.onChange?.(value, option); }}
    onDropdownVisibleChange={open => { if (open) { setRefresh(value => value + 1); setPage(1); } props.onDropdownVisibleChange?.(open); }}
    onPopupScroll={event => { const target = event.target as HTMLElement; if (!loading && !error && items.length < count && target.scrollTop + target.clientHeight >= target.scrollHeight - 32) setPage(value => value + 1); }}
    dropdownRender={menu => <>{menu}{error ? <Button block onMouseDown={event => event.preventDefault()} onClick={() => setRefresh(value => value + 1)}>读取失败，重试</Button> : items.length < count && <Button block loading={loading} onMouseDown={event => event.preventDefault()} onClick={() => setPage(value => value + 1)}>加载更多（已显示 {items.length}／{count}）</Button>}</>}
    placeholder={props.placeholder || '可搜索名称或业务标识'} notFoundContent={loading ? <Spin size="small" /> : error ? '读取失败，请重试' : '无匹配对象'} />;
});
