import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';

export async function initializeFileStorage(db: any) {
  if (!db.hasCollection('storages')) return;
  const directory = path.join(process.env.STORAGE_PATH || path.resolve('storage'), 'finance');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const repository = db.getRepository('storages');
  if (await repository.findOne({ filter: { name: 'finance_private' } })) return;
  await repository.create({ values: {
    name: 'finance_private', title: 'Finance 私有文档', type: 'local', default: false,
    // The internal input filename is an operation UUID, not a user-supplied path.
    renameMode: 'none', paranoid: true, baseUrl: '/finance-private-files', path: '',
    options: { documentRoot: 'storage/finance/documents', public: false, useOriginalUrl: false },
    rules: { size: 10 * 1024 * 1024 },
  } });
}
