import { AsyncLocalStorage } from 'node:async_hooks';
import { FinanceError } from '../shared/values';

const scope = new AsyncLocalStorage<boolean>();
const capability = Symbol('Finance domain write');
export function domainWrite<T>(work: () => Promise<T>): Promise<T> { return scope.run(true, work); }
export function writeOptions(transaction: any): any {
  return scope.getStore() ? { transaction, financeWriteToken: capability } : { transaction };
}

/** Applies to model/repository writes, including nested relations and workflow actions. */
export function installWriteGuard(db: any) {
  const guard = (recordOrOptions: any, options?: any) => {
    const model = options?.model || recordOrOptions?.model || recordOrOptions?.constructor;
    const token = (options || recordOrOptions)?.financeWriteToken;
    if (model?.name?.startsWith('finance_') && (!scope.getStore() || token !== capability)) {
      throw new FinanceError('DOMAIN_WRITE_REQUIRED', '请使用 Finance 业务操作保存，不能直接写入业务表', undefined, 403);
    }
  };
  for (const name of ['beforeCreate', 'beforeUpdate', 'beforeDestroy', 'beforeBulkCreate', 'beforeBulkUpdate', 'beforeBulkDestroy', 'beforeUpsert']) {
    db.sequelize.addHook(name, 'finance-domain-write-only', guard);
  }
  // Covers increment and hooks:false model writes. A workflow inheriting our
  // async context still lacks the per-query capability and must be rejected.
  db.sequelize.addHook('beforeQuery', 'finance-query-write-only', (options: any) => {
    if (['INSERT', 'UPDATE', 'BULKUPDATE', 'DELETE', 'BULKDELETE', 'UPSERT'].includes(options.type)) guard(options);
  });
}
