#!/usr/bin/env python3
"""Link A01-A42 to actual passing test output; do not infer pass from code alone."""
import datetime
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
# Each selector is an unambiguous substring of an executable test name.
CASES = {
    'A01': [('database', 'A01: different currencies')],
    'A02': [('database', 'failed aggregate leaves no partial')],
    'A03': [('database', 'Paged holdings preserve exact totals')],
    'A04': [],
    'A05': [('database', 'actual transactions produce 70')],
    'A06': [('database', 'actual transactions produce 70')],
    'A07': [('database', 'Current positions ignore future facts')],
    'A08': [('database', 'actual transactions produce 70')],
    'A09': [('database', 'Trade editing replays both accounts')],
    'A10': [('database', 'Trade import replays the final same-day set')],
    'A11': [('database', 'Concurrent retries of one key')],
    'A12': [('database', 'Identical real trades require explicit confirmation')],
    'A13': [('database', 'An existing NAV changed after preview')],
    'A14': [('database', 'Same-file same-date conflicts')],
    'A15': [('database', 'An existing NAV changed after preview')],
    'A16': [('database', 'Import containing one invalid row'), ('database', 'An existing NAV changed after preview')],
    'A17': [('database', 'Returns column mode resolves')],
    'A18': [('database', 'Return estimate mapping preserves unknown')],
    'A19': [('domain', 'decimal facts and arithmetic')],
    'A20': [('database', 'Complete same-date composition')],
    'A21': [('database', 'Missing optional composition dates')],
    'A22': [('database', 'Soft delete and restore preserve holdings')],
    'A23': [('database', 'Share-class disable belongs to one immutable fund version'), ('database', 'fund versions and idempotent retries')],
    'A24': [('database', 'Durable upload recovers after adapter failure'), ('database', 'stale same-day overwrite rejected')],
    'A25': [('database', 'Entity and benchmark edits use revisions')],
    'A26': [('api', 'Anonymous and read-only sessions')],
    'A27': [('backup-restore', 'Offline whole-database and private-file backup')],
    'A28': [('install', 'Fresh install, replayable initialization'), ('domain', 'mapping layer: all 161')],
    'A29': [('database', 'Entity and benchmark edits use revisions')],
    'A30': [('domain', 'EDATE +36 months'), ('database', 'Entity import preserves two subjects')],
    'A31': [('api', 'Root cannot bypass'), ('database', 'Nested repository relation writes'), ('database', 'Bulk, upsert, increment')],
    'A32': [('database', 'concurrent withdrawals share an account lock'), ('database', 'Different requests concurrently creating the first account')],
    'A33': [('database', 'Stale second row rolls back first row')],
    'A34': [('database', 'Exact NAV and tiny ratio'), ('domain', 'high precision facts')],
    'A35': [('database', 'One batch changes two proprietary share classes'), ('database', 'fund versions and idempotent retries')],
    'A36': [('install', 'Fresh install, replayable initialization'), ('backup-restore', 'Offline whole-database and private-file backup')],
    'A37': [('database', 'database has no automatic business modified-by')],
    'A38': [('api', 'Private document upload, protected downloads'), ('database', 'Failed physical deletion blocks reads')],
    'A39': [('database', 'Concurrent retries of one key'), ('database', 'fund versions and idempotent retries'), ('api', 'Application restart preserves')],
    'A40': [('database', 'Configuration change invalidates'), ('database', 'A manual trade after batch preview'), ('database', 'Series preview detects delete-and-reinsert')],
    'A41': [('database', 'Trade import rolls back earlier writes'), ('database', 'Main-data batches roll back'), ('api', 'Application restart preserves')],
    'A42': [('api', 'Finance editor can enter data'), ('database', 'Domain API rejects system fields')],
}
BROWSERS = {'A01': ['smoke'], 'A03': ['smoke'], 'A04': ['query'], 'A06': ['smoke'], 'A07': ['smoke'], 'A12': ['smoke'], 'A13': ['query', 'series-import'], 'A16': ['smoke'], 'A20': ['smoke'], 'A23': ['smoke'], 'A24': ['smoke'], 'A30': ['main-import'], 'A34': ['smoke', 'export'], 'A35': ['main-import'], 'A39': ['smoke', 'drafts']}
LOGS = {'domain': '.runtime/tests.log', 'database': '.runtime/tests.log', 'api': '.runtime/api-test.log', 'install': '.runtime/install-test.log', 'backup-restore': '.runtime/backup-restore.log'}


