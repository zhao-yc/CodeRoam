import fs from 'node:fs';import net from 'node:net';import path from 'node:path';import {fileURLToPath} from 'node:url';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {randomUUID} from 'node:crypto';import {EventEmitter} from 'node:events';
import {encodeFrame,FrameDecoder} from '../../packages/protocol/ipc-client.mjs';import {BridgeError} from '../../packages/protocol/contracts.mjs';
import {selectNativeEndpoint} from './native-endpoint.mjs';
const execute=promisify(execFile),helper=fileURLToPath(new URL('./windows-native-pipe.ps1',import.meta.url));
const allowed=new Set(['list_threads','navigate_to_codex_page','set_thread_read_state']);

/** 只调用原桌面的三个固定接口，所有账号、主机和未读判断均由原桌面完成。 */
export class NativeDesktop extends EventEmitter {
 constructor({platform=process.platform,invoke=null,stateDirectory=null,ipcSocketPath='\\\\.\\pipe\\codex-ipc'}={}){super();this.platform=platform;this.invokeOverride=invoke;this.ipcSocketPath=ipcSocketPath;this.socket=null;this.pending=new Map();this.connecting=null;this.reading=null;this.unread=new Map();this.context='';this.closed=false;this.refreshTimer=null;this.stateDirectory=stateDirectory;this.watcher=null;this.watchedIds=[];}
 /** 只监听桌面全局状态文件的变更通知，内容及账号状态始终由原生接口解释。 */
 watchReadState(){if(this.watcher||!this.stateDirectory||this.closed)return;try{this.watcher=fs.watch(this.stateDirectory,(_event,name)=>{if(name==null||String(name)==='.codex-global-state.json')this.schedule(this.watchedIds);});this.watcher.on('error',()=>{this.watcher?.close();this.watcher=null;});this.watcher.unref();}catch{}}
 invalidate(){const changed=[...this.unread.keys()];this.unread.clear();if(changed.length)this.emit('changed',changed);}
 /** 连接已核对安装路径及服务进程的管道，连接失败不向手机泄露本机路径。 */
 async connect(){
  if(this.socket?.writable)return;if(this.connecting)return this.connecting;
  this.connecting=(async()=>{
   if(this.platform!=='win32')throw new BridgeError('DESKTOP_NATIVE_UNAVAILABLE','当前电脑不支持原生会话同步');
   const executable=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
   const pipe=/^\\\\\.\\pipe\\([A-Za-z0-9._-]+)$/.exec(this.ipcSocketPath);if(!pipe)throw new Error('会话 IPC 通道无效');
   const result=await execute(executable,['-NoProfile','-NonInteractive','-File',helper,'-IpcPipeName',pipe[1]],{windowsHide:true,timeout:6000,maxBuffer:16384});
   const endpoint=selectNativeEndpoint(JSON.parse(result.stdout.trim()),process.env.CODEX_APP_TOOLS_PIPE_PATH);
   this.processId=endpoint.pid;
   await new Promise((resolve,reject)=>{const socket=net.createConnection(endpoint.path);this.socket=socket;const connectingTimer=setTimeout(()=>{socket.destroy();reject(new Error('原生通道连接超时'));},3000);const decoder=new FrameDecoder(message=>{const entry=this.pending.get(message.id);if(!entry)return;this.pending.delete(message.id);clearTimeout(entry.timer);message.error?entry.reject(new Error('原生请求失败')):entry.resolve(message.result);},8*1024*1024);
    socket.on('data',chunk=>{try{decoder.push(chunk);}catch{socket.destroy();}});socket.on('error',()=>{clearTimeout(connectingTimer);reject(new Error('原生通道不可用'));});socket.on('close',()=>{clearTimeout(connectingTimer);if(this.socket===socket){this.socket=null;this.invalidate();}for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(new Error('原生通道已关闭'));}this.pending.clear();});socket.once('connect',()=>{clearTimeout(connectingTimer);socket.unref();resolve();});
   });
  })().catch(()=>{this.invalidate();throw new BridgeError('DESKTOP_NATIVE_UNAVAILABLE','电脑原生会话连接未就绪，请确认桌面端正在运行后重试');}).finally(()=>{this.connecting=null;});return this.connecting;
 }
 /** 内部调用固定工具，手机不能传入方法、程序、路径或任意参数。 */
 async call(tool,args,threadId){
  if(!allowed.has(tool)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId))throw new BridgeError('BAD_NATIVE_REQUEST','原生会话请求无效');
  if(this.closed)throw new Error('原生通道已关闭');
  if(this.invokeOverride)return this.invokeOverride(tool,args,threadId);
  await this.connect();const id=randomUUID();
  const result=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('原生会话请求超时'));},7000);this.pending.set(id,{resolve,reject,timer});this.socket.write(encodeFrame({jsonrpc:'2.0',id,method:'tools/call',params:{namespace:'codex_app',tool,arguments:args,callerSource:'codex',callId:id,threadId,turnId:id,hostId:'local'}}));});
  if(result?.success!==true)throw new Error('原生会话请求未完成');const text=result.contentItems?.find(item=>item.type==='inputText')?.text;if(typeof text!=='string')throw new Error('原生返回格式不受支持');try{return JSON.parse(text);}catch{throw new BridgeError('BAD_NATIVE_RESPONSE','电脑返回的会话数据格式无效，请更新后重试');}
 }
 /** 原生确认已打开后才提交已读；不把系统启动或排队当作切换成功。 */
 async navigate(threadId,isCurrent=()=>true){
  if(!isCurrent())throw new BridgeError('SUBSCRIPTION_CANCELED','旧的会话导航已取消');
  const result=await this.call('navigate_to_codex_page',{threadId},threadId);
  if(result.navigated!==true)throw new BridgeError('DESKTOP_LOAD_FAILED','电脑未确认会话切换，请重试');
  if(!isCurrent())throw new BridgeError('SUBSCRIPTION_CANCELED','会话已切换，不提交旧会话的已读状态');
  await this.call('set_thread_read_state',{threadId,source:'codex',hostId:'local',read:true},threadId);
  if(this.reading)await this.reading.catch(()=>{});
  await this.refresh([threadId]);
 }
 /** 一次刷新共享给列表与详情；读取目录而非切换界面，未返回的会话保持未知。 */
 async refresh(ids=[]){
  this.watchedIds=[...new Set([...this.watchedIds,...ids])].slice(-200);this.watchReadState();
  if(this.reading)return this.reading;if(ids[0])this.context=ids[0];if(!this.context)return;
  this.reading=(async()=>{
   const next=new Map(),collect=result=>{for(const item of [...result.pinnedThreads??[],...result.threads??[]])if(item.kind==='codex'&&item.hostId==='local'&&typeof item.isUnread==='boolean')next.set(item.id,item.isUnread);};
   collect(await this.call('list_threads',{limit:50},this.context));
   let cursor;
   for(let page=0;page<3&&ids.some(id=>!next.has(id));page++){
    const result=await this.call('list_threads',{mode:'history',source:'codex',hostId:'local',limit:50,...(cursor?{cursor}:{})},this.context);collect(result);cursor=result.nextCursor;if(!cursor)break;
   }
   const changed=[...new Set([...this.unread.keys(),...next.keys()])].filter(id=>this.unread.get(id)!==next.get(id));this.unread=next;if(changed.length)this.emit('changed',changed);
  })().finally(()=>{this.reading=null;});return this.reading;
 }
 /** 合并桌面文件通知与流式状态通知，不使用周期轮询。 */
 schedule(ids=[]){clearTimeout(this.refreshTimer);this.refreshTimer=setTimeout(()=>this.refresh(ids).catch(()=>{}),250);this.refreshTimer.unref?.();}
 close(){this.closed=true;clearTimeout(this.refreshTimer);this.watcher?.close();this.watcher=null;this.socket?.destroy();}
}
let shared;
export function sharedNativeDesktop(){return shared??=new NativeDesktop();}
