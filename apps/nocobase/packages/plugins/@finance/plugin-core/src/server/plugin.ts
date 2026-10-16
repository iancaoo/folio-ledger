import { Plugin } from '@nocobase/server';
import { catalog, collections } from '../shared/models';
import { FinanceError } from '../shared/values';
import { FinanceService } from './service';
import { installWriteGuard } from './write-scope';
import { FinanceImports } from './imports';
import { FinanceOptions } from './options';
import { initializeFinance } from './initialize';
import { Op } from 'sequelize';
import { applyFinanceConstraints } from './constraints';
import { FinanceFiles } from './files';
import { FinanceQueries } from './queries';
import { FinanceDrafts } from './drafts';
import { FinanceIssues } from './issues';
import { FinanceExports } from './exports';
import { FinanceReportSnapshot } from './report-snapshot';
import { FinanceReports } from './reports';

export default class FinancePlugin extends Plugin {
  service: FinanceService;
  async install() { await initializeFinance(this.db); await applyFinanceConstraints(this.db); }
  async beforeLoad() {
    for (const collection of collections) this.db.collection({ ...collection, origin: '@finance/plugin-core', migrationRules: ['schema-only'], dumpRules: { group: 'business' } } as any);
    installWriteGuard(this.db);
    this.service = new FinanceService(this.db, process.env.FINANCE_DEMO_MODE === 'true');
  }
  async load() {
    const service = this.service;
    const queries = new FinanceQueries(service);
    const drafts = new FinanceDrafts(service);
    const issues = new FinanceIssues(service);
    const reportSnapshot = new FinanceReportSnapshot(service);
    const imports = new FinanceImports(service);
    const options = new FinanceOptions(service);
    const reports = new FinanceReports(service, reportSnapshot, options);
    const files = new FinanceFiles(service, this.app.pm.get('file-manager'));
    const rolesOf = (ctx: any) => ctx.state.currentRoles || [ctx.state.currentRole];
    const canConfigure = (ctx: any) => rolesOf(ctx).some((role: string) => ['root', 'admin', 'finance_configurator'].includes(role));
    const check = (ctx: any, write: boolean) => {
      if (!ctx.state.currentUser?.id) throw new FinanceError('UNAUTHENTICATED', '请先登录', undefined, 401);
      const roles = rolesOf(ctx);
      const allowed = write ? ['root', 'admin', 'finance_editor'] : ['root', 'admin', 'finance_editor', 'finance_reader', 'finance_configurator'];
      if (!roles.some((role: string) => allowed.includes(role))) throw new FinanceError('FORBIDDEN', '当前角色没有此 Finance 操作权限', undefined, 403);
    };
    const respond = (work: (ctx: any) => Promise<any>, write = false) => async (ctx: any, next: any) => {
      ctx.withoutDataWrapping = true;
      try {
        check(ctx, write);
        const result = await work(ctx);
        if (ctx.action.actionName === 'list') {
          const { rows, ...meta } = result;
          ctx.body = { data: rows, meta };
        } else ctx.body = { data: result };
        await next();
      } catch (error: any) {
        if (error instanceof FinanceError) { ctx.status = error.status; ctx.body = { errors: [{ code: error.code, message: error.message, field_path: error.field_path, details: error.details }] }; }
        else if (error.name === 'SequelizeUniqueConstraintError') { ctx.status = 409; ctx.body = { errors: [{ code: 'DUPLICATE_KEY', message: '唯一标识已存在，请检查 ISIN、日期或重复行' }] }; }
        else throw error;
      }
    };
    const mutations = { saveFund: 'saveFund', saveEntity: 'saveEntity', saveTrade: 'saveTrade', voidTrade: 'voidTrade', saveSeries: 'saveSeries', saveBenchmark: 'saveBenchmark', setDeleted: 'setDeleted', setClassDisabled: 'setClassDisabled', deleteSeries: 'deleteSeries' };
    const actions: any = {};
    for (const [action, method] of Object.entries(mutations)) actions[action] = respond(async ctx => {
      const { request_key, ...input } = ctx.action.params.values || {};
      const { draft, ...payload } = input; const actor = String(ctx.state.currentUser.id);
      return service.write(actor, action, request_key, input, transaction => draft === undefined ? service[method](payload, transaction) : drafts.submit(draft, action, payload, actor, transaction, () => service[method](payload, transaction)));
    }, true);
    actions.drafts = respond(async ctx => drafts.list(ctx.action.params, String(ctx.state.currentUser.id)));
    actions.draft = respond(async ctx => (await drafts.get(ctx.action.params.id, String(ctx.state.currentUser.id))).toJSON());
    for (const [action, method] of Object.entries({ saveDraft: 'save', discardDraft: 'discard' })) actions[action] = respond(async ctx => {
      if (ctx.method !== 'POST') throw new FinanceError('METHOD_NOT_ALLOWED', '草稿写入仅接受 POST', undefined, 405);
      const { request_key, ...payload } = ctx.action.params.values || {}; const actor = String(ctx.state.currentUser.id);
      return service.write(actor, action, request_key, payload, transaction => drafts[method](payload, actor, transaction));
    }, true);
    actions.stageImport = respond(async ctx => {
      const result = await imports.upload(ctx.action.params.values || {}, String(ctx.state.currentUser.id));
      setImmediate(() => void imports.process(result.batch_id).catch(error => this.log.error('Finance import parsing failed', { error })));
      return result;
    }, true);
    for (const [action, method] of Object.entries({ previewImport: 'preview', commitImport: 'commit', retryImport: 'retryParse', cancelImport: 'cancel' })) actions[action] = respond(async ctx => {
      const { request_key, ...payload } = ctx.action.params.values || {};
      const actor = String(ctx.state.currentUser.id);
      const result = await service.write(actor, action, request_key, payload, transaction => imports[method](payload, transaction, actor));
      if (action === 'retryImport') setImmediate(() => void imports.process(result.batch_id).catch(error => this.log.error('Finance import retry failed', { error })));
      return result;
    }, true);
    actions.importBatch = respond(async ctx => imports.view(ctx.action.params.id, String(ctx.state.currentUser.id)));
    actions.importBatches = respond(async ctx => imports.list(String(ctx.state.currentUser.id), Number(ctx.action.params.page) || 1, Number(ctx.action.params.page_size) || 20));
    actions.downloadImport = async ctx => {
      try { check(ctx, false); await imports.download(ctx, ctx.action.params.id, String(ctx.state.currentUser.id)); }
      catch (error: any) { if (!(error instanceof FinanceError)) throw error; ctx.withoutDataWrapping = true; ctx.status = error.status; ctx.body = { errors: [{ code: error.code, message: error.message }] }; }
    };
    actions.documents = respond(async ctx => files.list(ctx.action.params.fund_id));
    actions.fileTasks = respond(async ctx => files.tasks(ctx.action.params.fund_id, String(ctx.state.currentUser.id)));
    actions.fileTask = respond(async ctx => files.view(await files.task(ctx.action.params.id, String(ctx.state.currentUser.id))));
    for (const [action, method] of Object.entries({ uploadDocument: 'upload', deleteDocument: 'requestDelete', retryFile: 'retry', cancelUpload: 'cancelUpload' })) actions[action] = respond(async ctx => {
      const result = await files[method](ctx.action.params.values || {}, String(ctx.state.currentUser.id));
      if (!['complete', 'cancelled'].includes(result.status)) ctx.status = 202;
      return result;
    }, true);
    const fileDownload = async (ctx: any, id: string, byRecord = false) => {
      try { check(ctx, false); await files.download(ctx, id, byRecord); }
      catch (error: any) {
        if (!(error instanceof FinanceError)) throw error;
        ctx.withoutDataWrapping = true; ctx.status = error.status;
        ctx.body = { errors: [{ code: error.code, message: error.message }] };
      }
    };
    actions.downloadDocument = async (ctx: any) => fileDownload(ctx, ctx.action.params.id);
    actions.exportData = async (ctx: any) => {
      ctx.withoutDataWrapping = true;
      try {
        check(ctx, false);
        const { resourceName, actionName, values, filterByTk, ...input } = ctx.action.params;
        if (ctx.method !== 'GET' || filterByTk !== undefined || values && Object.keys(values).length) throw new FinanceError('INVALID_EXPORT_FILTER', '请使用业务导出页面提供的筛选条件');
        const result = await new FinanceExports(service).download(input);
        ctx.body = result.bytes; ctx.attachment(result.filename); ctx.type = result.contentType;
        ctx.set('Cache-Control', 'private, no-store'); ctx.set('X-Finance-Count', String(result.count)); ctx.set('X-Finance-Parts', String(result.parts));
      } catch (error: any) {
        if (!(error instanceof FinanceError)) throw error;
        ctx.status = error.status; ctx.body = { errors: [{ code: error.code, message: error.message, field_path: error.field_path }] };
      }
    };
    actions.exportSeries = async (ctx: any, next: any) => {
      check(ctx, false);
      ctx.withoutDataWrapping = true;
      ctx.body = await imports.exportSeries(ctx.action.params.data_type, ctx.action.params.share_class_id);
      ctx.attachment('finance-series.xlsx');
      ctx.type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      await next();
    };
    actions.tradeTemplate = async (ctx: any) => {
      check(ctx, false); ctx.withoutDataWrapping = true;
      ctx.body = await imports.tradeTemplate(); ctx.attachment('Finance-交易导入模板.xlsx');
      ctx.type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; ctx.set('Cache-Control', 'private, no-store');
    };
    actions.mainTemplate = async (ctx: any) => {
      check(ctx, false); ctx.withoutDataWrapping = true;
      ctx.body = await imports.mainTemplate(ctx.action.params.data_type, ctx.action.params.fund_kind);
      ctx.attachment('Finance-主数据导入模板.xlsx'); ctx.type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; ctx.set('Cache-Control', 'private, no-store');
    };
    actions.seriesTemplate = async (ctx: any) => {
      check(ctx, false); ctx.withoutDataWrapping = true;
      ctx.body = await imports.seriesTemplate(ctx.action.params.data_type, ctx.action.params.target_mode);
      ctx.attachment('Finance-时序数据导入模板.xlsx'); ctx.type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; ctx.set('Cache-Control', 'private, no-store');
    };
    actions.options = respond(async () => options.list());
    actions.saveOptions = respond(async ctx => {
      if (!canConfigure(ctx)) throw new FinanceError('FORBIDDEN', '仅候选配置管理员可以修改候选集', undefined, 403);
      const { request_key, ...payload } = ctx.action.params.values || {};
      return service.write(String(ctx.state.currentUser.id), 'saveOptions', request_key, payload, transaction => options.save(payload, transaction));
    });
    actions.users = respond(async ctx => {
      const search = String(ctx.action.params.search || '').slice(0, 100);
      const coverage = ctx.action.params.group === 'product';
      const memberships = coverage && !service.demoMode ? await this.db.getModel('rolesUsers').findAll({ where: { roleName: 'finance_product' }, attributes: ['userId'] }) : null;
      const where = { ...(memberships ? { id: { [Op.in]: memberships.map(row => row.get('userId')) } } : {}), ...(search ? { [Op.or]: [{ nickname: { [Op.iLike]: `%${search}%` } }, { username: { [Op.iLike]: `%${search}%` } }] } : {}) };
      const rows = await this.db.getModel('users').findAll({ where, attributes: ['id', 'nickname', 'username'], order: [['id', 'ASC']], limit: 100 });
      return rows.map(row => ({ value: String(row.id), label: row.get('nickname') || row.get('username') || `用户 ${row.id}` }));
    });
    actions.metadata = respond(async ctx => ({ demo_mode: service.demoMode, field_catalog: catalog, version: '0.1.0',
      permissions: { write: rolesOf(ctx).some((role: string) => ['root', 'admin', 'finance_editor'].includes(role)), configure: canConfigure(ctx) },
      current_user_id: String(ctx.state.currentUser.id), options: await options.list(),
    }));
    actions.positions = respond(async ctx => service.positions(ctx.action.params.entity_id, ctx.action.params.as_of));
    actions.fund = respond(async ctx => service.fundAggregate(ctx.action.params.id));
    actions.entity = respond(async ctx => service.entityAggregate(ctx.action.params.id));
    actions.versions = respond(async ctx => service.versions(ctx.action.params.fund_id));
    actions.compositions = respond(async ctx => service.compositionValues(ctx.action.params.fund_id));
    actions.list = respond(async ctx => queries.list(ctx.action.params));
    actions.lookup = respond(async ctx => queries.lookup(ctx.action.params));
    actions.userLookup = respond(async ctx => queries.userLookup(ctx.action.params));
    actions.summary = respond(async () => queries.summary());
    actions.navCoverage = respond(async ctx => queries.navCoverage(ctx.action.params));
    actions.seriesAt = respond(async ctx => queries.seriesAt(ctx.action.params));
    actions.positionList = respond(async ctx => queries.positions(ctx.action.params));
    actions.reportSnapshot = respond(async ctx => reportSnapshot.read(ctx.action.params));
    const postOnly = (ctx: any) => { if (ctx.method !== 'POST') throw new FinanceError('METHOD_NOT_ALLOWED', '月报操作仅接受 POST', undefined, 405); };
    actions.requestReports = respond(async ctx => {
      postOnly(ctx);
      const { request_key, ...payload } = ctx.action.params.values || {};
      const result = await service.write(String(ctx.state.currentUser.id), 'requestReports', request_key, payload, transaction => reports.request(payload, String(ctx.state.currentUser.id), transaction));
      for (const id of result.run_ids) setImmediate(() => void reports.process(id).catch(error => this.log.error('Finance report generation failed', { error })));
      return result;
    }, true);
    for (const [action, method] of Object.entries({ publishReport: 'publish', retryReport: 'retry' })) actions[action] = respond(async ctx => {
      postOnly(ctx);
      const { request_key, ...payload } = ctx.action.params.values || {}; const actor = String(ctx.state.currentUser.id);
      const result = await service.write(actor, action, request_key, payload, transaction => method === 'publish' ? reports.publish(payload, actor, transaction) : reports.retry(payload, transaction));
      if (action === 'retryReport') setImmediate(() => void reports.process(result.id).catch(error => this.log.error('Finance report retry failed', { error })));
      return result;
    }, true);
    actions.reportRuns = respond(async ctx => reports.list(ctx.action.params));
    actions.reportRun = respond(async ctx => reports.get(ctx.action.params.id));
    actions.reportTrace = respond(async ctx => reports.trace(ctx.action.params.id));
    actions.reportDocument = async (ctx: any) => {
      try { check(ctx, false); await reports.document(ctx, ctx.action.params); }
      catch (error: any) { if (!(error instanceof FinanceError)) throw error; ctx.withoutDataWrapping = true; ctx.status = error.status; ctx.body = { errors: [{ code: error.code, message: error.message }] }; }
    };
    actions.issues = respond(async ctx => issues.list(ctx.action.params, String(ctx.state.currentUser.id)));
    this.app.resourceManager.define({ name: 'finance', actions });
    for (const action of Object.keys(actions)) this.app.acl.allow('finance', action, 'loggedIn');
    // Stable internal collections are accessible through the domain API only, even for root.
    this.app.resourceManager.use(async (ctx: any, next: any) => {
      const resource = ctx.action?.resourceName || '';
      if (resource === 'finance_file_records' && ctx.action?.actionName === 'getFile') {
        await fileDownload(ctx, ctx.action.params.filterByTk || ctx.state.fileAccess?.id, true);
        return;
      }
      if (resource.split('.').some((part: string) => part.startsWith('finance_'))) {
        ctx.withoutDataWrapping = true;
        ctx.status = 403;
        ctx.body = { errors: [{ code: 'DOMAIN_API_REQUIRED', message: '请使用 Finance 业务接口访问数据' }] };
        return;
      }
      await next();
    }, { tag: 'finance-domain-api', after: 'auth', before: 'acl' });
    let worker: ReturnType<typeof setInterval> | undefined;
    let recovering = false;
    this.app.on('afterStart', () => {
      const recover = async () => {
        if (recovering) return;
        recovering = true;
        try { await Promise.all([files.recover(), imports.recover(), reports.recover()]); }
        catch (error) { this.log.error('Finance recovery failed', { error }); }
        finally { recovering = false; }
      };
      void recover();
      if (!worker) { worker = setInterval(recover, 30000); worker.unref(); }
    });
    this.app.on('beforeStop', async () => { if (worker) clearInterval(worker); worker = undefined; reports.stopping = true; await imports.close(); });
  }
}
