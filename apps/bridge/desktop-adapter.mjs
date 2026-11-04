import { firstMessagePermissions, readPermissions, updatePermissions } from './permissions.mjs';
import { EventEmitter } from 'node:events';
import { predictionTurnId } from './prediction-turn.mjs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { IpcClient } from '../../packages/protocol/ipc-client.mjs';
import { BridgeError, validateTurnRetry, validateTurnInput } from '../../packages/protocol/contracts.mjs';
import { applyPatches, normalizeConversation } from './conversation.mjs';
import { formatQuestionReply, validateQuestionAnswers, questionCounts } from './questions.mjs';
import { DesktopNavigation } from './desktop-navigation.mjs';
import { NativeDesktop } from './native-desktop.mjs';
import { openDesktopThread } from './desktop-launcher.mjs';
import { validateImages } from '../../packages/protocol/images.mjs';
import { resetPlanAfterSend, preparePlanForSend } from './plan-reset.mjs';
import { ModelCatalog, executionSettings, validateSettings, resolveExecutionEffort } from './model-settings.mjs';
import { AttachmentStore } from './attachment-store.mjs';
import { DesktopGoalController } from './desktop-goals.mjs';
import { readGoal, updateGoal } from './goals.mjs';
import { readThreadPlugins, selectThreadPlugins, pluginPrompt } from './plugins.mjs';
import { threadMentionPrompt } from './thread-mentions.mjs';
import { CACHE_WATCHER, CACHE_THREAD_LIMIT } from './thread-cache.mjs';

const internalWatcher=id=>id===CACHE_WATCHER||id==='list-status';
import { usesWindowsIpcWithoutPage, supportsDesktopIpcNewConversation } from './windows-ipc-mode.mjs';

/** 作为现有桌面会话的跟随者操作，所有执行与审批仍由原桌面所有者完成。 */
export class DesktopAdapter extends EventEmitter {
  constructor({ client = new IpcClient(), native=null, index, hosts = ['local','durable'], snapshotTimeoutMs = 8000, activateThread=openDesktopThread, loadTimeoutMs=10000, modelCatalog=new ModelCatalog(), attachments=new AttachmentStore(), goalController=new DesktopGoalController(), permissionCatalog=null } = {}) {
    super();
    this.client=client; this.index=index; this.hosts=hosts; this.snapshotTimeoutMs=snapshotTimeoutMs;
    this.modelCatalog=modelCatalog;this.attachments=attachments;
    this.goalController=goalController;this.permissionCatalog=permissionCatalog;
    this.conversations=new Map(); this.connecting=null; this.reconnectTimer=null; this.stopped=false;
    this.activityHistory=new Map();this.backgroundRotation={startedAt:0,count:0};
    this.native=native??(client instanceof IpcClient?new NativeDesktop({stateDirectory:index?.filePath?path.dirname(index.filePath):null,ipcSocketPath:client.socketPath}):null);
    this.native?.on('changed',ids=>{if(this.stopped)return;for(const id of ids){const entry=this.conversations.get(id);if(entry?.state)this.emit('conversation',this.snapshot(entry.state));else this.emit('readState',{threadId:id,hasUnreadTurn:this.native.unread.get(id)});}});
    this.activateThread=(id,options)=>activateThread(id,{...options,nativeApi:this.native??undefined});this.loadTimeoutMs=loadTimeoutMs;this.loadingThreads=new Map();this.navigation=new DesktopNavigation();
    client.on('broadcast', message => this.onBroadcast(message));
    client.on('transportError', error => this.emit('adapterWarning',{code:error.code??'IPC_ERROR',message:'本地 Codex 连接中断，正在等待恢复'}));
    client.on('disconnected', () => {
      for(const entry of this.conversations.values()) { entry.owner=null; entry.state=null; entry.revision=null; }
      this.emit('adapterWarning',{code:'DESKTOP_DISCONNECTED',message:'桌面连接已断开，请确认 Codex 正在运行'});
      if(!this.stopped) this.reconnectTimer=setTimeout(()=>this.connect().catch(()=>{}),1000);
    });
  }

  async connect() {
    if(this.connecting) return this.connecting;
    this.connecting=(async()=>{
      try { await this.client.connect(); for(const [threadId,entry] of this.conversations) if(entry.watchers.size&&!entry.owner) { const watcher=[...entry.watchers][0];this.watch(threadId,watcher,{history:!internalWatcher(watcher)}).catch(()=>{}); } }
      catch(error) { this.client.close(); throw error; }
      finally { this.connecting=null; }
    })();
    return this.connecting;
  }

