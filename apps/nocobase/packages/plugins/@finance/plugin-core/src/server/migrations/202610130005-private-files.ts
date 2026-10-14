import { Migration } from '@nocobase/server';
import { initializeFileStorage } from '../file-storage';
import { applyFinanceConstraints } from '../constraints';

export default class PrivateFiles extends Migration {
  on = 'afterLoad';
  async up() { await initializeFileStorage(this.context.db); await applyFinanceConstraints(this.context.db); }
}
