#!/usr/bin/env python3
"""Manage only this project's local PostgreSQL cluster. No global service changes."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.runtime'
DATA = RUNTIME / 'postgres'
SOCKET = RUNTIME / 'pg-socket'
PORT = '15432'


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def sql(statement):
    result = run(['psql', '-h', str(SOCKET), '-p', PORT, '-U', 'finance_bootstrap',
                  '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'],
                 input=statement, capture_output=True)
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['start', 'stop', 'status'], default='start', nargs='?')
    args = parser.parse_args()
    for command in ('initdb', 'pg_ctl', 'psql'):
        if not shutil.which(command):
            raise SystemExit(f'Missing {command}; install PostgreSQL tools first.')
    RUNTIME.mkdir(exist_ok=True)
    SOCKET.mkdir(mode=0o700, exist_ok=True)
    SOCKET.chmod(0o700)
    status = subprocess.run(['pg_ctl', '-D', str(DATA), 'status'], capture_output=True)
    if args.action == 'status':
        print('Finance PostgreSQL: running' if status.returncode == 0 else 'Finance PostgreSQL: stopped')
        return
    if args.action == 'stop':
        if status.returncode == 0:
            run(['pg_ctl', '-D', str(DATA), '-m', 'fast', '-w', 'stop'])
        return

    credentials_path = RUNTIME / 'dev-credentials.json'
    if credentials_path.exists():
        credentials = json.loads(credentials_path.read_text())
    else:
        credentials = {
            'database_password': secrets.token_hex(24),
            'admin_email': 'admin@finance.local',
            'admin_password': secrets.token_hex(16),
        }
        fd = os.open(credentials_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump(credentials, handle)

    if not (DATA / 'PG_VERSION').exists():
        bootstrap = RUNTIME / 'pg-bootstrap-password'
        fd = os.open(bootstrap, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(secrets.token_hex(24))
        try:
            run(['initdb', '-D', str(DATA), '-U', 'finance_bootstrap', '--encoding=UTF8',
                 '--locale=C', '--auth-local=trust', '--auth-host=scram-sha-256',
                 '--pwfile', str(bootstrap)], stdout=subprocess.DEVNULL)
        finally:
            bootstrap.unlink(missing_ok=True)
    if status.returncode != 0:
        run(['pg_ctl', '-D', str(DATA), '-l', str(RUNTIME / 'postgres.log'),
             '-o', f'-p {PORT} -h 127.0.0.1 -k {SOCKET}', '-w', 'start'])
    if sql("SELECT 1 FROM pg_roles WHERE rolname='finance_app';") != '1':
        # The password is generated as hex, and SQL is sent via stdin, never argv or logs.
        sql("CREATE ROLE finance_app LOGIN PASSWORD '" + credentials['database_password'] + "';")
    for database in ('finance_dev', 'finance_test'):
        if sql(f"SELECT 1 FROM pg_database WHERE datname='{database}';") != '1':
            sql(f'CREATE DATABASE {database} OWNER finance_app;')

    env_path = ROOT / 'apps/nocobase/.env'
    if env_path.parent.exists():
        changes = {
            'DB_DIALECT': 'postgres', 'DB_HOST': '127.0.0.1', 'DB_PORT': PORT,
            'DB_DATABASE': 'finance_dev', 'DB_USER': 'finance_app',
            'DB_PASSWORD': credentials['database_password'], 'TZ': 'UTC',
            'INIT_ROOT_EMAIL': credentials['admin_email'],
            'INIT_ROOT_PASSWORD': credentials['admin_password'],
            'INIT_ROOT_NICKNAME': 'Finance 开发管理员',
            'APP_HOST': '127.0.0.1', 'APP_PORT': '13000',
            'APPEND_PRESET_BUILT_IN_PLUGINS': '@finance/plugin-core',
        }
        lines = env_path.read_text().splitlines() if env_path.exists() else []
        existing = dict(line.split('=', 1) for line in lines if '=' in line and not line.startswith('#'))
        for key, value in {'APP_KEY': secrets.token_hex(32), 'APP_ENV': 'development',
                           'API_BASE_PATH': '/api/', 'INIT_APP_LANG': 'zh-CN',
                           'FINANCE_DEMO_MODE': 'true', 'REQUEST_BODY_LIMIT': '16mb'}.items():
            if not existing.get(key):
                changes[key] = value
        lines = [line for line in lines if line.partition('=')[0] not in changes]
        temporary = env_path.with_suffix('.tmp')
        fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write('\n'.join(lines + [f'{k}={v}' for k, v in changes.items()]) + '\n')
        temporary.chmod(0o600)
        temporary.replace(env_path)
    print(f'Finance PostgreSQL ready on 127.0.0.1:{PORT}; development and test databases isolated.')
    print('Local credentials saved in ignored .runtime/dev-credentials.json (mode 600).')


if __name__ == '__main__':
    main()
