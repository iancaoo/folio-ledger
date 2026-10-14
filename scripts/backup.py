#!/usr/bin/env python3
"""Offline PostgreSQL + local files backup. Restore only into an empty, separate DB.

Profiles and the separate secrets directory are private files (0600 / 0700).
Service commands are argument arrays, never shell strings. See docs/部署与恢复.md.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
DATA_DIRS = ('finance', 'uploads')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def private_json(path, value):
    with open(path, 'x', encoding='utf-8') as out:
        os.chmod(path, 0o600)
        json.dump(value, out, ensure_ascii=False, indent=2)
        out.write('\n')


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def inventory(root):
    result = {}
    if root.exists():
        for path in sorted(root.rglob('*')):
            require(not path.is_symlink(), 'Symlinks are unsupported in a portable local backup.')
            if path.is_file():
                result[path.relative_to(root).as_posix()] = {'bytes': path.stat().st_size, 'sha256': digest(path)}
            else:
                require(path.is_dir(), 'Special storage files are unsupported.')
    return result


def copy_private(source, target):
    if not source.exists():
        target.mkdir(parents=True, mode=0o700)
        return
    require(not source.is_symlink(), 'Storage root must not be a symlink.')
    inventory(source)
    shutil.copytree(source, target)
    target.chmod(0o700)
    for path in target.rglob('*'):
        path.chmod(0o700 if path.is_dir() else 0o600)


def pg(profile, program, args, sql=None):
    db = profile['database']
    env = dict(os.environ, PGPASSWORD=db['password'], PGCONNECT_TIMEOUT='5')
    command = [program, '-h', db['host'], '-p', str(db['port']), '-U', db['user'], '-d', db['name'], *args]
    result = subprocess.run(command, input=sql, text=True, capture_output=True, env=env)
    require(result.returncode == 0, f'{program} failed (exit {result.returncode}); no backup or restore success was recorded.')
    return result.stdout.strip()


def sql(profile, statement):
    return pg(profile, 'psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-At'], statement)


def offline(profile):
    with socket.socket() as probe:
        require(probe.connect_ex(('127.0.0.1', int(profile['app_port']))) != 0, 'Application port is still open; stop all writers first.')
    connected = sql(profile, 'SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid();')
    require(connected == '0', 'Database still has other connections; stop all app instances, jobs and maintenance clients first.')


def versions():
    paths = ['apps/nocobase/package.json', 'apps/nocobase/yarn.lock', 'apps/nocobase/packages/plugins/@finance/plugin-core/package.json', 'schema/field-catalog.json']
    paths += [p.relative_to(ROOT).as_posix() for p in (ROOT / 'apps/nocobase/packages/plugins/@finance/plugin-core/src').rglob('*') if p.is_file()]
    return {p: digest(ROOT / p) for p in sorted(paths)}


def create(profile, backup, secrets):
    require(not backup.exists() and not secrets.exists(), 'Backup and secrets destinations must both be new.')
    require(backup != secrets and backup not in secrets.parents and secrets not in backup.parents, 'Secrets must be stored separately from the backup directory.')
    storage = Path(profile['storage_path']).resolve()
    require(storage not in backup.parents and storage not in secrets.parents, 'Backup destinations must be outside the live storage tree.')
    stop = profile.get('stop_command'); start = profile.get('start_command')
    require(bool(stop) == bool(start), 'Service-managed backup requires both stop_command and start_command.')
    stopped = False
    try:
        if stop:
            require(isinstance(stop, list) and isinstance(start, list), 'Service commands must be argument arrays.')
            subprocess.run(stop, check=True, cwd=ROOT); stopped = True
        offline(profile)
        require(sql(profile, "SELECT count(*) FROM storages WHERE type<>'local';") == '0', 'This backup supports local file storage only; add external-storage backup before proceeding.')
        roots = json.loads(sql(profile, "SELECT coalesce(json_agg(options->>'documentRoot'),'[]') FROM storages WHERE type='local';"))
        for configured in roots:
            if not configured:
                continue
            candidate = storage / configured.removeprefix('storage/') if configured.startswith('storage/') else Path(configured)
            require(candidate.is_absolute() and any(candidate == storage / name or storage / name in candidate.parents for name in DATA_DIRS), 'A configured local storage root is outside finance/uploads; expand the backup plan first.')
        backup.mkdir(parents=True, mode=0o700); secrets.mkdir(parents=True, mode=0o700)
        identifier = str(uuid.uuid4())
        pg(profile, 'pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', str(backup / 'database.dump')])
        (backup / 'database.dump').chmod(0o600)
        for name in DATA_DIRS:
            copy_private(storage / name, backup / 'storage' / name)
        copy_private(storage / 'apps', secrets / 'apps')
        require(profile.get('app_key'), 'APP_KEY is required for a recoverable backup.')
        private_json(secrets / 'runtime.json', {'backup_id': identifier, 'app_key': profile['app_key']})
        offline(profile)
        manifest = {'format': 'finance-offline-backup-v1', 'backup_id': identifier, 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    'database_name': profile['database']['name'], 'postgres_version': sql(profile, 'SHOW server_version;'),
                    'platform': '2.2.24', 'plugin': json.loads((ROOT / 'apps/nocobase/packages/plugins/@finance/plugin-core/package.json').read_text())['version'],
                    'release_sha256': versions(), 'files': inventory(backup),
                    'scope': 'Whole PostgreSQL database; storage/finance and storage/uploads. APP_KEY and storage/apps are in the separate private secrets directory.'}
        private_json(secrets / 'manifest.json', {'backup_id': identifier, 'files': inventory(secrets)})
        private_json(backup / 'manifest.json', manifest)  # Success marker is written last.
        print(json.dumps({'backup_id': identifier, 'result': 'backup-created', 'files': len(manifest['files'])}))
    finally:
        if stopped:
            subprocess.run(start, check=True, cwd=ROOT)


def verify(backup, secrets):
    manifest = json.loads((backup / 'manifest.json').read_text())
    secret_manifest = json.loads((secrets / 'manifest.json').read_text())
    require(manifest['format'] == 'finance-offline-backup-v1', 'Unsupported backup format.')
    require(manifest['backup_id'] == secret_manifest['backup_id'], 'Secrets belong to another backup.')
    for folder, expected in [(backup, manifest['files']), (secrets, secret_manifest['files'])]:
        actual = inventory(folder); actual.pop('manifest.json', None)
        require(actual == expected, 'Backup file list, byte count or SHA-256 mismatch. Restore was not started.')
    require(json.loads((secrets / 'runtime.json').read_text())['backup_id'] == manifest['backup_id'], 'Runtime secrets belong to another backup.')
    return manifest


def restore(profile, backup, secrets):
    manifest = verify(backup, secrets)
    require(versions() == manifest['release_sha256'], 'Use the exact backed-up platform/plugin release before restoring; upgrade only after recovery verification.')
    require(profile['database']['name'] != manifest['database_name'], 'Restore must target a separate empty database, never the source database.')
    offline(profile)
    count = sql(profile, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S');")
    require(count == '0', 'Restore target is not empty; existing databases are never overwritten.')
    storage = Path(profile['storage_path']).resolve()
    for name in [*DATA_DIRS, 'apps']:
        require(not (storage / name).exists(), 'Restore storage destination already exists; use a new isolated directory.')
    pg(profile, 'pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', str(backup / 'database.dump')])
    for name in DATA_DIRS:
        copy_private(backup / 'storage' / name, storage / name)
    copy_private(secrets / 'apps', storage / 'apps')
    # The application stays stopped. Caller supplies APP_KEY from runtime.json.
    print(json.dumps({'backup_id': manifest['backup_id'], 'result': 'restored-offline', 'next': 'Supply the matching APP_KEY, start the isolated app, and verify records, permissions, files and task recovery.'}))


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['create', 'verify', 'restore'])
    parser.add_argument('--profile', type=Path)
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--secrets', type=Path, required=True)
    args = parser.parse_args()
    if args.action == 'verify':
        manifest = verify(args.backup.resolve(), args.secrets.resolve())
        print(json.dumps({'backup_id': manifest['backup_id'], 'result': 'checksums-verified'})); return
    require(args.profile is not None and args.profile.is_file(), 'A private JSON profile is required.')
    require(args.profile.stat().st_mode & 0o077 == 0, 'Profile contains credentials and must have mode 0600.')
    profile = json.loads(args.profile.read_text())
    (create if args.action == 'create' else restore)(profile, args.backup.resolve(), args.secrets.resolve())


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
