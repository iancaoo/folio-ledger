import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { Op } from 'sequelize';
import { FinanceError } from '../shared/values';
import { FinanceService, uuid } from './service';
import { configurationLock } from './options';
import { domainWrite, writeOptions } from './write-scope';

const plain = row => row?.get ? row.get({ plain: true }) : row;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES = 10 * 1024 * 1024;
const mimeTypes = { '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.csv': 'text/csv', '.txt': 'text/plain' };
export function validateDocument(name: any, encoded: any) {
  if (typeof name !== 'string' || !name || name.length > 240 || /[\u0000-\u001f]/.test(name) || typeof encoded !== 'string' || encoded.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new FinanceError('INVALID_FILE', '文件名称或内容无效，单文件上限为 10 MB', 'file');
  const original_name = name.split(/[\\/]/).pop()!;
  const extname = path.extname(original_name).toLowerCase();
  const mimetype = mimeTypes[extname];
  const bytes = Buffer.from(encoded, 'base64');
  if (!mimetype || !bytes.length || bytes.length > MAX_BYTES) throw new FinanceError('INVALID_FILE_TYPE', '请选择 PDF、Word、Excel、常见图片或文本文件，大小不超过 10 MB', 'file');
  const head = bytes.subarray(0, 12);
  const hex = head.toString('hex');
  const valid = extname === '.pdf' ? head.toString('ascii').startsWith('%PDF-')
    : ['.docx', '.xlsx'].includes(extname) ? hex.startsWith('504b0304')
    : ['.doc', '.xls'].includes(extname) ? hex.startsWith('d0cf11e0a1b11ae1')
    : extname === '.png' ? hex.startsWith('89504e470d0a1a0a')
    : ['.jpg', '.jpeg'].includes(extname) ? hex.startsWith('ffd8ff')
    : extname === '.gif' ? /^GIF8[79]a/.test(head.toString('ascii'))
    : extname === '.webp' ? head.toString('ascii').startsWith('RIFF') && head.toString('ascii').slice(8) === 'WEBP' : true;
  if (!valid) throw new FinanceError('FILE_SIGNATURE_MISMATCH', '文件内容与扩展名不符，请检查原文件', 'file');
  if (['.csv', '.txt'].includes(extname)) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new FinanceError('FILE_ENCODING', '文本文件请使用 UTF-8 编码', 'file'); }
  }
  return { original_name, extname, mimetype, size: bytes.length, sha256: sha(bytes), bytes };
}

