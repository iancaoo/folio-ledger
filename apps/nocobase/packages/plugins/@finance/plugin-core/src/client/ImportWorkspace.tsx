import React, { useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@nocobase/client';
import { Alert, Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography, Upload } from 'antd';
import { tradeImportFields } from '../shared/trade-import';
import { mainImportFields, mainImportTypes } from '../shared/main-import';
import { MainMapping, inspectMainRow, confirmCompositionReplacement } from './MainImportControls';
import { seriesImportFields, seriesImportTypes } from '../shared/series-import';
import { SeriesMapping, inspectSeriesRow } from './SeriesImportControls';
import { RemoteSelect } from './RemoteSelect';
import { exchangeMapping, exportColumns } from '../shared/export';
import { MainExchangeMapping, inspectExchangeRow, confirmClientRename } from './MainExchangeControls';
import { IMPORT_PARSER_VERSION } from '../shared/import-file';
type PreviewRow = { id: string; source_row: number; raw: Record<string, string>; corrected: Record<string, string>; selected: boolean;
  operation?: string; errors: Array<{ code: string; message: string }>; normalized?: any };

export function ImportWorkspace({ save, target }: { save: (action: string, payload: any) => Promise<any>; target?: any }) {
  const api = useAPIClient();
  const [form] = Form.useForm();
  const importType = Form.useWatch('data_type', form);
  const fundKind = Form.useWatch('fund_kind', form);
  const targetMode = Form.useWatch('target_mode', form) || 'single';
  const [result, setResult] = useState<any>();
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [mapping, setMapping] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File>();
  const [fileError, setFileError] = useState('');
  const [history, setHistory] = useState<any>({ rows: [], count: 0 });
  const [historyPage, setHistoryPage] = useState(1);
  const [rowPage, setRowPage] = useState(1);
  const [focusedRow, setFocusedRow] = useState<string>();
  const handledTarget = useRef<any>();
  const read = async (action, params = {}) => (await api.request({ url: `finance:${action}`, params })).data.data;
  const loadHistory = () => read('importBatches', { page: historyPage, page_size: 10 }).then(setHistory).catch(() => setFileError('批次列表读取失败，可刷新重试'));
  useEffect(() => { void loadHistory(); }, [historyPage]);
  useEffect(() => {
    if (!target || busy || handledTarget.current===target) return;
    handledTarget.current=target;
    const proceed = () => openBatch(target.batch_id, target.row_id, target);
    if (result?.batch && (Object.keys(edits).length || JSON.stringify(mapping)!==JSON.stringify(result.batch.mapping || {}))) Modal.confirm({ title: '切换导入批次', content: '当前映射或纠错尚未重新校验。切换将放弃这些未保存修改，原文件和已暂存结果仍保留。', okText: '放弃修改并打开目标', onOk: proceed });
    else void proceed();
  }, [target,busy]);
  useEffect(() => {
    if (!focusedRow || !result) return;
    const timer = setTimeout(() => document.querySelector(`[data-finance-import-rows] tr[data-row-key="${focusedRow}"]`)?.scrollIntoView({ block: 'center' }), 150);
    return () => clearTimeout(timer);
  }, [result, rowPage, focusedRow]);
  useEffect(() => {
    if (result?.batch && ['exchange', 'transactions', ...mainImportTypes, ...seriesImportTypes].includes(result.batch.data_type) && result.batch.context.headers.length && !result.batch.mapping && !Object.keys(mapping).length) {
      const headers = result.batch.context.headers;
      if (result.batch.context.exchange) { setMapping(exchangeMapping(result.batch.context.exchange.table)); return; }
      const definitions: Array<{ key: string; label: string }> = result.batch.data_type === 'transactions' ? tradeImportFields : seriesImportTypes.includes(result.batch.data_type) ? seriesImportFields(result.batch.data_type, result.batch.context.target_mode || 'single') : mainImportFields(result.batch.data_type, result.batch.context.fund_kind);
      setMapping(Object.fromEntries(definitions.filter(field => headers.includes(field.label) || headers.includes(field.key)).map(field => [field.key, headers.includes(field.label) ? field.label : field.key])));
    }
  }, [result]);
  useEffect(() => {
    if (!result?.batch || !['parsing', 'awaiting_file'].includes(result.batch.status)) return;
    let current = true;
    const timer = setInterval(() => read('importBatch', { id: result.batch.id }).then(value => { if (current) setResult(value); }).catch(() => { if (current) setFileError('连接中断，可稍后刷新批次继续'); }), 1000);
    return () => { current = false; clearInterval(timer); };
  }, [result?.batch?.id, result?.batch?.status]);
  async function run(action: string, payload: any) {
    setBusy(true);
    try { const response = await save(action, payload); if (action !== 'commitImport') { setResult(response); setEdits({}); if(action==='stageImport'){setRowPage(1);setFocusedRow(undefined);} } else setResult({ ...result, batch: { ...result.batch, status: 'committed', result: response } }); }
    finally { setBusy(false); void loadHistory(); }
  }
  async function openBatch(id, rowId?: string, location?: any) {
    try { const value = await read('importBatch', { id }); const targetRow=value.rows.find(row=>rowId?row.id===rowId:location?.source_row===row.source_row && location?.source_sheet===row.source_sheet); setResult(value); setMapping(value.batch.mapping || {}); setEdits({}); setFileError(''); setFocusedRow(targetRow?.id); setRowPage(Math.floor(Math.max(0,value.rows.findIndex(row=>row.id===targetRow?.id))/20)+1); }
    catch { setFileError('批次读取失败，请重试'); }
  }
  async function downloadOriginal() {
    try {
      const response = await api.request({ skipNotify: true, url: 'finance:downloadImport', params: { id: batch.id }, responseType: 'blob' });
      const url = URL.createObjectURL(response.data); const link = document.createElement('a'); link.href = url; link.download = batch.original_name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setFileError('原文件暂时无法下载，请检查上传状态或重试'); }
  }
  async function downloadTemplate() {
    try {
      const response = await api.request({ skipNotify: true, url: 'finance:tradeTemplate', responseType: 'blob' });
      const url = URL.createObjectURL(response.data); const link = document.createElement('a'); link.href = url; link.download = 'Finance-交易导入模板.xlsx'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setFileError('模板下载失败，请重试'); }
  }
  function inspectRow(row: PreviewRow) {
    Modal.info({ title: `核对原文件第 ${row.source_row} 行`, width: 1000, okText: '关闭', content: <>
      <Typography.Paragraph>新值按当前映射转换；主体及份额使用内部标识。金额、份额、费率均保留精确文本。</Typography.Paragraph>
      <Table<Record<string, any>> rowKey="key" size="small" pagination={false} columns={[
        { title: '字段', dataIndex: 'label' }, { title: '原文件值', dataIndex: 'original' }, { title: '修正后输入', dataIndex: 'input' }, { title: '将保存的新值', dataIndex: 'value' }, { title: '当前旧值', dataIndex: 'old' },
      ]} dataSource={tradeImportFields.map(field => ({ key: field.key, label: field.label, original: row.raw[mapping[field.key]] || '—', input: row.corrected?.[mapping[field.key]] ?? row.raw[mapping[field.key]] ?? '—', value: field.key === 'isin' ? row.normalized?.isin : field.key === 'id' ? row.normalized?.id || '新增' : row.normalized?.values?.[field.key] ?? '空', old: (field.key === 'isin' ? row.normalized?.existing_isin : field.key === 'id' ? row.normalized?.id : row.normalized?.existing_value?.[field.key]) ?? '—' }))} />
      {row.normalized?.warnings?.map(text => <Alert key={text} type="warning" message={text} style={{ marginTop: 8 }} />)}
    </> });
  }
  function confirmDuplicate(row: PreviewRow) {
    Modal.confirm({ title: `确认第 ${row.source_row} 行是另一笔真实交易？`, okText: '确认是独立交易', cancelText: '返回核对', width: 650,
      content: <><Typography.Paragraph>以下记录具有相同的主体、份额、日期、类型、金额和份额。请核对，不会自动去重或覆盖。</Typography.Paragraph>
        <Typography.Paragraph>相同记录共 {row.normalized.duplicate_count} 条（含本行），最多展示 20 条。</Typography.Paragraph>{row.normalized.duplicate_matches.map((match, index) => <p key={index}>{match.row_id ? `本文件第 ${result.rows.find(item => item.id === match.row_id)?.source_row} 行` : `已有交易 ${match.id}`}</p>)}</>,
      onOk: () => run('previewImport', { batch_id: batch.id, technical_revision: batch.technical_revision, mapping, corrections: Object.values({ ...edits, [row.id]: { ...edits[row.id], id: row.id, duplicate_confirmation: row.normalized.required_confirmation } }) }),
    });
  }
  async function downloadMainTemplate() {
    try {
      const response = await api.request({ skipNotify: true, url: 'finance:mainTemplate', params: { data_type: importType, fund_kind: importType === 'compositions' ? 'proprietary' : fundKind || 'third_party' }, responseType: 'blob' });
      const url = URL.createObjectURL(response.data); const link = document.createElement('a'); link.href = url; link.download = 'Finance-主数据导入模板.xlsx'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setFileError('模板下载失败，请检查类型后重试'); }
  }
  async function downloadSeriesTemplate() {
    try {
      const response = await api.request({ skipNotify: true, url: 'finance:seriesTemplate', params: { data_type: importType, target_mode: targetMode }, responseType: 'blob' });
      const url = URL.createObjectURL(response.data); const link = document.createElement('a'); link.href = url; link.download = 'Finance-时序数据导入模板.xlsx'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { setFileError('模板下载失败，请重试'); }
  }
  const batch = result?.batch;
  const isExchange = batch?.data_type === 'exchange';
  const isMain = batch && mainImportTypes.includes(batch.data_type);
  const mainFields = isMain ? mainImportFields(batch.data_type, batch.context.fund_kind) : [];
  const typeLabels = { exchange: '业务交换文件（自动识别）', nav: '单位净值', returns: 'MTD 收益率', benchmark: '基准数值', transactions: '申赎交易', entities: '客户与投资主体', funds: '基金与份额（可含成分）', compositions: '自营成分清单' };
  const headers = batch?.context?.headers || [];
  const readonlyColumns = new Set(batch?.context.exchange ? exportColumns(batch.context.exchange.table).filter(column => column.role !== 'fact').map(column => column.label) : []);
  const dirty = Object.keys(edits).length > 0 || JSON.stringify(mapping) !== JSON.stringify(batch?.mapping || {});
  const parserOutdated = batch && ['staged', 'ready', 'needs_correction'].includes(batch.status) && batch.context.parser_version !== IMPORT_PARSER_VERSION;
  const labels = { awaiting_file: '等待原文件', parsing: '正在解析', staged: '等待映射', ready: '可提交', needs_correction: '需要修正', committed: '已提交', failed: '解析失败', cancelled: '已取消' };
  return <Card title="文件导入" extra={batch && <Space><Button disabled={busy} onClick={() => void openBatch(batch.id)}>刷新批次</Button><Button onClick={() => void downloadOriginal()}>下载原文件</Button>{!['committed', 'cancelled'].includes(batch.status) && <Button danger disabled={busy} onClick={() => Modal.confirm({ title: '取消当前导入批次？', content: '尚未提交的业务数据不会生效，原文件和行记录仍保留。已经完成的提交不能取消。', okText: '取消批次', cancelText: '返回', onOk: () => run('cancelImport', { batch_id: batch.id, technical_revision: batch.technical_revision }) })}>取消批次</Button>}<Button disabled={busy} onClick={() => { setResult(undefined); setFile(undefined); setMapping({}); setEdits({}); void loadHistory(); }}>开始新批次</Button></Space>}>
    <Typography.Paragraph type="secondary">上传后先核对，不会直接写入业务数据。只读取首工作表，首行为表头。修正错误或明确取消选择后，一次提交所有选中行。</Typography.Paragraph>
    {fileError && <Alert type="error" message={fileError} style={{ marginBottom: 12 }} />}
    {batch?.context.exchange && <Alert type="info" showIcon message="已识别 Finance 交换文件" description={isExchange ? '固定映射已有业务表；只修改选中记录，ID 和固定关联保留。基金按组保存一个资料版本。成分修改需核对完整差异；文档仅修改分类。' : batch.data_type === 'transactions' ? '字段映射和比例费率已固定；\\N 表示空值。保留交易 ID，修改后仍是原交易；已撤销记录仅核对，不恢复。只读字段不写入业务事实。' : '字段映射和比例口径已固定；\\N 表示空值。请保留 ID，不能用修改日期或对象的方式创建另一条记录。只读字段仅用于核对。'} style={{ marginBottom: 12 }} />}
    {!batch ? <><Form layout="vertical" form={form} initialValues={{ data_type: 'nav', fund_kind: 'third_party', target_mode: 'single' }} onFinish={async values => {
      if (!file) { setFileError('请先选择文件'); return; }
      const reader = new FileReader();
      reader.onload = () => run('stageImport', { data_type: values.data_type, ...(seriesImportTypes.includes(values.data_type) ? { target_mode: values.target_mode || 'single', ...(values.target_mode === 'columns' ? {} : values.data_type === 'benchmark' ? { benchmark_id: values.benchmark_id } : { share_class_id: values.share_class_id }) } : values.data_type === 'funds' ? { fund_kind: values.fund_kind } : {}), original_name: file.name, content_base64: String(reader.result).split(',')[1] }).catch(() => {});
      reader.readAsDataURL(file);
    }} style={{ maxWidth: 650 }}>
      <Form.Item name="data_type" label="导入类型" rules={[{ required: true }]}><Select options={Object.entries(typeLabels).map(([value, label]) => ({ value, label }))} /></Form.Item>
      {importType === 'funds' && <Form.Item name="fund_kind" label="基金类型" rules={[{ required: true }]}><Select options={[{ value: 'third_party', label: '三方基金' }, { value: 'proprietary', label: '自营基金' }]} /></Form.Item>}
      {importType === 'exchange' ? <Alert type="info" message="上传从数据导出页下载的业务 Excel，系统自动识别业务表。持仓是只读结果，不能导入。文件需保留 Finance交换信息 工作表。" /> : mainImportTypes.includes(importType) ? <><Alert type="info" message="空白保留已有值，#清空 清空选填项。基金先按组汇总，每次保存只增加一个完整版本。" /><Button style={{ margin: '12px 0' }} onClick={() => void downloadMainTemplate()}>下载主数据模板及参考</Button></> : importType === 'transactions' ? <><Alert type="info" message="每行使用主体 ID 和 ISIN；交易 ID 留空为新增，填写已有 ID 为修改。" /><Button style={{ margin: '12px 0' }} onClick={() => void downloadTemplate()}>下载交易模板（含主体与份额参考）</Button></> : <><Form.Item name="target_mode" label="对象识别方式" rules={[{ required: true }]}><Select options={[{ value: 'single', label: '整份文件使用一个对象' }, { value: 'columns', label: '每行通过标识列识别对象' }]} /></Form.Item>
        {targetMode === 'single' ? importType === 'benchmark' ? <Form.Item name="benchmark_id" label="导入到基准" rules={[{ required: true }]}><RemoteSelect resource="benchmarks" /></Form.Item> : <Form.Item name="share_class_id" label="导入到基金份额" rules={[{ required: true }]}><RemoteSelect resource="share_classes" params={importType === 'returns' ? { fund_kind: 'third_party' } : {}} /></Form.Item> : <Alert type="info" message={importType === 'benchmark' ? '每行使用基准 ID，不按名称匹配。' : '每行使用已有 ISIN；可在一份文件录入多个份额。'} />}
        <Button style={{ margin: '12px 0' }} onClick={() => void downloadSeriesTemplate()}>下载时序模板及对象参考</Button></>}
      <Form.Item label="原始文件" required><Upload accept=".xlsx,.xls,.csv" maxCount={1} beforeUpload={value => { setFile(value); setFileError(''); return false; }} onRemove={() => setFile(undefined)}><Button>选择 xlsx／xls／CSV</Button></Upload>{fileError && <TextError text={fileError} />}</Form.Item>
      <Button type="primary" htmlType="submit" loading={busy}>读取文件并暂存</Button>
    </Form><Typography.Title level={4}>我的导入批次</Typography.Title><Button onClick={() => void loadHistory()}>刷新批次列表</Button><Table<Record<string, any>> rowKey="id" dataSource={history.rows} pagination={{ current: historyPage, total: history.count, pageSize: 10, onChange: setHistoryPage, showSizeChanger: false }} columns={[
      { title: '原文件', dataIndex: 'original_name' }, { title: '类型', dataIndex: 'data_type', render: value => typeLabels[value] || value },
      { title: '状态', dataIndex: 'status', render: value => labels[value] || value }, { title: '创建时间', dataIndex: 'created_at', render: value => new Date(value).toLocaleString('zh-CN') },
      { title: '操作', render: (_, row) => <Button onClick={() => void openBatch(row.id)}>打开批次</Button> },
    ]} /></> : <>
      <Space wrap style={{ marginBottom: 16 }}><Typography.Text strong>{batch.original_name}</Typography.Text><Tag>{batch.context.sheet_name}</Tag><Tag color={batch.status === 'committed' ? 'green' : 'blue'}>{labels[batch.status] || batch.status}</Tag><Typography.Text type="secondary">{result.rows.length} 条记录</Typography.Text></Space>
      {batch.context.ignored_sheets.length > 0 && <Alert type="info" message={`以下工作表未作为业务数据导入：${batch.context.ignored_sheets.join('、')}`} />}
      {batch.context.diagnostics?.notes?.map(note => <Alert key={note} type="info" message={note} style={{ marginBottom: 8 }} />)}
      {parserOutdated && <Alert type="warning" message="该批次需按新解析规则重新核对" description="请下载原文件，开始新批次重新核对。原批次及纠错记录仍保留，已提交业务记录不受影响。" />}
      {batch.status === 'committed' ? <Alert type="success" showIcon message={`已提交 ${batch.result.committed_count} 行`} description={isExchange ? `修改 ${batch.result.overwritten_count} 行，不变 ${batch.result.unchanged_count} 行；新增基金资料版本 ${batch.result.version_count} 个。原记录 ID 保留，重复提交不会再次保存。` : isMain ? `已处理 ${batch.result.object_count} 个对象：新增 ${batch.result.inserted_count ?? "未记录"}，保存修改 ${batch.result.overwritten_count ?? "未记录"}，不变 ${batch.result.unchanged_count ?? "未记录"}。基金每次明确保存均新增一个资料版本；重试不会重复保存。` : batch.data_type === 'transactions' ? `新增 ${batch.result.inserted_count}，修改 ${batch.result.overwritten_count}，不变 ${batch.result.unchanged_count}。可到申赎和持仓页面核对。重复提交不会追加交易。` : `新增 ${batch.result.inserted_count ?? '未记录'}，覆盖 ${batch.result.overwritten_count ?? '未记录'}，不变 ${batch.result.unchanged_count ?? '未记录'}。可到净值、收益、基准和持仓页面核对；重复提交不会再次写入。`} />
        : batch.status === 'cancelled' ? <Alert type="info" message="批次已取消，没有提交业务数据" description="原文件和暂存行仍保留；如需再次导入，请创建新批次。" />
        : batch.status === 'failed' ? <Alert type="error" message="文件解析失败" description={<><div>{batch.context.parse_error}</div><div style={{ marginTop: 8 }}>若需修正文件内容，请开始新批次上传。重试解析只用于文件内容未变的临时故障。</div></>} action={<Button loading={busy} onClick={() => run('retryImport', { batch_id: batch.id, technical_revision: batch.technical_revision }).catch(() => {})}>重试解析</Button>} />
        : ['parsing', 'awaiting_file'].includes(batch.status) ? <Alert type="info" showIcon message={batch.status === 'parsing' ? '文件正在解析' : '原文件尚未上传完成'} description="批次已经保存，可离开页面，稍后从“我的导入批次”继续。应用重启后会恢复解析。" action={batch.status === 'awaiting_file' && <Upload showUploadList={false} beforeUpload={file => { const reader = new FileReader(); reader.onload = () => run('stageImport', { batch_id: batch.id, content_base64: String(reader.result).split(',')[1] }).catch(() => {}); reader.readAsDataURL(file); return false; }}><Button loading={busy}>重新选择原文件</Button></Upload>} /> : <>
        <Space wrap align="start" style={{ marginBottom: 20 }}>
          {isExchange ? <MainExchangeMapping table={batch.context.exchange.table} /> : isMain ? <MainMapping fields={mainFields} mapping={mapping} headers={headers} busy={busy} onChange={setMapping} /> : batch.data_type === 'transactions' ? <>{tradeImportFields.map(field => <div key={field.key}><p>{field.label}{field.required ? ' *' : ''}</p><Select disabled={busy || !!batch.context.exchange} aria-label={`${field.label}映射`} allowClear={!field.required} style={{ width: 180 }} value={mapping[field.key]} options={headers.map(value => ({ value, label: value }))} onChange={value => { const updated = { ...mapping }; if (value) updated[field.key] = value; else delete updated[field.key]; setMapping(updated); }} /></div>)}{mapping.fee_rate && <div><p>费率列口径</p><Select disabled={busy || !!batch.context.exchange} aria-label="费率列口径" style={{ width: 240 }} value={mapping.fee_rate_mode} onChange={fee_rate_mode => setMapping({ ...mapping, fee_rate_mode })} options={[{ value: 'percent', label: '百分数：2 或 2% 表示 2%' }, { value: 'ratio', label: '比例值：0.02 表示 2%' }]} /></div>}</> : <SeriesMapping type={batch.data_type} mode={batch.context.target_mode || 'single'} headers={headers} mapping={mapping} busy={busy || !!batch.context.exchange} onChange={setMapping} />}

        </Space>
        <Typography.Paragraph type="secondary">表格内可直接修正。原始文件和原值会保留；每次修正后需要重新预览。</Typography.Paragraph>
        <Table<PreviewRow> data-finance-import-rows rowClassName={row=>row.id===focusedRow?'finance-target-row':''} rowKey="id" size="small" scroll={{ x: Math.max(850, headers.length * 180 + 500) }} dataSource={result.rows} pagination={{ current:rowPage,pageSize:20,onChange:setRowPage,showSizeChanger:false }} rowSelection={{ fixed: 'left', getCheckboxProps: () => ({ disabled: busy }), selectedRowKeys: result.rows.filter(row => edits[row.id]?.selected ?? row.selected).map(row => row.id), onChange: ids => setEdits(Object.fromEntries(result.rows.map(row => [row.id, { ...edits[row.id], id: row.id, selected: ids.includes(row.id) }]))) }} columns={[
          { title: '原文件行', dataIndex: 'source_row', width: 90, fixed: 'left' },
          ...headers.map(header => ({ title: header, key: header, render: (_, row) => <Input disabled={busy || readonlyColumns.has(header)} aria-label={`第 ${row.source_row} 行 ${header}`} value={edits[row.id]?.corrected?.[header] ?? row.corrected?.[header] ?? row.raw[header]} onChange={e => setEdits({ ...edits, [row.id]: { ...edits[row.id], id: row.id, corrected: { ...row.corrected, ...edits[row.id]?.corrected, [header]: e.target.value } } })} /> })),
          { title: '操作', dataIndex: 'operation', width: 85, render: value => value === 'overwrite' ? <Tag color="orange">覆盖</Tag> : value === 'insert' ? <Tag color="green">新增</Tag> : value === 'unchanged' ? <Tag>不变</Tag> : '—' },
          { title: '数值核对', width: 160, render: (_, row) => isExchange ? row.normalized?.values && <Button disabled={dirty || busy} onClick={() => inspectExchangeRow(row, batch.context.exchange.table)}>查看转换与旧值</Button> : isMain ? row.normalized?.values && <Button disabled={dirty || busy} onClick={() => inspectMainRow(row, mainFields, mapping)}>查看转换与旧值</Button> : batch.data_type === 'transactions' ? row.normalized?.values && <Button disabled={dirty || busy} onClick={() => inspectRow(row)}>查看转换与旧值</Button> : row.normalized?.values && <Button disabled={dirty || busy} onClick={() => inspectSeriesRow(row, batch.data_type, batch.context.target_mode || 'single', mapping)}>查看转换与旧值</Button> },
          { title: '校验结果', width: 280, fixed: 'right', render: (_, row) => <>{row.errors?.length ? row.errors.map(error => <div key={error.code} style={{ color: '#b42318' }}>{error.message}</div>) : row.normalized?.validated === false ? <Tag>待校验</Tag> : row.normalized ? <Tag color="green">通过</Tag> : '待预览'}{row.errors?.some(error => error.code === 'DUPLICATE_TRADE') && <Button disabled={dirty || busy} onClick={() => confirmDuplicate(row)}>核对重复交易</Button>}{row.errors?.some(error => error.code === 'COMPOSITION_CONFIRMATION_REQUIRED') && <Button disabled={dirty || busy} onClick={() => confirmCompositionReplacement(row, () => run('previewImport', { batch_id: batch.id, technical_revision: batch.technical_revision, mapping, corrections: Object.values({ ...edits, [row.id]: { ...edits[row.id], id: row.id, replacement_confirmation: row.normalized.required_confirmation } }) }))}>核对完整清单变更</Button>}{row.errors?.some(error => error.code === 'CLIENT_RENAME_CONFIRMATION_REQUIRED') && <Button disabled={dirty || busy} onClick={() => confirmClientRename(row, () => run('previewImport', { batch_id: batch.id, technical_revision: batch.technical_revision, mapping, corrections: Object.values({ ...edits, [row.id]: { ...edits[row.id], id: row.id, replacement_confirmation: row.normalized.required_confirmation } }) }))}>核对客户改名影响</Button>}{row.normalized?.warnings?.map(text => <div key={text} style={{ color: '#8a5800' }}>{text}</div>)}</> },
        ]} />
        <Space><Button loading={busy} disabled={busy || parserOutdated} onClick={() => run('previewImport', { batch_id: batch.id, technical_revision: batch.technical_revision, mapping, corrections: Object.values(edits) }).catch(() => {})}>重新校验并预览</Button><Button type="primary" loading={busy} disabled={busy || parserOutdated || batch.status !== 'ready' || dirty} onClick={() => run('commitImport', { batch_id: batch.id, technical_revision: batch.technical_revision, preview_token: batch.preview.token }).catch(() => {})}>提交选中集合（{batch.preview?.selected_count || 0} 行）</Button></Space>
      </>}
      {['committed','cancelled'].includes(batch.status) && <>
        <Typography.Paragraph type="secondary">以下为原批次的原值和暂存修正值，只读展示。正式业务记录可能已在之后修改。</Typography.Paragraph>
        <Table<PreviewRow> data-finance-import-rows rowClassName={row=>row.id===focusedRow?'finance-target-row':''} rowKey="id" size="small" dataSource={result.rows} scroll={{x:Math.max(800,headers.length*180)}} pagination={{current:rowPage,pageSize:20,onChange:setRowPage,showSizeChanger:false}} columns={[
          {title:'原文件行',dataIndex:'source_row',width:90,fixed:'left'},
          ...headers.map(header=>({title:header,key:header,render:(_,row)=><><div>{row.raw[header] ?? '—'}</div>{row.corrected?.[header]!==undefined && row.corrected[header]!==row.raw[header] && <Typography.Text type="secondary">修正：{row.corrected[header] || '空'}</Typography.Text>}</>})),
          {title:'选中状态',dataIndex:'selected',render:value=>value?'选中':'排除'},
        ]}/>
      </>}
    </>}
  </Card>;
}
function TextError({ text }: { text: string }) { return <p style={{ color: '#b42318' }}>{text}</p>; }
