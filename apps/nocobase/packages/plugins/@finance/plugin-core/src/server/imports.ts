import { domainWrite, writeOptions } from './write-scope';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, readdir, lstat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import { Op } from 'sequelize';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { FinanceError } from '../shared/values';
import { FinanceService, uuid } from './service';
import { FinanceOptions } from './options';
import { TradeImports } from './trade-imports';
import { tradeImportFields } from '../shared/trade-import';
import { mainImportFields, mainImportTypes } from '../shared/main-import';
import { MainImports } from './main-imports';
import { MainExchangeImports } from './main-exchange-imports';
import { SeriesImports } from './series-imports';
import { seriesImportFields, seriesImportTypes } from '../shared/series-import';
import { exchangeSeries, exchangeImportTypes } from '../shared/export';
import { ImportParserWorker } from './import-parser-worker';
import { IMPORT_PARSER_VERSION } from './import-parser';

const plain = (row: any) => row.get({ plain: true });
const assertImportKeys = (value: any, allowed: string[], field = 'import') => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new FinanceError('FIELD_NOT_WRITABLE', '导入参数包含不可直接写入的字段', field);
};
export { parseUpload } from './import-parser';

export class FinanceImports {
  parser = new ImportParserWorker();
  private queue: Promise<any> = Promise.resolve();
  private pending = new Map<string, Promise<any>>();
  private stopping = false;
  constructor(public service: FinanceService, public directory = path.join(process.env.STORAGE_PATH || path.resolve('storage'), 'finance/imports')) {}
  async seriesTemplate(type: string, targetMode = 'columns') {
    if (!seriesImportTypes.includes(type) || !['single', 'columns'].includes(targetMode)) throw new FinanceError('INVALID_TEMPLATE', '请选择有效的净值、收益或基准数值模板');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([seriesImportFields(type, targetMode).map(field => field.label)]), '待导入数据');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['填写说明'], ['只读取首工作表；每行一条记录。数据格建议设为文本，日期使用 YYYY-MM-DD，数值保留全部小数位。'],
      [targetMode === 'single' ? '整份文件使用上传时选择的同一个对象。' : '每行明确填写已有 ISIN 或基准 ID，不使用近似名称匹配。'],
      ['同对象同日期覆盖已有数值；文件内重复键必须先修正或明确取消选择。'],
      ['收益模板使用比例值：0.02 表示 2%；导入时仍须明确选择收益列口径。'],
      ['估算标记可填 是、否 或留空；留空保留未知。覆盖时未映射该列也会设为未知，请核对风险提示。'],
      ['业务日期、数值、估算标记会显示原值、转换值和旧值。整批通过后才能提交；不变记录不重复写入。'],
    ]), '填写说明');
    if (type === 'benchmark') {
      const rows = await this.service.model('benchmarks').findAll({ order: [['name', 'ASC']] });
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['基准 ID', '基准名称', '分类'], ...rows.map(row => [row.id, row.get('name'), row.get('category')])]), '基准参考');
    } else {
      const funds = await this.service.model('funds').findAll({ where: { is_deleted: false, ...(type === 'returns' ? { fund_kind: 'third_party' } : {}) } });
      const shares = await this.service.model('share_classes').findAll({ where: { is_deleted: false, fund_id: { [Op.in]: funds.map(row => row.id) } }, order: [['isin', 'ASC']] });
      const names = new Map(funds.map(row => [row.id, row.get('short_name')]));
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['ISIN', '份额 ID', '基金简称', '币种'], ...shares.map(row => [row.get('isin'), row.id, names.get(row.get('fund_id')), row.get('currency')])]), '份额参考');
    }
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }
  async mainTemplate(type: string, kind = 'third_party') {
    if (!mainImportTypes.includes(type) || !['third_party', 'proprietary'].includes(kind) || type === 'compositions' && kind !== 'proprietary') throw new FinanceError('INVALID_TEMPLATE', '请选择主体、基金或自营成分模板');
    const definitions = mainImportFields(type, kind); const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([definitions.map(field => field.label)]), '待导入数据');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['填写说明'], ['只读取首工作表；数据格建议设为文本。模板字段来自字段清单，系统字段不可导入。'],
      ['空白保留已有值；#清空 表示清空选填项；如需文本本身为 #清空，请填写 ##清空。新对象的必填项不能留空。'],
      ['主体：已有对象填写主体 ID；留空则新增。客户编号只分组，不能按姓名或客户编号覆盖。多选在一个单元格内每行写一个选项。'],
      ['基金：行类型为 份额、基金资料、成分 或 清空成分。同一新基金使用相同分组键；已有基金填写基金 ID，也可由已有份额 ID 或 ISIN 定位。'],
      ['基金公共字段可只在一行填写；重复填写必须一致。每个份额一行，基金与全部选中份额、成分一次保存仅生成一个版本。'],
      ['成分：已有自营基金用基金 ID；每组必须填写完整成分。日期相同视为同一清单；无日期新清单须有分组键，修改无日期清单使用清单 ID。'],
      ['成分 ISIN 必须已存在且属于三方基金。替换已有清单会提示新增、修改和移除项，需要明确确认。清空成分行只指定已有清单，不填写明细。'],
      ['份额、成分行可混合在自营基金模板内；股份字段只能写在份额行，成分字段只能写在成分行。负责人使用用户 ID。'],
      ['候选值待确认时只适用于模拟验证。确认日期及其他日期使用 YYYY-MM-DD，不将 Hold 等文字自动转为日期。'],
    ]), '填写说明');
    const funds = await this.service.model('funds').findAll({ where: { is_deleted: false }, order: [['short_name', 'ASC']] });
    const shares = await this.service.model('share_classes').findAll({ where: { is_deleted: false, fund_id: { [Op.in]: funds.map(row => row.id) } }, order: [['isin', 'ASC']] });
    const names = new Map<string, any>(funds.map(row => [row.id, row]));
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['基金 ID', '基金简称', '基金类型', '份额 ID', 'ISIN', '币种'], ...shares.map(row => [row.get('fund_id'), names.get(row.get('fund_id')).get('short_name'), names.get(row.get('fund_id')).get('fund_kind') === 'proprietary' ? '自营' : '三方', row.id, row.get('isin'), row.get('currency')])]), '基金份额参考');
    const lists = await this.service.model('composition_snapshots').findAll({ where: { parent_fund_id: { [Op.in]: funds.map(row => row.id) } } });
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['基金 ID', '基金简称', '成分清单 ID', '成分估值日期'], ...lists.map(row => [row.get('parent_fund_id'), names.get(row.get('parent_fund_id')).get('short_name'), row.id, row.get('valuation_date') || ''])]), '成分清单参考');
    const entities = await this.service.model('investment_entities').findAll({ where: { is_deleted: false }, order: [['legal_name', 'ASC']] });
    const codes = new Map((await this.service.model('client_groups').findAll()).map(row => [row.id, row.get('client_code')]));
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['主体 ID', '客户编号', '主体名称'], ...entities.map(row => [row.id, codes.get(row.get('client_group_id')), row.get('legal_name')])]), '主体参考');
    const users = this.service.db.hasCollection('users') ? await this.service.db.getModel('users').findAll({ attributes: ['id', 'nickname', 'username'] }) : [];
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['用户 ID', '显示名', '用户名'], ...users.map(row => [String(row.id), row.get('nickname'), row.get('username')])]), '负责人参考');
    const options = await new FinanceOptions(this.service).list();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['字段', '来源', '选项代码', '显示值', '是否已确认'], ...options.flatMap(set => set.values.map(value => [set.label, set.source_key, value.code, value.label, set.confirmed ? '是' : '否']))]), '候选项参考');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }
  async tradeTemplate() {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([tradeImportFields.map(field => field.label)]), '交易录入');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['填写说明'], ['仅导入首工作表；所有数据格建议设为文本，保留精确数值。'],
      ['主体 ID 从主体参考表复制，不能填写客户编号或姓名；ISIN 从份额参考表复制。'],
      ['交易 ID 留空表示新增；修改时填写已有交易 ID，并完整填写该行全部业务字段。未填选填值会清空原值。'],
      ['费率需在导入页面明确选择百分数或比例值；确认净值最多四位小数。'],
      ['日期使用 YYYY-MM-DD；交易类型为初次申购、追加申购或赎回；份额必须大于零。'],
      ['同日按申赎汇总校验；原文件和修正值分别保留，选中集合一次提交。'],
    ]), '填写说明');
    const entities = await this.service.model('investment_entities').findAll({ where: { is_deleted: false }, attributes: ['id', 'legal_name'], order: [['legal_name', 'ASC']] });
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['主体 ID', '投资主体名称'], ...entities.map(row => [row.id, row.get('legal_name')])]), '主体参考');
    const funds = await this.service.model('funds').findAll({ where: { is_deleted: false }, attributes: ['id', 'short_name'] });
    const shares = await this.service.model('share_classes').findAll({ where: { is_deleted: false, fund_id: { [Op.in]: funds.map(row => row.id) } }, order: [['isin', 'ASC']] });
    const fundNames = new Map(funds.map(row => [row.id, row.get('short_name')]));
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['ISIN', '基金简称', '份额', '币种'], ...shares.map(row => [row.get('isin'), fundNames.get(row.get('fund_id')), row.get('class_label'), row.get('currency')])]), '份额参考');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }
  async exportSeries(dataType: string, shareClassId: string) {
    if (!['nav', 'returns'].includes(dataType)) throw new FinanceError('UNSUPPORTED_EXPORT', '请选择净值或收益', 'data_type');
    await this.service.requiredRow('share_classes', uuid(shareClassId, 'share_class_id'), undefined);
    const [table, , date] = this.service.seriesConfig(dataType);
    const value = dataType === 'nav' ? 'nav_per_unit' : 'mtd_return';
    const rows = await this.service.model(table).findAll({ where: { share_class_id: shareClassId }, order: [[date, 'ASC']] });
    const matrix = dataType === 'nav' ? [['日期', '单位净值']] : [['日期', 'MTD收益（比例值）', '是否预估值']];
    for (const row of rows) matrix.push(dataType === 'nav' ? [row.get(date), row.get(value)] : [row.get(date), row.get(value), row.get('estimate_label') ?? '']);
    const book = XLSX.utils.book_new();
    // Explicit text cells preserve every decimal digit when Excel opens and saves the file.
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(matrix), '数据');
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }
  async batch(id: string, actor: string, transaction?: any) {
    const row = await this.service.requiredRow('import_batches', uuid(id, 'batch_id'), transaction);
    if (row.get('owner_id') !== actor) throw new FinanceError('FORBIDDEN', '只能处理本人创建的导入批次', 'batch_id', 403);
    return row;
  }
  async stage(payload: any, transaction: any, actor: string) {
    if (payload.batch_id) {
      if (Object.keys(payload).some(key => !['batch_id', 'content_base64'].includes(key)) || typeof payload.content_base64 !== 'string' || payload.content_base64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.content_base64)) throw new FinanceError('INVALID_FILE', '请选择原上传文件');
      const batch = await this.batch(payload.batch_id, actor, transaction);
      if (batch.get('status') === 'cancelled') throw new FinanceError('BATCH_CANCELLED', '已取消批次不能继续上传', 'batch_id', 409);
      if (createHash('sha256').update(Buffer.from(payload.content_base64, 'base64')).digest('hex') !== batch.get('context').file_sha256) throw new FinanceError('FILE_CONTENT_MISMATCH', '请选择本批次的原文件，内容必须一致');
      return { batch_id: batch.id };
    }
    if (Object.keys(payload).some(key => !['original_name', 'content_base64', 'data_type', 'share_class_id', 'benchmark_id', 'target_mode', 'fund_kind'].includes(key))) throw new FinanceError('FIELD_NOT_WRITABLE', '此导入参数不可直接写入');
    const { original_name, content_base64, data_type, share_class_id } = payload;
    if (![...seriesImportTypes, 'transactions', 'exchange', ...mainImportTypes].includes(data_type)) throw new FinanceError('UNSUPPORTED_IMPORT', '请选择已支持的导入类型', 'data_type');
    const fundKind = data_type === 'compositions' ? 'proprietary' : data_type === 'funds' ? payload.fund_kind : null;
    if (data_type === 'funds' && !['third_party', 'proprietary'].includes(fundKind)) throw new FinanceError('FUND_KIND_REQUIRED', '请选择三方或自营基金模板', 'fund_kind');
    if (typeof original_name !== 'string' || original_name.length > 240 || typeof content_base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(content_base64)) throw new FinanceError('INVALID_FILE', '文件参数无效', 'file');
    const isSeries = seriesImportTypes.includes(data_type);
    const targetMode = isSeries ? payload.target_mode || 'single' : null;
    if (isSeries && !['single', 'columns'].includes(targetMode)) throw new FinanceError('INVALID_TARGET_MODE', '请选择整份文件一个对象或按行识别对象', 'target_mode');
    if (isSeries && targetMode === 'columns' && (share_class_id || payload.benchmark_id)) throw new FinanceError('AMBIGUOUS_TARGET', '按行识别模式不能同时指定整份文件的目标对象', 'target_mode');
    if (isSeries && targetMode === 'single') {
      const parent = data_type === 'benchmark' ? 'benchmark_id' : 'share_class_id';
      if (payload[data_type === 'benchmark' ? 'share_class_id' : 'benchmark_id']) throw new FinanceError('INVALID_TARGET', '目标对象类型与导入类型不一致', parent);
      const id = uuid(payload[parent], parent);
      this.service.checkSeriesParent(data_type, (await this.service.seriesParents(data_type, [id], transaction)).get(id));
    }
    if (!['.xlsx', '.xls', '.csv'].includes(path.extname(original_name).toLowerCase())) throw new FinanceError('UNSUPPORTED_FILE', '请选择 xlsx、xls 或 CSV 文件', 'file');
    const bytes = Buffer.from(content_base64, 'base64');
    if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new FinanceError('FILE_SIZE', '文件应介于 1 字节和 10 MB 之间', 'file');
    const id = randomUUID();
    const storageKey = `${id}${path.extname(original_name).toLowerCase()}`;
    await this.service.model('import_batches').create({ id, owner_id: actor, data_type, status: 'awaiting_file', original_name: original_name.split(/[\\/]/).pop(), storage_key: storageKey,
      context: { target_mode: targetMode, share_class_id: isSeries && targetMode === 'single' && data_type !== 'benchmark' ? uuid(share_class_id, 'share_class_id') : null, benchmark_id: data_type === 'benchmark' && targetMode === 'single' ? uuid(payload.benchmark_id, 'benchmark_id') : null, fund_kind: fundKind, headers: [], ignored_sheets: [], file_sha256: createHash('sha256').update(bytes).digest('hex') } }, writeOptions(transaction));
    return { batch_id: id };
  }
  async upload(payload: any, actor: string) {
    const { request_key, ...input } = payload;
    // Reserve a durable batch identity before touching the filesystem. A retry
    // gets the same batch even if the first process stopped before writing bytes.
    const receipt = await this.service.write(actor, 'stageImport', request_key, input, transaction => this.stage(input, transaction, actor));
    await domainWrite(() => this.service.db.sequelize.transaction(async transaction => {
      await this.service.lock([`batch:${receipt.batch_id}`], transaction);
      const batch = await this.batch(receipt.batch_id, actor, transaction);
      if (batch.get('status') !== 'awaiting_file') return;
      const bytes = Buffer.from(input.content_base64, 'base64');
      if (createHash('sha256').update(bytes).digest('hex') !== batch.get('context').file_sha256) throw new FinanceError('FILE_CONTENT_MISMATCH', '文件内容与原请求不一致');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const destination = path.join(this.directory, batch.get('storage_key'));
      await writeFile(`${destination}.part`, bytes, { mode: 0o600 });
      await rename(`${destination}.part`, destination);
      await batch.update({ status: 'parsing' }, writeOptions(transaction));
    }));
    return receipt;
  }
  async process(id: string) {
    uuid(id, 'batch_id');
    if (this.stopping) return;
    if (this.pending.has(id)) return this.pending.get(id);
    const job = this.queue.then(() => this.stopping ? undefined : this.processOne(id));
    this.pending.set(id, job); this.queue = job.catch(() => {});
    try { return await job; } finally { this.pending.delete(id); }
  }
  private async processOne(id: string) {
    const claim: { token: string; storage_key: string; original_name: string; status: string; sha256: string } | null = await domainWrite(() => this.service.db.sequelize.transaction(async transaction => {
      await this.service.lock([`batch:${id}`], transaction);
      const batch = await this.service.requiredRow('import_batches', id, transaction);
      if (!['awaiting_file', 'parsing'].includes(batch.get('status'))) return null;
      const context = batch.get('context');
      if (context.parse_claim && Date.parse(context.parse_claim.expires_at) > Date.now()) return null;
      const token = randomUUID();
      await batch.update({ context: { ...context, parse_claim: { token, expires_at: new Date(Date.now() + 120000).toISOString() } } }, writeOptions(transaction));
      return { token, storage_key: batch.get('storage_key'), original_name: batch.get('original_name'), status: batch.get('status'), sha256: context.file_sha256 };
    }));
    if (!claim) return;
    try {
      let bytes: Buffer;
      try { bytes = await readFile(path.join(this.directory, claim.storage_key)); }
      catch (error: any) {
        if (error.code === 'ENOENT' && claim.status === 'awaiting_file') {
          await this.finishParseAttempt(id, claim.token, null); return;
        }
        if (error.code === 'ENOENT') throw new FinanceError('IMPORT_FILE_MISSING', '原文件缺失，请从批次下载备份检查存储；也可重新上传原文件创建新批次');
        throw error;
      }
      if (createHash('sha256').update(bytes).digest('hex') !== claim.sha256) throw new FinanceError('FILE_CONTENT_MISMATCH', '原文件校验未通过，请新建批次重新上传');
      // CPU-intensive workbook work runs without a database transaction or web-event-loop work.
      const parsed = await this.parser.parse(claim.original_name, bytes);
      await domainWrite(() => this.service.db.sequelize.transaction(async transaction => {
        await this.service.lock([`batch:${id}`], transaction);
        const batch = await this.service.requiredRow('import_batches', id, transaction);
        if (!['awaiting_file', 'parsing'].includes(batch.get('status')) || batch.get('context').parse_claim?.token !== claim.token) return;
        let dataType = batch.get('data_type'); let context = batch.get('context');
        if (dataType === 'exchange' && !parsed.exchange) throw new FinanceError('EXCHANGE_REQUIRED', '此入口只接收带 Finance交换信息 的业务导出文件；普通文件请选择对应录入类型');
        if (parsed.exchange) {
          if (!Object.hasOwn(exchangeImportTypes, parsed.exchange.table)) throw new FinanceError('EXCHANGE_READONLY', '持仓是只读计算结果，不能作为业务事实导入');
          if (dataType === 'exchange') { dataType = exchangeImportTypes[parsed.exchange.table]; context = { ...context, target_mode: Object.hasOwn(exchangeSeries, parsed.exchange.table) ? 'columns' : null }; }
          if (exchangeImportTypes[parsed.exchange.table] !== dataType || Object.hasOwn(exchangeSeries, parsed.exchange.table) && context.target_mode !== 'columns') throw new FinanceError('EXCHANGE_TARGET_MISMATCH', '请使用“业务交换文件”自动识别类型，或为净值、收益和基准数值选择“每行通过标识列识别对象”');
        }
        await this.service.model('import_rows').bulkCreate(parsed.rows.map((row, index) => ({ id: randomUUID(), batch_id: id, row_index: index, ...row, corrected: {}, errors: [], selected: true })), writeOptions(transaction));
        await batch.update({ data_type: dataType, status: 'staged', context: { ...context, headers: parsed.headers, sheet_name: parsed.sheet_name, ignored_sheets: parsed.ignored_sheets, exchange: parsed.exchange, parser_version: parsed.parser_version, diagnostics: parsed.diagnostics, parse_claim: null, parse_error: null, parse_error_code: null, parse_error_details: null }, technical_revision: batch.get('technical_revision') + 1 }, writeOptions(transaction));
      }));
    } catch (error: any) { await this.finishParseAttempt(id, claim.token, error); }
  }
  private async finishParseAttempt(id: string, token: string, error: any) {
    await domainWrite(() => this.service.db.sequelize.transaction(async transaction => {
      await this.service.lock([`batch:${id}`], transaction);
      const batch = await this.service.requiredRow('import_batches', id, transaction);
      if (!['awaiting_file', 'parsing'].includes(batch.get('status')) || batch.get('context').parse_claim?.token !== token) return;
      const interrupted = this.stopping && error?.code === 'PARSER_INTERRUPTED';
      await batch.update({ ...(error && !interrupted ? { status: 'failed', technical_revision: batch.get('technical_revision') + 1 } : {}), context: { ...batch.get('context'), parse_claim: null,
        ...(error ? { parse_error: error instanceof FinanceError ? error.message : '解析未完成，可重试；如再次失败请联系维护者检查日志', parse_error_code: error.code || 'PARSER_ERROR', parse_error_details: error instanceof FinanceError ? error.details || null : null } : {}) } }, writeOptions(transaction));
    }));
  }
  async recover() {
    // Missing uploads must not occupy all slots ahead of files ready to parse.
    for (const status of ['parsing', 'awaiting_file']) {
      const rows = await this.service.model('import_batches').findAll({ where: { status }, limit: 50, order: [['updated_at', 'ASC'], ['id', 'ASC']] });
      for (const row of rows) { if (this.stopping) return; await this.process(row.id); }
    }
    await this.cleanupOrphans();
  }
  async cleanupOrphans(now = Date.now()) {
    const configured = Number(process.env.FINANCE_IMPORT_ORPHAN_RETENTION_HOURS || 168);
    const cutoff = now - (Number.isFinite(configured) && configured >= 1 ? configured : 168) * 3600000;
    const names = await readdir(this.directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    let removed = 0;
    for (const name of names) {
      const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(xlsx|xls|csv)(\.part)?$/.exec(name);
      if (!match) continue;
      await domainWrite(() => this.service.db.sequelize.transaction(async transaction => {
        await this.service.lock([`batch:${match[1]}`], transaction);
        const file = path.join(this.directory, name); const stat = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!stat?.isFile() || stat.mtimeMs >= cutoff) return;
        const reference = await this.service.model('import_batches').findOne({ where: { storage_key: name.replace(/\.part$/, '') }, ...writeOptions(transaction) });
        // Associated originals are retained, even for committed/cancelled batches.
        if (reference && !match[3]) return;
        await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); removed++;
      }));
    }
    return { removed };
  }
  async close() { this.stopping = true; await this.parser.close(); await this.queue; }
  async retryParse(payload: any, transaction: any, actor: string) {
    assertImportKeys(payload, ['batch_id', 'technical_revision']);
    await this.service.lock([`batch:${uuid(payload.batch_id, 'batch_id')}`], transaction);
    const batch = await this.batch(payload.batch_id, actor, transaction);
    this.service.revision(batch, payload.technical_revision);
    if (batch.get('status') !== 'failed') throw new FinanceError('BATCH_NOT_FAILED', '仅解析失败的批次可重试解析', 'batch_id', 409);
    await batch.update({ status: 'parsing', technical_revision: batch.get('technical_revision') + 1 }, writeOptions(transaction));
    return { batch_id: batch.id };
  }
  async cancel(payload: any, transaction: any, actor: string) {
    assertImportKeys(payload, ['batch_id', 'technical_revision']);
    await this.service.lock([`batch:${uuid(payload.batch_id, 'batch_id')}`], transaction);
    const batch = await this.batch(payload.batch_id, actor, transaction);
    if (batch.get('status') === 'committed') throw new FinanceError('BATCH_COMMITTED', '已完成批次不能取消；如需修改，请编辑业务记录或创建新批次', 'batch_id', 409);
    if (batch.get('status') === 'cancelled') return { batch_id: batch.id };
    this.service.revision(batch, payload.technical_revision);
    await batch.update({ status: 'cancelled', preview: null, technical_revision: batch.get('technical_revision') + 1 }, writeOptions(transaction));
    return { batch_id: batch.id };
  }
  async list(actor: string, page = 1, pageSize = 20) {
    const size = Math.min(100, Math.max(1, pageSize));
    const { count, rows } = await this.service.model('import_batches').findAndCountAll({ where: { owner_id: actor }, attributes: ['id', 'data_type', 'status', 'original_name', 'created_at', 'updated_at', 'technical_revision'], order: [['created_at', 'DESC']], limit: size, offset: (Math.max(1, page) - 1) * size });
    return { count, rows: rows.map(plain) };
  }
  async download(ctx: any, id: string, actor: string) {
    const batch = await this.batch(id, actor);
    const stream = createReadStream(path.join(this.directory, batch.get('storage_key')));
    try { await once(stream, 'open'); }
    catch { throw new FinanceError('FILE_UNAVAILABLE', '原文件暂不可用，请检查批次上传状态', 'batch_id', 404); }
    ctx.withoutDataWrapping = true; ctx.body = stream; ctx.type = 'application/octet-stream';
    ctx.attachment(batch.get('original_name')); ctx.set('Cache-Control', 'private, no-store'); ctx.set('X-Content-Type-Options', 'nosniff');
  }
  async view(id: string, actor: string, transaction?: any) {
    const batch = plain(await this.batch(id, actor, transaction));
    delete batch.storage_key;
    const rows = await this.service.model('import_rows').findAll({ where: { batch_id: id }, order: [['row_index', 'ASC']], ...writeOptions(transaction) });
    return { batch, rows: rows.map(plain) };
  }
  checkParserVersion(batch: any) {
    if (batch.get('context').parser_version !== IMPORT_PARSER_VERSION) throw new FinanceError('PARSER_UPDATE_REQUIRED', '解析规则已更新，请下载原文件并创建新批次重新核对；原批次及纠错记录保留', 'batch_id', 409);
  }
  async preview(payload: any, transaction: any, actor: string) {
    assertImportKeys(payload, ['batch_id', 'technical_revision', 'mapping', 'corrections']);
    const { batch_id, technical_revision, mapping, corrections = [] } = payload;
    await this.service.lock([`batch:${uuid(batch_id, 'batch_id')}`], transaction);
    const batch = await this.batch(batch_id, actor, transaction);
    this.service.revision(batch, technical_revision);
    if (batch.get('status') === 'committed') throw new FinanceError('BATCH_COMMITTED', '该批次已经提交', 'batch_id', 409);
    if (!['staged', 'ready', 'needs_correction'].includes(batch.get('status'))) throw new FinanceError('BATCH_NOT_EDITABLE', '批次尚未解析完成或已取消，不能预览', 'batch_id', 409);
    this.checkParserVersion(batch);
    if (batch.get('data_type') === 'exchange') {
      await new MainExchangeImports(this.service).preview(batch, mapping, corrections, transaction);
      return this.view(batch_id, actor, transaction);
    }
    if (mainImportTypes.includes(batch.get('data_type'))) {
      await new MainImports(this.service).preview(batch, mapping, corrections, transaction);
      return this.view(batch_id, actor, transaction);
    }
    if (batch.get('data_type') === 'transactions') {
      await new TradeImports(this.service).preview(batch, mapping, corrections, transaction);
      return this.view(batch_id, actor, transaction);
    }
    await new SeriesImports(this.service).preview(batch, mapping, corrections, transaction);
    return this.view(batch_id, actor, transaction);
  }
  async commit(payload: any, transaction: any, actor: string) {
    assertImportKeys(payload, ['batch_id', 'technical_revision', 'preview_token']);
    const { batch_id, technical_revision, preview_token } = payload;
    await this.service.lock([`batch:${uuid(batch_id, 'batch_id')}`], transaction);
    const batch = await this.batch(batch_id, actor, transaction);
    if (batch.get('status') === 'committed') return batch.get('result');
    this.checkParserVersion(batch);
    this.service.revision(batch, technical_revision);
    const preview = batch.get('preview');
    if (batch.get('status') !== 'ready' || preview?.token !== preview_token) throw new FinanceError('PREVIEW_REQUIRED', '请先修正错误并重新生成预览', 'preview_token', 409);
    if (preview.rules_revision !== await new FinanceOptions(this.service).revision(transaction)) throw new FinanceError('PREVIEW_STALE', '字段配置已变化，请重新预览', 'batch_id', 409);
    if (batch.get('data_type') === 'exchange') return new MainExchangeImports(this.service).commit(batch, transaction);
    if (mainImportTypes.includes(batch.get('data_type'))) return new MainImports(this.service).commit(batch, transaction);
    if (batch.get('data_type') === 'transactions') return new TradeImports(this.service).commit(batch, transaction);
    return new SeriesImports(this.service).commit(batch, transaction);
  }
}
