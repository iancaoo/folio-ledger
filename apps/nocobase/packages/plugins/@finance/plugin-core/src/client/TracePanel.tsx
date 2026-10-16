import React, { useMemo, useState } from 'react';
import { Alert, Button, Card, Empty, Space, Tag, Typography } from 'antd';
import { CloseOutlined } from '@ant-design/icons';

const { Text } = Typography;
const levelType = { 错误: 'error', 警告: 'warning', 提示: 'info' } as const;
const flagColor = (flag: string) => flag === '缺失' ? 'error' : flag === '模拟' ? 'success' : flag.startsWith('来源') ? 'default' : 'orange';
const tableNames = { finance_transactions: '申赎记录', finance_fund_navs: '基金净值', finance_fund_returns: '基金收益率', finance_benchmark_values: '基准点位', finance_funds: '基金资料' };

export function formatValue(n: any) {
  const v = n?.value;
  if (v === null || v === undefined) return '—';
  if (typeof v !== 'number') return String(v);
  if (n.unit === 'pct') return `${(v * 100).toFixed(4)}%`;
  if (n.unit === 'money') return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v.toLocaleString('en-US', { maximumFractionDigits: 6 });
}
function sourceText(s: any) {
  if (!s) return null;
  if (s.sheet && !s.table) return `录入表「${s.sheet}」第 ${s.row} 行 · ${s.col}`;
  const head = `${tableNames[s.table] || s.table} · ${s.date ? `${s.date} · ` : ''}${s.col}`;
  return s.batch ? `${head}（导入批次 ${String(s.batch).slice(0, 8)}${s.sheet ? `，「${s.sheet}」第 ${s.row} 行` : ''}）` : `${head}（手工录入）`;
}
function formula(trace: any, n: any) {
  if (n.op === 'leaf') return '原始数据';
  if (n.op === 'pick') return `${trace.range_rules[n.params.mode]}（口径 ${n.params.mode}）`;
  const text = trace.formulas[n.rule] || n.op;
  return n.op === 'sum' && n.params?.coeffs?.some((c: number) => c < 0) ? `${text}（赎回取负）` : text;
}
export function leavesUnder(trace: any, ids: string[]) {
  const seen = new Set<string>(); const out: string[] = []; const stack = [...ids];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !trace.nodes[id]) continue;
    seen.add(id);
    const n = trace.nodes[id];
    if (n.op === 'leaf') out.push(id); else stack.push(...(n.inputs || []).map((x: any) => x[1]), ...(n.refs || []));
  }
  return out.sort();
}

function Flags({ flags }: { flags?: string[] }) {
  return <>{flags?.map(f => <Tag key={f} bordered={false} color={flagColor(f)} style={{ marginInlineStart: 4, marginInlineEnd: 0 }}>{f}</Tag>)}</>;
}

function TraceNode({ trace, id, role, depth, findings }: { trace: any; id: string; role?: string; depth: number; findings: Record<string, any[]> }) {
  const n = trace.nodes[id];
  const [open, setOpen] = useState(depth < 1);
  const kids: Array<[string, string]> = (n.inputs || []).map(([r, i]: [string, string], idx: number) => [n.params?.coeffs?.[idx] < 0 ? `${r}（−）` : r, i]);
  const children: Array<[string, string]> = [...kids, ...(n.refs || []).map((r: string) => ['分类依据', r] as [string, string])];
  return <div className="finance-trace-node" style={{ marginLeft: depth ? 14 : 0, paddingLeft: depth ? 8 : 0, borderLeft: depth ? '1px dashed var(--finance-border, #d9d9d9)' : undefined }}>
    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', padding: '3px 0' }}>
      <Button type="text" size="small" disabled={!children.length} onClick={() => setOpen(!open)} style={{ width: 18, padding: 0, height: 18 }} aria-label={open ? '收起' : '展开'}>{children.length ? (open ? '▾' : '▸') : '·'}</Button>
      <div style={{ flex: 1, minWidth: 0 }}>
        {role && <Text type="secondary">{role}：</Text>}<Text strong>{n.label}</Text><Flags flags={n.flags} />
        <div style={{ fontSize: 12, color: 'rgba(0,0,0,.55)' }}>{formula(trace, n)}</div>
        {n.src && <div style={{ fontSize: 12, color: '#389e0d' }}>{sourceText(n.src)}</div>}
        {findings[id]?.map((f, i) => <Alert key={i} type={levelType[f.level] || 'info'} showIcon style={{ margin: '4px 0', padding: '2px 8px', fontSize: 12 }} message={f.title} description={f.detail} />)}
      </div>
      <Text className="finance-num" style={{ whiteSpace: 'nowrap' }}>{formatValue(n)}</Text>
    </div>
    {open && children.map(([r, c], i) => <TraceNode key={`${c}-${i}`} trace={trace} id={c} role={r} depth={depth + 1} findings={findings} />)}
  </div>;
}

/** Calculation tree of one report number, down to the Finance records it was computed from. */
export function TracePanel({ trace, ids, onClose }: { trace: any; ids: string[]; onClose: () => void }) {
  const findings = useMemo(() => {
    const by: Record<string, any[]> = {};
    for (const f of trace.findings || []) if (f.node) (by[f.node] = by[f.node] || []).push(f);
    return by;
  }, [trace]);
  const leaves = useMemo(() => leavesUnder(trace, ids), [trace, ids]);
  const flagged = leaves.filter(i => trace.nodes[i].flags?.length).length;
  const root = trace.nodes[ids[0]];
  if (!root) return <Empty description="该单元格没有对应的计算节点" />;
  return <Card size="small" className="finance-panel" style={{ height: '72vh', display: 'flex', flexDirection: 'column' }} styles={{ body: { overflow: 'auto', flex: 1 } }}
    title={<Space direction="vertical" size={0}><Text strong>{root.label}</Text><Text type="secondary" style={{ fontSize: 12 }}>口径 {trace.meta.rules.id}：{trace.meta.rules.range_value_text}</Text></Space>}
    extra={<Button type="text" icon={<CloseOutlined />} aria-label="关闭追溯" onClick={onClose} />}>
    <Text type="secondary" style={{ fontSize: 12 }}>计算过程</Text>
    {ids.map(id => <TraceNode key={id} trace={trace} id={id} depth={0} findings={findings} />)}
    <div style={{ marginTop: 16 }}><Text type="secondary" style={{ fontSize: 12 }}>用到的原始数据：{leaves.length} 项{flagged ? `，其中 ${flagged} 项带标记` : ''}</Text></div>
    {leaves.map(i => { const n = trace.nodes[i]; return <div key={i} style={{ display: 'flex', gap: 8, padding: '4px 0', borderBottom: '1px solid #f0f0f0', fontSize: 12 }}>
      <div style={{ flex: 1 }}>{n.label}<Flags flags={n.flags} /><div style={{ color: 'rgba(0,0,0,.45)' }}>{sourceText(n.src) || '无来源定位'}</div></div>
      <span className="finance-num" style={{ whiteSpace: 'nowrap' }}>{formatValue(n)}</span>
    </div>; })}
  </Card>;
}
