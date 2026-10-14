#!/usr/bin/env python3
"""Extract the reviewed source mapping, without inferring missing business definitions."""
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
source = ROOT / 'docs/Finance系统端到端需求设计.md'
document = source.read_text()
appendix = document.split('<!-- FIELD_MAPPING -->', 1)[1]
sheet = None
fields = []
for line in appendix.splitlines():
    if line.startswith('### '):
        sheet = line[4:].strip()
    if not re.match(r'^\| \d+ \|', line):
        continue
    cells = [cell.strip().replace('<br>', '\n').replace('\\|', '|')
             for cell in re.split(r'(?<!\\)\|', line)[1:-1]]
    if len(cells) != 7:
        raise ValueError(f'Invalid source row: {sheet}: {cells[0]}')
    row, group, label, source_type, required, mapping, notes = cells
    match = re.match(r'^([a-z_]+)\.([a-z_0-9]+)', mapping)
    fields.append({
        'source_key': f'{sheet}:{row}', 'source_sheet': sheet, 'source_row': int(row),
        'group': group, 'label': label, 'source_type': source_type,
        'required_marker': required, 'required': required == '是',
        'required_unconfirmed': required == '未标明',
        'mapping': mapping, 'notes': notes,
        'logical_table': match.group(1) if match else None,
        'logical_field': match.group(2) if match else None,
        'needs_business_confirmation': '待确认' in notes or '待明确' in mapping
            or '定义缺失' in mapping or bool(re.search(r'Q\d\d', mapping)),
    })
expected = {'三方基金页面': 52, '自营基金页面': 41, '客户页面': 31,
            '申赎记录': 11, '基准页面': 5, '净值与文档': 21}
counts = {name: sum(f['source_sheet'] == name for f in fields) for name in expected}
assert counts == expected, counts
assert len({f['source_key'] for f in fields}) == 161
catalog = {
    'schema_version': '0.2.0',
    'source_document': str(source.relative_to(ROOT)),
    'source_appendix_sha256': hashlib.sha256(appendix.encode()).hexdigest(),
    'source_workbook': 'Finance交接/inputs/数据字段清单_20260928.xlsx',
    'counts': counts, 'fields': fields,
}
(ROOT / 'schema').mkdir(exist_ok=True)
(ROOT / 'schema/field-catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
shared = ROOT / 'apps/nocobase/packages/plugins/@finance/plugin-core/src/shared'
shared.mkdir(parents=True, exist_ok=True)
(shared / 'field-catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n')
acceptance = []
for line in document.splitlines():
    if not re.match(r'^\| A\d\d \|', line):
        continue
    cells = [cell.strip() for cell in line.split('|')[1:-1]]
    acceptance.append(dict(zip(('id', 'scenario', 'expected'), cells)))
assert [a['id'] for a in acceptance] == [f'A{i:02}' for i in range(1, 43)]
(ROOT / 'schema/acceptance-catalog.json').write_text(json.dumps(acceptance, ensure_ascii=False, indent=2) + '\n')
print(f'Extracted {len(fields)} field/rule mappings and {len(acceptance)} acceptance definitions; no tests claimed.')
