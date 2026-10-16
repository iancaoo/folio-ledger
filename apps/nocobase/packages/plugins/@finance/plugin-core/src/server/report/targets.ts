import { ReportTarget } from '../../shared/report-center';
import { Finding } from './checks';
import { Dataset, Month, monthEnd } from './model';

export type FindingJump = { label: string; target: ReportTarget };

function usedDate(ds: Dataset, key: string, month: Month) {
  return ds.returnSelections?.[key]?.[month]?.find(candidate => candidate.used)?.date || monthEnd(month);
}
function refOf(ds: Dataset, key: string) {
  return ds.refs?.funds[key];
}
export function returnTarget(ds: Dataset, key: string, date: string, label: string): FindingJump {
  return { label, target: { kind: 'return', share_class_id: refOf(ds, key)?.share_class_id || '', date } };
}
export function navTarget(ds: Dataset, key: string, date: string, label: string): FindingJump {
  const ref = refOf(ds, key);
  return { label, target: { kind: 'nav', fund_id: ref?.fund_id || '', share_class_id: ref?.share_class_id || '', date } };
}
export function fundTagTarget(ds: Dataset, key: string, field: 'allocation_role' | 'investment_region' | 'strategy', sourceKey: string | undefined, missing: boolean): FindingJump {
  if (sourceKey) return { label: '维护候选值', target: { kind: 'options', source_key: sourceKey } };
  return { label: missing ? '补充标签' : '修改标签', target: { kind: 'fund', fund_id: refOf(ds, key)?.fund_id || '', field } };
}
export function benchmarkTarget(ds: Dataset, name: string, date: string): FindingJump {
  return { label: '录入基准点位', target: { kind: 'benchmark', benchmark_id: ds.refs?.benchmarks[name] || null, date } };
}

/** Record jumps for one stored finding. Readiness checks keep their own targets. */
export function findingTargets(ds: Dataset, entityId: string, finding: Finding): FindingJump[] {
  const code = finding.code;
  const key = finding.fund;
  const month = finding.loc?.month;
  if (!code) return [];
  if (code === 'RECON_MISMATCH' && key && month) return [
    navTarget(ds, key, monthEnd(month), '核对净值'),
    returnTarget(ds, key, usedDate(ds, key, month), '核对收益率'),
    { label: '核对申赎', target: { kind: 'trades', entity_id: entityId } },
  ];
  if (code === 'ESTIMATE_MONTH' && month) return (finding.loc?.funds || []).slice(0, 10).map(fund => returnTarget(ds, fund, usedDate(ds, fund, month), `${fund}：${month < ds.asOf ? '替换为实际值' : '录入收益率'}`));
  if ((code === 'ESTIMATE_POINT' || code === 'ESTIMATE_STALE' || code === 'RETURN_UNLABELED' || code === 'RETURN_NOT_MONTH_END' || code === 'BIG_MOVE') && key && month) {
    const date = finding.loc?.date || usedDate(ds, key, month);
    const label = code === 'RETURN_UNLABELED' ? '补填估算标记' : code === 'ESTIMATE_STALE' ? '替换为实际值' : '录入收益率';
    return [returnTarget(ds, key, date, label)];
  }
  if (code === 'DATA_MISSING' && key && month) {
    const date = monthEnd(month);
    return refOf(ds, key)?.fund_kind === 'proprietary' ? [navTarget(ds, key, date, '补录净值')] : [returnTarget(ds, key, date, '录入收益率')];
  }
  if ((code === 'TAG_MISSING' || code === 'TAG_NOT_ALLOWED') && key && finding.loc?.field) {
    return [fundTagTarget(ds, key, finding.loc.field as 'allocation_role' | 'investment_region' | 'strategy', finding.loc.source_key, code === 'TAG_MISSING')];
  }
  if (code === 'BENCHMARK_GAP') return [benchmarkTarget(ds, finding.loc?.benchmark || key, monthEnd(month || ds.asOf))];
  if (code === 'CURRENCY_MIXED') return [{ label: '查看持仓', target: { kind: 'positions', entity_id: entityId } }];
  return [];
}
