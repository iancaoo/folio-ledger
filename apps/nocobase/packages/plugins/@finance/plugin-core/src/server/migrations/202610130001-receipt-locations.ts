import { Migration } from '@nocobase/server';
import { domainWrite, writeOptions } from '../write-scope';
import { receiptOutcome } from '../receipts';

export default class ReceiptLocations extends Migration {
  on = 'afterLoad';
  async up() {
    // Upgrade early M0 receipts in place; request keys and success identity remain intact.
    await domainWrite(async () => {
      const model = this.context.db.getModel('finance_request_receipts');
      await this.context.db.sequelize.transaction(async transaction => {
        const rows = await model.findAll(writeOptions(transaction));
        for (const row of rows) {
          const previous = row.get('result');
          const result = receiptOutcome(previous);
          if (JSON.stringify(previous) !== JSON.stringify(result)) await row.update({ result }, writeOptions(transaction));
        }
      });
    });
  }
}
