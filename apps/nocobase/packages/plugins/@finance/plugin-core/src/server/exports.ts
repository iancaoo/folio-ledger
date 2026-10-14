import { createHash } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import * as XLSX from 'xlsx';
import { cddDeadline, dateOnly, FinanceError } from '../shared/values';
import { exchangeFormat, exchangeSheet, exchangeText, exportColumns, exportTitle, ExportColumn } from '../shared/export';
import { FinanceService, uuid } from './service';
import { FinanceQueries } from './queries';

const fundJoin = ' JOIN finance_funds f ON f.id=t.fund_id';
const shareJoin = ' JOIN finance_share_classes s ON s.id=t.share_class_id JOIN finance_funds f ON f.id=s.fund_id';
const entityJoin = ' JOIN finance_investment_entities e ON e.id=t.entity_id JOIN finance_client_groups g ON g.id=e.client_group_id';
const fundExtra = ',f.short_name AS _fund_name';
const shareExtra = `${fundExtra},s.isin AS _isin,s.currency AS _currency`;
const entityExtra = ',e.legal_name AS _entity_name,g.client_code AS _client_code';
const definitions: Record<string, any> = {
  funds: { fund: 't.id', state: 't.is_deleted', kind: 't.fund_kind' },
  share_classes: { join: fundJoin, select: fundExtra, fund: 't.fund_id', share: 't.id', state: '(t.is_deleted OR f.is_deleted)', kind: 'f.fund_kind' },
  third_party_fund_details: { join: fundJoin, select: fundExtra, fund: 't.fund_id', state: 'f.is_deleted' },
  proprietary_fund_details: { join: fundJoin, select: fundExtra, fund: 't.fund_id', state: 'f.is_deleted' },
  third_party_class_terms: { join: shareJoin, select: shareExtra, fund: 'f.id', share: 's.id', state: '(s.is_deleted OR f.is_deleted)' },
  proprietary_class_terms: { join: shareJoin, select: shareExtra, fund: 'f.id', share: 's.id', state: '(s.is_deleted OR f.is_deleted)' },
  client_groups: {},
  investment_entities: { join: ' JOIN finance_client_groups g ON g.id=t.client_group_id', select: ',g.client_code AS _client_code', entity: 't.id', state: 't.is_deleted' },
  entity_agreements: { join: entityJoin, select: entityExtra, entity: 'e.id', state: 'e.is_deleted' },
  entity_products: { join: entityJoin, select: entityExtra, entity: 'e.id', state: 'e.is_deleted' },
  transactions: { join: shareJoin + entityJoin, select: shareExtra + entityExtra, fund: 'f.id', share: 's.id', entity: 'e.id', state: 't.is_void', date: 't.confirmation_date' },
  fund_navs: { join: shareJoin, select: shareExtra, fund: 'f.id', share: 's.id', date: 't.nav_date' },
  fund_returns: { join: shareJoin, select: shareExtra, fund: 'f.id', share: 's.id', date: 't.return_date' },
  composition_snapshots: { join: ' JOIN finance_funds f ON f.id=t.parent_fund_id', select: fundExtra, fund: 'f.id', date: 't.valuation_date' },
  composition_items: { join: ' JOIN finance_composition_snapshots c ON c.id=t.snapshot_id JOIN finance_funds f ON f.id=c.parent_fund_id JOIN finance_share_classes s ON s.id=t.child_share_class_id', select: shareExtra + ',f.id AS _parent_id', fund: 'f.id', share: 's.id', date: 'c.valuation_date' },
  benchmarks: { benchmark: 't.id' },
  benchmark_values: { join: ' JOIN finance_benchmarks b ON b.id=t.benchmark_id', select: ',b.name AS _benchmark_name', benchmark: 'b.id', date: 't.value_date' },
  fund_documents: { join: fundJoin, select: fundExtra, fund: 'f.id' },
};

