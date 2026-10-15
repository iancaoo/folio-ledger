import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Col, Collapse, Form, Input, Modal, Row, Select, Space, Table, Tabs, Tag, Typography, message, theme } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AppstoreOutlined, FundOutlined, TeamOutlined, SwapOutlined, ImportOutlined, CheckCircleOutlined, SettingOutlined, UnorderedListOutlined, DatabaseOutlined, LineChartOutlined } from '@ant-design/icons';
import { DateText, FundKind, Num, PageIntro, RecordState, ShareCell, StatCard, TradeType, numColumn } from './ui';
import { Workbench, FundCenter, localToday } from './BusinessPages';
import catalog from '../shared/field-catalog.json';
import navigation from '../shared/navigation.json';
import { decimal, Decimal, FinanceError } from '../shared/values';
import './style.css';
import { ImportWorkspace } from './ImportWorkspace';
import { OptionsWorkspace } from './OptionsWorkspace';
import { optionDefinition } from '../shared/options';
import { VersionViewer } from './VersionViewer';
import { FileWorkspace } from './FileWorkspace';
import { CompositionEditor, CompositionWorkspace, compositionDraft } from './CompositionWorkspace';
import { RemoteSelect } from './RemoteSelect';
import { QueryTable, stateControl, dateControls } from './QueryTable';
import { DraftWorkspace, useEntryDraft } from './EntryDrafts';
import { QualityWorkspace } from './QualityWorkspace';
import { ExportWorkspace } from './ExportWorkspace';
import { ReportWorkspace } from './ReportWorkspace';

const { Title, Text } = Typography;
const OptionsContext = createContext<any[]>([]);
const INTERNAL = new Set(['business_version', 'version_no', 'saved_at', 'is_deleted']);
const tableFields = (table: string, kind?: string) => {
  const seen = new Set<string>();
  return catalog.fields.flatMap(source => {
    if (source.logical_table !== table) return [];
    if (kind && ['三方基金页面', '自营基金页面'].includes(source.source_sheet) && source.source_sheet !== (kind === 'third_party' ? '三方基金页面' : '自营基金页面')) return [];
    return source.mapping.split('；')[0].split(' + ').flatMap((part, i) => {
      const name = part.includes('.') ? part.split('.')[1] : part;
      if (seen.has(name) || INTERNAL.has(name) || name.endsWith('_id') && !name.endsWith('_user_id')) return [];
      seen.add(name);
      return [{ ...source, name, secondary: i > 0, label: i > 0 ? `${source.label}（规则／单位）` : source.label }];
    });
  });
};
const demoChoices = (name: string) => name.includes('currency') ? ['USD', 'HKD', 'CNY'] : name.includes('frequency') ? ['每月', '每季度'] : name.endsWith('_user_id') ? ['1'] : ['模拟值'];
const demoValues = (table: string, kind?: string, userId = '1') => Object.fromEntries(tableFields(table, kind).filter(field => field.required).map(field => [field.name,
  field.name.endsWith('_user_id') ? userId : field.name === 'gate_raw' ? { value: '10', unit: '模拟单位' } : field.secondary ? '模拟值' : field.source_type.startsWith('数值') ? '1' : field.source_type === '日期' ? '2026-01-01' : /下拉|单选/.test(field.source_type) ? demoChoices(field.name)[0] : '模拟值',
]));
const pick = (table: string, row: any, kind?: string) => Object.fromEntries(tableFields(table, kind).filter(field => row?.[field.name] !== undefined).map(field => [field.name, row[field.name]]));
const clean = (value: any) => JSON.parse(JSON.stringify(value));

function UserSelect({ group, ...props }: any) {
  return <RemoteSelect {...props} resource="users" params={{ group }} allowClear placeholder="从系统用户中选择，可搜索姓名" />;
}

function Fields({ table, prefix, kind, demo }: { table: string; prefix: any[]; kind?: string; demo: boolean }) {
  const fields = tableFields(table, kind);
  const configured = useContext(OptionsContext);
  return <Row gutter={[20, 0]}>{fields.map(field => {
    const path = [...prefix, field.name];
    const definition = optionDefinition(field.source_key, field.name);
    const options = definition && configured.find(item => item.source_key === definition.source_key);
    const choices = [...(options?.values || []).map(value => ({ value: value.code, label: value.label })), ...(demo && definition ? demoChoices(field.name).filter(value => !options?.values.some(item => item.code === value)).map(value => ({ value, label: `${value}（模拟）` })) : [])];
    const label = <span>{field.label} {definition && !options?.confirmed && <Tag color="orange">待确认{demo ? ' · 可模拟' : ''}</Tag>}</span>;
    if (field.name === 'gate_raw') return <Col xs={24} md={12} key={field.name}><Form.Item label={field.label} required={field.required}><Space.Compact block><Form.Item name={[...path, 'value']} noStyle rules={[{ required: field.required }]}><Input placeholder="原数值" /></Form.Item><Form.Item name={[...path, 'unit']} noStyle rules={[{ required: field.required }]}><Input placeholder="原单位／规则（待确认）" /></Form.Item></Space.Compact></Form.Item></Col>;
    return <Col xs={24} md={field.source_type === '多行文本' ? 24 : 12} xl={field.source_type === '多行文本' ? 24 : 8} key={field.name}>
      <Form.Item name={path} label={label} extra={field.name === 'size_100m_usd' ? '单位：亿美元' : undefined} rules={[{ required: field.required, message: `请填写${field.label}` }]} tooltip={`${field.source_sheet} 第 ${field.source_row} 行；${field.notes}`}>
        {field.name.endsWith('_user_id') ? <UserSelect group={field.name === 'coverage_owner_user_id' ? 'product' : 'all'} /> : definition ? <Select allowClear options={choices} disabled={!demo && !options?.confirmed} placeholder={options?.confirmed ? '选择已配置候选值' : demo ? '选择候选或模拟值' : '候选项待业务确认'} />
          : field.source_type === '多行文本' ? <Input.TextArea rows={2} placeholder="按原条款填写，可换行" />
          : <Input type={field.source_type === '日期' ? 'date' : 'text'} inputMode={field.source_type.startsWith('数值') ? 'decimal' : undefined} placeholder={field.secondary ? '保留原规则或单位' : field.source_type.startsWith('数值') ? '精确数值，不自动四舍五入' : ''} />}
      </Form.Item>
    </Col>;
  })}</Row>;
}

