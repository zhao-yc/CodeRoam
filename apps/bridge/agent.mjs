import { goalCommandStatus } from './goal-command-status.mjs';
import { PermissionCatalog, permissionCommandStatus } from './permissions.mjs';
import { ComposerPredictionReader } from './composer-prediction.mjs';
import { DesktopFileReportReader } from './file-reports.mjs';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { isDeepStrictEqual } from 'node:util';
import { WRITE_METHODS, UPLOAD_METHODS, validateRequest, errorPayload, BridgeError, requestFingerprint } from '../../packages/protocol/contracts.mjs';
import { conversationUpdate, messageWindowUpdate } from './updates.mjs';
import { recentConversationPage } from './conversation-page.mjs';
import { computerName } from './computer-name.mjs';
import { hostname } from 'node:os';
import { NewThreadService } from './new-thread-service.mjs';
import { NativeDraftController } from './native-draft-controller.mjs';
import { NativeDraftService } from './native-draft-service.mjs';
import { archiveThread } from './thread-archive.mjs';
import { DesktopArchiveController } from './desktop-archive.mjs';
import { deleteThread, deletionCommandStatus, retainDeletionTarget } from './thread-delete.mjs';
import { NativeDeleteController } from './native-delete.mjs';
import { ThreadListFeed } from './thread-list-feed.mjs';
import { conversationContentRevision, conversationProjection, prefetchConversation } from './conversation-prefetch.mjs';
import { CACHE_WATCHER, ThreadCacheFeed } from './thread-cache.mjs';
import { ClientPresenceController } from './client-presence.mjs';
import { readAccountUsage } from './account-usage.mjs';
import { MessageQueue } from './message-queue.mjs';
import { TaskQueue } from './task-queue.mjs';
import { StateOperationHistory } from './state-operation-history.mjs';
import { runNewConversationTask } from './new-conversation-task.mjs';
import { randomUUID } from 'node:crypto';
import { PluginCatalog, pluginInstanceVerifier, readProjectPlugins } from './plugins.mjs';
import { ThreadMentionService } from './thread-mentions.mjs';
import { usesWindowsIpcWithoutPage, supportsDesktopIpcNewConversation } from './windows-ipc-mode.mjs';

/** 更新时间是本次规范化的生成时间，不单独推进传输游标。 */
function sameSnapshot(snapshot, previous) {
  if (!previous) return false;
  const {updatedAt,...current}=snapshot, {updatedAt:previousUpdatedAt,...previousState}=previous;
  return isDeepStrictEqual(current,previousState);
}

/** 后台缓存和列表跟随不持有详情传输游标。 */
function hasDetailWatcher(adapter, threadId) {
  return !adapter.conversations || [...adapter.conversations.get(threadId)?.watchers ?? []].some(id => id !== 'list-status' && id !== CACHE_WATCHER);
}

