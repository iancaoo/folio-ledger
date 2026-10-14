import Big from 'big.js';

// A separate constructor prevents other NocoBase plugins changing our precision policy.
export const Decimal = Big();
// NocoBase's SES lockdown freezes Object.prototype.constructor. Big assigns an
// own constructor on each instance; a writable property on its private prototype
// permits that assignment without weakening SES or changing global intrinsics.
Object.defineProperty(Decimal.prototype, 'constructor', { value: Decimal, writable: true, configurable: true });
Decimal.strict = true;
Decimal.DP = 40;
Decimal.RM = Decimal.roundHalfUp;

export class FinanceError extends Error {
  constructor(
    public code: string,
    message: string,
    public field_path?: string,
    public status = 422,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FinanceError';
  }
}

export function decimal(value: unknown, field: string, options: { required?: boolean; scale?: number; positive?: boolean } = {}) {
  if (value === null || value === undefined || value === '') {
    if (options.required) throw new FinanceError('REQUIRED', '请填写数值', field);
    return null;
  }
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) {
    throw new FinanceError('DECIMAL_STRING_REQUIRED', '请使用有限十进制字符串，不支持浮点数、NaN 或 Infinity', field);
  }
  const raw = value.trim();
  if (options.scale !== undefined && (raw.split('.')[1]?.length || 0) > options.scale) {
    throw new FinanceError('DECIMAL_SCALE', `最多允许 ${options.scale} 位小数，请修正后保存`, field);
  }
  const number = new Decimal(raw.replace(/^\+/, ''));
  if (options.positive && !number.gt('0')) throw new FinanceError('POSITIVE_REQUIRED', '确认份额必须大于 0', field);
  return number.toFixed();
}

export function dateOnly(value: unknown, field: string, required = false): string | null {
  if (value === '' || value === null || value === undefined) {
    if (required) throw new FinanceError('REQUIRED', '请选择日期', field);
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new FinanceError('INVALID_DATE', '日期格式应为 YYYY-MM-DD', field);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value || value.startsWith('0000-')) {
    throw new FinanceError('INVALID_DATE', '日期不存在，请核对年月日', field);
  }
  return value;
}

export function cddDeadline(value: string | null): string | null {
  if (!value) return null;
  dateOnly(value, 'latest_cdd_approval_date', true);
  const [year, month, day] = value.split('-').map(Number);
  const target = new Date(`${String(year + 3).padStart(4, '0')}-${String(month).padStart(2, '0')}-01T00:00:00Z`);
  target.setUTCMonth(target.getUTCMonth() + 1, 0);
  target.setUTCDate(Math.min(day, target.getUTCDate()) - 1);
  return target.toISOString().slice(0, 10);
}

export const TRANSACTION_TYPES = ['初次申购', '追加申购', '赎回'] as const;
export type Trade = {
  id: string; entity_id: string; share_class_id: string; confirmation_date: string;
  transaction_type: string; confirmed_units: string; is_void?: boolean;
};

/** Aggregate by business date before checking; source rows are not intraday chronology. */
export function replayUnits(trades: Trade[]) {
  const accounts = new Map<string, Map<string, { units: Big; ids: string[] }>>();
  for (const trade of trades) {
    if (trade.is_void) continue;
    const key = `${trade.entity_id}:${trade.share_class_id}`;
    if (!TRANSACTION_TYPES.includes(trade.transaction_type as any)) {
      throw new FinanceError('INVALID_TRANSACTION_TYPE', '请选择有效的申赎类型', 'transaction_type');
    }
    dateOnly(trade.confirmation_date, 'confirmation_date', true);
    const units = new Decimal(decimal(trade.confirmed_units, 'confirmed_units', { required: true, positive: true })!);
    const dates = accounts.get(key) || new Map();
    const current = dates.get(trade.confirmation_date) || { units: new Decimal('0'), ids: [] };
    current.units = trade.transaction_type === '赎回' ? current.units.minus(units) : current.units.plus(units);
    current.ids.push(trade.id);
    dates.set(trade.confirmation_date, current);
    accounts.set(key, dates);
  }
  const balances: Record<string, string> = {};
  for (const [key, dates] of accounts) {
    let balance = new Decimal('0');
    for (const date of [...dates.keys()].sort()) {
      balance = balance.plus(dates.get(date)!.units);
      if (balance.lt('0')) {
        throw new FinanceError('NEGATIVE_HISTORICAL_UNITS', `修改后 ${date} 的累计份额为负，整次操作未保存`, 'confirmed_units', 422,
          { account_key: key, conflict_date: date, balance: balance.toFixed(), transaction_ids: dates.get(date)!.ids });
      }
    }
    balances[key] = balance.toFixed();
  }
  return balances;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as any)[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
