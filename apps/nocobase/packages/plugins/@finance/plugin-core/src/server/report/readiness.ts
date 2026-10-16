import { FinanceError } from '../../shared/values';
import { ReadinessCounts, ReadinessItem, ReadinessResult } from '../../shared/report-center';
import { TAG_SOURCES } from '../reports';
import { Allowed, LEVELS, runChecks, tagProblems } from './checks';
import { datasetFromSnapshot } from './dataset';
import { Orders, compute } from './engine';
import { Dataset, Month, fundKeys, monthEnd, monthLabel, pct } from './model';

const LEVEL_RANK: Record<ReadinessItem['level'], number> = { 错误: 0, 警告: 1, 提示: 2 };
const CATEGORY_RANK = Object.fromEntries(['数据范围', '净值收益', '收益标注', '基金标签', '基准', '月报状态'].map((name, index) => [name, index]));
const TAG_DIM = { 风险分类: 'risk', 投资地区: 'region', 基金策略: 'strategy' } as const;

export function readinessCounts(items: ReadinessItem[]): ReadinessCounts {
  return {
    错误: items.filter(item => item.level === '错误').length,
    警告: items.filter(item => item.level === '警告').length,
    提示: items.filter(item => item.level === '提示').length,
  };
}

export function readinessStatus(items: ReadinessItem[]): ReadinessResult['status'] {
  if (items.some(item => item.level === '错误')) return 'blocked';
  if (items.some(item => item.level === '警告')) return 'warning';
  return 'ready';
}

export function sortReadinessItems(items: ReadinessItem[]) {
  return [...items].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]
    || (CATEGORY_RANK[a.category] ?? 99) - (CATEGORY_RANK[b.category] ?? 99)
    || (b.month || '').localeCompare(a.month || '')
    || (a.fund || '').localeCompare(b.fund || '', 'zh')
    || a.code.localeCompare(b.code));
}

function usedDate(ds: Dataset, key: string, month: Month) {
  return ds.returnSelections?.[key]?.[month]?.find(candidate => candidate.used)?.date || monthEnd(month);
}

/**
 * Data-entry checks for one entity-month. Rules match the monthly report;
 * EXISTING_RUN is added by the report-center action, not here.
 */
