import path from 'node:path';
import {createHash} from 'node:crypto';
import {WebSocket} from 'ws';
import {AsarReader} from '../../packages/protocol/asar-reader.mjs';
import {BridgeError} from '../../packages/protocol/contracts.mjs';
import {ComposerPredictionReader} from './composer-prediction.mjs';
import {fileReportExpression} from './file-report-expression.mjs';
import {fileReportSource} from './file-report-source.mjs';
import {NativeFileReportRuntime} from './native-report-runtime.mjs';
import {usesWindowsIpcWithoutPage} from './windows-ipc-mode.mjs';

/** 从已核验的原桌面安装包定位现成模块，只读取索引，不执行或复制安装包源码。 */
export function desktopDiffModules(executable) {
  if(typeof executable!=='string'||!/[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$/i.test(executable))throw new BridgeError('REPORT_UNAVAILABLE','当前电脑暂不支持读取原生文件汇总');
  const reader=new AsarReader(path.join(path.dirname(executable),'resources','app.asar'));
  try{
    const find=pattern=>{const names=[...reader.files.keys()].filter(name=>pattern.test(name));if(names.length!==1)throw new Error('原生模块不唯一');return path.posix.basename(names[0]);};
    return {initial:find(/^webview\/assets\/app-initial-[a-f0-9]+\.js$/),summary:find(/^webview\/assets\/diff-summary-[a-f0-9]+\.js$/)};
  }finally{reader.close();}
}

/** 独立有界调用原生只读模块；只接受连接服务生成的固定表达式。 */
export async function evaluateNativeFileReport(url,expression) {
  const socket=new WebSocket(url,{handshakeTimeout:2000,maxPayload:2*1024*1024,perMessageDeflate:false});
  try{
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.terminate();reject(new Error('原生汇总读取超时'));},6000);
      const finish=(error,value)=>{clearTimeout(timer);error?reject(error):resolve(value);};
      socket.once('error',()=>finish(new Error('原生汇总连接失败')));
      socket.once('close',()=>finish(new Error('原生汇总连接已关闭')));
      socket.on('message',data=>{let message;try{message=JSON.parse(data);}catch{return;}if(message.id!==1)return;finish(message.error||message.result?.exceptionDetails?new Error('原生汇总格式暂不兼容'):null,message.result?.result?.value);});
      // 模块导入需要等待 Promise；入口完全固定，不调用编辑、命令或 Git 写操作。
      socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true,timeout:4000}}));
    });
  }finally{socket.terminate();}
}