export class FinanceFiles {
  constructor(public service: FinanceService, public manager: any, public directory = path.join(process.env.STORAGE_PATH || path.resolve('storage'), 'finance')) {}
  async storage() {
    await this.manager.loadStorages();
    const storage = [...this.manager.storagesCache.values()].find((row: any) => row.name === 'finance_private') as any;
    if (!storage || storage.options?.public || storage.options?.useOriginalUrl) throw new FinanceError('FILE_STORAGE_CONFIG', 'Finance 私有文件存储未正确初始化');
    return { storage, adapter: new (this.manager.storageTypes.get(storage.type))(storage) };
  }
  async task(id: string, actor: string, transaction?: any) {
    const row = await this.service.requiredRow('file_operations', id, transaction);
    if (row.get('owner_id') !== actor) throw new FinanceError('FORBIDDEN', '只能处理本人发起的文件任务', 'task_id', 403);
    return row;
  }
  view(row: any) {
    return { task_id: row.id, fund_id: row.get('fund_id'), status: row.get('status'), operation: row.get('operation'), document_id: row.get('result')?.document_id || row.get('document_id'), original_name: row.get('context')?.original_name, error: row.get('error') || null };
  }
  async upload(payload: any, actor: string) {
    if (Object.keys(payload).some(key => !['fund_id', 'document_type', 'original_name', 'content_base64', 'request_key'].includes(key))) throw new FinanceError('FIELD_NOT_WRITABLE', '此文件字段不可直接写入');
    const file = validateDocument(payload.original_name, payload.content_base64);
    const { request_key, ...input } = payload;
    const outcome = await this.service.write(actor, 'uploadDocument', request_key, input, async transaction => {
      const fundId = uuid(input.fund_id, 'fund_id');
      await this.service.lock([`fund:${fundId}`], transaction);
      await this.service.requiredRow('funds', fundId, transaction, true);
      if (typeof input.document_type !== 'string' || !input.document_type.trim()) throw new FinanceError('REQUIRED', '请选择文档类型', 'document_type');
      await this.service.validateOption('净值与文档:13', input.document_type, transaction, 'document_type');
      const id = randomUUID();
      const { bytes, ...context } = file;
      return plain(await this.service.model('file_operations').create({ id, fund_id: fundId, owner_id: actor, operation: 'upload', status: 'pending', storage_key: `${id}${file.extname}`, context: { ...context, fund_id: fundId, document_type: input.document_type } }, writeOptions(transaction)));
    });
    await this.task(outcome.id, actor);
    return this.process(outcome.id, file.bytes);
  }
  async requestDelete(payload: any, actor: string) {
    if (Object.keys(payload).some(key => !['id', 'technical_revision', 'request_key'].includes(key))) throw new FinanceError('FIELD_NOT_WRITABLE', '此文件字段不可直接写入');
    const { request_key, ...input } = payload;
    const outcome = await this.service.write(actor, 'deleteDocument', request_key, input, async transaction => {
      await this.service.lock([`document:${uuid(input.id, 'id')}`], transaction);
      const document = await this.service.requiredRow('fund_documents', input.id, transaction);
      if (document.get('deleting')) {
        const existing = await this.service.model('file_operations').findOne({ where: { document_id: document.id, operation: 'delete' }, ...writeOptions(transaction) });
        if (!existing || existing.get('owner_id') !== actor) throw new FinanceError('FILE_TASK_IN_PROGRESS', '文档正在由另一文件任务处理，请查询状态', 'id', 409);
        return plain(existing);
      }
      this.service.revision(document, input.technical_revision);
      const file = await this.service.requiredRow('file_records', document.get('storage_key'), transaction);
      await document.update({ deleting: true, technical_revision: document.get('technical_revision') + 1 }, writeOptions(transaction));
      return plain(await this.service.model('file_operations').create({ id: randomUUID(), fund_id: document.get('fund_id'), owner_id: actor, operation: 'delete', status: 'pending', storage_key: file.get('filename'), document_id: document.id, context: { record_id: file.id, document_id: document.id } }, writeOptions(transaction)));
    });
    await this.task(outcome.id, actor);
    return this.process(outcome.id);
  }
  async retry(payload: any, actor: string) {
    if (Object.keys(payload).some(key => !['task_id', 'request_key', 'content_base64'].includes(key))) throw new FinanceError('FIELD_NOT_WRITABLE', '仅允许重试指定文件任务');
    const task = await this.task(uuid(payload.task_id, 'task_id'), actor);
    let bytes: Buffer | undefined;
    if (payload.content_base64 && !['complete', 'cancelled'].includes(task.get('status'))) {
      if (task.get('operation') !== 'upload') throw new FinanceError('INVALID_FILE_TASK', '删除任务无需重新上传文件');
      const file = validateDocument(task.get('context').original_name, payload.content_base64);
      if (file.sha256 !== task.get('context').sha256) throw new FinanceError('FILE_CONTENT_MISMATCH', '请选择本次上传的原文件，内容必须一致');
      bytes = file.bytes;
    }
    const { request_key, ...input } = payload;
    await this.service.write(actor, 'retryFile', request_key, input, async () => ({ id: payload.task_id, technical_revision: 1 }));
    return this.process(payload.task_id, bytes);
  }
  async cancelUpload(payload: any, actor: string) {
    if (Object.keys(payload).some(key => !['task_id', 'request_key'].includes(key))) throw new FinanceError('FIELD_NOT_WRITABLE', '仅允许取消指定上传任务');
    const id = uuid(payload.task_id, 'task_id');
    await this.service.write(actor, 'cancelUpload', payload.request_key, { task_id: id }, async transaction => {
      await this.service.lock([`file-task:${id}`], transaction);
      const task = await this.task(id, actor, transaction);
      if (task.get('status') === 'cancelled') return plain(task);
      if (task.get('status') === 'complete' || !['upload', 'cancel_upload'].includes(task.get('operation'))) throw new FinanceError('FILE_TASK_NOT_CANCELLABLE', '只能取消尚未关联成功的上传；已上传文档请使用删除');
      await task.update({ operation: 'cancel_upload', status: 'pending', technical_revision: task.get('technical_revision') + 1 }, writeOptions(transaction));
      return plain(task);
    });
    return this.process(id);
  }
  async process(id: string, bytes?: Buffer) {
    try {
      return await domainWrite(() => this.service.db.sequelize.transaction(async transaction => {
        await configurationLock(this.service.db, transaction);
        await this.service.lock([`file-task:${id}`], transaction);
        const task = await this.service.requiredRow('file_operations', id, transaction);
        if (['complete', 'cancelled'].includes(task.get('status'))) return this.view(task);
        const context = task.get('context');
        const { storage, adapter } = await this.storage();
        if (task.get('operation') === 'upload') {
          const filename = task.get('storage_key');
          // This filename was reserved in a committed task before any filesystem work.
          const staging = path.join(this.directory, 'staging', filename);
          await mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
          let content = bytes;
          if (!content) {
            try { content = await readFile(staging); }
            catch (error: any) { if (error.code !== 'ENOENT') throw error; }
          }
          const recordData = { title: path.basename(context.original_name, context.extname), filename, extname: context.extname, mimetype: context.mimetype, size: context.size, path: '', storageId: storage.id, meta: { sha256: context.sha256 } };
          if (!await adapter.exists(recordData)) {
            if (!content) {
              await task.update({ status: 'awaiting_upload', error: '文件尚未写入，请重新提交同一次上传' }, writeOptions(transaction));
              return this.view(task);
            }
            if (sha(content) !== context.sha256 || content.length !== context.size) throw new FinanceError('FILE_CONTENT_MISMATCH', '上传内容与原请求不一致');
            await writeFile(staging, content, { mode: 0o600 });
            await this.manager.uploadFile({ filePath: staging, storageName: 'finance_private' });
          }
          const stream = (await adapter.getFileStream(recordData)).stream;
          const hash = createHash('sha256'); let size = 0;
          for await (const chunk of stream) { hash.update(chunk); size += chunk.length; }
          if (size !== context.size || hash.digest('hex') !== context.sha256) throw new FinanceError('FILE_CONTENT_MISMATCH', '存储文件校验未通过，请联系管理员检查文件任务');
          await this.service.lock([`fund:${context.fund_id}`], transaction);
          await this.service.requiredRow('funds', context.fund_id, transaction, true);
          await this.service.validateOption('净值与文档:13', context.document_type, transaction, 'document_type');
          const file = await this.service.model('file_records').create({ id: randomUUID(), ...recordData }, writeOptions(transaction));
          const document = await this.service.model('fund_documents').create({ id: randomUUID(), fund_id: context.fund_id, document_type: context.document_type, original_name: context.original_name, size_bytes: String(context.size), uploaded_at: new Date(), storage_key: file.id }, writeOptions(transaction));
          await task.update({ status: 'complete', document_id: document.id, result: { document_id: document.id }, context: null, error: null, technical_revision: task.get('technical_revision') + 1 }, writeOptions(transaction));
          // Cleanup is safe to retry; the deterministic destination and task survive a crash.
          await unlink(staging).catch(error => { if (error.code !== 'ENOENT') return; });
        } else if (task.get('operation') === 'cancel_upload') {
          const [deleted] = await adapter.delete([{ filename: task.get('storage_key'), path: '' }]);
          if (!deleted) throw new FinanceError('FILE_DELETE_FAILED', '暂存文件清理未完成，可重试');
          await unlink(path.join(this.directory, 'staging', task.get('storage_key'))).catch(error => { if (error.code !== 'ENOENT') throw error; });
          await task.update({ status: 'cancelled', context: null, error: null, technical_revision: task.get('technical_revision') + 1 }, writeOptions(transaction));
        } else {
          const file = await this.service.model('file_records').findByPk(context.record_id, writeOptions(transaction));
          if (file) {
            const [deleted] = await adapter.delete([{ ...plain(file), storageId: storage.id }]);
            if (!deleted) throw new FinanceError('FILE_DELETE_FAILED', '文件删除未完成，可重试');
          }
          // Clear both upload and deletion task references before deleting metadata.
          await this.service.model('file_operations').update({ document_id: null }, { where: { document_id: context.document_id }, ...writeOptions(transaction) });
          await this.service.model('fund_documents').destroy({ where: { id: context.document_id }, ...writeOptions(transaction) });
          if (file) await file.destroy(writeOptions(transaction));
          await task.update({ status: 'complete', result: { document_id: context.document_id }, context: null, error: null, technical_revision: task.get('technical_revision') + 1 }, writeOptions(transaction));
        }
        return this.view(task);
      }));
    } catch (error: any) {
      this.manager.log?.error('Finance file task failed', { task_id: id, error });
      return domainWrite(() => this.service.db.sequelize.transaction(async transaction => {
        await this.service.lock([`file-task:${id}`], transaction);
        const task = await this.service.requiredRow('file_operations', id, transaction);
        if (!['complete', 'cancelled'].includes(task.get('status'))) await task.update({ status: 'failed', error: error instanceof FinanceError ? error.message : '文件存储操作未完成，可重试；请由维护者检查存储日志', technical_revision: task.get('technical_revision') + 1 }, writeOptions(transaction));
        return this.view(task);
      }));
    }
  }
  async list(fundId: string) {
    await this.service.requiredRow('funds', fundId, undefined);
    const rows = await this.service.model('fund_documents').findAll({ where: { fund_id: fundId }, order: [['uploaded_at', 'DESC']] });
    return Promise.all(rows.map(async row => {
      const { storage_key, ...document } = plain(row);
      const task = row.get('deleting') && await this.service.model('file_operations').findOne({ where: { document_id: row.id, operation: 'delete' } });
      return { ...document, task: task ? this.view(task) : null };
    }));
  }
  async download(ctx: any, id: string, byRecord = false) {
    const documentId = byRecord ? (await this.service.model('fund_documents').findOne({ where: { storage_key: uuid(id, 'id') } }))?.id : uuid(id, 'id');
    if (!documentId) throw new FinanceError('FILE_UNAVAILABLE', '文档不存在或正在删除', 'id', 404);
    await this.service.db.sequelize.transaction(async transaction => {
      // Serialize authorization + open with the durable deletion marker. A
      // download already opened may finish; no new one starts after deletion.
      await this.service.lock([`document:${documentId}`], transaction);
      const document = await this.service.model('fund_documents').findByPk(documentId, { transaction });
      if (!document || document.get('deleting')) throw new FinanceError('FILE_UNAVAILABLE', '文档不存在或正在删除', 'id', 404);
      const file = await this.service.requiredRow('file_records', document.get('storage_key'), transaction);
      const { storage } = await this.storage();
      let stream;
      try {
        stream = (await this.manager.getFileStream({ ...plain(file), storageId: storage.id })).stream;
        if (stream.pending) await once(stream, 'open');
      } catch { throw new FinanceError('FILE_UNAVAILABLE', '文件暂时不可读取，请联系维护者检查存储', 'id', 404); }
      ctx.withoutDataWrapping = true;
      ctx.body = stream;
      ctx.type = 'application/octet-stream'; ctx.attachment(document.get('original_name'));
      ctx.set('Cache-Control', 'private, no-store'); ctx.set('X-Content-Type-Options', 'nosniff');
    });
  }
  async tasks(fundId: string, actor: string) {
    uuid(fundId, 'fund_id');
    const rows = await this.service.model('file_operations').findAll({ where: { fund_id: fundId, owner_id: actor }, limit: 50, order: [['created_at', 'DESC']] });
    return rows.map(row => this.view(row));
  }
  async recover() {
    const configuredHours = Number(process.env.FINANCE_STAGED_FILE_RETENTION_HOURS || 168);
    const hours = Number.isFinite(configuredHours) && configuredHours >= 1 ? configuredHours : 168;
    const expired = await this.service.model('file_operations').findAll({ where: { operation: 'upload', status: { [Op.in]: ['pending', 'failed', 'awaiting_upload'] }, created_at: { [Op.lt]: new Date(Date.now() - hours * 3600000) } }, limit: 50 });
    for (const task of expired) await this.cancelUpload({ task_id: task.id, request_key: `expire:${task.id}` }, task.get('owner_id'));
    const tasks = await this.service.model('file_operations').findAll({ where: { status: { [Op.in]: ['pending', 'failed'] } }, limit: 50, order: [['updated_at', 'ASC'], ['id', 'ASC']] });
    for (const task of tasks) await this.process(task.id);
    // A failed staging unlink must not leave an extra online copy indefinitely.
    const staging = path.join(this.directory, 'staging');
    const names = await readdir(staging).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (names.length) {
      const finished = await this.service.model('file_operations').findAll({ where: { status: { [Op.in]: ['complete', 'cancelled'] }, storage_key: { [Op.in]: names } } });
      for (const task of finished) await unlink(path.join(staging, task.get('storage_key'))).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