export function checkReadiness(snap: any, entityId: string, month: Month, benchmarkIds: string[] | null,
  rules: { allowed: Allowed; orders: Orders }): ReadinessResult {
  const entity = snap.entities.find((row: any) => row.id === entityId);
  if (!entity) throw new FinanceError('NOT_FOUND', '快照中没有该投资主体', 'entity_id', 404);
  if (entity.is_deleted) {
    const items = sortReadinessItems([{
      code: 'ENTITY_DELETED', level: '错误', category: '数据范围', title: '投资主体已删除', detail: '恢复主体后才能生成月报',
      target: { kind: 'entity', entity_id: entityId },
    }]);
    return { status: 'blocked', counts: readinessCounts(items), items, funds: [], forecast: null, benchmark_ids_used: [] };
  }

  const ds = datasetFromSnapshot(snap, entityId, month, benchmarkIds);
  let res;
  try { res = compute(ds, rules.orders); }
  catch (error) {
    if (error instanceof FinanceError && error.code === 'NO_HOLDINGS') {
      const items = sortReadinessItems([{
        code: 'NO_TRANSACTIONS', level: '错误', category: '数据范围', title: '截至报告月没有申赎记录',
        detail: '该投资主体截至报告月没有申赎记录，无法生成月报', target: { kind: 'trades', entity_id: entityId },
      }]);
      return { status: 'blocked', counts: readinessCounts(items), items, funds: [], forecast: null, benchmark_ids_used: Object.values(ds.refs?.benchmarks || {}) };
    }
    throw error;
  }

  const items: ReadinessItem[] = [];
  if (ds.currencies.length > 1) items.push({
    code: 'CURRENCY_MIXED', level: '错误', category: '数据范围', title: `持仓和交易涉及多个币种：${ds.currencies.join('、')}`,
    detail: '月报不做汇率换算', target: { kind: 'positions', entity_id: entityId },
  });

  const missing = [...res.missing].sort((a, b) => a[1] === month ? -1 : b[1] === month ? 1 : a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : a[0] < b[0] ? -1 : 1);
  for (const [key, missingMonth] of missing) {
    const ref = ds.refs?.funds[key];
    const date = monthEnd(missingMonth);
    items.push({
      code: 'MONTH_DATA_MISSING', level: '错误', category: '净值收益', fund: key, month: missingMonth,
      title: `${key} ${monthLabel(missingMonth)}：缺少净值和收益率`, detail: '当月有持仓，净值将按上月结转',
      target: ref?.fund_kind === 'proprietary'
        ? { kind: 'nav', fund_id: ref.fund_id, share_class_id: ref.share_class_id, date }
        : { kind: 'return', share_class_id: ref?.share_class_id || '', date },
    });
  }

  for (const key of fundKeys(ds)) for (const [itemMonth, candidates] of Object.entries(ds.returnSelections?.[key] || {})) {
    const ref = ds.refs?.funds[key];
    for (const candidate of candidates) if (candidate.kind === '未标注') items.push({
      code: 'RETURN_UNLABELED', level: '错误', category: '收益标注', fund: key, month: itemMonth,
      title: `${key} ${monthLabel(itemMonth)}：收益率未标注是否估算`,
      detail: `${candidate.date} 的收益率 ${pct(candidate.value)} 没有标注是正式值还是估算值，未参与计算`,
      target: { kind: 'return', share_class_id: ref?.share_class_id || '', date: candidate.date },
    });
  }

  const stale = new Set<string>();
  const pushStale = (key: string, itemMonth: Month) => {
    const id = `${key}\0${itemMonth}`;
    if (stale.has(id)) return;
    stale.add(id);
    const ref = ds.refs?.funds[key];
    items.push({
      code: 'RETURN_STALE', level: '错误', category: '收益标注', fund: key, month: itemMonth,
      title: `${key} ${monthLabel(itemMonth)}：估算值应替换为实际值`, detail: '截止日之前月份的估算值应在出报告前替换为实际值。',
      target: { kind: 'return', share_class_id: ref?.share_class_id || '', date: usedDate(ds, key, itemMonth) },
    });
  };
  for (const key of fundKeys(ds)) for (const itemMonth of res.reportMonths) {
    if (itemMonth < month && ds.returns[key]?.[itemMonth]?.estimate) pushStale(key, itemMonth);
  }
  for (const key of fundKeys(ds)) {
    const returns = ds.returns[key] || {};
    const actual = Object.keys(returns).filter(itemMonth => !returns[itemMonth].estimate).sort();
    if (!actual.length) continue;
    const latest = actual[actual.length - 1];
    for (const [itemMonth, value] of Object.entries(returns)) if (value.estimate && itemMonth < latest) pushStale(key, itemMonth);
  }

  for (const key of fundKeys(ds)) if (ds.returns[key]?.[month]?.estimate) {
    const ref = ds.refs?.funds[key];
    items.push({
      code: 'RETURN_ESTIMATE_CURRENT', level: '提示', category: '收益标注', fund: key, month,
      title: `${key} 本月收益为估算值`, detail: '月报中会标红，实际值到位后重新生成',
      target: { kind: 'return', share_class_id: ref?.share_class_id || '', date: usedDate(ds, key, month) },
    });
  }
  for (const key of fundKeys(ds)) {
    const used = ds.returnSelections?.[key]?.[month]?.find(candidate => candidate.used);
    if (used?.kind === '正式' && used.date !== monthEnd(month)) {
      const ref = ds.refs?.funds[key];
      items.push({
        code: 'RETURN_NOT_MONTH_END', level: '提示', category: '收益标注', fund: key, month,
        title: `${key} 本月正式收益率日期不在月末`, detail: `采用的是 ${used.date} 的正式值 ${pct(used.value)}，可能只覆盖到月中。`,
        target: { kind: 'return', share_class_id: ref?.share_class_id || '', date: used.date },
      });
    }
  }

  for (const problem of tagProblems(ds, rules.allowed)) {
    const ref = ds.refs?.funds[problem.key];
    const dim = TAG_DIM[problem.label];
    const source = ref ? TAG_SOURCES[dim][ref.fund_kind as 'third_party' | 'proprietary'] : undefined;
    const target = problem.choices.length === 0 && problem.value && source
      ? { kind: 'options' as const, source_key: source }
      : { kind: 'fund' as const, fund_id: ref?.fund_id || '', field: problem.field as 'allocation_role' | 'investment_region' | 'strategy' };
    items.push(problem.value
      ? { code: 'TAG_NOT_ALLOWED', level: '警告', category: '基金标签', fund: problem.key, title: `${problem.key}：${problem.label}「${problem.value}」不在候选值中`, detail: `允许值：${problem.choices.join('/') || '尚未配置'}。`, target }
      : { code: 'TAG_MISSING', level: '错误', category: '基金标签', fund: problem.key, title: `${problem.key}：缺少${problem.label}`, detail: '持仓分类无法计算。', target });
  }

  if (!ds.benchmarks.length) items.push({
    code: 'BENCHMARK_NONE', level: '警告', category: '基准', title: '报告月没有可用基准点位，月报将不含基准对比',
    detail: '未指定时只使用报告月有点位的基准。', target: { kind: 'benchmark', benchmark_id: null, date: monthEnd(month) },
  });
  for (const name of ds.benchmarks) {
    const lack = res.reportMonths.filter(itemMonth => !ds.returns[name]?.[itemMonth]);
    if (!lack.length) continue;
    const levels = new Set((ds.lineage?.bench_levels[name] || []).map(([itemMonth]) => itemMonth));
    const noLevel = lack.filter(itemMonth => !levels.has(itemMonth));
    const hasLevel = lack.filter(itemMonth => levels.has(itemMonth));
    const notes: string[] = [];
    if (noLevel.includes(month)) notes.push('缺本月点位');
    else if (noLevel.length) notes.push(`缺${noLevel.map(monthLabel).join('、')}点位`);
    if (hasLevel.length) notes.push('缺上月点位，本月收益无法计算');
    items.push({
      code: 'BENCHMARK_GAP', level: '警告', category: '基准', fund: name, month: lack[0],
      title: `基准 ${name} 缺少：${lack.map(monthLabel).join('、')}`, detail: notes.join('；'),
      target: { kind: 'benchmark', benchmark_id: ds.refs?.benchmarks[name] || null, date: monthEnd(lack[0]) },
    });
  }

  const sorted = sortReadinessItems(items);
  const { findings, summary } = runChecks(ds, res, rules.allowed);
  const counts = Object.fromEntries(LEVELS.map(level => [level, findings.filter(finding => finding.level === level).length])) as ReadinessCounts;
  return {
    status: readinessStatus(sorted), counts: readinessCounts(sorted), items: sorted,
    funds: fundKeys(ds).map(key => {
      const ref = ds.refs!.funds[key];
      const value = ds.returns[key]?.[month];
      return {
        key, fund_id: ref.fund_id, share_class_id: ref.share_class_id, fund_kind: ref.fund_kind, currency: ref.currency,
        holding: (res.nav[key]?.[month]?.value ?? 0) > 0 || !!ds.flows[key]?.[month],
        month_nav: !!ds.navs[key]?.[month],
        month_return: !value ? null : value.estimate ? '估算' : '正式',
      };
    }),
    forecast: { counts, checks: summary },
    benchmark_ids_used: Object.values(ds.refs?.benchmarks || {}),
  };
}
