#!/usr/bin/env python3
"""Reproducible local demo installation. Never cleans or resets an existing DB."""
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.runtime'
APP = ROOT / 'apps/nocobase'


def main():
    bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
    node = os.environ.get('FINANCE_NODE') or (str(bundled) if bundled.exists() else shutil.which('node'))
    for name in ['python3', 'npm', 'initdb', 'pg_ctl', 'psql']:
        if not shutil.which(name):
            raise SystemExit(f'Missing {name}. Install Node.js 24, PostgreSQL 17 and Python 3 first.')
    if not node:
        raise SystemExit('Node.js 24 is required.')
    major = int(subprocess.check_output([node, '-p', 'process.versions.node.split(".")[0]'], text=True).strip())
    if major != 24:
        raise SystemExit('Use Node.js 24 LTS (tested: 24.19.0); set FINANCE_NODE if needed.')
    RUNTIME.mkdir(exist_ok=True)
    yarn = RUNTIME / 'tooling/node_modules/yarn/bin/yarn.js'
    env = {**os.environ, 'PATH': f'{Path(node).parent}:{os.environ.get("PATH", "")}'}
    log_path = RUNTIME / 'setup.log'
    fd = os.open(log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
    log_path.chmod(0o600)
    with os.fdopen(fd, 'a') as log:
        def run(args, label):
            print(label, flush=True)
            result = subprocess.run(args, cwd=ROOT, env=env, stdout=log, stderr=log)
            if result.returncode:
                raise SystemExit(f'{label} failed. Inspect .runtime/setup.log locally; it may contain environment details.')
        if not yarn.exists():
            run(['npm', 'install', '--prefix', str(RUNTIME / 'tooling'), '--no-audit', '--no-fund', 'yarn@1.22.22', 'tsx@4.21.0'], 'Install pinned local tools')
        run(['python3', 'scripts/dev-database.py', 'start'], 'Prepare project PostgreSQL and local .env')
        run(['python3', 'scripts/dev-app.py', 'stop'], 'Stop this project app before installing')
        run([node, str(yarn), '--cwd', str(APP), 'install', '--frozen-lockfile', '--network-timeout', '600000'], 'Install locked platform dependencies')
        run([node, str(yarn), '--cwd', str(APP), 'build', '@finance/plugin-core'], 'Build Finance plugin')
        c = json.loads((RUNTIME / 'dev-credentials.json').read_text())
        result = subprocess.run(['psql', '-h', '127.0.0.1', '-p', '15432', '-U', 'finance_app', '-d', 'finance_dev', '-At', '-c',
                                 "SELECT to_regclass('public.\"applicationVersion\"') IS NOT NULL OR to_regclass('public.collections') IS NOT NULL"],
                                env={**env, 'PGPASSWORD': c['database_password']}, text=True, capture_output=True, check=True)
        command = ['upgrade', '--skip-code-update'] if result.stdout.strip() == 't' else ['install', '--lang', 'zh-CN']
        run([node, str(yarn), '--cwd', str(APP), 'nocobase', *command], 'Initialize or migrate platform and Finance data')
        run(['python3', 'scripts/dev-app.py', 'start'], 'Start local Finance')
    log_path.chmod(0o600)
    print('Ready: http://127.0.0.1:13000/admin/finance')
    print('Local admin credentials: .runtime/dev-credentials.json (not committed).')


if __name__ == '__main__':
    main()