/** 电脑主动连接中转，断线只恢复读订阅，所有写操作通过持久化账本去重。 */
export class BridgeAgent extends EventEmitter {
  constructor({ config, adapter, journal, nativeDrafts, diagnostics = null, archiveController = new DesktopArchiveController(), deleteController = null, newThreads = new NewThreadService({ codexHome: config.codexHome, codexCliPath: config.codexCliPath, catalog: adapter.modelCatalog, settingsCache: config.newConversationSettingsCache }) }) {
    super(); this.config=config;this.adapter=adapter;this.journal=journal;this.socket=null;this.stopped=false;this.retries=0;this.reconnectTimer=null;this.threadLocks=new Map();
    this.published=new Map();
    this.diagnostics=diagnostics;this.diagnosticInFlight=0;
    this.newThreads=newThreads;
    adapter.threadMentions ??= new ThreadMentionService(adapter);
    this.nativeDrafts=nativeDrafts??new NativeDraftService({controller:new NativeDraftController({adapter}),projects:newThreads,attachments:adapter.attachments,threadMentions:adapter.threadMentions});
    this.nativeDrafts.on('changed',({deviceId,snapshot})=>this.send({v:1,type:'thread.draft.changed',deviceId,snapshot}));
    adapter.permissionCatalog ??= new PermissionCatalog({ creation: newThreads.creation });
    adapter.pluginCatalog ??= new PluginCatalog({ creation: newThreads.creation, verify: pluginInstanceVerifier(adapter, newThreads.creation) });
    this.archiveController=archiveController;this.predictions=new ComposerPredictionReader();this.fileReports=new DesktopFileReportReader();
    // 能力由当前文件汇总读取器决定，普通启动也可使用已核验的原生离线算法。
    this.adapter.nativeFileReportAvailable=()=>this.fileReports.supports(this.adapter);
    this.deleteController=deleteController??new NativeDeleteController({adapter,archiveController,creation:newThreads.creation});this.deletingIds=new Set();this.deletionRequests=new Map();
    this.detailDevices=new Map();this.taskLeaseCounts=new Map();this.taskClosed=false;
    this.operationHistory=journal.db?new StateOperationHistory({db:journal.db,changed:()=>this.taskQueue?.notify(),readTitle:id=>adapter.index?.readTitle?.(id,{includeArchived:true})}):null;
    this.taskQueue=journal.db?new TaskQueue({journal,readOperations:deviceId=>this.operationHistory.list(deviceId,{view:'active',limit:100}).tasks,readTitle:id=>adapter.index?.readTitle?.(id,{includeArchived:true}),
      ready:()=>!this.taskClosed&&!this.managementDraining&&(!adapter.client?.instance||(adapter.client.instance.alive===true&&adapter.client.instance.ready===true)),
      execute:(task,context)=>task.kind==='newConversation'?runNewConversationTask(this,task,context):this.runTaskCommand(task.payload.method,task.payload.params,task.deviceId,task.commandId,task.payload.firstMessageGuard),
      reconcile:task=>this.readTaskCommandStatus(task.deviceId,task.pendingCommandId,task.threadId),
      changed:(deviceId,snapshot)=>this.send({v:1,type:'tasks.changed',deviceId,snapshot})}):null;
    if(adapter.attachments)adapter.attachments.retainScope=(deviceId,scope)=>this.taskQueue?.holdsScope(scope,deviceId)===true||!!this.messageQueue?.db.prepare('SELECT 1 FROM message_queue WHERE device_id=? AND thread_id=? LIMIT 1').get(deviceId,scope);
    this.messageQueue=journal.db?new MessageQueue({journal,adapter,exclusive:(id,operation)=>this.queueExclusive(id,operation),changed:id=>this.publishQueue(id),blocked:id=>this.deletingIds.has(id)||this.taskQueuePaused(),
      dispatch:async(method,params,commandId,deviceId)=>{const taskId=randomUUID();this.taskQueue.submit(deviceId,{taskId,kind:'command',payload:{method,params}});return this.taskQueue.wait(deviceId,taskId);}}):null;
    this.backgroundSyncEnabled=config.backgroundSyncEnabled!==false;
    this.threadListFeed=new ThreadListFeed(adapter,event=>this.send(event),{db:journal.db,backgroundSyncEnabled:this.backgroundSyncEnabled,
      onActivity:inventory=>this.threadCache?.setActivityInventory(inventory),
      onSettled:snapshot=>this.threadCache?.settled(snapshot)});
    this.threadCache=new ThreadCacheFeed({adapter,db:journal.db,backgroundSyncEnabled:this.backgroundSyncEnabled,send:event=>this.send(event),blocked:id=>this.deletingIds.has(id),listRows:()=>this.threadListFeed.started&&this.threadListFeed.maintaining()?[...this.threadListFeed.indexRows.values()]:undefined,removed:id=>{
      this.threadListFeed.forget([id]);
      if(this.published.delete(id))this.send({v:1,type:'thread.removed',threadId:id});
    }});
    this.clientPresence=new ClientPresenceController({onModeChange:mode=>{this.threadListFeed.setMode(mode);this.threadCache.setMode(mode);this.emit('maintenance',mode);}});
    adapter.on('conversation',snapshot=>{
      this.captureCache(snapshot);
      if(hasDetailWatcher(adapter,snapshot.threadId))this.publish(snapshot,{dedupe:true});
    });
    adapter.on('adapterWarning',warning=>this.emit('warning',warning));
  }
  /** 开关仅作用于列表和正文后台维护，真实手机订阅及提交任务继续使用原通道。 */
  setBackgroundSyncEnabled(enabled) {
    enabled=enabled!==false;
    if(this.stopped||this.backgroundSyncEnabled===enabled)return this.backgroundSyncEnabled;
    this.backgroundSyncEnabled=enabled;
    this.threadCache.setBackgroundSyncEnabled(enabled);
    this.threadListFeed.setBackgroundSyncEnabled(enabled);
    return enabled;
  }
  start() {
    const url=new URL(this.config.relayUrl);
    if(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&['127.0.0.1','localhost'].includes(url.hostname))) throw new Error('跨网络连接必须使用 WSS');
    if(url.username||url.password||url.search||url.hash) throw new Error('中转地址不能包含凭据、查询参数或片段');
    this.threadCache.start();
    this.threadListFeed.start();
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
    socket.on('message',data=>{if(this.socket!==socket)return;let message;try{message=JSON.parse(data.toString());}catch{return;}if(message.type==='welcome'){this.configurePresence({supported:message.capabilities?.clientPresence===true,hostId:this.config.hostId});return;}if(message.type==='clients.presence'){this.clientPresence.update(message);return;}if(message.type==='request')this.handleRequest(message).then(response=>{
      const delivered=this.socket===socket&&socket.readyState===WebSocket.OPEN;
      if(delivered)socket.send(JSON.stringify(response));
      this.diagnostics?.record(delivered?'bridge.sent':'bridge.dropped',this.diagnostics.context(message),{delivered,bufferedBytes:socket.bufferedAmount});
    }).catch(()=>{});});
    socket.on('error',()=>this.emit('warning',{code:'RELAY_UNAVAILABLE',message:'中转暂时不可用，正在重连'}));
    socket.on('close',code=>{clearInterval(watchdog);if(this.socket!==socket)return;this.relayDisconnected();this.emit('disconnected');if(this.stopped||code===4001)return;const delay=Math.min(15000,500*2**Math.min(this.retries++,5))+Math.random()*300;this.reconnectTimer=setTimeout(()=>this.connect(),delay);});
  }
  /** 在线数量由当前中转连接和实例代次确认，不能从读取或订阅数量猜测。 */
  configurePresence(identity) {this.clientPresence.configure(identity);}
  /** 断开只废弃设备传输，新协议保留五分钟本地维护宽限。 */
  relayDisconnected() {
    this.threadListFeed.devices.clear();this.threadCache.clearSubscriptions();this.clientPresence.disconnected();
    this.taskQueue?.watchers.clear();
    if(this.clientPresence.mode==='legacy')this.threadListFeed.stop();
  }
  send(message) {
    if(this.socket?.readyState!==WebSocket.OPEN)return false;
    // 背压过高时主动重连，让客户端重取快照，不能静默丢失最后一段输出。
    if(this.socket.bufferedAmount>=8*1024*1024){this.socket.terminate();return false;}
    this.socket.send(JSON.stringify(message));return true;
  }
  /** 缓存写入失败不影响实时跟随和交互回执。 */
  captureCache(snapshot) {
    try { this.threadCache.captureLive(snapshot); } catch { this.emit('warning',{code:'THREAD_CACHE_UNAVAILABLE',message:'电脑聊天缓存暂时不可用'}); }
  }
  publish(snapshot, { excludeTransportId, decorated = false, dedupe = false, broadcast = true } = {}) {
    snapshot=recentConversationPage(snapshot);
    if(!decorated)snapshot=this.messageQueue?.decorate(snapshot)??snapshot;
    const previous=this.published.get(snapshot.threadId);
    if(dedupe&&sameSnapshot(snapshot,previous?.snapshot))return;
    const contentRevision=conversationContentRevision(snapshot);
    const event=this.journal.append(snapshot.threadId,{...conversationUpdate(previous,snapshot),contentRevision});
    this.published.set(snapshot.threadId,{snapshot,seq:event.seq});
    if(broadcast)this.send(excludeTransportId?{...event,excludeTransportId}:event);return event;
  }
  /** 详情操作状态始终来自实时 watch，正文能用已知版本恢复时省略重复传输。 */
  watchResult(source, message, preview) {
    const page={...recentConversationPage(source),...(this.adapter.native?.platform==='win32'?{supportsReadState:true}:{})};
    const snapshot=this.messageQueue?.decorate(page)??page;
    const projection=conversationProjection(snapshot), contentRevision=conversationContentRevision(projection);
    const requested=message.method==='thread.watch'?(message.params.contentRevision??preview?.contentRevision):undefined;
    let baseline;
    if(requested===contentRevision) baseline=projection;
    else if(preview&&preview.contentRevision===requested) baseline=preview.snapshot;
    else if(requested) {
      try { baseline=this.threadCache.baseline(snapshot.threadId,requested); } catch { /* 损坏的基线按首次同步处理。 */ }
    }
    const previous=this.published.get(snapshot.threadId);
    // 规范化每次都会更新生成时间，状态与正文相同可沿用已经发布的游标。
    const compact = requested !== undefined;
    const seq=compact&&sameSnapshot(snapshot,previous?.snapshot)?previous.seq:
      this.publish(snapshot,{decorated:true,broadcast:!compact||!!previous,excludeTransportId:compact?message.transportId:undefined}).seq;
    const result={snapshot,epoch:this.journal.epoch,seq,contentRevision,...(message.params.activate===true?{desktopActivated:true}:{})};
    if(baseline&&isDeepStrictEqual(snapshot.messages,projection.messages)) {
      const {messages,...metadata}=snapshot;
      const update=messageWindowUpdate(baseline.messages,projection.messages);
      if(isDeepStrictEqual(baseline.messages,projection.messages)) return {...result,snapshot:metadata,contentBaseRevision:requested};
      if(Buffer.byteLength(JSON.stringify(update))<Buffer.byteLength(JSON.stringify(messages))) return {...result,snapshot:metadata,contentBaseRevision:requested,contentUpdate:update};
    }
    return result;
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

  /** 只读取暂停标记；消息队列不能绕过实例级暂停继续投递。 */
  taskQueuePaused() {return this.managementDraining===true||this.taskQueue?.db.prepare('SELECT paused FROM submission_queue_state WHERE singleton=1').get()?.paused===1;}
  /** 管理端排空只暂停新任务，不改变持久化队列和原有未知结果保护。 */
  setManagementDraining(value) {
    this.managementDraining=value===true;
    if(!this.managementDraining&&!this.stopped){this.taskQueue?.pump().catch(()=>{});this.messageQueue?.pump().catch(()=>{});}
  }
  /** 重启前逐实例检查内存请求与自有账本，不读取或修改 Codex 原生数据库。 */
  managementIdle() {
    if(this.diagnosticInFlight>0||this.taskQueue?.running||this.messageQueue?.pumping)return false;
    const db=this.journal.db;if(!db)return true;
    if(db.prepare("SELECT 1 FROM commands WHERE state='pending' LIMIT 1").get())return false;
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='submission_tasks'").get()&&db.prepare("SELECT 1 FROM submission_tasks WHERE state='running' LIMIT 1").get())return false;
    return true;
  }

  /** 后台租约独立于手机详情订阅，仍使用原提交设备核验附件和业务权限。 */
  async retainTaskThread(threadId,deviceId,taskId) {
    if(!this.adapter.watch)return ()=>{};
    const watcher='submission:'+taskId+':'+randomUUID(),key=JSON.stringify([threadId,deviceId]);
    // 兼容已经建立的真实/旧客户端订阅；嵌套步骤不能把后台观察者误认成手机页面。
    if(!this.taskLeaseCounts.has(key)&&this.adapter.conversations?.get(threadId)?.watchers.has(deviceId)){
      const watching=this.detailDevices.get(threadId)??new Set();watching.add(deviceId);this.detailDevices.set(threadId,watching);
    }
    const leases=this.adapter.taskLeases??=new Map();
    const devices=leases.get(threadId)??new Set();devices.add(deviceId);leases.set(threadId,devices);
    this.taskLeaseCounts.set(key,(this.taskLeaseCounts.get(key)??0)+1);
    let released=false;
    const release=()=>{
      if(released)return;released=true;
      const count=(this.taskLeaseCounts.get(key)??1)-1;
      if(count>0)this.taskLeaseCounts.set(key,count);
      else {this.taskLeaseCounts.delete(key);devices.delete(deviceId);if(!devices.size)leases.delete(threadId);if(!this.detailDevices.get(threadId)?.has(deviceId))this.adapter.unwatch?.(threadId,deviceId);}
      this.adapter.unwatch?.(threadId,watcher);
    };
    try{await this.adapter.watch(threadId,watcher,{fresh:true,history:false});return release;}
    catch(error){release();throw error;}
  }

  /** 内部步骤保留原白名单、Journal 和会话锁，不能递归再次入队。 */
  async runTaskCommand(method,params,deviceId,commandId,firstMessageGuard) {
    if(!WRITE_METHODS.has(method))throw new BridgeError('METHOD_NOT_ALLOWED','此操作不在任务白名单中');
    const instance=this.adapter.client?.instance;
    if(instance){await instance.verify?.();if(instance.alive!==true||instance.ready!==true)throw new BridgeError('INSTANCE_CHANGED','原实例连接已变化，请核对后继续');}
    const release=params.threadId?await this.retainTaskThread(params.threadId,deviceId,commandId):()=>{};
    try {
      const response=await this.handleRequest({v:1,type:'request',requestId:commandId,deviceId,method,params,...(instance?{expectedGeneration:instance.generation}:{}),...(firstMessageGuard?{firstMessageGuard}:{})},{taskExecution:true});
      if(response.error)throw new BridgeError(response.error.code,response.error.message,response.error.outcomeUnknown);
      return response.result;
    }finally{release();}
  }

  /** 未知任务只复用已有只读收口器；查询不会重新创建、发送或切换权限。 */
  async readTaskCommandStatus(deviceId,commandId,threadId='') {
    const original=this.journal.status(deviceId,commandId);
    const target=threadId||original.result?.permissionChange?.threadId||original.result?.goalChange?.threadId;
    let release=()=>{};
    // 仅对原账本保存的目标恢复只读观察，不能靠查询任意编号取得其他会话权限。
    if(original.state==='unknown'&&target){try{release=await this.retainTaskThread(target,deviceId,'reconcile:'+commandId);}catch{return original;}}
    try{
      const draft=await this.nativeDrafts.commandStatus(this.journal,deviceId,commandId);if(draft.state!=='unknown')return draft;
      const deletion=deletionCommandStatus(this.adapter,this.journal,deviceId,commandId);if(deletion.state!=='unknown')return deletion;
      const status=await permissionCommandStatus(this.adapter,this.journal,deviceId,commandId);
      return status.state==='unknown'?goalCommandStatus(this.adapter,this.journal,deviceId,commandId):status;
    }finally{release();}
  }

  /** 旧客户端仍按原请求编号核对；等待领取也必须返回 pending，不能误报未提交。 */
  async legacyCommandStatus(deviceId,commandId) {
    const task=this.taskQueue?.row(deviceId,commandId);
    if(!task||task.kind!=='command')return this.readTaskCommandStatus(deviceId,commandId);
    if(['queued','running','waiting_resume'].includes(task.state))return {state:'pending'};
    const record=this.taskQueue.db.prepare('SELECT * FROM submission_task_keys WHERE device_id=? AND id=?').get(deviceId,commandId);
    if(task.state==='succeeded')return {state:'done',result:JSON.parse(record.result??'{}')};
    if(['failed','canceled','cancelled','skipped'].includes(task.state))return {state:'done',error:record.error?JSON.parse(record.error):{code:'TASK_CANCELED',message:'该提交任务已取消'}};
    const status=await this.readTaskCommandStatus(deviceId,this.taskQueue.internal(task).pendingCommandId,task.thread_id);
    // 原命令已只读收口时同步提交任务状态，重放原编号仍返回同一回执而不再执行。
    if(status.state==='done')await this.taskQueue.control(deviceId,{taskId:commandId,action:'reconcile'});
    return status.state==='not_found'?{state:'unknown',error:{code:'OUTCOME_UNKNOWN',message:'操作结果需要核对，请勿重复提交',outcomeUnknown:true}}:status;
  }

  /** 新协议立即确认落盘，旧写接口等待相同任务结果，全部共用持久化执行器。 */
  async handleTaskRequest(message) {
    const {method,params,deviceId}=message;
    if(!this.taskQueue)throw new BridgeError('TASK_QUEUE_UNAVAILABLE','请更新电脑连接服务后使用提交任务');
    if(method==='tasks.submit') {
      const scope='task:'+params.taskId;
      // 已接纳任务先核对指纹；临时附件已经释放也不能破坏原编号的去重回执。
      const accepted=this.taskQueue.db.prepare('SELECT 1 FROM submission_task_keys WHERE device_id=? AND id=?').get(deviceId,params.taskId);
      if(!accepted&&params.kind==='newConversation')for(const id of params.payload.attachments??[]){const {metadata}=this.adapter.attachments.metadata(deviceId,scope,id);if(!metadata.complete)throw new BridgeError('UPLOAD_INCOMPLETE','附件尚未上传完成，输入已保留');}
      return this.taskQueue.submit(deviceId,params);
    }
    if(method==='tasks.list')return params.category==='operation'?this.operationHistory.list(deviceId,params):this.taskQueue.list(deviceId,params);
    if(method==='tasks.watch')return this.taskQueue.watch(deviceId);
    if(method==='tasks.unwatch')return this.taskQueue.unwatch(deviceId);
    if(method==='tasks.control')return this.taskQueue.control(deviceId,params);
    const payload={method,params,...(message.firstMessageGuard?{firstMessageGuard:message.firstMessageGuard}:{})};
    this.taskQueue.submit(deviceId,{taskId:message.requestId,kind:'command',payload});
    return this.taskQueue.wait(deviceId,message.requestId);
  }

  async handleRequest(message,{taskExecution=false}={}) {
    const response={v:1,type:'response',transportId:message.transportId};
    const diagnostic=this.diagnostics?.context(message);
    this.diagnosticInFlight++;
    this.diagnostics?.record('bridge.dispatch',diagnostic,{inFlight:this.diagnosticInFlight});
    try {
      validateRequest(message);
      if(typeof message.deviceId!=='string')throw new BridgeError('UNAUTHENTICATED','缺少手机身份');
      if(this.managementDraining&&!taskExecution&&(WRITE_METHODS.has(message.method)||UPLOAD_METHODS.has(message.method)||['tasks.submit','tasks.control'].includes(message.method)))throw new BridgeError('SERVICE_RESTARTING','电脑连接服务正在准备重启，请稍后再操作');
      // 详情读订阅只记录手机本身的存活意图，后台写步骤不会改变它。
      if(!taskExecution&&['thread.watch','thread.history','thread.unwatch'].includes(message.method)&&!message.params.view){
        const devices=this.detailDevices.get(message.params.threadId)??new Set();
        if(message.method==='thread.unwatch')devices.delete(message.deviceId);else devices.add(message.deviceId);
        if(devices.size)this.detailDevices.set(message.params.threadId,devices);else this.detailDevices.delete(message.params.threadId);
      }
      const instance=this.adapter.client?.instance;
      const expectedGeneration=message.expectedGeneration;
      if(expectedGeneration!==undefined&&(typeof expectedGeneration!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expectedGeneration)))throw new BridgeError('BAD_PARAMS','预期实例代次无效');
      // 排队可能跨过实例撤销，真正执行之前也必须复核手机预期的代次。
      const assertExpectedGeneration=()=>{
        if(expectedGeneration!==undefined&&(this.adapter.client?.instance!==instance||instance?.generation!==expectedGeneration||instance.alive!==true||instance.ready!==true)){
          throw new BridgeError('INSTANCE_CHANGED','实例已变化，请重新连接后核对原操作');
        }
      };
      assertExpectedGeneration();
      const guard=message.firstMessageGuard;
      if(guard!==undefined){
        // 首条消息保护只适用于已核验的普通单实例，不能绕过计划或排队入口。
        if(message.method!=='turn.send'||Object.keys(message.params).some(key=>!['threadId','text','images','attachments','pluginIds','threadMentionIds','choices'].includes(key))||
            guard==null||typeof guard!=='object'||Array.isArray(guard)||Object.keys(guard).length!==2||
            typeof guard.permissionRevision!=='string'||!/^[a-f0-9]{64}$/.test(guard.permissionRevision)||typeof guard.confirmedFullAccess!=='boolean'){
          throw new BridgeError('BAD_PARAMS','首条消息保护参数无效');
        }
        if(!supportsDesktopIpcNewConversation(this.adapter))throw new BridgeError('INSTANCE_CHANGED','桌面连接已变化，请重新连接');
      }
      if(!taskExecution&&(message.method.startsWith('tasks.')||WRITE_METHODS.has(message.method))&&this.taskQueue){response.result=await this.handleTaskRequest(message);return response;}
      let deletionTarget = null;
      let lockQueued = false;
      const execute=async()=>{
        assertExpectedGeneration();
        // 队列等待和实际执行分开记录，便于区分会话锁阻塞与桌面响应慢。
        this.diagnostics?.record('bridge.execute',diagnostic,{inFlight:this.diagnosticInFlight,queueWaitMs:this.diagnostics.elapsed(diagnostic),lockQueued});
        if(WRITE_METHODS.has(message.method)&&this.deletingIds.has(message.params.threadId))throw new BridgeError('DELETE_IN_PROGRESS','该聊天正在永久删除，请先核对删除结果');
        if(message.method==='turn.send'&&message.params.queueAction) {
          if(!this.messageQueue)throw new BridgeError('QUEUE_UNAVAILABLE','请更新电脑连接服务后使用消息排队');
          return this.messageQueue.operate(message.params,message.requestId,message.deviceId);
        }
        if(message.method==='thread.create.permissions')return this.adapter.permissionCatalog.read(this.newThreads.project(message.params.projectId).cwd);
        if(message.method==='thread.create.plugins')return readProjectPlugins(this.newThreads,this.adapter.pluginCatalog,message.params.projectId,this.adapter);
        if(message.method==='thread.plugins.read')return this.adapter.readPlugins(message.params.threadId,message.deviceId);
        if(message.method==='thread.permissions.read')return this.adapter.readPermissions(message.params.threadId,message.deviceId);
        if(message.method==='threads.mentions')return this.adapter.threadMentions.list(message.params);
        if(message.method==='projects.list'){
          const projects=this.newThreads.projects();
          const instance=this.adapter.client?.instance;
          // 优先使用原生 IPC 首轮请求，避免为新消息逐项修改桌面草稿。
          if(supportsDesktopIpcNewConversation(this.adapter)){
            const supportsNewChatMentions=this.adapter.threadMentions.savedContextAvailable?.()===true;
            return {...projects,supportsNativeNewDraft:false,supportsDirectMessageChoices:true,newConversationMode:'desktopIpc',...(supportsNewChatMentions?{supportsNewChatMentions:true}:{})};
          }
          const supportsNativeNewDraft=!usesWindowsIpcWithoutPage(instance)&&await this.nativeDrafts.controller.capabilities({reuse:true});
          if(supportsNativeNewDraft)return {...projects,supportsNativeNewDraft:true,supportsDirectMessageChoices:false,newConversationMode:'nativeDraft'};
          return {...projects,supportsNativeNewDraft:false,newConversationUnavailableReason:'电脑实例连接尚未就绪，请重新连接后读取项目'};
        }
        if(message.method.startsWith('thread.draft.')) {
          if(['thread.draft.open','thread.draft.read'].includes(message.method))await this.adapter.threadMentions.available();
          const action=message.method.slice('thread.draft.'.length);
          if(action==='read'||action==='unwatch')return this.nativeDrafts[action](message.params,message.deviceId);
          return this.nativeDrafts[action](message.params,message.deviceId,message.requestId,result=>this.journal.checkpoint(message.deviceId,message.requestId,result));
        }
        if(message.method==='thread.create.settings')return this.newThreads.settings(message.params.projectId);
        if(message.method==='thread.create')return this.newThreads.create(message.params.projectId,message.params.title,result=>this.journal.checkpoint(message.deviceId,message.requestId,result));
        if(message.method==='thread.archive') {
          const result=await archiveThread(this.adapter,this.archiveController,message.params.threadId,message.deviceId,result=>this.journal.checkpoint(message.deviceId,message.requestId,result),message.requestId);
          this.messageQueue?.forget([message.params.threadId]);
          this.threadCache.forget(message.params.threadId);
          this.published.delete(message.params.threadId);if(this.threadListFeed.started)this.threadListFeed.readIndex();return result;
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
          for(const id of result.deletedThreadIds){this.published.delete(id);this.threadCache.forget(id);}
          this.threadListFeed.schedule();return result;
        }
        if(message.method==='thread.prediction.read')return this.predictions.read(this.adapter,message.params.threadId,message.deviceId);
        // 静默预加载在通用历史订阅之前短路；只读取已有状态，不发布事件或改变订阅。
        if(message.method==='thread.history'&&message.params.view==='prefetch')return prefetchConversation(this.adapter,message.params.threadId,{isDeleting:()=>this.deletingIds.has(message.params.threadId)});
        if(message.method==='thread.history'&&message.params.view==='file-report')return this.fileReports.read(this.adapter,message.params,message.deviceId);
        if(message.method==='thread.settings.read')return this.adapter.readSettings(message.params.threadId,message.deviceId);
        if(message.method==='thread.goal.read')return this.adapter.readGoal(message.params.threadId,message.deviceId);
        if(UPLOAD_METHODS.has(message.method)){
          if(message.params.taskId)return this.adapter.attachments[message.method.slice('attachment.'.length)](message.deviceId,'task:'+message.params.taskId,message.params);
          return message.params.draftId?this.nativeDrafts.transfer(message.method,message.params,message.deviceId):this.adapter.transfer(message.method,message.params,message.deviceId);
        }
        if(message.method==='threads.watch')return {...await this.threadListFeed.watch(message.deviceId),...(this.taskQueue?{supportsTaskQueue:true}:{})};
        if(message.method==='threads.unwatch')return this.threadListFeed.unwatch(message.deviceId);
        if(message.method==='threads.cache.watch')return this.threadCache.watch(message.deviceId,message.params);
        if(message.method==='threads.cache.unwatch')return this.threadCache.unwatch(message.deviceId,message.params);
        if(message.method==='threads.list') {
          // 通过已有白名单接口扩展只读信息；显式归档标记供手机识别旧服务。
          let result;
          if(message.params.archived===true)result={threads:await this.adapter.list(message.params),archived:true};
          else {
            result=this.threadListFeed.list();
            const {search='',offset=0,limit=50}=message.params;
            if(search||offset||limit>50) {
              const known=new Map(result.threads.map(row=>[row.id,row]));
              result={...result,threads:this.adapter.index.list(message.params).map(row=>({...this.threadListFeed.contentSummary(row),...(known.get(row.id)??{}),...row}))};
            }else result={...result,threads:result.threads.slice(0,limit)};
          }
          return {...result,...(this.taskQueue?{supportsTaskQueue:true}:{}),...(message.params.includeUsage===true?{usage:await readAccountUsage(this.newThreads)}:{})};
        }
        if(message.method==='thread.read') {
          const read=()=>this.adapter.markRead(message.params.threadId,message.deviceId);
          return this.operationHistory?this.operationHistory.run({deviceId:message.deviceId,requestId:message.requestId,method:'thread.read',threadId:message.params.threadId,alreadyRead:this.adapter.native?.unread?.get(message.params.threadId)===false},read,read):read();
        }
        if(message.method==='thread.images')return this.adapter.messageImages(message.params.threadId,message.params.messageId,message.deviceId,message.params);
        if(message.method==='thread.history'&&message.params.page===true)return this.adapter.historyPage(message.params.threadId,message.deviceId,message.params);
        if(message.method==='thread.watch'||message.method==='thread.history') {
          await this.adapter.threadMentions.available();
          const id=message.params.threadId;
          const readSavedHistory=this.adapter.index?.historyCacheSource?threadId=>this.threadCache.readSaved(threadId):undefined;
          this.threadCache.remember(id);
          // 首帧读取与桌面导航并行，预览失败不会中断原有实时订阅。
          let finished=false,preview;
          if(message.method==='thread.watch'&&message.params.previewId&&message.params.contentRevision===undefined) {
            this.threadCache.preview(id).then(cached=>{
              if(finished||!cached||this.deletingIds.has(id))return;
              const snapshot=recentConversationPage(cached.snapshot);
              // 预览的空可执行题组不能遮住展示题组，版本仍须包含待回答的问题。
              const current={snapshot,contentRevision:conversationContentRevision({...snapshot,questionGroups:undefined})};
              const sent=this.send({v:1,type:'thread.preview',transportId:message.transportId,deviceId:message.deviceId,previewId:message.params.previewId,threadId:id,...current});
              if(sent!==false)preview=current;
            }).catch(()=>{});
          }
          let snapshot;
          try {
            const watch=activate=>this.adapter.watch(id,message.deviceId,{activate,readSavedHistory});
            snapshot=message.params.activate===true&&this.operationHistory?
              await this.operationHistory.run({deviceId:message.deviceId,requestId:message.requestId,method:'thread.sync',threadId:id},()=>watch(true),()=>watch(false)):await watch(message.params.activate===true);
          }
          // 已有实时快照时直接结束读取；晚到的历史预览不能拖慢或覆盖实时回执。
          finally { finished=true; }
          this.threadCache.schedule();
          const result=this.watchResult(snapshot,message,preview);
          this.captureCache(snapshot);
          return result;
        }
        if(message.method==='thread.unwatch'){const result=this.adapter.unwatch(message.params.threadId,message.deviceId);if(!hasDetailWatcher(this.adapter,message.params.threadId))this.published.delete(message.params.threadId);return result;}
        if(message.method==='command.status')return this.legacyCommandStatus(message.deviceId,message.params.commandId);
        if(WRITE_METHODS.has(message.method))return this.adapter.operate(message.method,message.params,message.requestId,message.deviceId,result=>this.journal.checkpoint(message.deviceId,message.requestId,result),guard);
        throw new BridgeError('METHOD_NOT_ALLOWED','此接口不支持通过电脑执行');
      };
      if(WRITE_METHODS.has(message.method)) {
        const key=message.method==='thread.create'?'create:'+message.deviceId:message.method.startsWith('thread.draft.')?'draft:'+(message.params.draftId??message.params.projectId):message.params.threadId, previous=this.threadLocks.get(key)??Promise.resolve();
        lockQueued=this.threadLocks.has(key);
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
        // 首条保护参与原命令指纹；代次只限制路由，恢复时仍可用原命令核对。
        const journalParams=guard===undefined?message.params:{...message.params,firstMessageGuard:guard};
        const operation=previous.catch(()=>{}).then(()=>this.journal.execute(message.deviceId,message.requestId,message.method,journalParams,execute));
        this.threadLocks.set(key,operation);
        try { response.result=await operation; } finally {if(this.threadLocks.get(key)===operation)this.threadLocks.delete(key);}
      } else response.result=await execute();
    } catch(error) {response.error=errorPayload(error);}
    finally {
      this.diagnosticInFlight--;
      this.diagnostics?.record('bridge.completed',diagnostic,{inFlight:this.diagnosticInFlight,elapsedMs:this.diagnostics.elapsed(diagnostic),failed:!!response.error,errorCode:response.error?.code,outcomeUnknown:response.error?.outcomeUnknown===true});
    }
    return response;
  }
  async close(){this.stopped=true;this.taskClosed=true;this.messageQueue?.close();await this.taskQueue?.close();this.clientPresence.close();this.threadCache.close();this.adapter.threadMentions?.close();await this.nativeDrafts.close();clearTimeout(this.reconnectTimer);this.socket?.terminate();this.fileReports.close();this.threadListFeed.close();this.adapter.close();await Promise.allSettled(this.threadLocks.values());this.journal.close();}
}
