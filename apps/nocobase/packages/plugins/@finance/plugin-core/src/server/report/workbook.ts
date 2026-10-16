/**
 * Review workbook: the stored calculation trace laid out as an Excel file with live formulas.
 *
 * Every trace leaf is a row on 原始数据; every computed node is a row on 计算步骤 whose formula references the
 * rows of its inputs, next to the value the system stored and the difference. Formula cells carry no cached
 * value and the workbook asks for a full recalculation on open, so what the reviewer sees is Excel's own result.
 */
import * as XLSX from 'xlsx';
import { traceFormulaText, traceSourceText, TRACE_TABLE_NAMES } from '../../shared/trace-source';
import { monthLabel } from './model';
import { findingKey, REVIEW_STATUS_LABEL } from '../../shared/report-review';
import { Trace, TraceNode } from './trace';

export type WorkbookInfo = { report_month: string; status: string; engine_version: string; snapshot_at: string | Date | null; snapshot_sha256: string | null; findings?: any[]; finding_reviews?: any; reviewer_names?: Record<string, string> };

const RAW = '原始数据', CALC = '计算步骤', CASH = 'IRR现金流', VIEW = '月度总览', REVIEW = '校验与复核', README = '说明';
const FORMAT: Record<string, string> = { pct: '0.0000%', money: '#,##0.00', units: '#,##0.000000', price: '#,##0.000000', index: '#,##0.0000' };
const STATUS: Record<string, string> = { ready: '已生成，未发布（草稿）', published: '已发布', superseded: '已被新版本替代' };
const TOL = 1e-9;
const XIRR_TOL = 1e-7;

type Cell = XLSX.CellObject;
type Row = Array<Cell | null>;
const str = (v: unknown): Cell => ({ t: 's', v: v === null || v === undefined ? '' : String(v) });
const val = (v: unknown, unit?: string): Cell => typeof v === 'number' ? { t: 'n', v, ...(unit && FORMAT[unit] ? { z: FORMAT[unit] } : {}) } : str(v);
const fx = (f: string, unit?: string): Cell => ({ t: 'z', f, ...(unit && FORMAT[unit] ? { z: FORMAT[unit] } : {}) } as Cell);
const link = (cell: Cell, sheet: string, row: number): Cell => ({ ...cell, l: { Target: `#'${sheet}'!A${row}` } });
const excelDate = (iso: string): Cell => ({ t: 'n', v: (Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000, z: 'yyyy-mm-dd' });

function sheet(rows: Row[], widths: number[], filterRow?: number) {
  const ws: XLSX.WorkSheet = {};
  let cols = 0;
  rows.forEach((row, r) => row.forEach((cell, c) => { if (cell) ws[XLSX.utils.encode_cell({ r, c })] = cell; cols = Math.max(cols, c + 1); }));
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(rows.length - 1, 0), c: Math.max(cols - 1, 0) } });
  ws['!cols'] = widths.map(wch => ({ wch }));
  if (filterRow !== undefined && rows.length > filterRow + 1) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: filterRow, c: 0 }, e: { r: rows.length - 1, c: cols - 1 } }) };
  return ws;
}

