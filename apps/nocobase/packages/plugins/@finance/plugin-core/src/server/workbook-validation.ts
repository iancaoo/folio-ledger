import * as XLSX from 'xlsx';
import { Decimal, FinanceError } from '../shared/values';

// This checks a deliberately small, deterministic formula language. It never
// executes workbook code, retrieves links or claims to implement Excel fully.
export function verifyWorkbookCells(book: XLSX.WorkBook, sheetName: string, rawNumbers: Record<string, string>, isLegacy: boolean) {
  const sheet = book.Sheets[sheetName]; const cache = new Map<string, any>(); const visiting = new Set<string>();
  let steps = 0; let formulaCount = 0; let numericCount = 0; const checked = new Set<string>();
  const problem = (code: string, message: string, address: string): never => {
    throw new FinanceError(code, `${sheetName}!${address}：${message}`, 'file', 422, { sheet: sheetName, cell: address });
  };
  const budget = (address: string) => { if (++steps > 200000) problem('FORMULA_LIMIT', '公式引用过多，请在表格软件中重新计算后转为数值文件上传', address); };
  const literal = (address: string, cell: any) => {
    const text = rawNumbers[address] ?? String(cell.v);
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(cell.v)) problem('INVALID_NUMERIC_CELL', '数值不是有限数字，请核对原文件', address);
    const value = new Decimal(text.replace(/^\+/, ''));
    if (Math.abs(value.e) > 1000) problem('NUMERIC_CELL_LIMIT', '数值指数过大，请核对原文件中的金额或比例', address);
    if (isLegacy && (value.c.length > 15 || value.abs().gte('1000000000000000'))) problem('XLS_PRECISION_RISK', 'XLS 数字单元格超过可可靠核对的 15 位范围。请从原始精确数据重新填写为文本；仅改显示格式不能恢复已丢失的位数', address);
    return value;
  };
  const numeric = (address: string, depth = 0): any => {
    budget(address); address = address.replace(/\$/g, '').toUpperCase();
    if (cache.has(address)) return cache.get(address);
    if (depth > 32 || visiting.has(address)) problem('FORMULA_CYCLE', '公式循环引用或层级过深，请重新计算并转为数值文件', address);
    const cell = sheet[address];
    if (!cell) problem('FORMULA_REFERENCE', '公式引用了没有可核对数值的单元格，请转为数值文件', address);
    if ((cell.f || cell.F) && (cell.v === undefined || cell.v === null)) problem('FORMULA_CACHE_MISSING', '公式没有可核验的缓存值，请重新计算后转为数值文件', address);
    if (cell.t === 'e') problem('EXCEL_CELL_ERROR', `单元格含错误 ${cell.w || cell.v}，请修正原文件`, address);
    if (cell.t !== 'n' || cell.v === null || cell.v === undefined) problem(cell.f || cell.F ? 'FORMULA_CACHE_MISSING' : 'FORMULA_REFERENCE', '缺少可核验的数值缓存或引用值，请重新计算后转为数值文件', address);
    const stored = literal(address, cell);
    if (cell.f || cell.F) {
      if (cell.F) problem('FORMULA_UNSUPPORTED', '数组或动态数组公式尚不能独立核验，请重新计算后转为数值文件', address);
      visiting.add(address);
      try {
        const computed = evaluate(String(cell.f), address, depth + 1);
        // Excel stores numeric caches as binary doubles. Compare at Excel's
        // 15 significant-digit precision, then retain the file's cache lexeme.
        if (!computed.prec(15).eq(stored.prec(15))) problem('FORMULA_CACHE_MISMATCH', '公式缓存与当前引用值不一致，请在表格软件中重新计算并保存，或上传已转数值文件', address);
      } finally { visiting.delete(address); }
    }
    cache.set(address, stored); return stored;
  };
  function evaluate(formula: string, address: string, depth: number) {
    if (formula.length > 4096) problem('FORMULA_LIMIT', '公式过长，请重新计算后转为数值文件', address);
    const input = formula.replace(/^=/, ''); let at = 0;
    const tokens: string[] = [];
    while (at < input.length) {
      if (/\s/.test(input[at])) { at++; continue; }
      const match = /^(?:\$?[A-Za-z]{1,3}\$?[1-9]\d*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|SUM\b|[()+\-*/%,:])/i.exec(input.slice(at));
      if (!match || tokens.length > 1024) problem('FORMULA_UNSUPPORTED', '仅能核验本表数值引用、加减乘除、百分号和 SUM；请将其他公式重新计算后转为数值文件', address);
      tokens.push(match[0].toUpperCase()); at += match[0].length;
    }
    let index = 0; let nesting = 0;
    const bounded = (value: any) => {
      if (Math.abs(value.e) > 1000 || value.c.length > 8192) problem('FORMULA_LIMIT', '公式数值范围过大，请核对并转为数值文件', address);
      return value;
    };
    const take = (expected: string) => { if (tokens[index++] !== expected) problem('FORMULA_UNSUPPORTED', '公式语法不能核验，请重新计算后转为数值文件', address); };
    const ref = (token: string) => /^\$?[A-Z]{1,3}\$?[1-9]\d*$/.test(token || '');
    function primary(): any {
      budget(address);
      if (++nesting > 32) problem('FORMULA_LIMIT', '公式嵌套过深，请转为数值文件', address);
      const token = tokens[index++]; let value: any;
      if (token === '+' || token === '-') { value = primary(); if (token === '-') value = value.times('-1'); }
      else if (token === '(') { value = expression(); take(')'); }
      else if (token === 'SUM') {
        take('('); value = new Decimal('0');
        do {
          if (ref(tokens[index]) && tokens[index + 1] === ':') {
            const start = XLSX.utils.decode_cell(tokens[index++].replace(/\$/g, '')); index++;
            if (!ref(tokens[index])) problem('FORMULA_UNSUPPORTED', 'SUM 范围无效，请转为数值文件', address);
            const end = XLSX.utils.decode_cell(tokens[index++].replace(/\$/g, ''));
            if (end.r < start.r || end.c < start.c || (end.r - start.r + 1) * (end.c - start.c + 1) > 10000) problem('FORMULA_LIMIT', 'SUM 范围过大或无效，请转为数值文件', address);
            for (let r = start.r; r <= end.r; r++) for (let c = start.c; c <= end.c; c++) value = bounded(value.plus(numeric(XLSX.utils.encode_cell({ r, c }), depth)));
          } else value = bounded(value.plus(expression()));
          if (tokens[index] !== ',') break; index++;
        } while (true);
        take(')');
      } else if (ref(token)) value = numeric(token, depth);
      else if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?$/.test(token || '')) value = new Decimal(token);
      else problem('FORMULA_UNSUPPORTED', '公式内容不能核验，请重新计算后转为数值文件', address);
      while (tokens[index] === '%') { index++; value = value.times('0.01'); }
      nesting--; return bounded(value);
    }
    function product(): any {
      let value = primary();
      while (tokens[index] === '*' || tokens[index] === '/') {
        const operation = tokens[index++]; const next = primary();
        if (operation === '/' && next.eq('0')) problem('FORMULA_CACHE_MISMATCH', '公式当前除数为零，缓存不可用，请修正原文件', address);
        const result = bounded(operation === '*' ? value.times(next) : value.div(next));
        // A rounded intermediate division can falsely validate a stale cache,
        // especially after cancellation or underflow to zero. Accept only an
        // exact quotient within our decimal policy; otherwise require values.
        if (operation === '/' && !result.times(next).eq(value)) problem('FORMULA_PRECISION_UNVERIFIED', '该除法无法在支持的精度内精确核验，请重新计算后转为数值文件', address);
        value = result;
      }
      return value;
    }
    function expression(): any {
      let value = product();
      while (tokens[index] === '+' || tokens[index] === '-') { const operation = tokens[index++]; const next = product(); value = bounded(operation === '+' ? value.plus(next) : value.minus(next)); }
      return value;
    }
    const result = expression(); if (index !== tokens.length) problem('FORMULA_UNSUPPORTED', '公式存在不支持的运算，请重新计算后转为数值文件', address);
    return result;
  }
  for (const address of Object.keys(sheet).filter(key => /^[A-Z]+\d+$/.test(key))) {
    const cell = sheet[address];
    if ((cell.f || cell.F) && (cell.v === undefined || cell.v === null)) problem('FORMULA_CACHE_MISSING', '公式没有可核验的缓存值，请重新计算后转为数值文件', address);
    if (cell.t === 'e') problem('EXCEL_CELL_ERROR', `单元格含错误 ${cell.w || cell.v}，请修正原文件`, address);
    if (cell.f || cell.F) {
      numeric(address); if (!checked.has(address)) { checked.add(address); formulaCount++; }
    }
    if (cell.t === 'n') { literal(address, cell); numericCount++; }
  }
  return { formula_count: formulaCount, numeric_cell_count: numericCount, notes: [
    ...(formulaCount ? [`已核验 ${formulaCount} 个公式缓存，保存文件中现有缓存数值，不将公式写入业务字段。`] : []),
    ...(isLegacy && numericCount ? ['XLS 数字按文件保存的双精度值读取，无法恢复 Excel 先前舍弃的位数。金额、份额及比例需要更多精度时，请从原始资料填写文本单元格。'] : []),
  ] };
}
