import { Migration } from '@nocobase/server';

/** Adds the per-finding review column. Existing runs keep a null value. */
export default class ReportFindingReviews extends Migration {
  on = 'afterLoad';
  async up() {
    await this.context.db.getCollection('finance_report_runs').sync();
  }
}
