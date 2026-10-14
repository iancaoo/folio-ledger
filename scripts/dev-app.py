#!/usr/bin/env python3
"""Start/stop this checkout's local NocoBase process group; never touch other apps."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / '.runtime/app-process.json'

def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['start', 'stop', 'restart', 'status'], default='start', nargs='?')
    args = parser.parse_args()
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    pid = state.get('pid')
    if args.action == 'status':
        print('Finance app running' if pid and alive(pid) else 'Finance app stopped')
        return
    if pid and alive(pid):
        command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True)
        if str(ROOT / '.runtime/tooling/node_modules/yarn/bin/yarn.js') not in command:
            raise SystemExit('Saved PID is not this checkout’s app. Refusing to stop it.')
        if args.action == 'start':
            print('Already running: http://127.0.0.1:13000/admin/finance')
            return
        os.killpg(pid, signal.SIGTERM)
        for _ in range(50):
            if not alive(pid):
                break
            time.sleep(0.1)
        if alive(pid):
            os.killpg(pid, signal.SIGKILL)
    STATE.unlink(missing_ok=True)
    if args.action == 'stop':
        print('Finance app stopped')
        return
    bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'
    node = os.environ.get('FINANCE_NODE') or (str(bundled) if bundled.exists() else shutil.which('node'))
    if not node:
        raise SystemExit('Node.js is required (tested: 24.19.0).')
    yarn = ROOT / '.runtime/tooling/node_modules/yarn/bin/yarn.js'
    if not yarn.exists():
        raise SystemExit('Install project tools before starting (see README).')
    env = dict(os.environ)
    env['PATH'] = f'{Path(node).parent}:{yarn.parent.parent / ".bin"}:{env.get("PATH", "")}'
    with (ROOT / '.runtime/nocobase-local.log').open('a') as log:
        proc = subprocess.Popen([node, str(yarn), '--cwd', str(ROOT / 'apps/nocobase'), 'start', '--launch-mode=node'],
                                cwd=ROOT, env=env, stdout=log, stderr=log, start_new_session=True)
    STATE.write_text(json.dumps({'pid': proc.pid}))
    STATE.chmod(0o600)
    for _ in range(40):
        if proc.poll() is not None:
            raise SystemExit('App stopped during startup. See .runtime/nocobase-local.log.')
        try:
            with urllib.request.urlopen('http://127.0.0.1:13000/api/app:getInfo', timeout=1) as response:
                body = json.load(response)
                if response.status == 200 and body.get('data', {}).get('version'):
                    print('Finance app ready: http://127.0.0.1:13000/admin/finance')
                    return
        except Exception:
            pass
        time.sleep(0.25)
    raise SystemExit('App is starting; readiness not confirmed. Check local log before retrying.')

if __name__ == '__main__':
    main()
