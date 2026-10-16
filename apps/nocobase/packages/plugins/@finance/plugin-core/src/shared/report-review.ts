import { createHash } from 'node:crypto';
import { canonical } from './values';

export const REVIEW_STATUS_LABEL = { confirmed: '已确认', needs_fix: '需修改', not_applicable: '不适用' } as const;
export type ReviewStatus = keyof typeof REVIEW_STATUS_LABEL | null;

export function findingKey(index: number, finding: { level?: string; category?: string; title?: string; detail?: string; suggestion?: string; fund?: string; month?: string }) {
  const digest = createHash('sha256').update(canonical({
    level: finding.level || '', category: finding.category || '', title: finding.title || '',
    detail: finding.detail || '', suggestion: finding.suggestion || '', fund: finding.fund || '', month: finding.month || '',
  })).digest('hex').slice(0, 12);
  return `f${index}-${digest}`;
}

/** Match the same issue across report versions. Runs without a check code use the title with numbers folded. */
export function findingFingerprint(finding: { code?: string; category?: string; title?: string; fund?: string; month?: string; loc?: { date?: string; field?: string; benchmark?: string } }, legacy = false) {
  if (!legacy && finding.code) return [finding.code, finding.fund || '', finding.month || '', finding.loc?.date || '', finding.loc?.field || '', finding.loc?.benchmark || ''].join('|');
  return [finding.category || '', finding.fund || '', finding.month || '', String(finding.title || '').replace(/\d+/g, '#')].join('|');
}

export function noteRequired(level: string, status: ReviewStatus) {
  if (!status) return false;
  if (level === '错误') return true;
  return status === 'needs_fix' || status === 'not_applicable';
}

export function reviewCounts(findings: Array<{ level?: string; key?: string }>, items: Record<string, { status?: ReviewStatus }> = {}) {
  let open_errors = 0, needs_fix = 0, handled = 0;
  for (const finding of findings) {
    const status = finding.key ? items[finding.key]?.status : undefined;
    if (status === 'needs_fix') needs_fix += 1;
    if (status === 'confirmed' || status === 'not_applicable') handled += 1;
    if (finding.level === '错误' && status !== 'confirmed' && status !== 'not_applicable') open_errors += 1;
  }
  return { open_errors, needs_fix, handled };
}

export function reviewGate(findings: Array<{ level?: string; key?: string }>, reviews: { items?: Record<string, { status?: ReviewStatus }> } | null, note?: string | null) {
  const items = reviews?.items || {};
  const needsFix = findings.filter(finding => finding.key && items[finding.key]?.status === 'needs_fix').length;
  const openErrors = findings.filter(finding => finding.level === '错误' && (!finding.key || !['confirmed', 'not_applicable'].includes(items[finding.key]?.status || ''))).length;
  const blockers: Array<{ code: string; message: string }> = [];
  if (needsFix) blockers.push({ code: 'REVIEW_NEEDS_FIX', message: `有 ${needsFix} 项标记为需修改，请修正数据后重新生成，或改为已确认/不适用` });
  if (openErrors) blockers.push({ code: 'REVIEW_INCOMPLETE', message: `还有 ${openErrors} 项错误未处理` });
  if (findings.some(finding => finding.level === '错误') && !String(note || '').trim()) blockers.push({ code: 'REVIEW_NOTE_REQUIRED', message: '校验报告仍有错误，发布前请填写复核说明' });
  return { ok: blockers.length === 0, open_errors: openErrors, needs_fix: needsFix, blockers };
}
