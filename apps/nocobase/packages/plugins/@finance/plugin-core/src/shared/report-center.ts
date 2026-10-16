export type ReportTarget =
  | { kind: 'trades'; entity_id: string }
  | { kind: 'positions'; entity_id: string }
  | { kind: 'entity'; entity_id: string }
  | { kind: 'nav'; fund_id: string; share_class_id: string; date: string }
  | { kind: 'return'; share_class_id: string; date: string }
  | { kind: 'fund'; fund_id: string; field: 'allocation_role' | 'investment_region' | 'strategy' }
  | { kind: 'benchmark'; benchmark_id: string | null; date: string }
  | { kind: 'options'; source_key: string };

export type ReadinessItem = {
  code: string;
  level: '错误' | '警告' | '提示';
  category: string;
  title: string;
  detail: string;
  fund?: string;
  month?: string;
  target: ReportTarget | null;
};

export type ReadinessFund = {
  key: string;
  fund_id: string;
  share_class_id: string;
  fund_kind: string;
  currency: string;
  holding: boolean;
  month_nav: boolean;
  month_return: '正式' | '估算' | null;
};

export type ReadinessCounts = { 错误: number; 警告: number; 提示: number };

export type ReadinessResult = {
  status: 'blocked' | 'warning' | 'ready';
  counts: ReadinessCounts;
  items: ReadinessItem[];
  funds: ReadinessFund[];
  forecast: { counts: ReadinessCounts; checks: Array<[string, number]> } | null;
  benchmark_ids_used: string[];
};

export const BOARD_STAGES = ['not_ready', 'failed', 'ready_to_generate', 'not_checked', 'generating', 'review', 'published'] as const;
export type BoardStage = typeof BOARD_STAGES[number];
export type BenchmarkBasis = 'explicit' | 'default';

export function isBoardStage(value: string): value is BoardStage {
  return (BOARD_STAGES as readonly string[]).includes(value);
}
