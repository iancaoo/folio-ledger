import { Migration } from '@nocobase/server';
import { initializeFinance } from '../initialize';

export default class FinanceMenu extends Migration {
  on = 'afterLoad';
  async up() { await initializeFinance(this.context.db); }
}
