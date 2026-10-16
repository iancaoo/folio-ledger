/** "YYYY-MM"; string order equals calendar order. */
export type Month = string;

const pad = (value: number) => String(value).padStart(2, '0');
export const toMonth = (isoDate: string): Month => isoDate.slice(0, 7);
export const monthParts = (m: Month) => m.split('-').map(Number) as [number, number];
export const monthStart = (m: Month) => `${m}-01`;
export function monthEnd(m: Month) {
  const [year, month] = monthParts(m);
  return `${m}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
}
export function nextMonth(m: Month): Month {
  const [year, month] = monthParts(m);
  return month === 12 ? `${year + 1}-01` : `${year}-${pad(month + 1)}`;
}
export function monthRange(start: Month, end: Month): Month[] {
  const out: Month[] = [];
  for (let m = start; m <= end; m = nextMonth(m)) out.push(m);
  return out;
}
export const monthLabel = (m: Month) => { const [year, month] = monthParts(m); return `${year}年${month}月`; };
export const dayNumber = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`) / 86400000;

export class Return {
  value: number | null; lo: number | null; hi: number | null; point: number | null; estimate: boolean; source: string;
  constructor(init: Partial<Return>) {
    this.value = init.value ?? null; this.lo = init.lo ?? null; this.hi = init.hi ?? null; this.point = init.point ?? null;
    this.estimate = init.estimate ?? false; this.source = init.source ?? '';
  }
  get isRange() { return this.value === null && this.lo !== null && this.hi !== null; }
  get midpoint() { return this.isRange ? (this.lo! + this.hi!) / 2 : null; }
  /** Rate used to roll a NAV forward: actual > point estimate > range midpoint. */
  get used() { return this.value ?? this.point ?? this.midpoint!; }
  describe() { return this.isRange ? `${pct(this.lo)}~${pct(this.hi)}` : this.value === null ? '—' : pct(this.value); }
}

export type Nav = { value: number; source: '对账单' | '推算' | '缺失'; estimate?: boolean };
export type Fund = { key: string; nameT1: string; nameT3: string; risk: string; region: string; strategy: string; kind: string; currency: string; order: number };

export type Dataset = {
  client: string; clientCode: string; entityId: string; asOf: Month;
  funds: Record<string, Fund>; benchmarks: string[];
  returns: Record<string, Record<Month, Return>>;
  navs: Record<string, Record<Month, Nav>>;
  flows: Record<string, Record<Month, number>>;
  /** [source, table, tag, count]; tag is 模拟 or 推算. */
  provenance: Array<[string, string, string, number]>;
  /** Currencies seen in held share classes and their trades. */
  currencies: string[];
  /** Where each input value came from, for the calculation trace. */
  lineage?: Lineage;
};
/** Finance record locator: record id (or business key), column, and the import batch row it came from. */
export type Src = Record<string, string | number | null>;
export type Lineage = {
  trades: Record<string, Array<{ month: Month; sign: number; kind: string; amount: number; units: number; date: string; src_amount: Src; src_units: Src }>>;
  prices: Record<string, Record<Month, { value: number; src: Src }>>;
  returns: Record<string, Record<Month, Record<string, Src>>>;
  bench_levels: Record<string, Array<[Month, number, Src]>>;
  tags: Record<string, Record<string, Src & { value: string | null }>>;
};
export const fundKeys = (ds: Dataset) => Object.keys(ds.funds).sort((a, b) => ds.funds[a].order - ds.funds[b].order);

// Text formatting mirrors the Python prototype (`:.2%`, `:,.0f`) so both outputs read the same.
export const pct = (value: number | null | undefined, digits = 2) => value === null || value === undefined ? '' : `${(value * 100).toFixed(digits)}%`;
export const signed = (value: number, digits = 2) => `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
export function money(value: number | null | undefined) {
  if (value === null || value === undefined) return '';
  const [whole] = value.toFixed(0).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
