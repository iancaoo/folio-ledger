import React from 'react';
import { Button, Tooltip } from 'antd';
import type { ReportTarget } from '../shared/report-center';

const WRITE_TARGETS = new Set(['return', 'fund', 'benchmark', 'nav', 'trades']);

export function targetEnabled(target: ReportTarget, canWrite: boolean, canConfigure?: boolean) {
  if (target.kind === 'options') return !!canConfigure;
  return WRITE_TARGETS.has(target.kind) ? canWrite : true;
}

export function TargetButton({ target, label, canWrite, canConfigure, openTarget }: { target?: ReportTarget | null; label: string; canWrite: boolean; canConfigure?: boolean; openTarget?: (target: ReportTarget) => void }) {
  if (!target || !openTarget) return null;
  const enabled = targetEnabled(target, canWrite, canConfigure);
  const button = <Button type="link" size="small" disabled={!enabled} onClick={() => openTarget(target)}>{label}</Button>;
  return enabled ? button : <Tooltip title={target.kind === 'options' ? '仅候选配置管理员可修改' : '当前角色只读'}><span>{button}</span></Tooltip>;
}
