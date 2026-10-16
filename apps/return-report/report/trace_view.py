"""报告上的追溯面板：点击任意数字，右侧按树展开它的计算过程，直到录入单元格或 Finance 记录。"""
from __future__ import annotations

import json

from .trace import Graph

CSS = """
[data-n] { cursor: pointer; }
[data-n]:hover { outline: 2px solid #2e75b6; outline-offset: -2px; }
[data-n].sel { outline: 2px solid #c00000; outline-offset: -2px; }
[data-n].has-f { background-image: linear-gradient(225deg, #c00000 6px, transparent 6px); }
#tp { position: fixed; top: 0; right: 0; width: 520px; height: 100vh; background: #fff; box-shadow: -4px 0 16px rgba(0,0,0,.18);
      font-size: 13px; display: none; flex-direction: column; z-index: 10; }
#tp.on { display: flex; }
#tp header { padding: 12px 16px; background: #1f3864; color: #fff; }
#tp header b { font-size: 15px; }
#tp header .x { float: right; cursor: pointer; font-size: 18px; line-height: 1; }
#tp header .rule { font-size: 11.5px; opacity: .85; margin-top: 4px; }
#tp .body { overflow: auto; padding: 10px 14px 30px; flex: 1; }
#tp h3 { font-size: 13px; margin: 16px 0 6px; color: #1f3864; border-bottom: 1px solid #d9d9d9; padding-bottom: 3px; }
.tn { margin-left: 14px; border-left: 1px dashed #bfbfbf; padding-left: 8px; }
.tn > .row { padding: 3px 0; }
.tn .tw { display: inline-block; width: 14px; color: #7f7f7f; cursor: pointer; }
.tn .role { color: #7f7f7f; }
.tn .lab { font-weight: 600; }
.tn .val { float: right; font-family: Consolas, monospace; }
.tn .f { color: #555; font-size: 12px; margin: 2px 0 2px 14px; }
.tn .src { color: #375623; font-size: 12px; margin-left: 14px; }
.chip { display: inline-block; font-size: 11px; padding: 0 5px; border-radius: 3px; margin-left: 4px; background: #fce4d6; color: #833c0b; }
.chip.miss { background: #c00000; color: #fff; }
.chip.sim { background: #e2efda; color: #375623; }
.fd { border-left: 4px solid; padding: 4px 8px; margin: 4px 0; background: #fafafa; font-size: 12px; }
table.leaves { font-size: 12px; width: 100%; }
table.leaves td { text-align: left; border-bottom: 1px solid #eee; white-space: normal; padding: 2px 4px; }
table.leaves td.v { text-align: right; font-family: Consolas, monospace; white-space: nowrap; }
@media print { #tp { display: none !important; } [data-n].has-f { background-image: none; } }
"""