def main():
    definitions = json.loads((ROOT / 'schema/acceptance-catalog.json').read_text())
    assert len(definitions) == len(CASES) == 42
    cases = []
    for definition in definitions:
        refs = []; passed = True
        for suite, selector in CASES[definition['id']]:
            name = f'tests/{suite}.test.ts'; source = (ROOT / name).read_text()
            found = [(i + 1, match.group(1)) for i, line in enumerate(source.splitlines()) if (match := re.search(r"test\('([^']+)',", line)) and selector in match.group(1)]
            assert len(found) == 1, (definition['id'], selector, found)
            line, title = found[0]; output = (ROOT / LOGS[suite]).read_text()
            ok = f'✔ {title} (' in output and 'ℹ fail 0' in output
            passed &= ok
            refs.append({'file': name, 'line': line, 'test': title, 'passed': ok, 'source_sha256': hashlib.sha256(source.encode()).hexdigest()})
        browser_refs = []
        for name in BROWSERS.get(definition['id'], []):
            result = json.loads((ROOT / f'.runtime/browser-{name}-result.json').read_text()); ok = bool(result.get('passed'))
            passed &= ok
            browser_refs.append({'file': f'tests/browser-{name}.{"cjs" if name == "smoke" else "ts"}', 'passed': ok, 'executed_at': result.get('timestamp', result.get('executed_at'))})
        assert refs or browser_refs
        cases.append({**definition, 'result': 'technical-pass' if passed else 'not-verified', 'tests': refs, 'browser': browser_refs})
    report = {'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'scope': '模拟数据技术验收；未代替真实业务配置确认、历史文件迁移、生产部署及用户试用',
              'total': 42, 'technical_pass': sum(case['result'] == 'technical-pass' for case in cases), 'cases': cases}
    (ROOT / 'docs/verification/M5验收矩阵.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    lines = ['# 第一阶段验收记录', '', f'本次 A01—A42 中，{report["technical_pass"]} 项通过模拟数据技术验证。测试出处与执行结果见 [机器可读矩阵](verification/M5验收矩阵.json)。', '',
             '该结果说明系统按既定模型运行，不代表字段候选、真实数据、生产部署或业务试用已经确认。业务参与事项见 [试用与业务确认](试用与业务确认.md)。', '',
             '| 编号 | 场景 | 技术结果 | 证据 |', '| --- | --- | --- | --- |']
    for case in cases:
        refs = [f'[{ref["file"].split("/")[-1]}:{ref["line"]}](../{ref["file"]}#L{ref["line"]})' for ref in case['tests']]
        refs += [f'[{ref["file"].split("/")[-1]}](../{ref["file"]})' for ref in case['browser']]
        lines.append(f'| {case["id"]} | {case["scenario"]} | {"通过" if case["result"] == "technical-pass" else "未验证"} | {"；".join(refs)} |')
    lines += ['', '性能与恢复证据：', '',
              '- [规定规模性能](verification/M5性能验证.json)：十万交易、三十万净值、五个独立录入会话；HTTP 和真实浏览器分别测量。',
              '- [配套备份恢复](verification/M5备份恢复验证.json)：整库、文件及独立密钥恢复到同机隔离实例；含四种中断检查点。',
              '- [空库安装与升级](verification/M1安装迁移.json)：固定版本重放，不更新平台代码；136 条来源字段核对物理列，其余 25 条有规则或暂缓说明。',
              '- [汇总结果](verification/M0验证结果.json)：自动测试与浏览器流程分列；不将性能请求数计为新增功能用例。', '']
    (ROOT / 'docs/第一阶段验收记录.md').write_text('\n'.join(lines))
    print(f'{report["technical_pass"]}/42 technical checks verified from recorded executions.')


if __name__ == '__main__':
    main()