/** 按电脑实例、会话和报告读取汇总；差异正文仅按文件请求返回，不进入快照或操作账本。 */
export class DesktopFileReportReader extends ComposerPredictionReader {
  constructor({evaluateNative=evaluateNativeFileReport,resolveModules=desktopDiffModules,nativeRuntime=new NativeFileReportRuntime(),...options}={}){super(options);this.evaluateNative=evaluateNative;this.resolveModules=resolveModules;this.nativeRuntime=nativeRuntime;this.cache=new Map();this.pendingReports=new Map();}
  /** 仅使用实例发现器已核验的安装位置，手机和历史内容不能指定原生代码来源。 */
  nativeExecutable(adapter) {
    const instance=adapter.client?.instance;
    return instance?.alive===true&&instance.ready===true?instance.executable:null;
  }
  /** 普通启动复用官方离线计算能力；其它启动模式继续保留原有页面接口。 */
  supports(adapter) {
    if(this.closed)return false;
    return this.nativeRuntime.supports(this.nativeExecutable(adapter))||process.platform==='win32'&&!usesWindowsIpcWithoutPage(adapter.client?.instance);
  }
  /** 优先在隔离线程执行同版本原生算法，兼容既有页面调用，不修改桌面会话。 */
  async nativeReport(adapter,source) {
    const executable=this.nativeExecutable(adapter);
    if(this.nativeRuntime.supports(executable))return this.nativeRuntime.calculate(executable,source.batches);
    if(usesWindowsIpcWithoutPage(adapter.client?.instance))throw new BridgeError('REPORT_UNAVAILABLE','当前桌面版本的原生文件汇总暂不可用，请更新电脑连接服务');
    if(!adapter.native?.processId)await adapter.native?.connect();
    const ports=(await this.endpoints()).filter(port=>port.pid===adapter.native?.processId);
    if(ports.length!==1)throw new BridgeError('REPORT_UNAVAILABLE','电脑原生文件汇总暂不可用，请确认桌面端正在运行');
    const port=ports[0],modules=this.resolveModules(port.executable??adapter.native?.instance?.executable),expression=fileReportExpression(modules,source.batches);
    for(const url of await this.targets(port)){
      if(!this.trusted(port))break;
      try{const result=await this.evaluateNative(url,expression);if(this.trusted(port)&&result?.files)return result;}catch{}
    }
    throw new BridgeError('REPORT_UNAVAILABLE','暂时无法读取电脑原生文件汇总，请稍后重试');
  }
  /** 重复请求共享在途解析，订阅与所有者变化后不返回旧报告。 */
  async read(adapter,{threadId,reportId,fileId},deviceId) {
    const entry=adapter.conversations.get(threadId);
    if(!entry?.watchers.has(deviceId))throw new BridgeError('SUBSCRIPTION_REQUIRED','请先打开这条聊天再查看文件修改');
    const owner=entry.owner,ownerId=JSON.stringify([owner?.hostId,owner?.clientId]);
    const instance=adapter.client?.instance,generation=instance?.generation;
    // 本地计算期间同样核对实例代次，不能把已撤销实例的差异返回新连接。
    const current=()=>!this.closed&&(!instance||adapter.client?.instance===instance&&instance.alive===true&&instance.ready===true&&instance.generation===generation)&&adapter.conversations.get(threadId)===entry&&entry.watchers.has(deviceId)&&JSON.stringify([entry.owner?.hostId,entry.owner?.clientId])===ownerId;
    let source=entry.state?fileReportSource(entry.state,reportId):null;
    if(!source&&adapter.index?.readHistory){const saved=await adapter.index.readHistory(threadId,{reportId,rawTurns:true});source=fileReportSource(saved,reportId);}
    if(!current())throw new BridgeError('SUBSCRIPTION_CANCELED','这条聊天的文件查看已取消');
    // 安装包原地升级后也要重新确认能力，不能从旧报告缓存绕过版本核验。
    if(usesWindowsIpcWithoutPage(instance)&&!this.supports(adapter))throw new BridgeError('REPORT_UNAVAILABLE','当前桌面版本的原生文件汇总暂不可用，请更新电脑连接服务');
    if(!source)throw new BridgeError('REPORT_NOT_FOUND','这份报告的修改记录暂不可用');
    if(!source.batches.length)return {report:null};
    const revision=createHash('sha256').update(JSON.stringify(source.batches)).digest('hex'),key=JSON.stringify([ownerId,threadId,reportId,revision]);
    let report=this.cache.get(key);
    if(!report){
      if(!this.pendingReports.has(key))this.pendingReports.set(key,this.nativeReport(adapter,source).finally(()=>this.pendingReports.delete(key)));
      const native=await this.pendingReports.get(key);
      if(!current())throw new BridgeError('SUBSCRIPTION_CANCELED','这条聊天的文件查看已取消');
      if(!Number.isSafeInteger(native.additions)||native.additions<0||!Number.isSafeInteger(native.deletions)||native.deletions<0||!Array.isArray(native.files)||native.files.length>500)throw new BridgeError('BAD_REPORT','电脑文件汇总格式无效');
      if(native.files.some(file=>typeof file.path!=='string'||!file.path||!Number.isSafeInteger(file.additions)||file.additions<0||!Number.isSafeInteger(file.deletions)||file.deletions<0||!Array.isArray(file.diffs)||file.diffs.some(diff=>typeof diff!=='string')))throw new BridgeError('BAD_REPORT','电脑文件差异格式无效');
      report={reportId,revision,additions:native.additions,deletions:native.deletions,files:native.files.map(file=>({...file,id:createHash('sha256').update(file.path).digest('hex').slice(0,24)}))};
      if(Buffer.byteLength(JSON.stringify(report))>1600000)throw new BridgeError('REPORT_TOO_LARGE','这份报告的差异过大，请在电脑端查看');
      if(this.cache.size>=8)this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key,report);
    }
    if(!current())throw new BridgeError('SUBSCRIPTION_CANCELED','这条聊天的文件查看已取消');
    if(fileId){const file=report.files.find(file=>file.id===fileId);if(!file)throw new BridgeError('FILE_NOT_FOUND','这份报告中没有这个文件');return {reportId,revision,file};}
    return {report:{...report,fileCount:report.files.length,files:report.files.map(({diffs,...file})=>file)}};
  }
  close(){super.close();this.nativeRuntime.close();this.cache.clear();this.pendingReports.clear();}
}