  /** 缺少实例活动入口时，只读变化历史的生命周期，候选仍需实时核验。 */
  async readActivityInventory() {
    if(!this.index?.historyActivity||!this.index?.historyCacheSource)return {complete:false,threadIds:[]};
    const rows=this.index.list({limit:50}),present=new Set(rows.map(row=>row.id)),threadIds=[];
    for(const id of this.activityHistory.keys())if(!present.has(id))this.activityHistory.delete(id);
    for(const row of rows) {
      await new Promise(resolve=>setImmediate(resolve));
      if(this.stopped)return {complete:false,threadIds:[]};
      try {
        const source=this.index.historyCacheSource(row.id);let activity=this.activityHistory.get(row.id);
        if(source&&activity?.source!==source){activity={source,...this.index.historyActivity(row.id)};this.activityHistory.set(row.id,activity);}
        if(activity?.status==='active')threadIds.push(row.id);
      }catch{/* 保存记录仅提供候选，缺失或失败仍是未知。 */}
    }
    return {complete:false,threadIds};
  }
  /** 前台优先；纯内部条目有独立上限，满额后按有界节奏轮转。 */
  reserveEntry(deviceId) {
    const internal=internalWatcher(deviceId);
    const background=[...this.conversations].filter(([,value])=>![...value.watchers].some(id=>!internalWatcher(id)));
    if((internal&&background.length>=50)||this.conversations.size>=64+CACHE_THREAD_LIMIT) {
      if(!background.length)throw new BridgeError('TOO_MANY_THREADS','订阅聊天过多，请关闭不用的聊天');
      if(internal) {
        const now=Date.now();if(now-this.backgroundRotation.startedAt>=2000)this.backgroundRotation={startedAt:now,count:0};
        if(this.backgroundRotation.count>=2)throw new BridgeError('TOO_MANY_THREADS','后台聊天正在分批核对');
        this.backgroundRotation.count++;
      }
      const [id,entry]=background[0];for(const watcher of [...entry.watchers])this.unwatch(id,watcher);
    }
  }
  /** 列表状态来自桌面实时快照；不存在所有者或读取失败时明确返回未知，绝不猜测空闲。 */
  async list(params) {
    const rows=this.index.list(params), result=new Array(rows.length);
    // 归档列表只读索引，不能订阅或唤醒已经归档的桌面会话。
    if(params?.archived===true)return rows;
    await this.refreshReadState(rows.map(row=>row.id));
    let next=0;
    const worker=async()=>{
      while(next<rows.length) {
        const position=next++, row=rows[position], watcher='status:'+randomUUID();
        try {
          const snapshot=await this.watch(row.id,watcher,{snapshotTimeoutMs:1000,ownerTimeoutMs:500,history:false});
          // 异步问题不改变运行状态，但列表仍同步全部待回答数量。
          result[position]={...row,latestTurn:snapshot.latestTurn ? {turnId:snapshot.latestTurn.turnId,status:snapshot.latestTurn.status} : undefined,hasUnreadTurn:snapshot.hasUnreadTurn,activeFlags:snapshot.activeFlags,status:snapshot.status,activeTurnId:snapshot.activeTurnId,approvalCount:snapshot.approvals.length,...questionCounts(snapshot)};
        } catch { result[position]={...row,hasUnreadTurn:this.native?.unread.get(row.id),status:'unknown',activeTurnId:'',approvalCount:0,pendingQuestionCount:0}; }
        finally { this.unwatch(row.id,watcher); }
      }
    };
    await Promise.all(Array.from({length:Math.min(8,rows.length)},worker));
    return result;
  }

  /** 单个来源超时后仍查询其他来源，避免 local 超时掩盖 durable 所有者。 */
  async discoverOwner(threadId, timeoutMs) {
    for (const hostId of this.hosts) {
      try { const owner=await this.client.findOwner(threadId,hostId,timeoutMs); if(owner) return owner; }
      catch(error) { if(error.code!=='IPC_TIMEOUT') throw error; }
    }
    return null;
  }

