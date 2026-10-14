import { Migration } from '@nocobase/server';
import { applyFinanceConstraints } from '../constraints';

export default class FinanceConstraints extends Migration {
  on = 'afterLoad';
  async up() { await applyFinanceConstraints(this.context.db); }
}
