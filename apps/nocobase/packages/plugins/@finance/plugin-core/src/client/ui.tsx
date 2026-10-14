import React from 'react';
import { Tag, Typography } from 'antd';

const { Text } = Typography;

// Display-only grouping: keeps every digit of the exact decimal string, never rounds.
export function groupDecimal(value: any) {
  if (value === null || value === undefined || value === '') return '—';
  const text = String(value);
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(text);
  if (!match) return text;
  return `${match[1]}${match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${match[3] || ''}`;
}

export function Num({ value, rawValue, suffix, empty = '—' }: { value: any; rawValue?: any; suffix?: React.ReactNode; empty?: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return <span className="finance-num is-empty">{empty}</span>;
  return <span className="finance-num" title={String(rawValue ?? value)}>{groupDecimal(value)}{suffix && <small> {suffix}</small>}</span>;
}

export const numColumn = (column: any) => ({ align: 'right', ...column, render: column.render || (value => <Num value={value} />) });

export function DateText({ value }: { value?: string | null }) {
  return <span className="finance-date">{value || '—'}</span>;
}

// "基金 · 份额 · ISIN · 币种" labels come from the server; show the fund first and the rest muted.
export function ShareCell({ label, fund, detail }: { label?: string; fund?: React.ReactNode; detail?: React.ReactNode }) {
  const parts = label ? String(label).split(' · ') : [];
  const main = fund ?? parts[0] ?? '—';
  const rest = detail ?? parts.slice(1).join(' · ');
  return <div className="finance-cell"><span className="finance-cell-main">{main}</span>{rest ? <span className="finance-cell-sub">{rest}</span> : null}</div>;
}

export function TwoLine({ main, sub }: { main: React.ReactNode; sub?: React.ReactNode }) {
  return <div className="finance-cell"><span className="finance-cell-main">{main}</span>{sub ? <span className="finance-cell-sub">{sub}</span> : null}</div>;
}

export function PageIntro({ description, extra, children }: { description?: React.ReactNode; extra?: React.ReactNode; children?: React.ReactNode }) {
  return <div className="finance-intro">
    <div className="finance-intro-text">{description && <Text type="secondary">{description}</Text>}{children}</div>
    {extra && <div className="finance-intro-extra">{extra}</div>}
  </div>;
}

export function StatCard({ label, value, unit, hint, icon, tone = 'default', onClick, active, ariaLabel }: any) {
  const Comp: any = onClick ? 'button' : 'div';
  return <Comp type={onClick ? 'button' : undefined} className={`finance-stat is-${tone}${onClick ? ' is-clickable' : ''}${active ? ' is-active' : ''}`} onClick={onClick} aria-pressed={onClick ? !!active : undefined} aria-label={ariaLabel}>
    <div className="finance-stat-head"><span className="finance-stat-label">{label}</span>{icon && <span className="finance-stat-icon">{icon}</span>}</div>
    <div className="finance-stat-value">{value ?? '—'}{unit && <small>{unit}</small>}</div>
    {hint && <div className="finance-stat-hint">{hint}</div>}
  </Comp>;
}

const tradeColors = { 初次申购: 'green', 追加申购: 'cyan', 赎回: 'orange' };
export const TradeType = ({ value }: { value: string }) => <Tag color={tradeColors[value] || 'default'} bordered={false}>{value}</Tag>;

const batchColors = { committed: 'success', ready: 'processing', staged: 'processing', parsing: 'processing', awaiting_file: 'warning', needs_correction: 'warning', failed: 'error', cancelled: 'default' };
export const BatchStatus = ({ value, labels }: { value: string; labels: Record<string, string> }) => <Tag color={batchColors[value] || 'default'} bordered={false}>{labels[value] || value}</Tag>;

export const RecordState = ({ deleted, deletedLabel = '已删除', activeLabel = '有效' }: { deleted: boolean; deletedLabel?: string; activeLabel?: string }) =>
  deleted ? <Tag bordered={false}>{deletedLabel}</Tag> : <Tag color="success" bordered={false}>{activeLabel}</Tag>;

export const fundKindLabel = (kind: string) => kind === 'third_party' ? '三方基金' : '自营基金';
export const FundKind = ({ kind }: { kind: string }) => <Tag color={kind === 'third_party' ? 'blue' : 'purple'} bordered={false}>{fundKindLabel(kind)}</Tag>;