export function reviewWorkbook(trace: Trace, info: WorkbookInfo): Buffer {
  const nodes = Object.values(trace.nodes);
  const leaves = nodes.filter(n => n.op === 'leaf'); const calcs = nodes.filter(n => n.op !== 'leaf');
  const HEAD = 1;
  const at = new Map<string, [string, number]>();
  leaves.forEach((n, i) => at.set(n.id, [RAW, HEAD + 1 + i]));
  calcs.forEach((n, i) => at.set(n.id, [CALC, HEAD + 1 + i]));
  const ref = (id: string) => {
    const [s, r] = at.get(id) || (() => { throw new Error(`trace node ${id} has no row`); })();
    return `'${s}'!$${s === RAW ? 'D' : 'F'}$${r}`;
  };
  const label = (id: string) => trace.nodes[id]?.label ?? id;

  // XIRR needs contiguous date and cash-flow ranges, so each IRR node gets its own block.
  const cash: Row[] = [[str('IRR'), str('日期'), str('现金流（投资者视角）'), str('来源')]];
  const xirrRange = new Map<string, string>();
  for (const n of calcs.filter(n => n.op === 'xirr')) {
    const dates: string[] = n.params!.dates; const ins = n.inputs || [];
    const first = cash.length + 1;
    ins.forEach(([role, id], i) => cash.push([str(n.label), excelDate(dates[i]), fx(i < ins.length - 1 ? `-${ref(id)}` : ref(id), 'money'), str(`${role}：${label(id)}`)]));
    const last = cash.length;
    xirrRange.set(n.id, `XIRR('${CASH}'!$C$${first}:$C$${last},'${CASH}'!$B$${first}:$B$${last})`);
    cash.push([]);
  }

  const expr = (n: TraceNode): string => {
    const ins = n.inputs || []; const xs = ins.map(([, id]) => ref(id));
    const one = (role: string) => { const hit = ins.find(([r]) => r === role); return hit ? ref(hit[1]) : '0'; };
    switch (n.op) {
      case 'sum': {
        const c: number[] = n.params?.coeffs || xs.map(() => 1);
        const terms = xs.map((x, i) => c[i] === 1 ? `+${x}` : c[i] === -1 ? `-${x}` : `+${c[i]}*${x}`).join('');
        return terms ? terms.replace(/^\+/, '') : '0';
      }
      case 'mul': return xs.join('*') || '1';
      case 'nav_roll': return `(${one('上月市值')}+${one('本月申赎')})*(1+${one('本月收益率')})`;
      case 'carry': return `${one('上月市值')}+${one('本月申赎')}`;
      case 'dietz': return `(${one('本月总净值')}-${one('上月总净值')}-${one('本月申赎')})/(${one('上月总净值')}+${one('本月申赎')})`;
      case 'chain': return xs.length ? `${xs.map(x => `(1+${x})`).join('*')}-1` : '0';
      case 'ratio': return `${xs[0]}/${xs[1]}`;
      case 'growth': return `${one('本月末点位')}/${one('上月末点位')}-1`;
      case 'select': return xs[n.params!.chosen];
      case 'pick': return n.params!.mode === 'point' && ins.some(([r]) => r === '估算点值') ? one('估算点值') : `(${one('下限')}+${one('上限')})/2`;
      case 'xirr': return xirrRange.get(n.id)!;
      default: throw new Error(`unknown trace op ${n.op}`);
    }
  };

  const raw: Row[] = [[str('编号'), str('项目'), str('标记'), str('值'), str('来源'), str('来源表'), str('记录 ID'), str('日期'), str('字段'), str('导入批次'), str('来源工作表'), str('行号')]];
  for (const n of leaves) {
    const s: any = n.src || {};
    raw.push([str(n.id), str(n.label), str((n.flags || []).join('、')), val(n.value, n.unit), str(traceSourceText(n.src) || '无来源定位'),
      str(TRACE_TABLE_NAMES[s.table] || s.table || ''), str(s.id ?? ''), str(s.date ?? ''), str(s.col ?? ''), str(s.batch ?? ''), str(s.sheet ?? ''), s.row ? val(Number(s.row)) : str('')]);
  }

  const calc: Row[] = [[str('编号'), str('计算项'), str('计算规则'), str('输入'), str('标记'), str('Excel 重算'), str('系统值'), str('差异'), str('结果')]];
  calcs.forEach((n, i) => {
    const r = HEAD + 1 + i; const tol = n.op === 'xirr' ? XIRR_TOL : TOL;
    const inputs = [...(n.inputs || []).map(([role, id], j) => `${role}${n.params?.coeffs?.[j] < 0 ? '（−）' : ''}：${label(id)}`), ...(n.refs || []).map(id => `分类依据：${label(id)}`)];
    calc.push([str(n.id), str(n.label), str(traceFormulaText(trace, n)), str(inputs.join('；')), str((n.flags || []).join('、')),
      fx(expr(n), n.unit), val(n.value, n.unit), fx(`F${r}-G${r}`, n.unit), fx(`IF(ABS(H${r})<=${tol}*MAX(1,ABS(G${r})),"一致","不一致")`)]);
  });

  const o = trace.outputs;
  const cellOf = (id: string | string[] | undefined) => {
    const one = Array.isArray(id) ? id[0] : id;
    if (!one || !at.has(one)) return null;
    const n = trace.nodes[one]; const [s, r] = at.get(one)!;
    return link(fx(ref(one), n.unit), s, r);
  };
  const months = Object.keys(o.total_nav || {}).sort();
  const funds = Object.keys(o.nav || {});
  const view: Row[] = [[str(`${trace.meta.client} · ${monthLabel(trace.meta.as_of)} · 月度总览`)], [str('点击数字跳到对应的计算步骤或原始数据；数字均为公式，随原始数据重算。')], [],
    [str('组合'), str('总净值'), str('当月申赎'), str('月度收益')],
    ...months.map(m => [str(monthLabel(m)), cellOf(o.total_nav[m]), cellOf(o.total_flow[m]), cellOf(o.port_ret?.[m])]),
    [str('YTD'), null, null, cellOf(o.ytd)], [str('IRR（投资以来）'), null, null, cellOf(o.irr)], [],
    [str('基金'), str('持仓比例'), str('总计投资金额'), str('YTD'), str('YTD 上限（区间估算时）')],
    ...funds.map(k => [str(k), cellOf(o.weight?.[k]), cellOf(o.invested?.[k]), cellOf(o.fund_ytd?.[k]), Array.isArray(o.fund_ytd?.[k]) ? cellOf(o.fund_ytd[k][1]) : null]), [],
    [str('基金期末市值'), ...months.map(m => str(monthLabel(m)))], ...funds.map(k => [str(k), ...months.map(m => cellOf(o.nav[k]?.[m]))]), [],
    [str('基金月度收益（计算采用值）'), ...months.map(m => str(monthLabel(m)))], ...funds.map(k => [str(k), ...months.map(m => cellOf(o.ret_cell?.[k]?.[m]))])];

  const review: Row[] = [[str('级别'), str('类别'), str('问题'), str('说明'), str('建议'), str('关联计算'), str('复核结论'), str('复核人'), str('复核说明'), str('复核时间')]];
  const reviewItems = info.finding_reviews?.items || {};
  (trace.findings || []).forEach((f, index) => {
    const pos = f.node ? at.get(f.node) : undefined;
    const source = info.findings?.[index] || f;
    const item = reviewItems[findingKey(index, source)];
    review.push([str(f.level), str(f.category), str(f.title), str(f.detail), str(f.suggestion), pos ? link(str(label(f.node!)), pos[0], pos[1]) : str(''),
      str(item?.status ? REVIEW_STATUS_LABEL[item.status] || '' : ''), str(item ? info.reviewer_names?.[item.by] || '' : ''), str(item?.note || ''), str(item?.at ? new Date(item.at).toISOString() : '')]);
  });

  const counts = (trace.findings || []).reduce<Record<string, number>>((c, f) => ({ ...c, [f.level]: (c[f.level] || 0) + 1 }), {});
  const draft = info.status !== 'published';
  const readme: Row[] = [[str(`投资组合回顾 · 复核工作簿${draft ? '（草稿，未发布）' : ''}`)], [],
    ...([['客户编号', trace.meta.client_code], ['客户', trace.meta.client], ['报告月份', monthLabel(info.report_month)], ['月报状态', STATUS[info.status] || info.status],
      ['计算版本', info.engine_version], ['计算口径', `${trace.meta.rules.id}：${trace.meta.rules.range_value_text}`], ['数据快照时间', info.snapshot_at ? new Date(info.snapshot_at).toISOString() : ''], ['数据快照 SHA-256', info.snapshot_sha256],
      ['原始数据', `${leaves.length} 项`], ['计算步骤', `${calcs.length} 步`], ['校验发现', ['错误', '警告', '提示'].map(l => `${l} ${counts[l] || 0}`).join('，')]] as Array<[string, unknown]>).map(([k, v]) => [str(k), str(v)]),
    [str('Excel 重算与系统值不一致的步骤'), fx(`COUNTIF('${CALC}'!I:I,"不一致")`)], [],
    [str('怎么复核')],
    [str(`1. 「${VIEW}」是月报上的主要数字，点击可跳到计算步骤。`)],
    [str(`2. 「${CALC}」每行一步：F 列是 Excel 按输入重新计算的值，G 列是系统存档值，H 列差异，I 列结果；上方“不一致的步骤”应为 0。`)],
    [str(`3. 「${RAW}」是计算用到的全部 Finance 记录（含记录 ID、导入批次和行号）。改动这里的值，所有依赖它的步骤会重算，可用于试算，不会改动系统数据。`)],
    [str(`4. 「${REVIEW}」中的复核结论取自 Finance 的逐条确认，为导出时的状态；未发布月报的结论可能仍会变化，以系统为准。`)],
    [str('5. 本文件由系统按已存的计算追溯生成，与月报正文、校验报告和数据快照出自同一次计算。')]];

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet(readme, [30, 90]), README);
  XLSX.utils.book_append_sheet(book, sheet(view, [28, ...months.map(() => 16), 16]), VIEW);
  XLSX.utils.book_append_sheet(book, sheet(calc, [34, 34, 46, 60, 14, 18, 18, 12, 8], 0), CALC);
  XLSX.utils.book_append_sheet(book, sheet(raw, [34, 34, 14, 16, 60, 12, 38, 12, 14, 38, 14, 8], 0), RAW);
  XLSX.utils.book_append_sheet(book, sheet(cash, [28, 12, 20, 40]), CASH);
  XLSX.utils.book_append_sheet(book, sheet(review, [8, 12, 40, 60, 40, 30, 14, 10, 40], 0), REVIEW);
  return recalcOnOpen(XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer);
}

/** SheetJS writes no calcPr; ask Excel to recompute every formula when the file is opened. */
function recalcOnOpen(file: Buffer): Buffer {
  const zip = XLSX.CFB.read(file, { type: 'buffer' });
  const entry: any = XLSX.CFB.find(zip, '/xl/workbook.xml');
  const xml = Buffer.from(entry.content).toString('utf8');
  if (!xml.includes('</workbook>') || xml.includes('<calcPr')) throw new Error('unexpected workbook.xml');
  entry.content = Buffer.from(xml.replace('</workbook>', '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>'), 'utf8');
  entry.size = entry.content.length;
  return Buffer.from(XLSX.CFB.write(zip, { fileType: 'zip', type: 'buffer', compression: true }) as any);
}
