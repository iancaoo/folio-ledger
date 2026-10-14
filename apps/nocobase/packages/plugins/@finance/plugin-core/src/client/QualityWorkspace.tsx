import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Input, Select, Space, Table, Tag, Typography } from 'antd';
import { useAPIClient } from '@nocobase/client';
import { issueCategories, issueFieldLabel } from '../shared/issues';
import { RemoteSelect } from './RemoteSelect';
import { ReloadOutlined } from '@ant-design/icons';
import { BatchStatus, DateText, StatCard, TwoLine } from './ui';

const categoryTones = { missing_nav: 'warning', unknown_estimate: 'warning', options: 'default', imports: 'danger', composition: 'warning', future: 'default' };

export function QualityWorkspace({ active, refresh, resolve, source, canWrite, canConfigure, asOf, setDate, category, setCategory }: any) {
  const api = useAPIClient();
  const [query, setQuery] = useState<any>({ page: 1, page_size: 10, as_of: new Date().toISOString().slice(0,10), category });
  const [result, setResult] = useState<any>({ rows: [], summary: {}, count: 0 });
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  useEffect(() => { if (asOf) setQuery(old => ({ ...old, as_of: asOf, page: 1 })); }, [asOf]);
  useEffect(() => { setQuery(old => old.category === category ? old : { ...old, category, page: 1 }); }, [category]);
  useEffect(() => {
    if (!active) return;
    let current = true; setLoading(true); setError('');
    api.request({ url: 'finance:issues', params: query }).then(response => {
      if (!current) return; const value = response.data.data;
      if (query.page>1 && !value.rows.length && value.count<=(query.page-1)*query.page_size) { setQuery(old => ({ ...old, page: Math.max(1,Math.ceil(value.count/query.page_size)) })); return; }
      setResult(value);
    }).catch(error => { if (current) { setResult({ rows: [], summary: {}, count: 0 }); setError(error.response?.data?.errors?.[0]?.message || '问题列表读取失败，请重试'); } }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [active, refresh, retry, JSON.stringify(query)]);
  const change = (key, value) => { setQuery(old => ({ ...old, [key]: value || undefined, page: 1 })); if (key === 'category') setCategory?.(value || undefined); };
  const total = Object.values(result.summary || {}).reduce<number>((sum, value: any) => sum + (Number(value) || 0), 0);
  async function open(row, original = false) {
    setError(''); try { await (original ? source(row) : resolve(row)); } catch (error: any) { setError(error.response?.data?.errors?.[0]?.message || error.message || '对象已变化，请刷新后重试'); }
  }
  const batchLabels = {awaiting_file:'等待原文件',parsing:'解析中',staged:'待映射',ready:'可提交',needs_correction:'需修正',committed:'已提交',failed:'解析失败',cancelled:'已取消'};
  return <Card title="数据质量工作台" data-finance-quality extra={<Typography.Text type="secondary">共 {total} 项问题 · 点击分类卡片筛选</Typography.Text>}>
    <Typography.Paragraph type="secondary">问题来自当前已保存数据，修改后刷新重新检查。导入错误只显示本人的选中行及解析失败批次；未来日期仅供核对，不自动删除；旧净值不设未经确认的逾期门槛。</Typography.Paragraph>
    <div className="finance-stats is-compact">{Object.entries(issueCategories).map(([key,label]) => { const value = result.summary[key] || 0; return <StatCard key={key} label={label} ariaLabel={`${label} · ${value}`} value={value} unit="项" tone={value ? categoryTones[key] : 'success'} active={query.category===key} onClick={()=>change('category',query.category===key?undefined:key)} hint={query.category===key ? '已筛选 · 再次点击取消' : value ? '点击筛选' : '未发现问题'} />; })}</div>
    <div className="finance-toolbar">
      <div className="finance-toolbar-filters">
        <Input.Search aria-label="质量问题搜索" placeholder="搜索对象、字段或原因" allowClear style={{ width: 260 }} onSearch={value=>change('search',value)} />
        <Input type="date" aria-label="质量检查业务日" prefix={<span className="finance-prefix">检查业务日</span>} style={{ width: 220 }} value={query.as_of || ''} onChange={event=>{ if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) { change('as_of',event.target.value); setDate?.(event.target.value); } }} />
        <Select aria-label="质量问题类型" allowClear prefix={<span className="finance-prefix">类型</span>} placeholder="全部" style={{ width: 180 }} value={query.category} onChange={value=>change('category',value)} options={Object.entries(issueCategories).map(([value,label])=>({value,label}))} />
        <RemoteSelect aria-label="质量问题基金" resource="funds" params={{state:'all'}} allowClear prefix={<span className="finance-prefix">基金</span>} placeholder="全部" style={{width:230}} value={query.fund_id} onChange={value=>change('fund_id',value)} />
        <RemoteSelect aria-label="质量问题主体" resource="investment_entities" params={{state:'all'}} allowClear prefix={<span className="finance-prefix">主体</span>} placeholder="全部" style={{width:230}} value={query.entity_id} onChange={value=>change('entity_id',value)} />
      </div>
      <div className="finance-toolbar-meta"><Button icon={<ReloadOutlined />} onClick={()=>setRetry(value=>value+1)}>刷新检查</Button></div>
    </div>
    {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
    <Table<Record<string, any>> className="finance-table" rowKey="id" size="middle" loading={loading} dataSource={result.rows} scroll={{x:1250}} pagination={{current:query.page,pageSize:query.page_size,total:result.count,showTotal:count=>`共 ${count} 项`,showSizeChanger:true,pageSizeOptions:[10,20,50,100],onChange:(page,page_size)=>setQuery(old=>({...old,page:old.page_size!==page_size?1:page,page_size}))}} columns={[
      { title:'类型',dataIndex:'category',width:120,render:value=><Tag color={value==='imports'?'error':value==='options'?'default':'warning'} bordered={false}>{issueCategories[value]}</Tag> },
      { title:'对象',dataIndex:'object_name',width:300,render:value=>{ const [main, ...rest] = String(value || '—').split(' / '); return <TwoLine main={main} sub={rest.join(' / ')} />; } }, {title:'业务日期',dataIndex:'business_date',width:110,render:value=><DateText value={value} />},
      { title:'字段与原因',render:(_,row)=><><Typography.Text strong title={row.field_path}>{issueFieldLabel(row.field_path)}</Typography.Text><div>{row.reason}</div>{row.context?.deleted && <Typography.Text type="warning">关联对象已删除或停用，新增前需恢复。</Typography.Text>}</> },
      { title:'来源',width:180,render:(_,row)=>row.category==='options'?`${row.context.source_sheet} 第 ${row.context.source_row} 行`:row.source_batch_id?<><div>{row.source_access?row.source_name:'导入记录'}</div>{row.source_access?<Button type="link" onClick={()=>open(row,true)}>{row.source_sheet || '原文件'}{row.source_row?` · 第 ${row.source_row} 行`:''}</Button>:<Typography.Text type="secondary">原批次仅本人可查看</Typography.Text>}</>:'当前业务记录' },
      { title:'处理',width:135,render:(_,row)=>row.category==='options'&&!canConfigure?<Typography.Text type="secondary">需配置管理员确认</Typography.Text>:<Button type="link" disabled={row.category!=='options'&&!canWrite} onClick={()=>open(row)}>{row.category==='imports'?'打开批次纠错':row.category==='options'?'维护候选值':row.code==='MISSING_NAV'?'补录净值':'核对／修正'}</Button> },
    ]} locale={{emptyText:error?'检查失败':'当前筛选下未发现上述问题'}} />
    <Typography.Title level={5} className="finance-section-title">我的最近 5 个导入批次</Typography.Title>
    <Typography.Paragraph type="secondary">仅显示本人批次，不受上方问题筛选影响。</Typography.Paragraph>
    <Table<Record<string,any>> className="finance-table" rowKey="id" size="small" pagination={false} dataSource={result.recent_imports || []} columns={[
      {title:'原文件',dataIndex:'original_name'},{title:'状态',dataIndex:'status',render:value=><BatchStatus value={value} labels={batchLabels} />},
      {title:'接收时间',dataIndex:'created_at',render:value=>new Date(value).toLocaleString('zh-CN')},
      {title:'查看',render:(_,row)=><Button type="link" onClick={()=>open({source_batch_id:row.id,context:{}},true)}>打开批次</Button>},
    ]}/>
  </Card>;
}
