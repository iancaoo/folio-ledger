import path from 'node:path';
import * as XLSX from 'xlsx';
import { Decimal, FinanceError } from '../shared/values';
import { exchangeFormat, exchangeSheet, exportColumns } from '../shared/export';
import { verifyWorkbookCells } from './workbook-validation';
import { IMPORT_PARSER_VERSION } from '../shared/import-file';
export { IMPORT_PARSER_VERSION } from '../shared/import-file';

const attr = (xml: string, name: string) => new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`).exec(xml)?.[1];

/** Keep the OOXML decimal lexeme before SheetJS's numeric JS representation. */
function originalNumbers(book: any): Record<string, string> {
  if (!book.files) return {};
  const xml = (name: string) => {
    const content = book.files[name]?.content;
    return content ? typeof content === 'string' ? content : Buffer.from(content).toString('utf8') : '';
  };
  const first = /<sheet\s[^>]*>/.exec(xml('xl/workbook.xml'))?.[0];
  const id = first && attr(first, 'r:id');
  const relationship = [...xml('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\s[^>]*>/g)].find(match => attr(match[0], 'Id') === id)?.[0];
  const target = relationship && attr(relationship, 'Target');
  if (!target) return {};
  const sheetPath = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${target}`);
  const result: Record<string, string> = {};
  for (const match of xml(sheetPath).matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const reference = attr(match[1], 'r');
    const type = attr(match[1], 't');
    const value = /<v(?:\s[^>]*)?>([^<]*)<\/v>/.exec(match[2])?.[1];
    if (reference && (!type || type === 'n') && value !== undefined) result[reference] = value;
  }
  return result;
}

export function parseUpload(filename: string, bytes: Buffer) {
  const extension = path.extname(filename).toLowerCase();
  if (!['.xlsx', '.xls', '.csv'].includes(extension)) throw new FinanceError('UNSUPPORTED_FILE', '请选择 xlsx、xls 或 CSV 文件', 'file');
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new FinanceError('FILE_SIZE', '文件应介于 1 字节和 10 MB 之间', 'file');
  let book: XLSX.WorkBook;
  try {
    const input = extension === '.csv' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes;
    book = XLSX.read(input, { type: extension === '.csv' ? 'string' : 'buffer', raw: true, cellDates: false, cellFormula: true, sheetStubs: true, cellNF: true, bookFiles: true, sheetRows: 10002 });
  }
  catch { throw new FinanceError('INVALID_WORKBOOK', '无法读取文件，请检查文件是否损坏或受密码保护', 'file'); }
  const sheetName = book.SheetNames[0];
  const sheet = book.Sheets[sheetName];
  if (!sheet?.['!ref']) throw new FinanceError('EMPTY_FILE', '首工作表没有数据', 'file');
  const range = XLSX.utils.decode_range(sheet['!fullref'] || sheet['!ref']);
  if (range.e.r > 10000 || range.e.c > 99) throw new FinanceError('IMPORT_LIMIT', '单批最多 10,000 条数据和 100 列', 'file');
  const rawNumbers = originalNumbers(book);
  const diagnostics = verifyWorkbookCells(book, sheetName, rawNumbers, extension === '.xls');
  const valueAt = (r: number, c: number) => {
    const address = XLSX.utils.encode_cell({ r, c });
    const cell = sheet[address];
    if (!cell || cell.v === undefined || cell.v === null) return '';
    if (cell.t === 'e') return `#单元格错误:${cell.w || cell.v}`;
    if (cell.t === 'n') {
      if (XLSX.SSF.is_date(cell.z || '')) {
        const date = XLSX.SSF.parse_date_code(cell.v, { date1904: book.Workbook?.WBProps?.date1904 });
        return date ? `${date.y.toString().padStart(4, '0')}-${date.m.toString().padStart(2, '0')}-${date.d.toString().padStart(2, '0')}` : '#日期错误';
      }
      const literal = rawNumbers[address] ?? String(cell.v);
      return new Decimal(literal).toFixed();
    }
    return String(cell.v);
  };
  const headers = Array.from({ length: range.e.c + 1 }, (_, c) => valueAt(0, c).trim());
  if (headers.some(header => !header) || new Set(headers).size !== headers.length) throw new FinanceError('INVALID_HEADERS', '首行表头不能为空或重复，请先修正文件', 'file');
  let exchange: { format: string; table: string } | null = null;
  if (book.Sheets[exchangeSheet]) {
    const entries = XLSX.utils.sheet_to_json<any[]>(book.Sheets[exchangeSheet], { header: 1, raw: true });
    const metadata = Object.fromEntries(entries.filter(row => row.length === 2).map(row => [String(row[0]), String(row[1])]));
    if (metadata.format !== exchangeFormat) throw new FinanceError('INVALID_EXCHANGE', '交换文件格式版本无效，请重新导出', 'file');
    const expected = exportColumns(metadata.table).map(column => column.label);
    if (headers.length !== expected.length || expected.some(label => !headers.includes(label))) throw new FinanceError('INVALID_EXCHANGE', '交换文件的字段列已被增删或改名，请保留原字段列后重试', 'file');
    exchange = { format: metadata.format, table: metadata.table };
  } else if (sheetName === '业务数据' && headers.some(header => header.endsWith('（created_at）') || header === '主体 ID（entity_id）') && headers.some(header => header.endsWith('（id）') || header === '份额 ID（share_class_id）')) {
    throw new FinanceError('EXCHANGE_METADATA_MISSING', '交换文件缺少 Finance交换信息 工作表，不能确定空值和只读字段语义，请使用完整导出文件', 'file');
  }
  const rows = [];
  for (let r = 1; r <= range.e.r; r++) {
    const raw = Object.fromEntries(headers.map((header, c) => [header, valueAt(r, c)]));
    if (Object.values(raw).every(value => value === '')) continue;
    rows.push({ source_row: r + 1, source_sheet: sheetName, raw });
  }
  if (!rows.length) throw new FinanceError('EMPTY_FILE', '表头下没有可导入数据', 'file');
  return { headers, rows, sheet_name: sheetName, ignored_sheets: book.SheetNames.slice(1), exchange, diagnostics, parser_version: IMPORT_PARSER_VERSION };
}

