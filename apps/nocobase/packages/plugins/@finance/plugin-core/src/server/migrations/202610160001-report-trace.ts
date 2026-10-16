import { Migration } from '@nocobase/server';

/** Adds the calculation trace column to report runs. Earlier runs keep a null trace. */
export default class ReportTrace extends Migration {
  on = 'afterLoad';
  async up() {
    await this.context.db.getCollection('finance_report_runs').sync();
  }
}