export function FinanceWorkspace({ embeddedPage }: { embeddedPage?: string } = {}) {
  const api = useAPIClient();
  const [route, setRoute] = useSearchParams();
  const { token } = theme.useToken();
  const routerNavigate = useNavigate();
  const [nativePages, setNativePages] = useState<Record<string, string>>({});
  useEffect(() => {
    api.request({ url: 'desktopRoutes:listAccessible', params: { paginate: false } }).then(({ data }) => {
      const flatten = (rows: any[]): any[] => rows.flatMap(row => [row, ...flatten(row.children || [])]);
      const routes = flatten(data.data || []);
      const pages: Record<string, string> = {};
      for (const item of navigation) {
        const matches = routes.filter(row => row.type === 'flowPage' && row.options?.financePage === item.key);
        if (matches.length === 1 && matches[0].schemaUid) pages[item.key] = `/admin/${matches[0].schemaUid}`;
      }
      setNativePages(pages);
    }).catch(() => { /* Business API permissions remain independent of native menu discovery. */ });
  }, [api]);
  const active = embeddedPage || route.get('page') || 'home';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(route.get('date') || '') ? route.get('date')! : localToday();
  const fundId = route.get('fund') || undefined;
  const fundSection = ['info', 'classes', 'nav', 'compositions', 'files'].includes(route.get('section') || '') ? route.get('section')! : 'info';
  const navigate = (patch: Record<string, string | undefined>, options: { replace?: boolean } = {}) => { const next = new URLSearchParams(route); for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); } const targetPage = patch.page || active;
    if (nativePages[targetPage] && (!embeddedPage || targetPage !== active)) {
      next.delete('page');
      routerNavigate({ pathname: nativePages[targetPage], search: next.toString() }, options);
    } else if (embeddedPage && targetPage !== active) {
      routerNavigate({ pathname: '/admin/finance', search: next.toString() }, options);
    } else {
      if (embeddedPage) next.delete('page');
      setRoute(next, options);
    }
  };
  useEffect(() => {
    if (!embeddedPage && route.get('legacy') !== '1' && nativePages[active]) {
      const next = new URLSearchParams(route); next.delete('page');
      routerNavigate({ pathname: nativePages[active], search: next.toString() }, { replace: true });
    }
  }, [embeddedPage, active, nativePages]);
  const setActive = (page: string) => navigate({ page });
  const setDate = (date: string) => navigate({ date });
  const openFund = (id: string, section = 'info', share?: string, options?: { replace?: boolean }) => navigate({ page: 'funds', fund: id, section, share }, options);
  const qualityCategory = route.get('category') || undefined;
  const [navContext, setNavContext] = useState<any>();
  const documentFundId = route.get('documentFund') || undefined;
  const setDocumentFundId = (id?: string) => navigate({ documentFund: id });
  const compositionFundId = route.get('compositionFund') || undefined;
  const setCompositionFundId = (id?: string, options?: { replace?: boolean }) => navigate({ compositionFund: id }, options);
  const [metadata, setMetadata] = useState<any>();
  const [summary, setSummary] = useState<any>({});
  const [refresh, setRefresh] = useState(0);
  const [tradeShare, setTradeShare] = useState<any>();
  const [compositionLabels, setCompositionLabels] = useState<Record<string, string>>({});
  const importTarget = React.useMemo(() => route.get('batch') ? { batch_id: route.get('batch'), row_id: route.get('row') || undefined, source_row: route.get('sourceRow') ? Number(route.get('sourceRow')) : undefined, source_sheet: route.get('sourceSheet') || undefined, nonce: route.get('targetNonce') } : undefined, [route.toString()]);
  const optionTarget = React.useMemo(() => route.get('option') ? { source_key: route.get('option'), nonce: route.get('targetNonce') } : undefined, [route.toString()]);
  const [entryFocus, setEntryFocus] = useState<any>();
  const [entryNotice, setEntryNotice] = useState<any>();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<string>();
  const [editing, setEditing] = useState<any>();
  const [versions, setVersions] = useState<any[]>([]);
  const [fundForm] = Form.useForm();
  const [entityForm] = Form.useForm();
  const [tradeForm] = Form.useForm();
  const [seriesForm] = Form.useForm();
  const [benchmarkForm] = Form.useForm();
  const [benchmarkValueForm] = Form.useForm();
  const fundKind = Form.useWatch('fund_kind', fundForm) || 'third_party';
  const tradeClass = Form.useWatch('share_class_id', tradeForm);
  const tradeCurrency = Form.useWatch('currency', tradeForm);
  const tradeValues = Form.useWatch([], tradeForm);
  const request = useRef<{ body: string; key: string }>();
  const duplicateChoice = useRef<{ body: string; token: string }>();
  const seriesAttempt = useRef<{ body: string; payload: any }>();
  const demo = metadata?.demo_mode === true;
  const canWrite = metadata?.permissions?.write === true;
  const forms = { fund: fundForm, entity: entityForm, trade: tradeForm, series: seriesForm, benchmark: benchmarkForm, benchmarkValue: benchmarkValueForm };
  const drafts = useEntryDraft({ api, forms, dialog, editing, canWrite, busy, setBusy, setError, close: () => setDialog(undefined), refresh: () => setRefresh(value => value + 1) });
  const refreshMetadata = () => read('metadata').then(setMetadata);
  const choicesFor = (key: string) => (metadata?.options?.find(item => item.source_key === key)?.values || []).map(item => ({ value: item.code, label: item.label }));
  async function read(action: string, params: any = {}) {
    const body = (await api.request({ url: `finance:${action}`, params })).data;
    return action === 'list' ? { rows: body.data, ...body.meta } : body.data;
  }
  async function reload() {
    setRefresh(value => value + 1);
    try { setSummary(await read('summary')); setError(''); }
    catch (e: any) { setError(e.response?.data?.errors?.[0]?.message || e.message); }
  }
  useEffect(() => { read('metadata').then(setMetadata).catch((e: any) => setError(e.message)); reload(); }, []);
  useEffect(() => { if (tradeShare && tradeShare.id === tradeClass && !tradeForm.getFieldValue('currency')) tradeForm.setFieldValue('currency', tradeShare.currency); }, [tradeShare, tradeClass]);
  useEffect(() => {
    if (!entryFocus || !forms[dialog]) return;
    const timer = setTimeout(() => { forms[dialog].scrollToField(entryFocus, { block: 'center' }); forms[dialog].getFieldInstance(entryFocus)?.focus?.(); }, 180);
    return () => clearTimeout(timer);
  }, [dialog, entryFocus]);
  const currencyWarning = tradeShare && tradeCurrency && tradeShare.currency !== tradeCurrency;
  let amountWarning = false;
  try { if (tradeValues?.amount && tradeValues?.confirmed_units && tradeValues?.confirmed_nav) amountWarning = !new Decimal(tradeValues.amount).eq(new Decimal(tradeValues.confirmed_units).times(tradeValues.confirmed_nav)); } catch {}
  async function save(action: string, payload: any) {
    if (['saveFund', 'saveEntity', 'saveTrade', 'saveSeries', 'saveBenchmark'].includes(action) && drafts.reference.current) payload = { ...payload, draft: drafts.reference.current };
    const serialized = JSON.stringify(clean(payload));
    if (request.current?.body !== `${action}:${serialized}`) request.current = { body: `${action}:${serialized}`, key: crypto.randomUUID() };
    setBusy(true); setError('');
    try {
      let response = (await api.request({ skipNotify: true, url: `finance:${action}`, method: 'post', data: { ...clean(payload), request_key: request.current.key } })).data.data;
      if (['stageImport', 'previewImport', 'cancelImport', 'retryImport'].includes(action)) response = await read('importBatch', { id: response.batch_id });
      request.current = undefined; drafts.reset();
      message.success({ content: action === 'stageImport' ? '文件已接收，可在批次中查看解析进度' : action === 'discardDraft' ? '草稿已删除' : '保存成功', key: 'finance-save', duration: 2 }); setDialog(undefined); await reload(); return response;
    } catch (e: any) {
      const detail = e.response?.data?.errors?.[0];
      setError(detail ? `${detail.message}${detail.field_path ? `（${detail.field_path}）` : ''}` : '连接中断；保留输入后重试，同一次请求不会重复保存');
      throw e;
    } finally { setBusy(false); }
  }
  const open = (name: string) => { setNavContext(undefined); drafts.reset(); setEditing(undefined); setEntryFocus(undefined); setEntryNotice(undefined); request.current = undefined; duplicateChoice.current = undefined; seriesAttempt.current = undefined; setError(''); setDialog(name); };
  async function resumeDraft(row: any) {
    const form = forms[row.form_type]; if (!form) throw new Error('不支持此草稿表单');
    open(row.form_type); form.resetFields(); form.setFieldsValue(row.content.values);
    setEditing(row.content.editing); drafts.setReference({ id: row.id, technical_revision: row.technical_revision });
  }
  async function submitTrade(values: any, confirmation?: string) {
    try {
      const body = JSON.stringify(values);
      if (confirmation) duplicateChoice.current = { body, token: confirmation };
      else if (duplicateChoice.current?.body === body) confirmation = duplicateChoice.current.token;
      const input = { ...values };
      if (input.fee_rate) input.fee_rate = new Decimal(decimal(input.fee_rate, 'transactions.fee_rate')!).times('0.01').toFixed();
      await save('saveTrade', { values: input, ...(editing ? { id: editing.id, technical_revision: editing.technical_revision } : {}), ...(confirmation ? { duplicate_confirmation: confirmation } : {}) });
      duplicateChoice.current = undefined;
    } catch (e: any) {
      if (e instanceof FinanceError) { setError(e.message); return; }
      const detail = e.response?.data?.errors?.[0];
      if (detail?.code === 'DUPLICATE_TRADE') Modal.confirm({ title: '疑似重复交易', content: `已有 ${detail.details.records.length} 笔交易与本次主体、份额、日期、类型、金额 ${values.amount} 及份额 ${values.confirmed_units} 相同。确认这是另一笔真实交易后可以继续。`, okText: '确认为另一笔并保存', cancelText: '返回核对', onOk: () => submitTrade(values, detail.details.confirmation_token) });
    }
  }
  async function submitSeries(type: string, values: any) {
    setBusy(true); setError('');
    try {
      const body = JSON.stringify({ type, values: clean(values) });
      const submitPayload = async (payload: any) => {
        seriesAttempt.current = { body, payload };
        try { await save('saveSeries', payload); seriesAttempt.current = undefined; }
        catch (error: any) { if (error.response) seriesAttempt.current = undefined; throw error; }
      };
      // A lost response must retry the accepted revision and request key, not
      // read our own committed value and accidentally create another overwrite.
      if (seriesAttempt.current?.body === body) { await submitPayload(seriesAttempt.current.payload); return; }
      seriesAttempt.current = undefined;
      const parent = type === 'benchmark' ? values.benchmark_id : values.share_class_id;
      const date = type === 'benchmark' ? values.value_date : values.date;
      const valueField = type === 'benchmark' ? 'index_value' : type === 'nav' ? 'nav_per_unit' : 'mtd_return';
      const input = type === 'benchmark' ? values : { share_class_id: parent, [type === 'nav' ? 'nav_date' : 'return_date']: date,
        [valueField]: type === 'returns' ? new Decimal(decimal(values.value, 'value', { required: true })!).times('0.01').toFixed() : values.value,
        ...(type === 'returns' ? { estimate_label: values.estimate_label || null } : {}) };
      const existing = await read('seriesAt', { data_type: type, parent_id: parent, date });
      const submit = () => submitPayload({ data_type: type, values: input, expected_revision: existing?.technical_revision ?? null });
      if (existing) Modal.confirm({ title: type === 'benchmark' ? '覆盖同日基准数值' : '覆盖同日记录', content: <><p>原值 {existing[valueField]}，新值 {input[valueField]}{type === 'returns' ? '（比例值）' : ''}。</p>{type === 'returns' && <p>估算标记：{existing.estimate_label || '未填写'} → {input.estimate_label || '未填写'}{existing.estimate_label === '否' && input.estimate_label !== '否' ? '；原正式标记将被覆盖，请核对。' : ''}</p>}<p>提交前会再次检查修订号；基金资料版本不增加。</p></>, onOk: () => submit().catch(() => {}) });
      else await submit();
    } catch (error: any) { setError(error.response?.data?.errors?.[0]?.message || (error instanceof FinanceError ? error.message : '连接中断，请保留输入重试；保存请求会沿用原标识')); }
    finally { setBusy(false); }
  }
  const shareLabel = (id: string) => compositionLabels[id] || id;
  const renderTable = (rows: any[], columns: any[]) => <Table rowKey="id" size="middle" dataSource={rows} columns={columns} pagination={{ pageSize: 10, showSizeChanger: true }} scroll={{ x: 760 }} />;
  const businessTable = (table: string, title: string, columns: any[], controls: any[] = [], initial = {}) => <QueryTable table={table} title={title} columns={columns} controls={controls} initial={initial} refresh={refresh} />;
  async function editFund(row: any) {
    const aggregate = await read('fund', { id: row.id });
    const kind = aggregate.fund.fund_kind;
    fundForm.resetFields();
    const compositions = aggregate.compositions.map(compositionDraft);
    const ids = [...new Set(compositions.flatMap(list => list.items.map(item => item.child_share_class_id)))];
    const labels = {};
    for (let i = 0; i < ids.length; i += 50) for (const option of (await read('lookup', { resource: 'share_classes', ids: ids.slice(i, i + 50).join(','), page_size: 50 })).rows) labels[option.value] = option.label;
    setCompositionLabels(labels);
    fundForm.setFieldsValue({ fund_kind: kind, fund: pick('funds', aggregate.fund, kind), details: pick(`${kind}_fund_details`, aggregate.details, kind), share_classes: aggregate.share_classes.filter(item => !item.is_deleted).map(item => ({ id: item.id, values: pick('share_classes', item, kind), terms: pick(`${kind}_class_terms`, item.terms, kind) })), compositions });
    open('fund'); setEditing({ ...aggregate.fund, all_classes: aggregate.share_classes, original_compositions: compositions });
  }
  async function editEntity(row: any) {
    const aggregate = await read('entity', { id: row.id });
    entityForm.resetFields();
    entityForm.setFieldsValue({ client_code: aggregate.client_code, entity: pick('investment_entities', aggregate.entity), agreements: aggregate.agreements, products: aggregate.products });
    open('entity'); setEditing({ ...aggregate.entity, next_cdd_deadline: aggregate.next_cdd_deadline });
  }
  function editTrade(row: any) {
    tradeForm.resetFields(); tradeForm.setFieldsValue({ ...pick('transactions', row), entity_id: row.entity_id, share_class_id: row.share_class_id, fee_rate: row.fee_rate ? new Decimal(row.fee_rate).times('100').toFixed() : row.fee_rate }); open('trade'); setEditing(row);
  }
  async function openIssueSource(issue: any) {
    const batch_id=issue.source_batch_id || issue.context.batch_id;
    if(!canWrite){
      const result=await read('importBatch',{id:batch_id});
      const row=result.rows.find(row=>issue.record_table==='import_rows'?row.id===issue.record_id:row.source_row===issue.source_row && row.source_sheet===issue.source_sheet);
      Modal.info({title:result.batch.original_name,width:850,content:<><p>本人原批次，只读查看。{row?`${row.source_sheet} 第 ${row.source_row} 行`:result.batch.context.parse_error || '该批次没有可定位的行'}</p>{row&&<Table<Record<string,any>> rowKey="field" pagination={false} dataSource={Object.entries(row.raw).map(([field,value])=>({field,value,corrected:row.corrected?.[field]??value}))} columns={[{title:'原列名',dataIndex:'field'},{title:'原文件值',dataIndex:'value'},{title:'暂存修正值',dataIndex:'corrected'}]}/>}</>}); return;
    }
    navigate({ page: 'imports', batch: batch_id, row: issue.record_table === 'import_rows' ? issue.record_id : undefined, sourceRow: issue.source_row == null ? undefined : String(issue.source_row), sourceSheet: issue.source_sheet, targetNonce: String(Date.now()) });
  }
  async function resolveIssue(issue: any) {
    if (issue.category==='options') { await refreshMetadata(); navigate({ page: 'options', option: issue.context.source_key, targetNonce: String(Date.now()) }); return; }
    if (issue.category==='imports') { await openIssueSource(issue); return; }
    if (issue.code==='MISSING_NAV') { seriesForm.resetFields(); seriesForm.setFieldsValue({data_type:'nav',share_class_id:issue.share_class_id,date:issue.business_date}); open('series'); setEntryFocus(['value']); return; }
    if (issue.record_table==='composition_snapshots') {
      await editFund({id:issue.fund_id});
      const lists=fundForm.getFieldValue('compositions') || []; const index=lists.findIndex(row=>row.id===issue.context.composition_id);
      if (index>=0) { const item=lists[index].items.findIndex(row=>row.child_share_class_id===issue.share_class_id); setEntryFocus(item>=0?['compositions',index,'items',item,'units']:issue.code==='MIXED_CURRENCIES'?['compositions',index,'items',0,'child_share_class_id']:issue.code==='NON_POSITIVE_TOTAL'?['compositions',index,'items',0,'units']:['compositions',index,'valuation_date']); }
      return;
    }
    const row=(await read('list',{table:issue.record_table,id:issue.record_id,page_size:1})).rows[0];
    if (!row) throw new Error('该记录已被删除，请刷新检查');
    if (issue.record_table==='transactions') { editTrade(row); setEntryFocus(['confirmation_date']); return; }
    const type=issue.record_table==='fund_navs'?'nav':issue.record_table==='fund_returns'?'returns':'benchmark';
    if (type==='benchmark') { benchmarkValueForm.resetFields(); benchmarkValueForm.setFieldsValue({benchmark_id:row.benchmark_id,value_date:row.value_date,index_value:row.index_value}); open('benchmarkValue'); setEntryFocus(['value_date']); }
    else { seriesForm.resetFields(); seriesForm.setFieldsValue({data_type:type,share_class_id:row.share_class_id,date:row.nav_date || row.return_date,value:type==='returns'?new Decimal(row.mtd_return).times('100').toFixed():row.nav_per_unit,estimate_label:row.estimate_label}); open('series'); setEntryFocus([type==='returns'?'estimate_label':'date']); }
    setEntryNotice({ row, type });
  }
  const issueNotice = entryNotice && <Alert type="info" style={{marginBottom:12}} message={`当前原记录日期：${entryNotice.row.nav_date || entryNotice.row.return_date || entryNotice.row.value_date}`} description="同日保存会覆盖原值。修改日期会另存一条；若原日期错误，请先删除错误记录，再按正确日期录入。" action={<Button danger disabled={!canWrite || busy} onClick={()=>removeSeries(entryNotice.type,entryNotice.row)}>删除错误记录</Button>} />;
  function changeDeletion(table: string, row: any) {
    Modal.confirm({ title: `${row.is_deleted ? '恢复' : '删除'}${row.short_name || row.legal_name}`, content: row.is_deleted ? '恢复后可继续录入新业务，历史记录保留。' : '历史交易、净值和持仓继续保留。删除后新录入选择器隐藏此对象，可随时恢复。', okText: row.is_deleted ? '恢复' : '确认删除', okButtonProps: { danger: !row.is_deleted }, onOk: () => save('setDeleted', { table, id: row.id, technical_revision: row.technical_revision, deleted: !row.is_deleted }) });
  }
  function removeSeries(type: string, row: any) {
    Modal.confirm({ title: `删除 ${row.nav_date || row.return_date || row.value_date} 的${type === 'benchmark'?'基准数值':type === 'nav' ? '净值' : '收益'}`, content: type==='benchmark'?`基准：${row._benchmark_name || row.benchmark_id}；原数值 ${row.index_value}。只删除此日期数值，基准定义保留。`:`基金份额：${row._share_label || shareLabel(row.share_class_id)}。删除后重新计算相关持仓；缺少净值时显示空值。`, okText: '确认删除', okButtonProps: { danger: true }, onOk: () => save('deleteSeries', { data_type: type, id: row.id, technical_revision: row.technical_revision }).catch(()=>{}) });
  }
  const tabs = [
    { key:'quality',label:'数据质量',children:<QualityWorkspace active={active==='quality'} refresh={refresh} resolve={resolveIssue} source={openIssueSource} canWrite={canWrite} canConfigure={metadata?.permissions?.configure} asOf={date} setDate={setDate} category={qualityCategory} setCategory={category => navigate({ category }, { replace: true })} /> },
    { key: 'drafts', label: '个人草稿', children: <DraftWorkspace read={read} save={save} resume={resumeDraft} refresh={refresh} canWrite={canWrite} /> },
    { key: 'imports', label: '导入与纠错', children: canWrite ? <ImportWorkspace save={save} target={importTarget} /> : <Alert type="info" message="当前角色只读，不能创建或提交导入批次" /> },
    { key: 'fund-register', label: '基金资料管理', children: <Card title="基金资料" extra={<Button type="primary" disabled={!canWrite} onClick={() => { fundForm.resetFields(); fundForm.setFieldsValue({ fund_kind: 'third_party', share_classes: [{ values: {}, terms: {} }] }); open('fund'); }}>新建基金</Button>}>
      <Text type="secondary">全部基金记录、资料版本与删除恢复。日常补录净值请到“基金中心 → 基金列表”。</Text>
      {businessTable('funds', '基金', [
        { title: '基金', dataIndex: 'short_name', width: 280, render: (text, row) => <div className="finance-cell"><Button className="finance-text-link" type="link" onClick={() => editFund(row)}>{text}</Button><span className="finance-cell-sub">{row.lei || 'LEI 未填写'}</span></div> },
        { title: '类型', dataIndex: 'fund_kind', width: 100, render: value => <FundKind kind={value} /> },
        { title: '份额类别', render: (_, row) => <Space size={[4, 4]} wrap>{(row._share_classes || []).slice(0, 3).map(item => <Tag key={item.id} bordered={false}>{item.class_label || item.isin} · {item.currency}</Tag>)}{row._share_classes?.length > 3 && <Text type="secondary">等 {row._share_classes.length} 个</Text>}</Space> },
        { title: '资料版本', dataIndex: 'business_version', width: 130, render: (value, row) => <Button className="finance-text-link" type="link" onClick={async () => { setVersions(await read('versions', { fund_id: row.id })); setDialog('versions'); }}>V{value} · 查看历史</Button> },
        { title: '状态', dataIndex: 'is_deleted', width: 80, render: value => <RecordState deleted={value} /> },
        { title: '操作', width: 230, render: (_, row) => <Space size={0} wrap>{row.fund_kind === 'proprietary' && <Button type="link" size="small" onClick={() => { navigate({ page: 'compositions', compositionFund: row.id }); }}>成分</Button>}<Button type="link" size="small" onClick={() => { navigate({ page: 'documents', documentFund: row.id }); }}>文档</Button><Button type="link" size="small" onClick={async () => { const aggregate = await read('fund', { id: row.id }); setEditing({ ...aggregate.fund, all_classes: aggregate.share_classes }); setDialog('classes'); }}>份额状态</Button><Button type="link" size="small" danger={!row.is_deleted} disabled={!canWrite} onClick={() => changeDeletion('funds', row)}>{row.is_deleted ? '恢复' : '删除'}</Button></Space> },
      ], [stateControl(), { key: 'fund_kind', label: '基金类型', options: [{ value: 'third_party', label: '三方基金' }, { value: 'proprietary', label: '自营基金' }] }])}
    </Card> },
    { key: 'entities', label: '客户与主体', children: <Card title="投资主体" extra={<Button type="primary" disabled={!canWrite} onClick={() => { entityForm.resetFields(); open('entity'); }}>新建主体</Button>}>
      <Text type="secondary">同一客户编号下可有多个投资主体，申赎和持仓分别记在各主体名下。点击主体名称查看或修改资料。</Text>
      {businessTable('investment_entities', '主体', [
        { title: '投资主体', dataIndex: 'legal_name', width: 260, render: (text, row) => <div className="finance-cell"><Button className="finance-text-link" type="link" onClick={() => editEntity(row)}>{text}</Button>{row.common_name && <span className="finance-cell-sub">常用名：{row.common_name}</span>}</div> },
        { title: '客户编号', dataIndex: '_client_code', render: value => <Text copyable={value ? { text: value } : false}>{value || '—'}</Text> },
        { title: '客户类型', dataIndex: 'client_type', render: value => value || '—' },
        { title: '账户状态', dataIndex: 'account_status', render: value => value ? <Tag bordered={false}>{value}</Tag> : '—' },
        { title: 'CDD 批准日期', dataIndex: 'latest_cdd_approval_date', width: 130, render: value => <DateText value={value} /> },
        { title: '记录状态', dataIndex: 'is_deleted', width: 90, render: value => <RecordState deleted={value} /> },
        { title: '操作', width: 130, render: (_, row) => <Space size={0}><Button type="link" size="small" onClick={() => navigate({ page: 'reports', reportEntity: row.id })}>月报</Button><Button type="link" size="small" danger={!row.is_deleted} disabled={!canWrite} onClick={() => changeDeletion('investment_entities', row)}>{row.is_deleted ? '恢复' : '删除'}</Button></Space> },
      ], [stateControl()])}
    </Card> },
    { key: 'trades', label: '申赎录入', children: <Card title="申赎记录" extra={<Button type="primary" disabled={!canWrite} onClick={() => { tradeForm.resetFields(); tradeForm.setFieldsValue({ transaction_type: '初次申购' }); open('trade'); }}>录入申赎</Button>}>
      <Text type="secondary">保存即生效。系统按确认日期检查历史持有份额，金额和费用保留手工输入。</Text>
      {businessTable('transactions', '申赎', [
        { title: '确认日期', dataIndex: 'confirmation_date', width: 110, render: value => <DateText value={value} /> },
        { title: '投资主体', dataIndex: '_entity_name', width: 160 },
        { title: '基金份额', dataIndex: '_share_label', width: 300, render: value => <ShareCell label={value} /> },
        { title: '类型', dataIndex: 'transaction_type', width: 96, render: value => <TradeType value={value} /> },
        numColumn({ title: '确认份额', dataIndex: 'confirmed_units', width: 140 }),
        numColumn({ title: '金额', dataIndex: 'amount', width: 200, render: (value, row) => <Num value={value} suffix={row.currency} /> }),
        { title: '状态', dataIndex: 'is_void', width: 80, render: value => <RecordState deleted={value} deletedLabel="已撤销" activeLabel="生效" /> },
        { title: '操作', width: 120, render: (_, row) => !row.is_void && <Space size={0}><Button disabled={!canWrite} type="link" size="small" onClick={() => editTrade(row)}>修改</Button><Button danger disabled={!canWrite} type="link" size="small" onClick={() => { setEditing(row); setDialog('void'); setError(''); }}>撤销</Button></Space> },
      ], [stateControl('已撤销'), { key: 'entity_id', label: '主体', resource: 'investment_entities', params: { state: 'all' } }, { key: 'share_class_id', label: '份额', resource: 'share_classes', params: { state: 'all' } }, ...dateControls], { state: 'active' })}
    </Card> },
    { key: 'series', label: '净值与收益', children: <Card title="净值与 MTD 收益" extra={<Space><Button disabled={!canWrite} onClick={() => { seriesForm.resetFields(); seriesForm.setFieldValue('data_type', 'returns'); open('series'); }}>录入收益</Button><Button type="primary" disabled={!canWrite} onClick={() => { seriesForm.resetFields(); seriesForm.setFieldValue('data_type', 'nav'); open('series'); }}>录入净值</Button></Space>}>
      <Text type="secondary">全部份额的净值与月度收益明细。按单只基金核对、补录，请从“基金列表”进入对应基金的净值标签。</Text>
      <Tabs items={[{ key: 'nav', label: '净值', children: businessTable('fund_navs', '净值', [
        { title: '基金份额', dataIndex: '_share_label', render: value => <ShareCell label={value} /> },
        { title: '净值日期', dataIndex: 'nav_date', width: 120, render: value => <DateText value={value} /> },
        numColumn({ title: '单位净值', dataIndex: 'nav_per_unit', width: 200 }),
        { title: '操作', width: 80, render: (_, row) => <Button type="link" size="small" danger disabled={!canWrite} onClick={() => removeSeries('nav', row)}>删除</Button> },
      ], [{ key: 'share_class_id', label: '份额', resource: 'share_classes', params: { state: 'all' } }, ...dateControls]) }, { key: 'returns', label: 'MTD 收益', children: businessTable('fund_returns', '收益', [
        { title: '基金份额', dataIndex: '_share_label', render: value => <ShareCell label={value} /> },
        { title: '收益日期', dataIndex: 'return_date', width: 120, render: value => <DateText value={value} /> },
        numColumn({ title: 'MTD 收益率', dataIndex: 'mtd_return', width: 160, render: value => <span className="finance-num" title={value}>{new Decimal(value).times('100').toFixed()}%</span> }),
        { title: '估算标记', dataIndex: 'estimate_label', width: 110, render: value => value === '是' ? <Tag color="orange" bordered={false}>预估</Tag> : value === '否' ? <Tag color="success" bordered={false}>正式</Tag> : <Tag bordered={false}>未填写</Tag> },
        { title: '操作', width: 80, render: (_, row) => <Button type="link" size="small" danger disabled={!canWrite} onClick={() => removeSeries('returns', row)}>删除</Button> },
      ], [{ key: 'share_class_id', label: '份额', resource: 'share_classes', params: { state: 'all', fund_kind: 'third_party' } }, { key: 'estimate', label: '估算标记', options: [{ value: '是', label: '预估' }, { value: '否', label: '正式' }, { value: 'unknown', label: '未分类' }] }, ...dateControls]) }]} />
    </Card> },
    { key: 'positions', label: '持仓核对', children: <Card title="当前持仓">
      <Text type="secondary">按申赎记录累计份额，取不晚于截至日期的最近净值计算原币市值，不做汇率换算。缺少净值时市值留空。</Text>
      <QueryTable action="positionList" title="持仓" refresh={refresh} rowKey={row => `${row.entity_id}:${row.share_class_id}`} controls={[{ key: 'entity_id', label: '主体', resource: 'investment_entities', params: { state: 'all' } }, { key: 'balance', label: '持仓', options: [{ value: 'all', label: '全部' }, { value: 'positive', label: '有持仓' }, { value: 'zero', label: '零持仓' }] }, { key: 'as_of', label: '截至日期', type: 'date' }, { key: 'currency', label: '币种', type: 'text' }]} columns={[
        { title: '投资主体', dataIndex: 'entity_name', width: 200, render: (value, row) => <div className="finance-cell"><span className="finance-cell-main">{value}</span>{row.entity_deleted && <span><Tag bordered={false}>主体已删除</Tag></span>}</div> },
        { title: '基金 / 份额', dataIndex: 'fund_name', render: (value, row) => <div className="finance-cell"><span className="finance-cell-main">{value}</span><span className="finance-cell-sub">{row.class_label || '—'} · {row.currency}{row.fund_deleted && ' · 基金已删除'}{row.class_deleted && ' · 份额已停用'}</span></div> },
        numColumn({ title: '持有份额', dataIndex: 'units', width: 140 }),
        numColumn({ title: '最新净值', dataIndex: 'nav_per_unit', width: 170, render: (value, row) => value === null || value === undefined ? <Tag color="warning" bordered={false}>缺少净值</Tag> : <div className="finance-cell" style={{ alignItems: 'flex-end' }}><Num value={value} /><span className="finance-cell-sub finance-date">{row.nav_date}</span></div> }),
        numColumn({ title: '持有市值', dataIndex: 'market_value', width: 190, render: (value, row) => value === null ? <span className="finance-num is-empty">—</span> : <Num value={new Decimal(value).toFixed(2)} suffix={row.currency} /> }),
        { title: '操作', width: 80, render: (_, row) => <Button type="link" size="small" disabled={!canWrite || row.fund_deleted || row.entity_deleted || row.class_deleted || !new Decimal(row.units).gt('0')} onClick={() => { tradeForm.resetFields(); tradeForm.setFieldsValue({ entity_id: row.entity_id, share_class_id: row.share_class_id, currency: row.currency, transaction_type: '赎回', confirmation_date: new Date().toISOString().slice(0, 10) }); open('trade'); }}>赎回</Button> },
      ]} />
    </Card> },
  ];
  tabs.push({ key: 'benchmarks', label: '基准', children: <Card title="基准定义与数值" extra={<Space>
    <Button disabled={!canWrite} onClick={() => { benchmarkValueForm.resetFields(); open('benchmarkValue'); }}>录入基准数值</Button>
    <Button type="primary" disabled={!canWrite} onClick={() => { benchmarkForm.resetFields(); open('benchmark'); }}>新建基准</Button>
  </Space>}><Text type="secondary">基准分类手工填写。修改覆盖当前定义，不生成基金资料版本。</Text>
    <Title level={5} className="finance-section-title">基准定义</Title>
    {businessTable('benchmarks', '基准定义', [{ title: '基准名称', dataIndex: 'name', width: 300, render: (text, row) => <Button className="finance-text-link" type="link" onClick={() => { benchmarkForm.resetFields(); benchmarkForm.setFieldsValue(pick('benchmarks', row)); open('benchmark'); setEditing(row); }}>{text}</Button> }, { title: '分类', dataIndex: 'category', width: 160, render: value => value ? <Tag bordered={false}>{value}</Tag> : '—' }, { title: '备注', dataIndex: 'remarks', render: value => value || '—' }])}
    <Title level={5} className="finance-section-title">日期数值</Title>
    {businessTable('benchmark_values', '基准数值', [{ title: '基准', dataIndex: '_benchmark_name' }, { title: '日期', dataIndex: 'value_date', width: 120, render: value => <DateText value={value} /> }, numColumn({ title: '数值', dataIndex: 'index_value', width: 200 }), { title:'操作', width: 80, render:(_,row)=><Button type="link" size="small" danger disabled={!canWrite} onClick={()=>removeSeries('benchmark',row)}>删除</Button> }], [{ key: 'benchmark_id', label: '基准', resource: 'benchmarks' }, ...dateControls])}
  </Card> });
  tabs.push({ key: 'documents', label: '文档', children: <FileWorkspace metadata={metadata} fundId={documentFundId} setFundId={setDocumentFundId} active={active === 'documents'} /> });
  tabs.push({ key: 'export', label: '数据导出', children: <ExportWorkspace /> });
  tabs.push({ key: 'reports', label: '客户月报', children: <ReportWorkspace active={active === 'reports'} canWrite={canWrite} entityId={route.get('reportEntity') || undefined} /> });
  tabs.push({ key: 'compositions', label: '成分核对', children: <CompositionWorkspace refresh={refresh} fundId={compositionFundId} setFundId={setCompositionFundId} read={read} editFund={editFund} canWrite={canWrite} active={active === 'compositions'} /> });
  if (metadata?.permissions?.configure) tabs.push({ key: 'options', label: '字段候选配置', children: <OptionsWorkspace options={metadata.options || []} save={save} reload={refreshMetadata} target={optionTarget} /> });
  const enterNav = (row: any, date: string) => {
    seriesForm.resetFields(); seriesForm.setFieldsValue({ data_type: 'nav', share_class_id: row.id, date, value: row.exact_nav ?? undefined });
    open('series'); setNavContext({ ...row, date });
  };
  const newFund = () => { fundForm.resetFields(); fundForm.setFieldsValue({ fund_kind: 'third_party', share_classes: [{ values: {}, terms: {} }] }); open('fund'); };
  tabs.unshift({ key: 'funds', label: '基金中心', children: <FundCenter fundId={fundId} section={fundSection} selectedShare={route.get('share')} openFund={openFund} date={date} setDate={setDate} refresh={refresh} active={active === 'funds'} metadata={metadata} editFund={editFund} newFund={newFund} enterNav={enterNav} read={read} fields={tableFields}
    versions={async row => { setVersions(await read('versions', { fund_id: row.id })); setDialog('versions'); }}
    classes={async row => { const aggregate = await read('fund', { id: row.id }); setEditing({ ...aggregate.fund, all_classes: aggregate.share_classes }); setDialog('classes'); }} /> });
  tabs.unshift({ key: 'home', label: '工作台', children: <Workbench date={date} setDate={setDate} refresh={refresh} active={active === 'home'} summary={summary} openFund={openFund} navigate={setActive} openQuality={category => navigate({ page: 'quality', category })} canWrite={canWrite} canConfigure={metadata?.permissions?.configure}
    resolve={issue => resolveIssue(issue).catch(error => setError(error.message))} openBatch={row => openIssueSource({ source_batch_id: row.id, context: {} }).catch(error => setError(error.message))} /> });
  const pendingOptions = (metadata?.options || []).filter(row => !row.fixed && !row.confirmed).length;
  tabs.push({ key: 'settings', label: '系统设置', children: <div data-finance-settings>
    <PageIntro description="业务规则与平台管理集中在这里。修改权限由服务端检查。" />
    <div className="finance-stats">
      <StatCard label="基金记录" value={summary.funds} unit="只" hint="含已删除基金" icon={<FundOutlined />} />
      <StatCard label="投资主体" value={summary.investment_entities} unit="个" hint="含历史停用记录" icon={<TeamOutlined />} />
      <StatCard label="待确认候选项" value={metadata ? pendingOptions : undefined} unit="项" tone={pendingOptions ? 'warning' : 'success'} hint={pendingOptions ? '正式录入前需业务确认' : '候选项均已明确'} icon={<UnorderedListOutlined />} onClick={metadata?.permissions?.configure ? () => setActive('options') : undefined} />
    </div>
    <div className="finance-link-grid">
      {metadata?.permissions?.configure && <button type="button" className="finance-link-card" onClick={() => setActive('options')}><span className="finance-link-card-icon"><UnorderedListOutlined /></span><div><strong>字段候选配置</strong><span>维护下拉字段的候选值，并标记是否已由业务确认。</span></div></button>}
      <button type="button" className="finance-link-card" onClick={() => setActive('fund-register')}><span className="finance-link-card-icon"><DatabaseOutlined /></span><div><strong>基金资料管理</strong><span>查看全部基金记录与资料版本，删除或恢复基金、停用份额。</span></div></button>
      <button type="button" className="finance-link-card" onClick={() => setActive('benchmarks')}><span className="finance-link-card-icon"><LineChartOutlined /></span><div><strong>基准数据</strong><span>维护基准定义与按日期记录的基准数值。</span></div></button>
      <a className="finance-link-card" href="/admin/settings" target="_blank" rel="noopener noreferrer"><span className="finance-link-card-icon"><SettingOutlined /></span><div><strong>平台设置 ↗</strong><span>角色权限、插件与主题在 NocoBase 平台设置中维护，新标签页打开。</span></div></a>
    </div>
  </div> });
  const menu = [{ key: 'home', label: '工作台', icon: <AppstoreOutlined /> }, { key: 'funds', label: '基金中心', icon: <FundOutlined /> }, { key: 'entities', label: '客户中心', icon: <TeamOutlined /> }, { key: 'trades', label: '交易录入', icon: <SwapOutlined /> }, { key: 'imports', label: '导入中心', icon: <ImportOutlined /> }, { key: 'quality', label: '数据质量', icon: <CheckCircleOutlined /> }, { key: 'settings', label: '系统设置', icon: <SettingOutlined /> }];
  const group = ['series', 'documents', 'compositions'].includes(active) ? 'funds' : ['positions', 'reports'].includes(active) ? 'entities' : ['options', 'benchmarks', 'fund-register'].includes(active) ? 'settings' : active;
  const pageTitle = (embeddedPage && navigation.find(item => item.key === embeddedPage)?.title) || menu.find(item => item.key === group)?.label || tabs.find(item => item.key === active)?.label || '工作台';
  useEffect(() => { document.title = `${pageTitle} · Finance`; }, [pageTitle]);
  return <OptionsContext.Provider value={metadata?.options || []}><main className={`finance-workspace${embeddedPage ? ' finance-workspace-native' : ''}`} style={{ '--finance-primary': token.colorPrimary, '--finance-primary-bg': token.colorPrimaryBg, '--finance-bg': token.colorBgLayout, '--finance-panel': token.colorBgContainer, '--finance-border': token.colorBorderSecondary, '--finance-text': token.colorText, '--finance-muted': token.colorTextSecondary, '--finance-radius': `${token.borderRadiusLG}px`, '--finance-warning': token.colorWarning, '--finance-warning-bg': token.colorWarningBg, '--finance-error': token.colorError, '--finance-error-bg': token.colorErrorBg, '--finance-success': token.colorSuccess, '--finance-success-bg': token.colorSuccessBg } as React.CSSProperties}>
    {!embeddedPage && <aside className="finance-sidebar"><Button type="text" className="finance-brand" onClick={() => setActive('home')}><span>F</span> FINANCE</Button><Text className="finance-sidebar-caption" type="secondary">业务数据工作空间</Text>
      <nav aria-label="Finance 主导航">{menu.map(item => <Button key={item.key} className={group === item.key ? 'is-active' : ''} type="text" icon={item.icon} aria-current={group === item.key ? 'page' : undefined} onClick={() => setActive(item.key)}>{item.label}</Button>)}</nav>
      <div className="finance-sidebar-tools"><Text type="secondary">数据工具</Text><Button type="text" onClick={() => setActive('drafts')}>个人草稿</Button><Button type="text" onClick={() => setActive('series')}>全量净值与收益</Button><Button type="text" onClick={() => setActive('export')}>数据导出</Button></div>
    </aside>}
    <div className="finance-main">{!embeddedPage && <header className="finance-topbar"><Space><Button type="link" onClick={() => setActive('home')}>工作台</Button><Text type="secondary">/</Text><Text>{pageTitle}</Text></Space><Space>{!canWrite && <Tag>只读</Tag>}{demo && <Tag color="gold">模拟数据环境</Tag>}<Text type="secondary">数据录入 · 流程样稿</Text></Space></header>}
    <div className="finance-content">
      {demo && (embeddedPage
        ? <div className="finance-demo-banner"><Tag color="gold" bordered={false}>模拟数据</Tag>当前使用模拟数据。正式录入前，请先确认业务候选项与原始资料。{!canWrite && <Tag bordered={false}>只读</Tag>}</div>
        : <div className="finance-demo-note">当前使用模拟数据。正式录入前，请先确认业务候选项与原始资料。</div>)}
      {error && !dialog && <Alert closable onClose={() => setError('')} type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
      {!embeddedPage && group === 'entities' && <div className="finance-subnav"><Button type={active === 'entities' ? 'primary' : 'default'} onClick={() => setActive('entities')}>客户与主体</Button><Button type={active === 'positions' ? 'primary' : 'default'} onClick={() => setActive('positions')}>持仓核对</Button><Button type={active === 'reports' ? 'primary' : 'default'} onClick={() => setActive('reports')}>客户月报</Button></div>}
      {embeddedPage === 'options' && metadata && !metadata.permissions?.configure ? <Alert type="warning" message="当前角色没有业务配置权限" /> : <Tabs className="finance-page-panels" activeKey={tabs.some(tab => tab.key === active) ? active : 'home'} renderTabBar={() => <></>} items={tabs} />}
    </div></div>
    <Modal open={dialog === 'versions'} title="基金资料历史版本" width={1080} footer={null} onCancel={() => setDialog(undefined)} destroyOnClose><VersionViewer versions={versions} /></Modal>
    <Modal open={dialog === 'classes'} title="份额状态" width={860} footer={null} onCancel={() => setDialog(undefined)} destroyOnClose>
      <Alert type="info" message="停用或恢复会增加一个基金资料版本，历史交易与持仓保留。" style={{ marginBottom: 16 }} />
      {error && <Alert type="error" message={error} />}
      {renderTable((editing?.all_classes || []), [
        { title: '份额', dataIndex: 'class_label' }, { title: 'ISIN', dataIndex: 'isin' }, { title: '币种', dataIndex: 'currency' },
        { title: '状态', dataIndex: 'is_deleted', render: value => value ? '已停用' : '有效' },
        { title: '操作', render: (_, share) => <Button disabled={!canWrite || editing?.is_deleted} onClick={() => Modal.confirm({ title: `${share.is_deleted ? '恢复' : '停用'}份额 ${share.class_label || share.isin}`, content: '确认后保存一次新的基金资料版本。', onOk: () => save('setClassDisabled', { id: share.id, technical_revision: share.technical_revision, fund_revision: editing.technical_revision, disabled: !share.is_deleted }) })}>{share.is_deleted ? '恢复' : '停用'}</Button> },
      ])}
    </Modal>
    <Modal open={dialog === 'benchmark'} title={editing ? '修改基准定义' : '新建基准'} width={760} footer={null} onCancel={drafts.cancel} destroyOnClose>
      {error && <Alert type="error" message={error} />}
      <Form form={benchmarkForm} layout="vertical" disabled={!canWrite || busy} onFinish={values => save('saveBenchmark', { values, ...(editing ? { id: editing.id, technical_revision: editing.technical_revision } : {}) }).catch(() => {})}>
        <Fields table="benchmarks" prefix={[]} demo={demo} /><Button type="primary" htmlType="submit" loading={busy}>保存基准定义</Button>
      {drafts.controls}</Form>
    </Modal>
    <Modal open={dialog === 'benchmarkValue'} title="录入基准数值" footer={null} onCancel={drafts.cancel} destroyOnClose>
      {error && <Alert type="error" message={error} />}{issueNotice}
      <Form form={benchmarkValueForm} layout="vertical" disabled={!canWrite || busy} onFinish={values => submitSeries('benchmark', values)}>
        <Form.Item name="benchmark_id" label="基准" rules={[{ required: true }]}><RemoteSelect resource="benchmarks" /></Form.Item>
        <Form.Item name="value_date" label="日期" rules={[{ required: true }]}><Input type="date" /></Form.Item>
        <Form.Item name="index_value" label="基准数值" rules={[{ required: true }]}><Input inputMode="decimal" /></Form.Item>
        <Button type="primary" htmlType="submit" loading={busy}>保存基准数值</Button>
      {drafts.controls}</Form>
    </Modal>
    <Modal open={dialog === 'fund'} title={editing ? `基金资料 · V${editing.business_version}` : '新建基金'} width={1080} footer={null} onCancel={drafts.cancel} destroyOnClose>
      {error && <Alert type="error" showIcon message={error} />}
      <Form form={fundForm} disabled={!canWrite || busy || editing?.is_deleted} layout="vertical" onFinish={values => {
        const { compositions, ...payload } = values;
        if (values.fund_kind === 'proprietary') payload.compositions = (compositions || []).map(compositionDraft).filter(list => !list.id || JSON.stringify(list) !== JSON.stringify(editing?.original_compositions?.find(original => original.id === list.id)));
        const submit = () => save('saveFund', { ...payload, ...(editing ? { id: editing.id, technical_revision: editing.technical_revision } : {}) });
        const changed = payload.compositions?.filter(list => list.id) || [];
        if (changed.length) Modal.confirm({ title: '核对成分清单变更', width: 760, okText: '确认保存资料版本', cancelText: '返回核对', content: <>
          <p>以下完整清单会被替换，与本次基金和份额修改一起保存为一个资料版本。</p>
          {changed.map(list => { const original = editing.original_compositions.find(row => row.id === list.id); const ids = [...new Set([...original.items, ...list.items].map(row => row.child_share_class_id))]; return <div key={list.id}><strong>{original.valuation_date || '空日期'} → {list.valuation_date || '空日期'}</strong>{ids.map(id => { const before = original.items.find(row => row.child_share_class_id === id); const after = list.items.find(row => row.child_share_class_id === id); return <p key={id}>{shareLabel(id)}：{before ? before.units ?? '未填' : '无此行'} → {after ? after.units ?? '未填' : '移除此行'}；备注 {before?.remarks || '—'} → {after?.remarks || '—'}</p>; })}</div>; })}
        </>, onOk: () => submit().catch(() => {}) }); else submit().catch(() => {});
      }}>
        <Space style={{ margin: '18px 0' }}>{demo && !editing && <Button onClick={() => { const suffix = Date.now().toString(36); fundForm.setFieldsValue({ fund: { ...demoValues('funds', fundKind), short_name: `模拟基金 ${suffix}`, full_name: `模拟基金全称 ${suffix}`, lei: `DEMO-${suffix}` }, details: demoValues(`${fundKind}_fund_details`, fundKind, metadata.current_user_id), share_classes: ['A', 'B'].map(label => ({ values: { ...demoValues('share_classes', fundKind), isin: `DEMO-${suffix}-${label}`, currency: 'USD', class_label: fundKind === 'third_party' ? label : undefined }, terms: demoValues(`${fundKind}_class_terms`, fundKind) })) }); }}>填入模拟示例（两份额）</Button>}<Text type="secondary">带 * 为原字段表必填项</Text></Space>
        <Form.Item label="基金类型" name="fund_kind" rules={[{ required: true }]}><Select disabled={!!editing} onChange={() => { fundForm.setFieldsValue({ details: {}, share_classes: [{ values: {}, terms: {} }] }); }} options={[{ value: 'third_party', label: '三方基金' }, { value: 'proprietary', label: '自营基金' }]} /></Form.Item>
        <Collapse defaultActiveKey={['common']} items={[{ key: 'common', label: '基金共用资料', children: <Fields table="funds" prefix={['fund']} kind={fundKind} demo={demo} /> }, { key: 'detail', forceRender: true, label: '分类资料与联系人', children: <Fields table={`${fundKind}_fund_details`} prefix={['details']} kind={fundKind} demo={demo} /> }]} />
        <Title level={4}>份额类别与条款</Title>
        {editing?.is_deleted && <Alert type="info" message="基金已删除；请在列表中恢复后再编辑" />}
        <Form.List name="share_classes">{(items, { add, remove }) => <>{items.map((item, index) => <Card size="small" key={item.key} title={`份额 ${index + 1}`} style={{ marginBottom: 12 }} extra={items.length > 1 && !editing && <Button type="link" danger onClick={() => remove(item.name)}>移除此份额</Button>}>
          <Form.Item name={[item.name, 'id']} hidden><Input /></Form.Item>
          <Fields table="share_classes" prefix={[item.name, 'values']} kind={fundKind} demo={demo} />
          <Collapse items={[{ key: 'terms', forceRender: true, label: '申赎安排及费率条款', children: <Fields table={`${fundKind}_class_terms`} prefix={[item.name, 'terms']} kind={fundKind} demo={demo} /> }]} />
        </Card>)}<Button block onClick={() => add({ values: {}, terms: {} })}>添加份额类别</Button></>}</Form.List>
        {fundKind === 'proprietary' && <CompositionEditor form={fundForm} />}
        <div className="finance-form-footer"><Button onClick={drafts.cancel}>取消</Button><Button type="primary" htmlType="submit" loading={busy}>保存基金资料版本</Button></div>
      {drafts.controls}</Form>
    </Modal>
    <Modal open={dialog === 'entity'} title={editing ? '投资主体资料' : '新建投资主体'} width={980} footer={null} onCancel={drafts.cancel} destroyOnClose>
      {error && <Alert type="error" message={error} />}
      <Form form={entityForm} disabled={!canWrite || busy || editing?.is_deleted} layout="vertical" onFinish={values => save('saveEntity', { ...values, ...(editing ? { id: editing.id, technical_revision: editing.technical_revision } : {}) }).catch(() => {})}>
        {demo && !editing && <Button style={{ margin: '16px 0' }} onClick={() => entityForm.setFieldsValue({ client_code: 'DEMO-CLIENT-01', entity: { ...demoValues('investment_entities', undefined, metadata.current_user_id), legal_name: `模拟主体 ${Date.now().toString(36)}`, latest_cdd_approval_date: '2024-02-29' }, agreements: ['n/a'], products: [] })}>填入模拟主体示例</Button>}
        <Form.Item name="client_code" label="客户编号" rules={[{ required: true }]} extra="相同编号会归入同一客户，投资主体各自独立。"><Input /></Form.Item>
        <Fields table="investment_entities" prefix={['entity']} demo={demo} />
        {editing && <p>下次 CDD 截止日期：{editing.next_cdd_deadline || '未填写批准日期'}</p>}
        <Form.Item name="agreements" label="签署协议"><Select mode="multiple" options={choicesFor('客户页面:9')} /></Form.Item>
        <Form.Item name="products" label="产品"><Select mode="multiple" options={[...choicesFor('客户页面:10'), ...(demo ? [{ value: '模拟产品', label: '模拟产品（待确认）' }] : [])]} /></Form.Item>
        <div className="finance-form-footer"><Button type="primary" htmlType="submit" loading={busy}>保存投资主体</Button></div>
      {drafts.controls}</Form>
    </Modal>
    <Modal open={dialog === 'trade'} title={editing ? '修改申赎' : '录入申赎'} width={760} footer={null} onCancel={drafts.cancel} destroyOnClose>
      {error && <Alert type="error" message={error} />}
      {editing && <Alert type="info" message="修改会重新检查原主体、目标主体及相关份额的全部历史日期；如任何日期份额不足，整次修改不保存。" style={{ marginBottom: 16 }} />}
      {currencyWarning && <Alert type="warning" message="交易币种与份额币种不同，将保留原值。持仓市值仍按份额币种计算，不进行汇率换算。" />}
      {amountWarning && <Alert type="warning" message="金额与份额乘确认净值不一致，将保留手工金额和费用。请核对原始凭证。" />}
      <Form form={tradeForm} disabled={!canWrite || busy} layout="vertical" onFinish={values => submitTrade(values)}>
        <Form.Item name="entity_id" label="投资主体" rules={[{ required: true }]}><RemoteSelect resource="investment_entities" /></Form.Item>
        <Form.Item name="share_class_id" label="基金份额" rules={[{ required: true }]}><RemoteSelect resource="share_classes" onRecord={setTradeShare} /></Form.Item>
        <Row gutter={20}>{[{ name: 'transaction_type', label: '交易类型', required: true }, { name: 'confirmation_date', label: '确认日期', required: true }, { name: 'confirmed_units', label: '确认份额', required: true }, { name: 'amount', label: '金额', required: true }, { name: 'currency', label: '币种', required: true }, { name: 'confirmed_nav', label: '确认净值（最多 4 位小数）' }, { name: 'fee_rate', label: '费率（%，输入 2 表示 2%）' }, { name: 'fee', label: '费用' }].map(field => <Col span={12} key={field.name}><Form.Item name={field.name} label={field.label} rules={[{ required: field.required }]}>{field.name === 'transaction_type' ? <Select options={['初次申购', '追加申购', '赎回'].map(value => ({ value, label: value }))} /> : field.name === 'currency' ? <Select options={[...choicesFor('申赎记录:7'), ...(demo ? ['USD', 'HKD', 'CNY'].filter(value => !choicesFor('申赎记录:7').some(item => item.value === value)).map(value => ({ value, label: `${value}（模拟）` })) : [])]} /> : <Input type={field.name === 'confirmation_date' ? 'date' : 'text'} />}</Form.Item></Col>)}</Row>
        <Form.Item name="remarks" label="备注"><Input.TextArea /></Form.Item>
        <div className="finance-form-footer"><Button type="primary" htmlType="submit" loading={busy}>保存并生效</Button></div>
      {drafts.controls}</Form>
    </Modal>
    <Modal open={dialog === 'series'} title={navContext ? `${navContext.exact_nav === null ? '录入' : '修改'}单位净值` : '录入净值／收益'} width={navContext ? 740 : 520} footer={null} onCancel={drafts.cancel} destroyOnClose>
      {error && <Alert type="error" message={error} />}{issueNotice}
      {navContext && <div className="finance-nav-context" style={{ background: token.colorFillQuaternary, color: token.colorText }}><Typography.Title level={4}>{navContext.fund_name}</Typography.Title><Space wrap><Tag>{navContext.class_label || navContext.isin}</Tag><Tag>{navContext.currency}</Tag><Typography.Text type="secondary">{navContext.isin}</Typography.Text></Space><p>最近可用记录：{navContext.latest_date || '暂无'} · 单位净值 {navContext.latest_nav ?? '—'}</p></div>}
      <Form form={seriesForm} layout="vertical" disabled={!canWrite || busy} onFinish={values => submitSeries(values.data_type, values)}>
        <Form.Item name="data_type" label="数据类型" hidden={!!navContext}><Select options={[{ value: 'nav', label: '单位净值' }, { value: 'returns', label: 'MTD 收益率（%）' }]} /></Form.Item>
        <Form.Item name="share_class_id" label="基金份额" hidden={!!navContext} rules={[{ required: true }]}><RemoteSelect resource="share_classes" /></Form.Item>
        <Form.Item name="date" label={navContext ? "净值日期" : "日期"} extra={navContext ? "默认使用核对日，请按原始披露日期调整。" : undefined} rules={[{ required: true }]}><Input type="date" /></Form.Item>
        <Form.Item name="value" label={navContext ? "单位净值" : "数值（收益率按百分数填写）"} extra={navContext ? "保留原始精度。保存后返回本基金的净值列表。" : undefined} rules={[{ required: true, message: "请填写数值" }]}><Input inputMode="decimal" autoFocus={!!navContext} placeholder={navContext ? "填写原始单位净值" : undefined} /></Form.Item>
        <Form.Item noStyle shouldUpdate>{() => seriesForm.getFieldValue('data_type') === 'returns' && <Form.Item name="estimate_label" label="是否预估"><Select allowClear placeholder="未填写（保留未知）" options={[{ value: '是', label: '是' }, { value: '否', label: '否' }]} /></Form.Item>}</Form.Item>
        <Button type="primary" htmlType="submit" loading={busy}>{navContext ? '保存净值' : '保存'}</Button>
      {drafts.controls}</Form>
    </Modal>
    <Modal open={dialog === 'void'} title="撤销交易" footer={null} onCancel={() => setDialog(undefined)} destroyOnClose>
      {error && <Alert type="error" message={error} />}
      <p>撤销后，此记录不再计入份额。若历史份额变成负数，整次撤销会被拒绝。</p>
      <Form layout="vertical" onFinish={values => save('voidTrade', { id: editing.id, technical_revision: editing.technical_revision, reason: values.reason }).catch(() => {})}><Form.Item name="reason" label="撤销原因"><Input.TextArea /></Form.Item><Button danger type="primary" htmlType="submit" loading={busy}>确认撤销</Button></Form>
    </Modal>
    {drafts.leaveDialog}
  </main></OptionsContext.Provider>;
}
