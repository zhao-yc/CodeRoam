import { goalCommandStatus } from './goal-command-status.mjs';
import { PermissionCatalog, permissionCommandStatus } from './permissions.mjs';
import { ComposerPredictionReader } from './composer-prediction.mjs';
import { DesktopFileReportReader } from './file-reports.mjs';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { WRITE_METHODS, UPLOAD_METHODS, validateRequest, errorPayload, BridgeError, requestFingerprint } from '../../packages/protocol/contracts.mjs';
import { conversationUpdate } from './updates.mjs';
import { computerName } from './computer-name.mjs';
import { hostname } from 'node:os';
import { NewThreadService } from './new-thread-service.mjs';
import { NativeDraftController } from './native-draft-controller.mjs';
import { NativeDraftService } from './native-draft-service.mjs';
import { archiveThread } from './thread-archive.mjs';
import { DesktopArchiveController } from './desktop-archive.mjs';
import { deleteThread, deletionCommandStatus, retainDeletionTarget } from './thread-delete.mjs';
import { DesktopDeleteController } from './desktop-delete.mjs';
import { ThreadListFeed } from './thread-list-feed.mjs';
import { prefetchConversation } from './conversation-prefetch.mjs';
import { readAccountUsage } from './account-usage.mjs';
import { MessageQueue } from './message-queue.mjs';
import { PluginCatalog, pluginInstanceVerifier, readProjectPlugins } from './plugins.mjs';