  /** 明确继续时才加载桌面会话；并发共用一次加载，超时也不会发送或重放用户指令。 */
  async loadOwner(threadId,requestDeadline) {
    if(this.loadingThreads.has(threadId))return this.loadingThreads.get(threadId);
    const loading=(async()=>{
      if(!this.index?.containsThread?.(threadId))throw new BridgeError('THREAD_NOT_FOUND','这条聊天已不存在或已经归档，请刷新聊天列表');
      if(this.stopped)throw new BridgeError('SUBSCRIPTION_CANCELED','连接服务已停止');
      // 显式打开已统一发出导航；这里只等待原桌面所有者，不重复切换。
      const deadline=Math.min(Date.now()+this.loadTimeoutMs,requestDeadline);
      while(!this.stopped&&Date.now()<deadline){
        const owner=await this.discoverOwner(threadId,Math.min(1000,Math.max(1,Math.floor((deadline-Date.now())/this.hosts.length))));
        if(owner)return owner;
        if(Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,Math.min(200,deadline-Date.now())));
      }
      throw new BridgeError('DESKTOP_LOAD_TIMEOUT','电脑仍在加载聊天，请稍后点击继续此聊天重试');
    })();
    this.loadingThreads.set(threadId,loading);
    try{return await loading;}finally{if(this.loadingThreads.get(threadId)===loading)this.loadingThreads.delete(threadId);}
  }

  async watch(threadId, deviceId, {fresh=false,snapshotTimeoutMs=this.snapshotTimeoutMs,ownerTimeoutMs=500,history=true,activate=false,readSavedHistory,isCurrent=()=>true} = {}) {
    // 总等待留在中转十五秒超时以内；默认只读历史，明确 activate 才导航桌面。
    const navigation=activate?this.navigation.begin(threadId,deviceId):null;
    const requestDeadline=Date.now()+14000;
    await this.connect();
    if(!isCurrent())throw new BridgeError('SUBSCRIPTION_CANCELED','这条聊天的同步已取消');
    let entry=this.conversations.get(threadId);
    // 后台跟随有独立额度，不能挤占手机详情或列表既有订阅额度。
    if (!internalWatcher(deviceId) && (!entry || ![...entry.watchers].some(id=>!internalWatcher(id)))) {
      const regular=[...this.conversations.values()].filter(item=>[...item.watchers].some(id=>!internalWatcher(id))).length;
      if(regular>=64) throw new BridgeError('TOO_MANY_THREADS','订阅聊天过多，请关闭不用的聊天');
    }
    if(!entry) {
      this.reserveEntry(deviceId);
      entry={watchers:new Set(),owner:null,state:null,revision:null,waiters:[],publishTimer:null};
      this.conversations.set(threadId,entry);
    }
    entry.watchers.add(deviceId);
    {
      const previous=entry.owner;
      let discovered;
      try {
        if(activate) {
          if(!this.index?.containsThread?.(threadId))throw new BridgeError('THREAD_NOT_FOUND','这条聊天已不存在或已经归档，请刷新聊天列表');
          await this.navigation.run(navigation,(id,options)=>this.activateThread(id,options));
          fresh=true;
        }
        discovered=await this.discoverOwner(threadId,ownerTimeoutMs);
        // 用户切换会话或断开后，不再启动加载，也不遗留迟到的跟随订阅。
        const current=()=>!this.stopped&&isCurrent()&&this.conversations.get(threadId)===entry&&entry.watchers.has(deviceId)&&(!navigation||this.navigation.isCurrent(navigation));
        if(!current()) throw new BridgeError('SUBSCRIPTION_CANCELED','这条聊天的同步已取消');
        if(!discovered&&activate){discovered=await this.loadOwner(threadId,requestDeadline-1000);if(!current())throw new BridgeError('SUBSCRIPTION_CANCELED','这条聊天的同步已取消');}
        if(!discovered&&history) {
          if(!this.index?.readHistory) throw new BridgeError('HISTORY_UNAVAILABLE','暂时无法读取这条聊天的已保存历史');
          const saved=await (readSavedHistory ? readSavedHistory(threadId) : this.index.readHistory(threadId));
          if(!current()) throw new BridgeError('SUBSCRIPTION_CANCELED','这条聊天的同步已取消');
          if(previous&&this.client.socket?.writable) this.client.broadcast('thread-stream-following-changed',{hostId:previous.hostId,conversationId:threadId,following:false},1,[previous.clientId]);
          entry.owner=null;entry.state=null;entry.revision=null;
          const history=this.native?{...saved,hasUnreadTurn:this.native.unread.get(threadId)}:saved;
          return {...history,supportsFileReports:this.supportsFileReports};
        }
        // 列表临时探测失败时只撤销本次订阅，不能清空手机正在使用的所有者和快照。
        if(!discovered) throw new BridgeError('HISTORY_READ_ONLY','请先点击继续此聊天，加载完成后再操作');
        if(!current()) throw new BridgeError('SUBSCRIPTION_CANCELED','这条聊天的同步已取消');
      }
      catch(error) { if(this.conversations.get(threadId)===entry&&(!navigation||this.navigation.current===navigation||this.navigation.current?.threadId!==threadId)) this.unwatch(threadId,deviceId); throw error; }
      entry.owner=discovered;
      if(entry.owner?.clientId!==previous?.clientId){entry.state=null;entry.revision=null;}
      if(!entry.owner) { this.unwatch(threadId,deviceId); throw new BridgeError('HISTORY_READ_ONLY','请先点击继续此聊天，加载完成后再操作'); }
    }
    if(entry.state&&!fresh) return this.snapshot(entry.state);
    const snapshot=new Promise((resolve,reject)=>{
      const waiter={resolve,reject}; waiter.timer=setTimeout(()=>{entry.waiters=entry.waiters.filter(value=>value!==waiter);reject(new BridgeError('SNAPSHOT_TIMEOUT','桌面聊天快照读取超时'));},Math.min(snapshotTimeoutMs,Math.max(1,requestDeadline-Date.now())));entry.waiters.push(waiter);
    });
    this.client.broadcast('thread-stream-following-changed',{hostId:entry.owner.hostId,conversationId:threadId,following:true},1,[entry.owner.clientId]);
    return snapshot;
  }

  unwatch(threadId,deviceId) {
    this.navigation.cancel(threadId,deviceId);
    const entry=this.conversations.get(threadId); if(!entry) return {ok:true};
    entry.watchers.delete(deviceId);
    if(entry.watchers.size===0) {
      for(const waiter of entry.waiters.splice(0)) {clearTimeout(waiter.timer);waiter.reject(new BridgeError('SUBSCRIPTION_CANCELED','这条聊天的同步已取消'));}
      if(entry.owner&&this.client.socket?.writable) {
        // 旧所有者换代后也必须释放本地状态，定向退订只作尽力通知。
        try { this.client.broadcast('thread-stream-following-changed',{hostId:entry.owner.hostId,conversationId:threadId,following:false},1,[entry.owner.clientId]); } catch { }
      }
      clearTimeout(entry.publishTimer); this.conversations.delete(threadId);
    }
    return {ok:true};
  }

  onBroadcast(message) {
    if(message.method==='thread-read-state-changed'){this.native?.schedule([message.params?.conversationId].filter(Boolean));return;}
    if(message.method!=='thread-stream-state-changed'||message.version!==11) return;
    const entry=this.conversations.get(message.params?.conversationId);
    if(!entry?.owner||message.sourceClientId!==entry.owner.clientId||message.params.hostId!==entry.owner.hostId) return;
    const change=message.params.change;
    const previousAttention=JSON.stringify([entry.state?.hasUnreadTurn,entry.state?.threadRuntimeStatus]);
    try {
      if(change.type==='snapshot') { entry.state=change.conversationState; entry.revision=change.revision; }
      else if(change.type==='patches'&&entry.state&&entry.revision===change.baseRevision) { applyPatches(entry.state,change.patches); entry.revision=change.revision; }
      else { entry.state=null; this.client.broadcast('thread-stream-following-changed',{hostId:entry.owner.hostId,conversationId:message.params.conversationId,following:true},1,[entry.owner.clientId]);return; }
      if(entry.state?.id!==message.params.conversationId)throw new BridgeError('HISTORY_ID_MISMATCH','桌面聊天快照编号不一致');
      if(previousAttention!==JSON.stringify([entry.state?.hasUnreadTurn,entry.state?.threadRuntimeStatus]))this.native?.schedule([message.params.conversationId]);
      // 没有首帧等待者时只合并补丁，完整投影留到固定发布帧，避免每个 token 重建长聊天。
      if(entry.waiters.length) {
        const normalized=this.snapshot(entry.state);
        for(const waiter of entry.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.resolve(normalized); }
      }
      if(!entry.publishTimer) entry.publishTimer=setTimeout(()=>{entry.publishTimer=null;if(entry.state)this.emit('conversation',this.snapshot(entry.state));},200);
    } catch(error) {
      entry.state=null;
      if(this.client.socket?.writable)this.client.broadcast('thread-stream-following-changed',{hostId:entry.owner.hostId,conversationId:message.params.conversationId,following:true},1,[entry.owner.clientId]);
      this.emit('adapterWarning',{code:'SNAPSHOT_RESET',message:'聊天状态需要重新同步'});
    }
  }

  /** 图片只从该手机已订阅会话的可见用户消息读取，不接受手机传入文件路径或图片地址。 */
  async messageImages(threadId,messageId,deviceId,options={}) {
    const entry=this.conversations.get(threadId);
    if(!entry?.watchers.has(deviceId))throw new BridgeError('SUBSCRIPTION_REQUIRED','请先打开这条聊天再查看图片');
    const selection={imageMessageId:messageId,...(options.imageIndex === undefined ? {} : {imageIndex:options.imageIndex})};
    const snapshot=entry.state?normalizeConversation(entry.state,selection):await this.index?.readHistory(threadId,selection);
    // 异步读取结束后再次核对订阅，切换会话或设备断开后不返回原图。
    if(this.conversations.get(threadId)!==entry||!entry.watchers.has(deviceId))throw new BridgeError('SUBSCRIPTION_CANCELED','这条聊天的同步已取消');
    const message=snapshot?.messages.find(item=>item.id===messageId&&['user','assistant'].includes(item.role));
    if(!message?.images?.length)throw new BridgeError('IMAGE_UNAVAILABLE','这条记录没有保留可预览的图片，请重新发送原图');
    // 每个回复片段小于协议上限；手机只能选择消息内的图片序号。
    if(options.imageIndex !== undefined) {
      const source=message.images[0], size=1024*1024, count=Math.ceil(source.length/size);
      if(options.chunkIndex>=count)throw new BridgeError('BAD_PARAMS','图片分片编号超出范围');
      return {imageCount:message.imageCount,chunkCount:count,data:source.slice(options.chunkIndex*size,(options.chunkIndex+1)*size)};
    }
    return {images:message.images};
  }

  /** 翻页只读取已订阅会话的保存记录，不导航桌面，也不发布成实时状态。 */
  async historyPage(threadId,deviceId,options) {
    const entry=this.conversations.get(threadId);
    if(!entry?.watchers.has(deviceId))throw new BridgeError('SUBSCRIPTION_REQUIRED','请先打开这条聊天再加载历史');
    if(!this.index?.readHistory)throw new BridgeError('HISTORY_UNAVAILABLE','当前电脑暂不支持读取早期记录');
    const page=await this.index.readHistory(threadId,{...options,page:true});
    if(this.conversations.get(threadId)!==entry||!entry.watchers.has(deviceId))throw new BridgeError('SUBSCRIPTION_CANCELED','聊天已切换，已停止读取历史');
    return page;
  }

  /** 设置读取和附件上传均要求手机已订阅，绝不借上传或选择菜单唤醒其他会话。 */
  subscribed(threadId,deviceId) {
    const entry=this.conversations.get(threadId);
    if(!entry?.watchers.has(deviceId)||!entry.owner||!entry.state)throw new BridgeError('SUBSCRIPTION_REQUIRED','请先加载此聊天后再操作');
    return entry;
  }

  readPermissions(threadId,deviceId) { return readPermissions(this,threadId,deviceId); }

  /** 插件只读和发送选择共用订阅及实例核对，不接收手机提供的原生路径。 */
  readPlugins(threadId,deviceId) { return readThreadPlugins(this,threadId,deviceId); }
  selectPlugins(threadId,deviceId,ids) { return selectThreadPlugins(this,threadId,deviceId,ids); }

  async readSettings(threadId,deviceId) {
    const entry=this.subscribed(threadId,deviceId),owner=entry.owner;
    const response=await this.client.request('thread-follower-read-model-settings',{conversationId:threadId},1,{targetClientId:owner.clientId,timeoutMs:5000});
    if(this.subscribed(threadId,deviceId)!==entry||entry.owner!==owner)throw new BridgeError('SUBSCRIPTION_CANCELED','聊天已切换，请重新打开设置');
    const settings=response.result?.settings;
    if(response.resultType!=='success'||!settings?.model)throw new BridgeError('SETTINGS_UNAVAILABLE','电脑端暂不支持读取模型设置，请更新后重试');
    const current=executionSettings(entry.state)??{model:settings.model,effort:settings.reasoningEffort??'',serviceTier:'',mode:'default'};
    // 回执切换了模型时，不能把旧模型的强度套到新模型；缺省档位按桌面目录解析。
    if(current.model!==settings.model)current.effort='';
    current.model=settings.model;current.effort=settings.reasoningEffort??current.effort;
    const models=this.modelCatalog.read(settings.modelProvider??entry.state.modelProvider??'openai');
    return {settings:resolveExecutionEffort(current,models),models};
  }

  /** 只读刷新原生未读记录，失败保留未知，不猜测已读。 */
  async refreshReadState(ids){try{await this.native?.refresh(ids);}catch{}}

  /** 文件汇总能力由已核验的本机原生算法或页面通道决定。 */
  get supportsFileReports() { return this.nativeFileReportAvailable?.()??(process.platform==='win32'&&!usesWindowsIpcWithoutPage(this.client.instance)); }
  /** 目标控制能力由本机帮助程序决定，历史记录不能声明实时目标操作能力。 */
  snapshot(state,options) {
    const snapshot={...normalizeConversation(state,options),supportsThreadMentions:this.threadMentions?.supported===true,supportsFileReports:this.supportsFileReports,supportsComposerPrediction:process.platform==='win32',predictionTurnId:predictionTurnId(state),supportsGoalControl:this.goalController.available&&Object.hasOwn(state,'threadGoal')};
    // 侧边栏保存的未读独立于流式快照，不能用快照默认 false 提前清理桌面蓝点。
    if(this.native){if(this.native.unread.has(state.id))snapshot.hasUnreadTurn=this.native.unread.get(state.id);else delete snapshot.hasUnreadTurn;}
    const entry=this.conversations.get(state.id);
    // 桌面实时状态可能没有标题；每次订阅最多查询一次索引，避免流式更新反复读取 SQLite。
    let title=[state.title,state.fallbackSearchTitle].find(value=>typeof value==='string'&&value.trim().length>0);
    if(!title) {
      if(entry&&!Object.hasOwn(entry,'indexedTitle')) {
        try {entry.indexedTitle=this.index?.readTitle?.(state.id) ?? '';}
        catch {entry.indexedTitle='';}
      }
      title=entry?.lastTitle||entry?.indexedTitle;
    }
    if(typeof title==='string'&&title.trim().length>0) {snapshot.title=title;if(entry)entry.lastTitle=title;}
    return snapshot;
  }
  readGoal(threadId,deviceId) { return readGoal(this,threadId,deviceId); }

  transfer(method,params,deviceId) {
    this.subscribed(params.threadId,deviceId);
    return this.attachments[method.slice('attachment.'.length)](deviceId,params.threadId,params);
  }

  /** 每次重试都回读原所有者；拒绝时立即同步状态，让手机撤下过期入口。 */
  async retryTurn(params,commandId,deviceId) {
    validateTurnRetry(params);
    await this.watch(params.threadId,deviceId,{fresh:true,history:false});
    const entry=this.subscribed(params.threadId,deviceId),snapshot=this.snapshot(entry.state);
    const reject=(code,message)=>{this.emit('conversation',snapshot);throw new BridgeError(code,message);};
    if(snapshot.readOnly||snapshot.activeTurnId||snapshot.status==='active')reject('TURN_ACTIVE','任务状态已变化，请核对最新聊天后操作');
    if(snapshot.latestTurn?.turnId!==params.expectedTurnId||snapshot.latestTurn.status!=='failed')reject('STALE_TURN','失败任务已变化，请核对最新聊天后操作');
    const pendingRequest=(entry.state.requests??[]).some(entry=>{
      const request=entry.request??entry;
      return request.completed!==true&&(request.method?.endsWith('/requestApproval')||request.method==='item/tool/requestUserInput');
    });
    if(pendingRequest||snapshot.approvals.length||snapshot.questionGroups.some(group=>group.state==='pending')||snapshot.pendingPlan||snapshot.activeFlags?.length)reject('TURN_RETRY_BLOCKED','请先处理当前审批、问题或计划后再重试');
    // 与桌面手动重试一致：空输入继续上下文，不创建或恢复用户消息，不重发上次正文。
    const response=await this.client.request('thread-follower-start-turn',{
      conversationId:params.threadId,
      turnStart:{request:{threadId:params.threadId,input:[],turnTrigger:'capacity_retry_manual'},context:{inheritThreadSettings:true}}
    },2,{targetClientId:entry.owner.clientId,timeoutMs:15000});
    if(response.resultType!=='success')throw new BridgeError('OWNER_UNAVAILABLE','桌面聊天所有者已不可用');
    return {ok:true,commandId,threadId:params.threadId,expectedTurnId:params.expectedTurnId,result:response.result};
  }

  /** 发送首条消息前以当前绑定和最新快照核对空会话，并返回本次明确使用的权限。 */
  firstMessageContext(threadId,deviceId,guard,expected=null) {
    const instance=this.client.instance;
    if(!supportsDesktopIpcNewConversation(this))throw new BridgeError('INSTANCE_CHANGED','桌面连接已变化，请重新连接');
    const entry=this.subscribed(threadId,deviceId), owner=entry.owner;
    const cwd=entry.state.cwd??entry.state.environments?.[0]?.cwd;
    if(expected&&(expected.instance!==instance||expected.generation!==instance.generation||expected.entry!==entry||expected.ownerId!==owner.clientId||expected.hostId!==owner.hostId||expected.cwd!==cwd)){
      throw new BridgeError('SUBSCRIPTION_CANCELED','原聊天连接已变化，请重新打开后核对');
    }
    const snapshot=normalizeConversation(entry.state), history=entry.state.turnHistory?.history;
    if(entry.state.historyTruncated||!Array.isArray(entry.state.turns)&&!history?.entitiesByKey||
        snapshot.activeTurnId||snapshot.status==='active'||snapshot.messages.length||snapshot.turns.length||entry.state.turns?.length||
        (history?.entitiesByKey&&Object.keys(history.entitiesByKey).length)){
      throw new BridgeError('FIRST_MESSAGE_CHANGED','电脑未确认原聊天为空，请核对后重试');
    }
    const permissions=firstMessagePermissions(entry.state,guard);
    return {instance,generation:instance.generation,entry,ownerId:owner.clientId,hostId:owner.hostId,cwd,permissions};
  }

  async operate(method,params,commandId,deviceId,checkpoint=()=>{},firstMessageGuard) {
    if(method==='turn.send'||method==='turn.steer')validateTurnInput(params);
    if(method==='turn.retry')return this.retryTurn(params,commandId,deviceId);
    // 正文由最新桌面计划提供，手机只能选择计划编号。
    if(method==='turn.send'&&params.planAction!==undefined) {
      await this.watch(params.threadId,deviceId,{fresh:true,history:false});
      const plan=normalizeConversation(this.subscribed(params.threadId,deviceId).state).pendingPlan;
      if(!plan||plan.id!==params.planId)throw new BridgeError('STALE_PLAN','计划已处理或发生变化，请重新同步');
      if(!['implement','feedback'].includes(params.planAction))throw new BridgeError('BAD_PARAMS','计划操作无效');
      const text=params.planAction==='implement'?'PLEASE IMPLEMENT THIS PLAN:\n'+plan.text:params.text;
      if(typeof text!=='string'||!text.trim()||text.length>32000)throw new BridgeError('BAD_PARAMS','计划或修改意见为空或过长');
      return this.operate('turn.send',{threadId:params.threadId,text,...(params.planAction==='implement'?{planMode:'default',resetPlanAfterSend:true}:{})},commandId,deviceId,checkpoint);
    }
    if(method==='thread.permissions.update')return updatePermissions(this,params,commandId,deviceId,checkpoint);
    if(method==='thread.goal.update')return updateGoal(this,params,commandId,deviceId);
    // 问答在回传前读取所有者最新快照，避免使用手机停留期间的旧问题。
    await this.watch(params.threadId,deviceId,{fresh:firstMessageGuard!==undefined||method==='question.reply'||(method==='turn.send'&&params.resetPlanAfterSend===true),history:false});
    const firstMessage=firstMessageGuard===undefined?null:this.firstMessageContext(params.threadId,deviceId,firstMessageGuard);
    if(method==='turn.send'&&params.resetPlanAfterSend===true) {
      const current=normalizeConversation(this.conversations.get(params.threadId).state);
      if(current.activeTurnId||current.status==='active')throw new BridgeError('TURN_ACTIVE','任务正在运行，请使用追加指令');
      await preparePlanForSend(this,params,deviceId,commandId);
    }
    // 未选择插件时沿用原路径，不启动目录短连接；选择后在异步返回时再次核对上下文。
    const selection=['turn.send','turn.steer'].includes(method)&&params.pluginIds?.length?await this.selectPlugins(params.threadId,deviceId,params.pluginIds):null;
    selection?.check();
    const plugins=selection?.plugins??[];
    const mentions=['turn.send','turn.steer'].includes(method)&&params.threadMentionIds?.length?await this.threadMentions?.select(params.threadMentionIds,params.threadId,deviceId,{savedContext:firstMessage!==null}):null;
    if(params.threadMentionIds?.length&&!mentions)throw new BridgeError('THREAD_MENTIONS_UNAVAILABLE','请更新电脑连接服务后引用聊天');
    selection?.check(); mentions?.check();
    const entry=this.conversations.get(params.threadId), snapshot=normalizeConversation(entry.state), base={conversationId:params.threadId};
    let ipcMethod,version,payload;
    // 桌面高层发送接口需要可恢复的用户消息上下文，工作目录沿用原会话。
    const text=typeof params.text==='string'?params.text:'';
    const cwd=entry.state.cwd??entry.state.environments?.[0]?.cwd??'/';
    const prompt=threadMentionPrompt(pluginPrompt(text,plugins),mentions);
    const restoreMessage={id:commandId,text:prompt,cwd,createdAt:Date.now(),context:{prompt,addedFiles:[],fileAttachments:[],ideContext:null,imageAttachments:[],workspaceRoots:[cwd]}};
    if(mentions?.references.length&&mentions.mode!=='savedContext')restoreMessage.context.threadReferences=mentions.references;
    let input;
    if(method==='turn.send'||method==='turn.steer') {
      const images=validateImages(params.images);
      if((params.text!==undefined&&typeof params.text!=='string')||text.length>32000||(!text.trim()&&!images.length&&!params.attachments?.length))throw new BridgeError('BAD_PARAMS','请输入消息或选择附件');
      // 先核对轮次再落盘，旧任务的追加请求不会在新会话中创建附件。
      if(method==='turn.send'&&(snapshot.activeTurnId||snapshot.status==='active'))throw new BridgeError('TURN_ACTIVE','任务正在运行，请使用追加指令');
      if(method==='turn.steer'&&(!snapshot.activeTurnId||snapshot.activeTurnId!==params.expectedTurnId))throw new BridgeError('STALE_TURN','运行中的任务已变化，请重新同步后操作');
      const files=this.attachments.materialize(deviceId,params.threadId,params.attachments,cwd,images.length);
      restoreMessage.context.fileAttachments=files.map(({label,path})=>({label,path}));
      // 与桌面附件提示一致，正文引用由电脑生成的路径，手机不能传入本地路径。
      const attachmentText=files.length?'\n\n# 用户附带的文件\n'+files.map(file=>'\n## '+file.label+': '+file.path).join('\n'):'';
      input=[...((prompt.trim()||attachmentText)?[{type:'text',text:prompt+attachmentText+(mentions?.contextText??''),text_elements:[]}]:[]),...images.map(url=>({type:'image',url})),...plugins.map(plugin=>({type:'mention',name:plugin.name,path:'plugin://'+plugin.id}))];
      restoreMessage.context.imageAttachments=images.map((src,index)=>({id:`${commandId}:image:${index}`,src}));
    }
    if(method==='turn.send') {
      if(snapshot.activeTurnId||snapshot.status==='active') throw new BridgeError('TURN_ACTIVE','任务正在运行，请使用追加指令');
      ipcMethod='thread-follower-start-turn';version=2;
      payload={...base,turnStart:{request:{threadId:params.threadId,input,clientUserMessageId:commandId},context:{inheritThreadSettings:true,restoreMessage}}};
    } else if(method==='turn.steer') {
      if(!snapshot.activeTurnId||snapshot.activeTurnId!==params.expectedTurnId) throw new BridgeError('STALE_TURN','运行中的任务已变化，请重新同步后操作');
      ipcMethod='thread-follower-steer-turn';version=1;
      payload={...base,input,restoreMessage,clientUserMessageId:commandId,attachments:[],serviceTier:executionSettings(entry.state)?.serviceTier||null};
    } else if(method==='thread.settings.update') {
      const {settings,models}=await this.readSettings(params.threadId,deviceId);
      const {threadSettings}=validateSettings(params.changes,settings,models,entry.state.latestCollaborationMode);
      ipcMethod='thread-follower-update-thread-settings';version=2;
      // 桌面用原始字段检查并发；显示设置可能从协作模式补全，不能代替 null 或缺省原值。
      payload={...base,threadSettings,condition:{ifModelEquals:entry.state.latestModel,ifEffortEquals:entry.state.latestReasoningEffort}};
    } else if(method==='turn.stop') {
      if(!snapshot.activeTurnId||snapshot.activeTurnId!==params.expectedTurnId) throw new BridgeError('STALE_TURN','目标任务已经结束或发生变化');
      ipcMethod='thread-follower-interrupt-turn';version=4;payload={...base,mode:'user-stop',expectedTurnId:params.expectedTurnId};
    } else if(method==='question.reply') {
      const group=snapshot.questionGroups.find(item=>item.id===params.questionGroupId&&item.turnId===params.turnId);
      if(!group||group.state!=='pending') throw new BridgeError('STALE_QUESTION','这组问题已回答或已经失效，请重新同步');
      const answers=validateQuestionAnswers(group,params.answers);
      if(group.kind==='native') {
        const request=(entry.state.requests??[]).map(item=>item.request??item).find(item=>`native:${item.id}`===group.id&&item.method==='item/tool/requestUserInput');
        if(!request) throw new BridgeError('STALE_QUESTION','这组问题已经失效');
        ipcMethod='thread-follower-submit-user-input';version=1;
        payload={...base,requestId:request.id,response:{answers:Object.fromEntries(answers.map(answer=>[answer.questionId,{answers:[answer.text]}]))}};
      } else {
        // 异步问答沿用桌面自己的消息格式，运行中追加，空闲时开始下一轮。
        const replyText=formatQuestionReply(group,answers);
        restoreMessage.text=replyText;restoreMessage.context.prompt=replyText;
        const input=[{type:'text',text:replyText,text_elements:[]}];
        if(snapshot.activeTurnId) {ipcMethod='thread-follower-steer-turn';version=1;payload={...base,input,restoreMessage,clientUserMessageId:commandId,attachments:[]};}
        else {ipcMethod='thread-follower-start-turn';version=2;payload={...base,turnStart:{request:{threadId:params.threadId,input,clientUserMessageId:commandId},context:{inheritThreadSettings:true,restoreMessage}}};}
      }
    } else if(method==='approval.reply') {
      const approval=snapshot.approvals.find(item=>item.id===params.approvalId&&item.turnId===params.turnId);
      if(!approval) throw new BridgeError('STALE_APPROVAL','这条审批已处理或已经失效');
      if(!['accept','decline','cancel'].includes(params.decision)) throw new BridgeError('BAD_DECISION','首版仅允许本次通过、拒绝或取消');
      const request=(entry.state.requests??[]).map(item=>item.request??item).find(item=>String(item.id)===params.approvalId);
      ipcMethod=approval.kind==='command'?'thread-follower-command-approval-decision':'thread-follower-file-approval-decision';version=1;
      payload={...base,requestId:request.id,decision:params.decision};
    } else throw new BridgeError('METHOD_NOT_ALLOWED','不支持的桌面操作');
    if(firstMessage){
      // 初始快照强制刷新，插件解析和附件落盘后再次核对当前订阅收到的最新状态。
      const current=this.firstMessageContext(params.threadId,deviceId,firstMessageGuard,firstMessage);
      Object.assign(payload.turnStart.request,current.permissions);
      if(mentions?.additionalContext) payload.turnStart.request.additionalContext=mentions.additionalContext;
    }
    selection?.check(); mentions?.check();
    const response=await this.client.request(ipcMethod,payload,version,{targetClientId:entry.owner.clientId,timeoutMs:15000});
    if(response.resultType!=='success') throw new BridgeError('OWNER_UNAVAILABLE','桌面聊天所有者已不可用');
    if(method==='thread.settings.update') {
      if(response.result?.applied!==true)throw new BridgeError('SETTINGS_CHANGED','电脑端设置已变化，请刷新后重新选择');
      // 桌面广播是最终来源；回读确认而非把乐观选择伪装成桌面快照。
      await this.watch(params.threadId,deviceId,{fresh:true,history:false});
      const current=await this.readSettings(params.threadId,deviceId);
      if(current.settings.model!==payload.threadSettings.model||current.settings.effort!==payload.threadSettings.effort||current.settings.mode!==payload.threadSettings.collaborationMode.mode||current.settings.serviceTier!==(payload.threadSettings.serviceTier??''))throw new BridgeError('SETTINGS_NOT_APPLIED','桌面尚未确认所选设置，请刷新后核对');
      return {ok:true,commandId,...current};
    }
    if(['turn.send','turn.steer'].includes(method)&&params.resetPlanAfterSend===true) {
      // 先持久记录消息已被接收；恢复模式失败或进程退出不应让用户重发正文。
      const accepted={ok:true,commandId,threadId:params.threadId,messageAccepted:true,planReset:false,result:response.result};
      try{checkpoint(accepted);}catch{return {...accepted,planResetError:'消息已发送，恢复普通模式尚未确认，请重试恢复。'};}
      return {...accepted,...await resetPlanAfterSend(this,params.threadId,deviceId,commandId)};
    }
    return {ok:true,commandId,result:response.result};
  }

  close() {
    this.stopped=true;this.navigation.close();this.native?.close();clearTimeout(this.reconnectTimer);
    for(const [threadId,entry] of this.conversations) { for(const waiter of entry.waiters) {clearTimeout(waiter.timer);waiter.reject(new Error('连接服务已停止'));} if(entry.owner&&this.client.socket?.writable)this.client.broadcast('thread-stream-following-changed',{hostId:entry.owner.hostId,conversationId:threadId,following:false},1,[entry.owner.clientId]);clearTimeout(entry.publishTimer); }
    this.conversations.clear();this.client.close();
  }
}