JS = r"""
const T = JSON.parse(document.getElementById('trace-data').textContent);
const N = T.nodes, LV = {"错误": "#c00000", "警告": "#e46c0a", "提示": "#2e75b6"};
const byNode = {};
T.findings.forEach(f => { if (f.node) (byNode[f.node] = byNode[f.node] || []).push(f); });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
function fmt(n) {
  const v = n.value;
  if (v === null || v === undefined) return '—';
  if (typeof v !== 'number') return esc(v);
  if (n.unit === 'pct') return (v * 100).toFixed(4) + '%';
  if (n.unit === 'money') return v.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  if (n.unit === 'units' || n.unit === 'price') return v.toLocaleString('en-US', {maximumFractionDigits: 6});
  return v.toLocaleString('en-US', {maximumFractionDigits: 6});
}
function src(s) {
  if (!s) return '';
  if (s.sheet && !s.table) return `录入表「${esc(s.sheet)}」第 ${s.row} 行 · ${esc(s.col)}`;
  let t = `Finance ${esc(s.table)} · ${esc(s.id || s.share_class_id)}${s.date ? ' · ' + esc(s.date) : ''} · ${esc(s.col)}`;
  if (s.batch) t += `<br>导入批次 ${esc(s.batch)}${s.sheet ? ` · 「${esc(s.sheet)}」第 ${s.row} 行` : ''}`;
  return t;
}
const chip = f => `<span class="chip${f === '缺失' ? ' miss' : f === '模拟' ? ' sim' : ''}">${esc(f)}</span>`;
function formula(n) {
  if (n.op === 'leaf') return '原始数据';
  if (n.op === 'pick') return T.range_rules[n.params.mode] + `（口径 ${esc(n.params.mode)}）`;
  let t = T.formulas[n.rule] || n.op;
  if (n.op === 'sum' && n.params && n.params.coeffs && n.params.coeffs.some(c => c < 0)) t += '（赎回取负）';
  return esc(t);
}
function node(id, role, depth) {
  const n = N[id], kids = n.inputs || [], refs = n.refs || [];
  const open = depth < 1;
  const el = document.createElement('div');
  el.className = 'tn';
  const tw = kids.length || refs.length ? `<span class="tw">${open ? '▾' : '▸'}</span>` : '<span class="tw">·</span>';
  el.innerHTML = `<div class="row">${tw}${role ? `<span class="role">${esc(role)}：</span>` : ''}<span class="lab">${esc(n.label)}</span>`
    + (n.flags || []).map(chip).join('') + `<span class="val">${fmt(n)}</span></div>`
    + `<div class="f">${formula(n)}</div>`
    + (n.src ? `<div class="src">${src(n.src)}</div>` : '')
    + (byNode[id] || []).map(f => `<div class="fd" style="border-color:${LV[f.level]}"><b>${esc(f.level)}</b> ${esc(f.title)}<br>${esc(f.detail)}</div>`).join('');
  const box = document.createElement('div');
  el.appendChild(box);
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    kids.forEach((k, i) => box.appendChild(node(k[1], k[0] + (n.params && n.params.coeffs && n.params.coeffs[i] < 0 ? '（−）' : ''), depth + 1)));
    refs.forEach(r => box.appendChild(node(r, '分类依据', depth + 1)));
  };
  if (open) build(); else box.style.display = 'none';
  const t = el.querySelector('.tw');
  t.onclick = () => { build(); const h = box.style.display === 'none'; box.style.display = h ? '' : 'none'; t.textContent = h ? '▾' : '▸'; };
  return el;
}
function leaves(ids) {
  const seen = new Set(), out = [], st = [...ids];
  while (st.length) {
    const id = st.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = N[id];
    if (n.op === 'leaf') out.push(id);
    else st.push(...(n.inputs || []).map(x => x[1]), ...(n.refs || []));
  }
  return out.sort();
}
function show(ids, cell) {
  document.querySelectorAll('[data-n].sel').forEach(e => e.classList.remove('sel'));
  cell.classList.add('sel');
  const p = document.getElementById('tp'), b = p.querySelector('.body');
  b.innerHTML = '<h3>计算过程</h3>';
  ids.forEach(i => b.appendChild(node(i, '', 0)));
  const ls = leaves(ids);
  const flagged = ls.filter(i => (N[i].flags || []).length).length;
  b.insertAdjacentHTML('beforeend', `<h3>用到的原始数据（${ls.length} 项${flagged ? `，其中 ${flagged} 项带标记` : ''}）</h3>`
    + '<table class="leaves">' + ls.map(i => `<tr><td>${esc(N[i].label)}${(N[i].flags || []).map(chip).join('')}<br><small>${src(N[i].src) || '无来源定位'}</small></td><td class="v">${fmt(N[i])}</td></tr>`).join('') + '</table>');
  p.querySelector('header b').textContent = N[ids[0]].label;
  p.classList.add('on');
}
document.querySelectorAll('[data-n]').forEach(c => {
  const ids = JSON.parse(c.dataset.n).filter(i => N[i]);
  if (!ids.length) return;
  if (ids.some(i => byNode[i])) c.classList.add('has-f');
  c.title = '点击查看计算过程';
  c.onclick = () => show(ids, c);
});
document.querySelector('#tp .x').onclick = () => document.getElementById('tp').classList.remove('on');
"""


def panel(g: Graph) -> str:
    rules = g.meta["rules"]
    data = json.dumps(g.to_dict(), ensure_ascii=False).replace("</", "<\\/")
    return (f'<div id="tp"><header><span class="x">×</span><b></b>'
            f'<div class="rule">口径 {rules["id"]}：{rules["range_value_text"]}</div></header><div class="body"></div></div>'
            f'<script type="application/json" id="trace-data">{data}</script><script>{JS}</script>')
