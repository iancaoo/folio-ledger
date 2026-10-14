import { Worker } from 'node:worker_threads';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import { FinanceError } from '../shared/values';

const bootstrap = `
const { parentPort, workerData } = require('node:worker_threads');
if (workerData.register) require(workerData.register);
const { parseUpload } = require(workerData.parser);
parentPort.on('message', ({ filename, bytes }) => {
  try { parentPort.postMessage({ result: parseUpload(filename, Buffer.from(bytes)) }); }
  catch (error) { parentPort.postMessage({ error: { code: error.code || 'INVALID_WORKBOOK', message: error.code ? error.message : '文件解析未完成，请检查文件内容后重试', field_path: error.field_path, details: error.details } }); }
});`;

/** One reusable thread per importer. The owning queue serializes durable claims. */
export class ImportParserWorker {
  worker?: Worker;
  pending?: { resolve: (value: any) => void; reject: (error: any) => void; timer: ReturnType<typeof setTimeout> };
  start() {
    const parser = require.resolve('./import-parser');
    // Source tests use the existing TSX runtime. Shipped .js uses only Node.
    const loader = parser.endsWith('.ts') && process.execArgv.find(arg => arg.includes('/tsx/dist/loader.mjs'));
    const loaderPath = loader && loader.replace(/^--import=/, '');
    const register = loaderPath ? fileURLToPath(new URL('./cjs/index.cjs', loaderPath.startsWith('file:') ? loaderPath : pathToFileURL(loaderPath))) : null;
    const worker = new Worker(bootstrap, { eval: true, execArgv: [], workerData: { parser, register }, resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 4 } });
    this.worker = worker;
    worker.on('message', message => {
      if (this.worker !== worker || !this.pending) return;
      const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer); worker.unref();
      if (message.error) pending.reject(new FinanceError(message.error.code, message.error.message, message.error.field_path, 422, message.error.details));
      else pending.resolve(message.result);
    });
    const fail = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      if (this.pending) { const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer); pending.reject(new FinanceError('PARSER_INTERRUPTED', '解析进程已中断，可重试；如反复发生请缩小文件并检查内容')); }
    };
    worker.on('error', fail); worker.on('exit', fail); worker.unref();
  }
  parse(filename: string, bytes: Buffer): Promise<any> {
    if (this.pending) throw new FinanceError('PARSER_BUSY', '解析任务正忙，请稍后重试');
    if (!this.worker) this.start();
    this.worker.ref();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const worker = this.worker; this.worker = undefined; this.pending = undefined;
        void worker?.terminate(); reject(new FinanceError('PARSER_TIMEOUT', '文件解析超过 60 秒，请拆分文件或转为数值后重试'));
      }, 60000);
      this.pending = { resolve, reject, timer };
      this.worker.postMessage({ filename, bytes });
    });
  }
  async close() {
    const worker = this.worker; this.worker = undefined;
    if (this.pending) { const pending = this.pending; this.pending = undefined; clearTimeout(pending.timer); pending.reject(new FinanceError('PARSER_INTERRUPTED', '应用停止，解析未完成，可在启动后重试')); }
    if (worker) await worker.terminate();
  }
}