/** 电脑主动连接中转，断线只恢复读订阅，所有写操作通过持久化账本去重。 */
export class BridgeAgent extends EventEmitter {
  constructor({ config, adapter, journal, nativeDrafts, archiveController = new DesktopArchiveController(), deleteController = new DesktopDeleteController(), newThreads = new NewThreadService({ codexHome: config.codexHome, codexCliPath: config.codexCliPath, catalog: adapter.modelCatalog }) }) {
    super(); this.config=config;this.adapter=adapter;this.journal=journal;this.socket=null;this.stopped=false;this.retries=0;this.reconnectTimer=null;this.threadLocks=new Map();
    this.published=new Map();
    this.newThreads=newThreads;
    this.nativeDrafts=nativeDrafts??new NativeDraftService({controller:new NativeDraftController({adapter}),projects:newThreads,attachments:adapter.attachments});
    this.nativeDrafts.on('changed',({deviceId,snapshot})=>this.send({v:1,type:'thread.draft.changed',deviceId,snapshot}));
    adapter.permissionCatalog ??= new PermissionCatalog({ creation: newThreads.creation });
    adapter.pluginCatalog ??= new PluginCatalog({ creation: newThreads.creation, verify: pluginInstanceVerifier(adapter, newThreads.creation) });
    this.archiveController=archiveController;this.predictions=new ComposerPredictionReader();this.fileReports=new DesktopFileReportReader();
    this.deleteController=deleteController;this.deletingIds=new Set();this.deletionRequests=new Map();
    this.messageQueue=journal.db?new MessageQueue({journal,adapter,exclusive:(id,operation)=>this.queueExclusive(id,operation),changed:id=>this.publishQueue(id),blocked:id=>this.deletingIds.has(id)}):null;
    this.threadListFeed=new ThreadListFeed(adapter,event=>this.send(event));
    adapter.on('conversation',snapshot=>{if(!adapter.conversations||[...adapter.conversations.get(snapshot.threadId)?.watchers??[]].some(id=>id!=='list-status'))this.publish(snapshot);});
    adapter.on('adapterWarning',warning=>this.emit('warning',warning));
  }
  start() {
    const url=new URL(this.config.relayUrl);
    if(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&['127.0.0.1','localhost'].includes(url.hostname))) throw new Error('跨网络连接必须使用 WSS');
    if(url.username||url.password||url.search||url.hash) throw new Error('中转地址不能包含凭据、查询参数或片段');
    this.connect();
  }
  connect() {
    if(this.stopped)return;
    const socket=new WebSocket(this.config.relayUrl,{headers:{Authorization:`Bearer ${this.config.token}`},handshakeTimeout:8000,perMessageDeflate:false,maxPayload:2*1024*1024});this.socket=socket;
    // 主动探活可发现断网后没有 close 事件的半开连接。
    let alive=true;
    const watchdog=setInterval(()=>{if(socket.readyState!==WebSocket.OPEN)return;if(!alive){socket.terminate();return;}alive=false;socket.ping();},15000);
    socket.on('pong',()=>{alive=true;});
    socket.on('open',()=>{this.retries=0;this.send({v:1,type:'host.ready',label:computerName(this.config.label),hostname:hostname(),connectionType:'codex-desktop'});this.emit('connected');});
    socket.on('message',data=>{let message;try{message=JSON.parse(data.toString());}catch{return;}if(message.type==='request')this.handleRequest(message).then(response=>{if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(response));}).catch(()=>{});});
    socket.on('error',()=>this.emit('warning',{code:'RELAY_UNAVAILABLE',message:'中转暂时不可用，正在重连'}));
    socket.on('close',code=>{clearInterval(watchdog);this.threadListFeed.devices.clear();this.threadListFeed.stop();this.emit('disconnected');if(this.stopped||code===4001)return;const delay=Math.min(15000,500*2**Math.min(this.retries++,5))+Math.random()*300;this.reconnectTimer=setTimeout(()=>this.connect(),delay);});
  }
  send(message) {
    if(this.socket?.readyState!==WebSocket.OPEN)return false;
    // 背压过高时主动重连，让客户端重取快照，不能静默丢失最后一段输出。
    if(this.socket.bufferedAmount>=8*1024*1024){this.socket.terminate();return false;}
    this.socket.send(JSON.stringify(message));return true;
  }
  publish(snapshot) {
    snapshot=this.messageQueue?.decorate(snapshot)??snapshot;
    const event=this.journal.append(snapshot.threadId,conversationUpdate(this.published.get(snapshot.threadId),snapshot));
    this.published.set(snapshot.threadId,{snapshot,seq:event.seq});this.send(event);return event;
  }
  /** 自动出队与手机写请求共用同一把会话锁，取消、追加和删除不会同时发送。 */
  async queueExclusive(threadId, operation) {
    const previous=this.threadLocks.get(threadId)??Promise.resolve();
    const running=previous.catch(()=>{}).then(operation);this.threadLocks.set(threadId,running);
    try{return await running;}finally{if(this.threadLocks.get(threadId)===running)this.threadLocks.delete(threadId);}
  }
  /** 队列变化重新发布当前桌面快照，不伪造用户消息或任务状态。 */
  publishQueue(threadId) {
    const entry=this.adapter.conversations?.get(threadId);
    if(entry?.state)this.publish(this.adapter.snapshot(entry.state));
  }
  async handleRequest(message) {
    const response={v:1,type:'response',transportId:message.transportId};
    try {
      validateRequest(message);
      if(typeof message.deviceId!=='string')throw new BridgeError('UNAUTHENTICATED','缺少手机身份');
      let deletionTarget = null;
      const execute=async()=>{
        if(WRITE_METHODS.has(message.method)&&this.deletingIds.has(message.params.threadId))throw new BridgeError('DELETE_IN_PROGRESS','该聊天正在永久删除，请先核对删除结果');
        if(message.method==='turn.send'&&message.params.queueAction) {
          if(!this.messageQueue)throw new BridgeError('QUEUE_UNAVAILABLE','请更新电脑连接服务后使用消息排队');
          return this.messageQueue.operate(message.params,message.requestId,message.deviceId);
        }
        if(message.method==='thread.create.permissions')return this.adapter.permissionCatalog.read(this.newThreads.project(message.params.projectId).cwd);
        if(message.method==='thread.create.plugins')return readProjectPlugins(this.newThreads,this.adapter.pluginCatalog,message.params.projectId,this.adapter);
        if(message.method==='thread.plugins.read')return this.adapter.readPlugins(message.params.threadId,message.deviceId);
        if(message.method==='thread.permissions.read')return this.adapter.readPermissions(message.params.threadId,message.deviceId);
        if(message.method==='projects.list')return {...this.newThreads.projects(),supportsNativeNewDraft:await this.nativeDrafts.controller.capabilities()};
        if(message.method.startsWith('thread.draft.')) {
          const action=message.method.slice('thread.draft.'.length);
          if(action==='read'||action==='unwatch')return this.nativeDrafts[action](message.params,message.deviceId);
          return this.nativeDrafts[action](message.params,message.deviceId,message.requestId,result=>this.journal.checkpoint(message.deviceId,message.requestId,result));
        }
        if(message.method==='thread.create.settings')return this.newThreads.settings(message.params.projectId);
        if(message.method==='thread.create')return this.newThreads.create(message.params.projectId,message.params.title,result=>this.journal.checkpoint(message.deviceId,message.requestId,result));
        if(message.method==='thread.archive') {
          const result=await archiveThread(this.adapter,this.archiveController,message.params.threadId,message.deviceId,result=>this.journal.checkpoint(message.deviceId,message.requestId,result),message.requestId);
          this.messageQueue?.forget([message.params.threadId]);
          this.published.delete(message.params.threadId);return result;
        }
        if(message.method==='thread.delete') {
          const lockRelated=async ids=>{
            if(ids.some(id=>this.deletingIds.has(id)))throw new BridgeError('DELETE_IN_PROGRESS','关联聊天正在删除，请先核对原操作');
            ids.forEach(id=>this.deletingIds.add(id));
            const release=()=>ids.forEach(id=>this.deletingIds.delete(id));
            try {await Promise.all(ids.filter(id=>id!==message.params.threadId).map(id=>this.threadLocks.get(id)?.catch(()=>{})));return release;}
            catch(error){release();throw error;}
          };
          const result=await deleteThread(this.adapter,this.deleteController,message.params.threadId,message.deviceId,result=>{this.journal.checkpoint(message.deviceId,message.requestId,result);if(result.deleted===true)this.journal.forgetThreads(result.deletedThreadIds);},message.requestId,lockRelated,deletionTarget);
          this.messageQueue?.forget(result.deletedThreadIds);
          for(const id of result.deletedThreadIds)this.published.delete(id);
          this.threadListFeed.schedule();return result;
        }
        if(message.method==='thread.prediction.read')return this.predictions.read(this.adapter,message.params.threadId,message.deviceId);
        // 静默预加载在通用历史订阅之前短路；只读取已有状态，不发布事件或改变订阅。
        if(message.method==='thread.history'&&message.params.view==='prefetch')return prefetchConversation(this.adapter,message.params.threadId,{isDeleting:()=>this.deletingIds.has(message.params.threadId)});
        if(message.method==='thread.history'&&message.params.view==='file-report')return this.fileReports.read(this.adapter,message.params,message.deviceId);
        if(message.method==='thread.settings.read')return this.adapter.readSettings(message.params.threadId,message.deviceId);
        if(message.method==='thread.goal.read')return this.adapter.readGoal(message.params.threadId,message.deviceId);
        if(UPLOAD_METHODS.has(message.method))return message.params.draftId?this.nativeDrafts.transfer(message.method,message.params,message.deviceId):this.adapter.transfer(message.method,message.params,message.deviceId);
        if(message.method==='threads.watch')return this.threadListFeed.watch(message.deviceId);
        if(message.method==='threads.unwatch')return this.threadListFeed.unwatch(message.deviceId);
        if(message.method==='threads.list') {
          // 通过已有白名单接口扩展只读信息；显式归档标记供手机识别旧服务。
          const threads=await this.adapter.list(message.params);
          return {threads:message.params.archived===true?threads:threads.map(row=>this.threadListFeed.contentSummary(row)),...(message.params.archived===true?{archived:true}:{}),...(message.params.includeUsage===true?{usage:await readAccountUsage(this.newThreads)}:{})};
        }
        if(message.method==='thread.images')return this.adapter.messageImages(message.params.threadId,message.params.messageId,message.deviceId,message.params);
        if(message.method==='thread.history'&&message.params.page===true)return this.adapter.historyPage(message.params.threadId,message.deviceId,message.params);
        if(message.method==='thread.watch'||message.method==='thread.history') {
          const snapshot=await this.adapter.watch(message.params.threadId,message.deviceId,{activate:message.params.activate===true});
          const event=this.publish(snapshot);
          return {snapshot:event.snapshot??this.messageQueue?.decorate(snapshot)??snapshot,epoch:this.journal.epoch,seq:event.seq,...(message.params.activate===true?{desktopActivated:true}:{})};
        }
        if(message.method==='thread.unwatch'){const result=this.adapter.unwatch(message.params.threadId,message.deviceId);if(!this.adapter.conversations.has(message.params.threadId))this.published.delete(message.params.threadId);return result;}
        if(message.method==='command.status') { const draft=await this.nativeDrafts.commandStatus(this.journal,message.deviceId,message.params.commandId);if(draft.state!=='unknown')return draft;const deletion=deletionCommandStatus(this.adapter,this.journal,message.deviceId,message.params.commandId);if(deletion.state!=='unknown')return deletion;const status=await permissionCommandStatus(this.adapter,this.journal,message.deviceId,message.params.commandId);return status.state==='unknown'?goalCommandStatus(this.adapter,this.journal,message.deviceId,message.params.commandId):status; }
        if(WRITE_METHODS.has(message.method))return this.adapter.operate(message.method,message.params,message.requestId,message.deviceId,result=>this.journal.checkpoint(message.deviceId,message.requestId,result));
        throw new BridgeError('METHOD_NOT_ALLOWED','此接口不支持通过电脑执行');
      };
      if(WRITE_METHODS.has(message.method)) {
        const key=message.method==='thread.create'?'create:'+message.deviceId:message.method.startsWith('thread.draft.')?'draft:'+(message.params.draftId??message.params.projectId):message.params.threadId, previous=this.threadLocks.get(key)??Promise.resolve();
        // 删除先入账并持有目标，再排队；立即返回、退订和断线均不依赖页面存活。
        if(message.method==='thread.delete') {
          const requestKey=JSON.stringify([message.deviceId,message.requestId]), fingerprint=requestFingerprint(message.method,message.params);
          const existing=this.deletionRequests.get(requestKey);
          if(existing) {
            if(existing.fingerprint!==fingerprint)throw new BridgeError('REQUEST_ID_REUSED','同一请求编号不能用于不同操作');
            response.result=await existing.operation;return response;
          }
          if(this.journal.status(message.deviceId,message.requestId).state==='not_found') deletionTarget=retainDeletionTarget(this.adapter,message.params.threadId,message.deviceId,message.requestId);
          const operation=this.journal.execute(message.deviceId,message.requestId,message.method,message.params,()=>previous.catch(()=>{}).then(execute));
          this.threadLocks.set(key,operation);this.deletionRequests.set(requestKey,{fingerprint,operation});
          try {response.result=await operation;} finally {deletionTarget?.release();this.deletionRequests.delete(requestKey);if(this.threadLocks.get(key)===operation)this.threadLocks.delete(key);}
          return response;
        }
        const operation=previous.catch(()=>{}).then(()=>this.journal.execute(message.deviceId,message.requestId,message.method,message.params,execute));
        this.threadLocks.set(key,operation);
        try { response.result=await operation; } finally {if(this.threadLocks.get(key)===operation)this.threadLocks.delete(key);}
      } else response.result=await execute();
    } catch(error) {response.error=errorPayload(error);}
    return response;
  }
  async close(){this.stopped=true;this.messageQueue?.close();await this.nativeDrafts.close();clearTimeout(this.reconnectTimer);this.socket?.terminate();this.fileReports.close();this.threadListFeed.close();this.adapter.close();await Promise.allSettled(this.threadLocks.values());this.journal.close();}
}
