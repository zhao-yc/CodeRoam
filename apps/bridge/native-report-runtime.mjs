import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { AsarReader } from '../../packages/protocol/asar-reader.mjs';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { nativeReportLayout } from './native-report-layout.mjs';
import { nativeReportCurrentLayout } from './native-report-current-layout.mjs';

const archiveCacheLimit = 4;
const maxParallelReports = 4;
const maxInputBytes = 1024 * 1024;
const allowedKinds = new Set(['add','update','delete']);
const executablePattern = /[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/](?:ChatGPT|Codex)\.exe$/i;

class UnsupportedNativeReportVersion extends Error {}

/** 调用方负责验证进程所有权；这里再次核对安装路径并拒绝越出包目录的资源。 */
function archiveForExecutable(executable) {
  if (process.platform !== 'win32' || typeof executable !== 'string' || !path.isAbsolute(executable) || !executablePattern.test(executable)) {
    throw new Error('桌面安装路径不受支持');
  }
  const canonicalExecutable = fs.realpathSync.native(executable);
  if (!executablePattern.test(canonicalExecutable) || canonicalExecutable.toLowerCase() !== path.normalize(executable).toLowerCase()) {
    throw new Error('桌面安装路径已变化');
  }
  const expectedArchive = path.join(path.dirname(canonicalExecutable), 'resources', 'app.asar');
  const archive = fs.realpathSync.native(expectedArchive);
  if (archive.toLowerCase() !== expectedArchive.toLowerCase()) throw new Error('桌面资源路径已变化');
  return archive;
}

/** 缓存按受信安装文件的身份和完整模块哈希区分，更新后重新校验。 */
function archiveIdentity(archive) {
  const stat = fs.statSync(archive, {bigint:true});
  if (!stat.isFile()) throw new Error('桌面资源格式无效');
  return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
}

/** 先验证所有模块完整字节，再从本机提取经过审核的函数和必要初始化。 */
function loadNativeFunctions(archive) {
  const reader = new AsarReader(archive);
  try {
    // 仅按已审核资源入口选择布局，未知版本不能靠文件名猜测后执行。
    const layout = reader.files.has('webview/assets/' + nativeReportCurrentLayout.modules[0][0])
      ? nativeReportCurrentLayout : nativeReportLayout;
    const modules = layout.modules.map(([filename,expected])=>{
      const file = 'webview/assets/' + filename;
      if (!reader.files.has(file)) throw new UnsupportedNativeReportVersion('桌面原生差异模块版本尚未验证');
      const source = reader.text(file);
      if (createHash('sha256').update(source).digest('hex') !== expected) throw new UnsupportedNativeReportVersion('桌面原生差异模块版本尚未验证');
      return source;
    });
    if (layout === nativeReportCurrentLayout) return currentNativeFunctions(modules,layout);
    const slice = ([module,start,end])=>modules[module].slice(start,end);
    const declarations = nativeReportLayout.declarations.map(slice).join('\n');
    const aliases = nativeReportLayout.aliases.map(([name,local])=>`const ${name} = ${local};`).join('\n');
    const initializations = nativeReportLayout.initializations.map(([name,...range])=>`let ${name} = ${slice(range)};`).join('\n');
    const sum = slice(nativeReportLayout.sum);
    return {
      version:nativeReportLayout.modules.map(([,hash])=>hash).join(':'),
      source:`
        'use strict';
        const console = Object.freeze({error(){},warn(){}});
        const Tr = console;
        const SJa = Object.freeze({maxSize:0,get(){},set(){}});
        const xJa = Object.freeze({default:(array,iteratee)=>array?.length ? (${sum})(array,iteratee) : 0});
        // 既有报告调用不提供仓库根目录，保留序列化函数但封闭路径重写分支。
        function zw(){throw new Error('报告不支持重写仓库路径')}
        const F_n = null;
        ${declarations}
        ${aliases}
        ${initializations}
        return Object.freeze({convert:BZt,serialize:k_n,parse:dJa,summarize:t});
      `,
    };
  } finally { reader.close(); }
}

/** 数字分块版只提取已审核定义；模块装载器只连接这些纯计算闭包，不启动桌面应用。 */
function currentNativeFunctions(modules,layout) {
  const slice = (module,start,end)=>modules[module].slice(start,end);
  const sum = slice(...layout.sum);
  const overrides = {
    emptyCache:'Object.freeze({maxSize:0,get(){},set(){}})',
    silentLogger:'Object.freeze({v:Object.freeze({error(){}})})',
    sumBy:'nativeSumBy',
    blockedPaths:'Object.freeze({ph(){throw new Error("报告不支持重写仓库路径")}})',
    noPaths:'null',
  };
  const factories = layout.factories.map(factory=>{
    const replacements = Object.entries(factory.overrides).map(([name,key])=>`const ${name}=${overrides[key]};`).join('\n');
    const declarations = factory.declarations.map(([start,end,variable])=>(variable?'let ':'')+slice(factory.module,start,end)+';').join('\n');
    const exports = factory.exports.map(([name,start,end])=>JSON.stringify(name)+':'+slice(factory.module,start,end)).join(',');
    return `modules[${JSON.stringify(factory.id)}]=()=>{${replacements}\n${declarations}\nreturn {${exports}};};`;
  }).join('\n');
  return {
    version:layout.modules.map(([,hash])=>hash).join(':'),
    source:`
      'use strict';
      const console=Object.freeze({error(){},warn(){}});
      const nativeSumBy=(array,fn)=>array?.length?(${sum})(array,fn):0;
      const modules=Object.create(null),cache=Object.create(null);
      function n(id){if(cache[id])return cache[id];if(!modules[id])throw new Error('未开放原生模块');return cache[id]=modules[id]();}
      n.n=value=>()=>value;
      ${factories}
      return Object.freeze({convert:n('C4Sc').LU,serialize:n('aCkJ').CD,parse:n('JiBc').F,summarize:n('mHZT').s});
    `,
  };
}

