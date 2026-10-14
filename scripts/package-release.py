#!/usr/bin/env python3
"""Package an explicit source/build allowlist; never include runtime data or keys."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = Path('apps/nocobase/packages/plugins/@finance/plugin-core')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('Use a new output path; existing releases are not overwritten.')
    if not (ROOT / PLUGIN / 'dist/server/import-parser-worker.js').exists():
        raise SystemExit('Build the Finance plugin before packaging.')
    paths = {Path(name) for name in ['README.md', 'GOAL.md', '.gitignore', 'apps/nocobase/package.json', 'apps/nocobase/yarn.lock',
                                    'apps/nocobase/tsconfig.json', 'apps/nocobase/tsconfig.server.json', 'apps/nocobase/tsconfig.paths.json',
                                    'apps/nocobase/lerna.json', 'apps/nocobase/.env.example']}
    paths.update(PLUGIN / name for name in ['package.json', 'client.js', 'server.js'])
    for folder in ['schema', 'scripts', 'tests', 'docs', str(PLUGIN / 'src'), str(PLUGIN / 'dist')]:
        for file in (ROOT / folder).rglob('*'):
            relative = file.relative_to(ROOT)
            if file.is_file() and not file.is_symlink() and not any(part in {'__pycache__', '.DS_Store'} for part in relative.parts) and file.suffix != '.pyc':
                paths.add(relative)
    assert all('.runtime' not in path.parts and 'Finance交接' not in path.parts and path.name != '.env' for path in paths)
    payload = {path.as_posix(): (ROOT / path).read_bytes() for path in sorted(paths)}
    manifest = {'format': 'finance-release-v1', 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'platform': '2.2.24', 'plugin': '0.1.0', 'stage': 'phase-1-local-technical-delivery',
                'files': {name: {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in payload.items()},
                'excluded': ['运行凭据和 APP_KEY', '数据库及备份', '原始交接包及业务 Excel', '用户上传、草稿和运行日志', '平台 node_modules'],
                'note': 'Install platform dependencies from yarn.lock. Documentation screenshots and examples use simulated data. Production business configuration and deployment require separate confirmation.'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in payload.items():
            archive.writestr(f'Finance/{name}', data)
        archive.writestr('Finance/RELEASE.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    with zipfile.ZipFile(args.output) as archive:
        assert archive.testzip() is None
        for name, expected in manifest['files'].items():
            data = archive.read(f'Finance/{name}')
            assert len(data) == expected['bytes'] and hashlib.sha256(data).hexdigest() == expected['sha256']
    print(json.dumps({'path': str(args.output.resolve()), 'files': len(payload), 'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(), 'verified': True}, ensure_ascii=False))


if __name__ == '__main__':
    main()
