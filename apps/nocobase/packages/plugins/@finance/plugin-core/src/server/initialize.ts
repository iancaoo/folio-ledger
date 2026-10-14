import { initializeOptions } from './options';
import { initializeFileStorage } from './file-storage';

export async function initializeFinance(db: any) {
  await initializeOptions(db);
  await initializeFileStorage(db);
  // Replay only plugin-owned roles. User memberships and other roles are retained.
  if (!db.hasCollection('roles')) return;
  for (const [name, title] of [
    ['finance_editor', 'Finance 录入员'], ['finance_reader', 'Finance 只读'],
    ['finance_configurator', 'Finance 候选配置管理员'], ['finance_product', 'Finance 产品组成员'],
  ]) {
    const repository = db.getRepository('roles');
    const values = { name, title, allowConfigure: false, allowNewMenu: false, strategy: { actions: [] }, snippets: ['!ui.*', '!pm', '!pm.*'] };
    const role = await repository.findOne({ filterByTk: name });
    if (role) await repository.update({ filterByTk: name, values });
    else await repository.create({ values });
  }
  if (db.hasCollection('desktopRoutes')) {
    const repository = db.getRepository('desktopRoutes');
    let route = await repository.findOne({ filter: { schemaUid: 'finance-workspace-entry' } });
    if (!route) route = await repository.create({ values: { title: 'Finance 数据录入', type: 'link', icon: 'FundOutlined', schemaUid: 'finance-workspace-entry', options: { href: '/admin/finance', openInNewWindow: false } } });
    await db.getRepository('desktopRoutes.roles', route.id).set({ tk: ['root', 'admin', 'finance_editor', 'finance_reader', 'finance_configurator'] });
  }
}
