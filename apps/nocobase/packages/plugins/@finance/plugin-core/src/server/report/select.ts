import { Month, toMonth } from './model';

/**
 * Monthly return selection (requirements 10.2, D06), per share class:
 * records without an estimate label are not used; estimates dated on or before the latest formal date D are
 * superseded; within a month a formal value wins over estimates, and the latest record of the winning kind is used.
 * Months are never compounded from several records.
 */
export type ReturnRow = { date: string; value: number; label: string | null; row: any };
export type Candidate = ReturnRow & { kind: '正式' | '估算' | '未标注'; used: boolean; reason: string };
export type Selection = { month: Month; candidates: Candidate[]; chosen: number | null };

const kindOf = (label: string | null): Candidate['kind'] => label === '否' ? '正式' : label === '是' ? '估算' : '未标注';

export function selectReturns(rows: ReturnRow[]): Selection[] {
  const formalDates = rows.filter(r => kindOf(r.label) === '正式').map(r => r.date).sort();
  const latestFormal = formalDates.length ? formalDates[formalDates.length - 1] : null;
  const byMonth = new Map<Month, Candidate[]>();
  for (const r of [...rows].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) {
    const c: Candidate = { ...r, kind: kindOf(r.label), used: false, reason: '' };
    if (c.kind === '未标注') c.reason = '未标注是否估算，补填后才参与计算';
    else if (c.kind === '估算' && latestFormal && c.date <= latestFormal) c.reason = `已有 ${latestFormal} 的正式值，此前的估算值不再使用`;
    const m = toMonth(r.date);
    byMonth.set(m, [...(byMonth.get(m) || []), c]);
  }
  return [...byMonth.keys()].sort().map(month => {
    const cs = byMonth.get(month)!;
    const eligible = cs.map((c, i) => [c, i] as const).filter(([c]) => !c.reason);
    const pool = eligible.some(([c]) => c.kind === '正式') ? eligible.filter(([c]) => c.kind === '正式') : eligible;
    const chosen = pool.length ? pool[pool.length - 1][1] : null;
    cs.forEach((c, i) => {
      if (i === chosen) { c.used = true; c.reason = c.kind === '正式' ? '当月正式值' : '当月最新估算值'; return; }
      if (c.reason) return;
      c.reason = cs[chosen!].kind === '正式' && c.kind === '估算' ? '当月已有正式值' : `当月有更晚的${c.kind}值`;
    });
    return { month, candidates: cs, chosen };
  });
}