export class FinanceExports {
  constructor(public service: FinanceService) {}
  async download(input: any) {
    const allowed = ['table', 'fund_id', 'share_class_id', 'entity_id', 'benchmark_id', 'date_from', 'date_to', 'state', 'fund_kind', 'as_of'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new FinanceError('INVALID_EXPORT_FILTER', '导出只接受已提供的业务筛选，不能指定任意查询或分页');
    const table = input.table; const columns = exportColumns(table);
    const definition = definitions[table]; const where = ['TRUE']; const params: any = {};
    if (table !== 'positions') {
      if (input.as_of) throw new FinanceError('INVALID_EXPORT_FILTER', '截止日期仅适用于持仓核对', 'as_of');
      for (const [key, column] of Object.entries({ fund_id: definition.fund, share_class_id: definition.share, entity_id: definition.entity, benchmark_id: definition.benchmark })) if (input[key]) {
        if (!column) throw new FinanceError('INVALID_EXPORT_FILTER', '此表不支持该关联筛选', key);
        params[key] = uuid(input[key], key); where.push(`${column}=:${key}`);
      }
      for (const [key, operator] of [['date_from', '>='], ['date_to', '<=']]) if (input[key]) {
        if (!definition.date) throw new FinanceError('INVALID_EXPORT_FILTER', '此表没有可筛选的业务日期', key);
        params[key] = dateOnly(input[key], key, true); where.push(`${definition.date}${operator}:${key}`);
      }
      if (params.date_from && params.date_to && params.date_from > params.date_to) throw new FinanceError('INVALID_DATE_ORDER', '开始日期不能晚于结束日期');
      if (input.state && input.state !== 'all') {
        if (!definition.state || !['active', 'inactive'].includes(input.state)) throw new FinanceError('INVALID_EXPORT_FILTER', '此表不支持该状态筛选', 'state');
        where.push(`${definition.state}=${input.state === 'inactive' ? 'TRUE' : 'FALSE'}`);
      }
      if (input.fund_kind) {
        if (!definition.kind || !['third_party', 'proprietary'].includes(input.fund_kind)) throw new FinanceError('INVALID_EXPORT_FILTER', '此表不支持该基金类型筛选', 'fund_kind');
        params.kind = input.fund_kind; where.push(`${definition.kind}=:kind`);
      }
    } else if (['date_from', 'date_to', 'state', 'fund_kind', 'benchmark_id'].some(key => input[key])) throw new FinanceError('INVALID_EXPORT_FILTER', '持仓只支持主体、基金、份额及截止日期筛选');
    return this.service.db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async transaction => {
      const sql = (text: string, bind = params): Promise<any[]> => this.service.db.sequelize.query(text, { replacements: bind, transaction, type: QueryTypes.SELECT });
      const [{ snapshot }] = await sql('SELECT transaction_timestamp()::text AS snapshot');
      const asOf = table === 'positions' ? dateOnly(input.as_of || new Date().toISOString().slice(0, 10), 'as_of', true) : null;
      const parts: Array<{ name: string; bytes: Buffer; count: number; sha256: string }> = [];
      const buffer: any[] = []; let count = 0;
      const flush = (rows: any[]) => {
        const bytes = this.workbook(table, columns, rows, { format: exchangeFormat, table, snapshot, as_of: asOf, filters: input, count: rows.length, part: parts.length + 1 });
        // Every part fits the existing upload limit. Never truncate a row or the result set.
        if (bytes.length > 10 * 1024 * 1024) {
          if (rows.length < 2) throw new FinanceError('EXPORT_ROW_SIZE', '单条记录超过 10 MB，无法生成可再次上传的 Excel 文件');
          const middle = Math.ceil(rows.length / 2); flush(rows.slice(0, middle)); flush(rows.slice(middle)); return;
        }
        parts.push({ name: `Finance-${table}-${String(parts.length + 1).padStart(4, '0')}.xlsx`, bytes, count: rows.length, sha256: createHash('sha256').update(bytes).digest('hex') });
      };
      const accept = (row: any) => { buffer.push(row); count++; if (buffer.length === 10000) { flush(buffer.splice(0)); } };
      if (table === 'positions') {
        const result = await new FinanceQueries(this.service).positions({ entity_id: input.entity_id, fund_id: input.fund_id, share_class_id: input.share_class_id, as_of: asOf }, true, transaction);
        for (const row of result.rows) accept(row);
      } else {
        const from = `FROM finance_${table} t${definition.join || ''} WHERE ${where.join(' AND ')}`;
        let after: string | null = null;
        const physical = columns.filter(column => !column.key.startsWith('_') && column.key !== 'next_cdd_deadline').map(column => `t."${column.key}"`).join(',');
        // Keyset pages and all joins use one snapshot, including computed results.
        const compositionCache = new Map<string, any>();
        while (true) {
          const rows = await sql(`SELECT ${physical}${definition.select || ''} ${from}${after ? ' AND t.id>:after' : ''} ORDER BY t.id ASC LIMIT 1000`, { ...params, after });
          if (!rows.length) break;
          for (const row of rows) {
            if (table === 'investment_entities') row.next_cdd_deadline = cddDeadline(row.latest_cdd_approval_date);
            if (table === 'composition_items') {
              if (!compositionCache.has(row._parent_id)) {
                const computed = await this.service.compositionValues(row._parent_id, transaction);
                compositionCache.set(row._parent_id, new Map(computed.compositions.flatMap(list => list.items.map(item => [item.id, { ...item, issues: list.issues }]))));
              }
              const computed = compositionCache.get(row._parent_id).get(row.id);
              Object.assign(row, { _nav_date: computed.nav_date, _nav_per_unit: computed.nav_per_unit, _market_value: computed.market_value, _weight: computed.weight, _issues: computed.issues.map(issue => issue.code).join(' / ') });
            }
            accept(row);
          }
          after = rows[rows.length - 1].id;
        }
      }
      if (buffer.length || !parts.length) flush(buffer);
      if (parts.length === 1) return { bytes: parts[0].bytes, filename: `Finance-${table}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', count, parts: 1 };
      const zip = XLSX.CFB.utils.cfb_new();
      for (const part of parts) XLSX.CFB.utils.cfb_add(zip, part.name, part.bytes);
      XLSX.CFB.utils.cfb_add(zip, 'manifest.json', Buffer.from(JSON.stringify({ format: exchangeFormat, table, snapshot, as_of: asOf, filters: input, count, files: parts.map(({ name, count, sha256 }) => ({ name, count, sha256 })) }, null, 2)));
      return { bytes: XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip', compression: true }), filename: `Finance-${table}.zip`, contentType: 'application/zip', count, parts: parts.length };
    });
  }
  workbook(table: string, columns: ExportColumn[], rows: any[], metadata: any): Buffer {
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([columns.map(column => column.label), ...rows.map(row => columns.map(column => exchangeText(row[column.key])))]);
    sheet['!cols'] = columns.map(() => ({ wch: 26 }));
    sheet['!autofilter'] = { ref: sheet['!ref']! };
    XLSX.utils.book_append_sheet(book, sheet, '业务数据');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['字段名', '内部字段', '原始类型', '用途', '单位或格式'],
      ...columns.map(column => [column.label, column.key, column.type, column.role === 'readonly' ? '只读核对，不能覆盖事实' : column.role === 'identity' ? '稳定标识，不用于创建新 ID' : '业务事实', column.unit]),
    ]), '字段说明');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ['说明'], [`${exportTitle(table)}；${rows.length} 条。此文件用于业务数据核对，不是客户报告或数据库备份。`],
      ['所有单元格均为文本。不要把金额、份额、比例、编号转换为 Excel 数字。日期为 YYYY-MM-DD；时间为 UTC。'],
      ['空值写为 \\N；空字符串保留为空单元格；原文本以反斜杠开头时增加一个反斜杠。保留交换信息工作表才能正确识别这些语义。'],
      ['比例值 0.02 表示 2%。只读计算值、系统状态、来源和修订号不能作为事实列导入。'],
      ['默认导出全部状态，已删除、停用及撤销记录仍保留。文档导出仅含元数据，原文件仍从文档页面受控下载。'],
      ['18 个业务表支持交换格式再导入，选择“业务交换文件”自动识别。持仓是只读结果，不能导入。'],
      ['保留 ID 及固定关联；只修改选中行，未选中及文件外记录继续保留。基金每次明确保存增加一个资料版本，成分先核对完整差异；已撤销交易仅核对。大文件需先解压，逐个核对并导入。'],
    ]), '使用说明');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(Object.entries(metadata).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)])), exchangeSheet);
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
  }
}
