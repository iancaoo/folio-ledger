import { fields } from '../shared/models';

// Identifiers below come from version-controlled model definitions, never HTTP.
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
export async function applyFinanceConstraints(db: any) {
  await db.sequelize.transaction(async transaction => {
    for (const [table, columns] of Object.entries(fields)) {
      for (const field of columns.filter(field => field.allowNull === false)) {
        await db.sequelize.query(`ALTER TABLE ${quote(`finance_${table}`)} ALTER COLUMN ${quote(field.name)} SET NOT NULL`, { transaction });
      }
    }
    const checks = [
      ['transactions', 'positive_units', '"confirmed_units" > 0'],
      ['transactions', 'transaction_type', '"transaction_type" IN (\'初次申购\', \'追加申购\', \'赎回\')'],
      ['transactions', 'confirmed_nav_scale', '"confirmed_nav" IS NULL OR scale("confirmed_nav") <= 4'],
      ['funds', 'fund_kind', '"fund_kind" IN (\'third_party\', \'proprietary\')'],
      ['funds', 'fund_dates', '"maturity_date" IS NULL OR "inception_date" IS NULL OR "maturity_date" >= "inception_date"'],
      ...Object.keys(fields).map(table => [table, 'revision', '"technical_revision" >= 1']),
    ];
    for (const [table, suffix, expression] of checks) {
      const name = `finance_${table}_${suffix}_ck`;
      const [existing] = await db.sequelize.query('SELECT 1 FROM pg_constraint WHERE conname=:name AND conrelid=to_regclass(:table)', { replacements: { name, table: `finance_${table}` }, transaction });
      if (!existing.length) await db.sequelize.query(`ALTER TABLE ${quote(`finance_${table}`)} ADD CONSTRAINT ${quote(name)} CHECK (${expression})`, { transaction });
    }
    if (db.hasCollection('users')) {
      for (const [table, field] of [['third_party_fund_details', 'coverage_owner_user_id'], ['investment_entities', 'key_contact_user_id']]) {
        const name = `finance_${table}_user_fk`;
        const [existing] = await db.sequelize.query('SELECT 1 FROM pg_constraint WHERE conname=:name AND conrelid=to_regclass(:table)', { replacements: { name, table: `finance_${table}` }, transaction });
        if (!existing.length) await db.sequelize.query(`ALTER TABLE ${quote(`finance_${table}`)} ADD CONSTRAINT ${quote(name)} FOREIGN KEY (${quote(field)}) REFERENCES "users"("id") ON DELETE RESTRICT`, { transaction });
      }
    }
  });
}