/** 复制固定历史字段，限制数量及序列化体积。差异文本始终作为数据传输。 */
function reportInput(batches) {
  if (!Array.isArray(batches) || batches.length > 2048) throw new BridgeError('BAD_REPORT','文件汇总输入格式无效');
  let bytes=0,count=0;
  const safe = batches.map(batch=>{
    if (!Array.isArray(batch?.changes) || (count+=batch.changes.length)>2048 ||
        (batch.cwd!=null && (typeof batch.cwd!=='string' || batch.cwd.length>32768))) {
      throw new BridgeError('BAD_REPORT','文件汇总输入格式无效');
    }
    bytes+=Buffer.byteLength(batch.cwd??'');
    const changes=batch.changes.map(change=>{
      const {path,kind,diff}=change??{};
      if (typeof path!=='string' || !path || typeof diff!=='string' || !allowedKinds.has(kind?.type) ||
          (kind.move_path!=null && typeof kind.move_path!=='string')) throw new BridgeError('BAD_REPORT','文件变更输入格式无效');
      bytes+=Buffer.byteLength(path)+Buffer.byteLength(diff)+Buffer.byteLength(kind.move_path??'');
      if (bytes>maxInputBytes) throw new BridgeError('REPORT_TOO_LARGE','这份报告的差异过大，请在电脑端查看');
      return {path,kind:{type:kind.type,move_path:kind.move_path??null},diff};
    });
    return {cwd:batch.cwd??null,changes};
  });
  const serialized=JSON.stringify(safe);
  if (Buffer.byteLength(serialized)>maxInputBytes) throw new BridgeError('REPORT_TOO_LARGE','这份报告的差异过大，请在电脑端查看');
  return serialized;
}

/** 隔离并限制原生差异计算，不接触桌面会话、鉴权或数据库。 */
export class NativeFileReportRuntime {
  #bundles = new Map();
  #pending = new Map();
  #workers = new Set();
  #closed = false;

  /** 在正常桌面进程中也可使用，安装版本未知时隐藏相应能力。 */
  supports(executable) {
    if (this.#closed) return false;
    try { this.#bundle(executable); return true; } catch { return false; }
  }

  /** 同一安装版本和输入共享进行中的计算，避免同时占用多个工作线程。 */
  async calculate(executable,batches) {
    if (this.#closed) throw new BridgeError('REPORT_UNAVAILABLE','文件汇总服务已关闭');
    const input=reportInput(batches);
    let bundle;
    try { bundle=this.#bundle(executable); } catch {
      throw new BridgeError('REPORT_UNAVAILABLE','电脑连接服务尚未适配当前桌面版本，请更新连接服务后重试文件汇总');
    }
    const key=bundle.version+':'+createHash('sha256').update(input).digest('hex');
    const existing=this.#pending.get(key);
    if (existing) return existing;
    if (this.#workers.size>=maxParallelReports) throw new BridgeError('REPORT_UNAVAILABLE','文件汇总正在处理，请稍后重试');
    const task=this.#run(bundle.source,input).finally(()=>this.#pending.delete(key));
    this.#pending.set(key,task);
    return task;
  }

  /** 停止所有计算并清除只保存在进程内存中的提取结果。 */
  close() {
    this.#closed=true;
    this.#bundles.clear();
    this.#pending.clear();
    for(const worker of this.#workers) void worker.terminate();
  }

  /** 同一安装的后续报告复用已通过完整哈希校验的函数闭包。 */
  #bundle(executable) {
    const archive=archiveForExecutable(executable);
    const identity=archiveIdentity(archive);
    const cached=this.#bundles.get(archive);
    if (cached?.identity===identity) {
      if (!cached.bundle) throw new UnsupportedNativeReportVersion('桌面原生差异模块版本尚未验证');
      return cached.bundle;
    }
    this.#bundles.delete(archive);
    let bundle=null;
    try { bundle=loadNativeFunctions(archive); }
    catch (error) {
      // 仅缓存明确不支持的模块版本，临时读取错误留给下一次重试。
      if (!(error instanceof UnsupportedNativeReportVersion)) throw error;
    }
    if (archiveIdentity(archive)!==identity) throw new Error('桌面资源在读取期间发生更新');
    if (this.#bundles.size>=archiveCacheLimit) this.#bundles.delete(this.#bundles.keys().next().value);
    this.#bundles.set(archive,{bundle,identity});
    if (!bundle) throw new UnsupportedNativeReportVersion('桌面原生差异模块版本尚未验证');
    return bundle;
  }

  /** 以独立工作线程和硬超时运行固定代码，响应只接收 JSON 字符串。 */
  #run(source,input) {
    return new Promise((resolve,reject)=>{
      let worker;
      try {
        worker=new Worker(new URL('./native-report-worker.mjs',import.meta.url),{
          workerData:{source,input},
          resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:4},
        });
      } catch {
        reject(new BridgeError('REPORT_UNAVAILABLE','暂时无法启动原生文件汇总'));
        return;
      }
      this.#workers.add(worker);
      const fail=()=>reject(new BridgeError('REPORT_UNAVAILABLE','原生文件汇总计算失败或超时，请在电脑端查看'));
      const timer=setTimeout(()=>{fail();void worker.terminate();},4000);
      worker.once('message',({output})=>{
        if(this.#closed || typeof output!=='string'){fail();return;}
        try {resolve(JSON.parse(output));} catch {fail();}
      });
      worker.once('error',fail);
      worker.once('exit',()=>{
        clearTimeout(timer);
        this.#workers.delete(worker);
        fail();
      });
    });
  }
}
