import { Migration } from '@nocobase/server';

export default class NullableUuids extends Migration {
  on = 'afterLoad';
  async up() {
    // Early M0 models generated phantom batch IDs for manual entry. Repair only
    // records without source coordinates AND without a corresponding batch.
    await this.context.db.sequelize.transaction(async transaction => {
      for (const table of ['transactions', 'fund_navs', 'fund_returns', 'benchmark_values']) {
        await this.context.db.sequelize.query(`UPDATE "finance_${table}" AS fact
          SET source_batch_id = NULL
          WHERE source_batch_id IS NOT NULL AND source_sheet IS NULL AND source_row IS NULL
            AND NOT EXISTS (SELECT 1 FROM finance_import_batches AS batch WHERE batch.id = fact.source_batch_id)`, { transaction });
      }
    });
  }
}
