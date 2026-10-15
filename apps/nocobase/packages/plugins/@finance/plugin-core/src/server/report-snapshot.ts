import { QueryTypes } from 'sequelize';
import { dateOnly, FinanceError } from '../shared/values';
import { FinanceService, uuid } from './service';

export const REPORT_SNAPSHOT_SCHEMA = 'finance.report-snapshot/v1';

/**
 * Every fact a monthly report needs for the selected entities, read in one
 * REPEATABLE READ transaction so a paged reader cannot mix revisions.
 * Numbers stay strings; the report service owns any conversion.
 */
export class FinanceReportSnapshot {
  constructor(public service: FinanceService) {}

  async read(input: any) {
    const reportDate = dateOnly(input.report_date, 'report_date', true) as string;
    const ids = input.entity_ids === undefined ? [] : typeof input.entity_ids === 'string' ? input.entity_ids.split(',') : input.entity_ids;
    if (!Array.isArray(ids) || ids.length > 50) throw new FinanceError('INVALID_ID', '一次最多选择 50 个投资主体', 'entity_ids');
    const entityIds = ids.map((id: any) => uuid(id, 'entity_ids'));
    const clientCode = input.client_code;
    if (clientCode !== undefined && (typeof clientCode !== 'string' || !clientCode.trim() || clientCode.length > 30)) throw new FinanceError('INVALID_FILTER', '客户编号无效', 'client_code');
    if (!entityIds.length && !clientCode) throw new FinanceError('REQUIRED', '请选择投资主体或客户编号', 'entity_ids');

    return this.service.db.sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async (transaction: any) => {
      const sql = (text: string, replacements: any) => this.service.db.sequelize.query(text, { replacements, transaction, type: QueryTypes.SELECT });
      const where = [entityIds.length ? 'e.id IN (:entityIds)' : null, clientCode ? 'g.client_code=:clientCode' : null].filter(Boolean).join(' AND ');
      const entities: any[] = await sql(`SELECT e.id,e.legal_name,e.common_name,e.is_deleted,g.client_code
        FROM finance_investment_entities e JOIN finance_client_groups g ON g.id=e.client_group_id
        WHERE ${where} ORDER BY g.client_code,e.created_at,e.id`, { entityIds, clientCode });
      if (!entities.length) throw new FinanceError('NOT_FOUND', '没有找到对应的投资主体', 'entity_ids', 404);
      const scope = { entityIds: entities.map(row => row.id), reportDate };

      const transactions: any[] = await sql(`SELECT id,entity_id,share_class_id,transaction_type,confirmation_date::text,
          amount::text,currency,confirmed_units::text,confirmed_nav::text,fee_rate::text,fee::text,remarks,
          source_batch_id,source_sheet,source_row
        FROM finance_transactions WHERE NOT is_void AND entity_id IN (:entityIds) AND confirmation_date<=:reportDate
        ORDER BY confirmation_date,created_at,id`, scope);
      const classIds = [...new Set(transactions.map(row => row.share_class_id))];
      const byClass = { classIds, reportDate };
      const empty = !classIds.length;

      const shareClasses: any[] = empty ? [] : await sql(`SELECT s.id,s.fund_id,s.isin,s.class_label,s.currency,s.is_deleted,
          f.short_name,f.full_name,f.fund_kind,f.strategy,f.strategy_detail,f.allocation_role,f.investment_region,
          f.is_deleted AS fund_deleted,f.business_version
        FROM finance_share_classes s JOIN finance_funds f ON f.id=s.fund_id WHERE s.id IN (:classIds)
        ORDER BY f.short_name,s.class_label,s.id`, byClass);
      const navs: any[] = empty ? [] : await sql(`SELECT share_class_id,nav_date::text,nav_per_unit::text,source_batch_id,source_sheet,source_row
        FROM finance_fund_navs WHERE share_class_id IN (:classIds) AND nav_date<=:reportDate ORDER BY share_class_id,nav_date`, byClass);
      const returns: any[] = empty ? [] : await sql(`SELECT share_class_id,return_date::text,mtd_return::text,estimate_label,source_batch_id,source_sheet,source_row
        FROM finance_fund_returns WHERE share_class_id IN (:classIds) AND return_date<=:reportDate ORDER BY share_class_id,return_date`, byClass);
      const benchmarks: any[] = await sql(`SELECT id,name,category FROM finance_benchmarks ORDER BY created_at,id`, {});
      const benchmarkValues: any[] = await sql(`SELECT benchmark_id,value_date::text,index_value::text
        FROM finance_benchmark_values WHERE value_date<=:reportDate ORDER BY benchmark_id,value_date`, { reportDate });
      const [{ snapshot_at }]: any[] = await sql('SELECT now() AS snapshot_at', {});

      return { schema: REPORT_SNAPSHOT_SCHEMA, report_date: reportDate, snapshot_at, demo_mode: this.service.demoMode,
        entities, share_classes: shareClasses, transactions, fund_navs: navs, fund_returns: returns,
        benchmarks, benchmark_values: benchmarkValues };
    });
  }
}
