import { Migration } from '@nocobase/server';
import { applyFinanceConstraints } from '../constraints';

export default class ReportRuns extends Migration {
  on = 'afterLoad';
  async up() {
    await this.context.db.getCollection('finance_report_runs').sync();
    await applyFinanceConstraints(this.context.db);
  }
}
