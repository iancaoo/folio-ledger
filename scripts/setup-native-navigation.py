#!/usr/bin/env python3
"""Create missing official Finance menu/page shells using the configured nb environment.

Existing pages are never replaced. Add each Finance block with the UI editor after
building the plugin. Menu permissions are configured separately through nb ACL.
"""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PAGES = json.loads((ROOT / 'apps/nocobase/packages/plugins/@finance/plugin-core/src/shared/navigation.json').read_text())

def nb(*args):
    return json.loads(subprocess.check_output(['nb', *args, '-j'], text=True))['data']

def main():
    capabilities = nb('api', 'flow-surfaces', 'list-navigation-targets')
    if capabilities.get('capabilities', {}).get('multiPortal') is not False:
        raise SystemExit('This setup targets the verified single desktop layout only.')
    tree = nb('api', 'resource', 'list', '--resource', 'desktopRoutes:listAccessible', '--no-paginate')
    manifest = []
    for spec in PAGES:
        marked = [(g, r) for g in tree for r in g.get('children', [])
                  if r.get('type') == 'flowPage' and (r.get('options') or {}).get('financePage') == spec['key']]
        if len(marked) > 1:
            raise SystemExit(f'Ambiguous Finance key: {spec["key"]}')
        groups = [marked[0][0]] if marked else [r for r in tree if r['type'] == 'group' and r['title'] == spec['group']]
        if len(groups) > 1:
            raise SystemExit(f'Ambiguous group: {spec["group"]}')
        if not groups:
            result = nb('api', 'flow-surfaces', 'create-menu', '--type', 'group', '--title', spec['group'], '--icon', spec['icon'])
            group = {'id': result['routeId'], 'title': spec['group'], 'type': 'group', 'children': []}
            tree.append(group)
        else:
            group = groups[0]
        matches = [marked[0][1]] if marked else [r for r in group.get('children', []) if r['type'] == 'flowPage' and r['title'] == spec['title']]
        if len(matches) > 1:
            raise SystemExit(f'Ambiguous page: {spec["title"]}')
        if matches:
            route = matches[0]
        else:
            result = nb('api', 'flow-surfaces', 'create-menu', '--type', 'item', '--title', spec['title'], '--icon', spec['icon'], '--parent-menu-route-id', str(group['id']))
            route = {'id': result['routeId'], 'schemaUid': result['pageSchemaUid'], 'title': spec['title'], 'type': 'flowPage'}
            group['children'].append(route)
        # The public create-page action initializes only the missing grid of a bindable menu.
        surface = nb('api', 'flow-surfaces', 'get', '--page-schema-uid', route['schemaUid'])
        tabs = surface.get('tree', {}).get('subModels', {}).get('tabs', [])
        if not tabs or not all(t.get('subModels', {}).get('grid') for t in tabs):
            nb('api', 'flow-surfaces', 'create-page', '--menu-route-id', str(route['id']), '--title', spec['title'])
            surface = nb('api', 'flow-surfaces', 'get', '--page-schema-uid', route['schemaUid'])
        options = {**(route.get('options') or {}), 'financePage': spec['key']}
        if route.get('options') != options:
            nb('api', 'resource', 'update', '--resource', 'desktopRoutes', '--filter-by-tk', str(route['id']), '--values', json.dumps({'options': options}))
        blocks = [n for n in surface.get('nodeMap', {}).values() if n.get('use') == spec['model']]
        manifest.append({**spec, **({'blockUid': blocks[0]['uid']} if len(blocks) == 1 else {}), 'tabRouteIds': [r['id'] for r in surface.get('pageRoute', {}).get('children', [])], 'groupRouteId': group['id'], 'routeId': route['id'], 'pageSchemaUid': route['schemaUid'], 'url': f'http://127.0.0.1:13000/admin/{route["schemaUid"]}'})
        print(f'{spec["group"]} / {spec["title"]}: {route["schemaUid"]}', flush=True)
    output = ROOT / 'docs/navigation/installed-pages.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    for name, pages in [('business', [p for p in manifest if p['key'] != 'options']), ('configurator', manifest)]:
        ids = list(dict.fromkeys(i for p in pages for i in [p['groupRouteId'], p['routeId'], *p['tabRouteIds']]))
        (output.parent / f'access-{name}.json').write_text(json.dumps(ids, indent=2) + '\n')

if __name__ == '__main__':
    main()
