import fs from 'node:fs';
import path from 'node:path';
import {questionCounts} from './questions.mjs';
import {conversationContentRevision,existingConversationSnapshot,savedContentRevision} from './conversation-prefetch.mjs';
import {ThreadListStore,threadListDisplay} from './thread-list-store.mjs';

const OWNER='list-status',RETRY_MS=10000;
/** 正文、标题和索引时间允许合并，其余状态摘要必须立即送达。 */
function statusSummary(rows) {return JSON.stringify(rows.map(({contentRevision,title,cwd,updatedAt,...status})=>status));}
/** 新客户端获得完整通知基线，旧客户端只看到待交互，避免补发历史终态。 */
function catchupRows(rows) {
  return rows.map(({notificationState,...row})=>notificationState?{...row,notificationBaselineState:notificationState,notificationState:{...notificationState,latestTurnId:'',latestTurnStatus:''}}:row);
}

/** 常驻列表维护可信内存状态，首帧只读索引，不等待原生未读或所有者探测。 */
export class ThreadListFeed {
  constructor(adapter,send,{db,onSettled=()=>{},onActivity=()=>{},backgroundSyncEnabled=true}={}) {
    Object.assign(this,{adapter,send,onSettled,onActivity});
    this.devices=new Set();this.rows=[];this.ids=new Set();this.revision=0;this.generation=0;
    this.mode='legacy';this.closed=false;this.started=false;this.dirty=false;this.syncing=false;
    this.backgroundSyncEnabled=backgroundSyncEnabled!==false;
    this.store=new ThreadListStore(db,{verifyVisible:ids=>this.adapter.index.visibleThreadIds?this.adapter.index.visibleThreadIds(ids):new Set(this.adapter.index.list({limit:50}).map(row=>row.id))});
    this.indexRows=new Map();this.changed=new Set();this.initialized=new Set();
    this.probeLeases=new Map();
    this.nextActivityAt=0;this.nextReadStateAt=0;this.activityReading=null;
    this.owned=new Set();this.nextProbe=new Map();this.activity=new Set();this.pendingSnapshots=new Map();this.recheck=new Set();this.settled=new Set();
    this.onConversation=snapshot=>this.update(snapshot);adapter.on('conversation',this.onConversation);
    this.onReadState=state=>{
      if(!this.started||this.closed||!this.backgroundSyncEnabled)return;
      if(this.readStateRunning&&this.readStateGeneration!==this.generation)return;
      this.replace((this.pendingRows??this.rows).map(row=>row.id===state.threadId?{...row,hasUnreadTurn:state.hasUnreadTurn}:row));
    };
    adapter.on('readState',this.onReadState);
  }
  /** 进程启动即恢复展示索引；兼容旧中转时没有设备就不持有正文跟随。 */
  start() {
    if(this.closed||this.started)return;
    this.started=true;
    try {this.rows=this.store.load().map(row=>this.unknown(row));this.ids=new Set(this.rows.map(row=>row.id));} catch { /* 副本损坏时继续读取原生只读索引。 */ }
    if(!this.backgroundSyncEnabled)return;
    this.readIndex();this.attachWatcher();this.armCycle();
    if(this.maintaining())this.kick();
  }
  /** 新中转明确驻留模式；旧中转继续按设备数启停，避免误判离线。 */
  setMode(mode) {
    if(!['online','grace','light','legacy'].includes(mode))throw new TypeError('未知的列表维护模式');
    const previous=this.mode;this.mode=mode;
    if(previous!==mode){this.generation++;this.dirty=true;for(const lease of this.probeLeases.values())lease.active=false;}
    if(previous==='light'||previous==='legacy'&&mode!=='legacy'){this.catchupStarted=false;this.nextActivityAt=0;this.nextReadStateAt=0;}
    this.start();
    if(mode==='light'||!this.maintaining())this.releaseAll();
    this.armCycle();if(previous!==mode&&this.maintaining()&&!this.running)this.kick();return mode;
  }
  /** 暂停仅释放内部维护，保留已登记的手机设备及已有展示索引。 */
  setBackgroundSyncEnabled(enabled) {
    if(this.closed||this.backgroundSyncEnabled===enabled)return;
    this.backgroundSyncEnabled=enabled;
    if(!enabled) {
      this.stop();
      this.watcher?.close();this.watcher=null;
      clearTimeout(this.store.timer);this.store.timer=null;
      this.syncing=false;this.syncError=undefined;this.dirty=false;
      return;
    }
    // 第一份新鲜状态建立通知基线，避免将暂停期间的终态误认为实时变化。
    this.resumeBaselineIds=new Set();
    this.catchupStarted=false;this.nextActivityAt=0;this.nextReadStateAt=0;
    this.initialized.clear();this.settled.clear();this.nextProbe.clear();
    if(!this.started)return;
    this.attachWatcher();this.armCycle();
    if(this.maintaining())this.kick();else this.readIndex();
  }
  maintaining() {return !this.closed&&this.backgroundSyncEnabled&&(this.mode!=='legacy'||this.devices.size>0);}
  realtime() {return this.maintaining()&&this.mode!=='light';}
  /** 新订阅不重放旧完成通知；后续真实转换仍使用原协议通知字段。 */
  list() {
    const started=this.started;this.start();
    if(!this.backgroundSyncEnabled)return this.readPausedList();
    // 旧客户端可能只请求普通列表；没有实时订阅时仍同步读取索引，不等待任何 IPC。
    if(started&&!this.maintaining())this.readIndex();
    return {threads:catchupRows(this.pendingRows??this.rows),revision:this.revision,catchup:true,...this.syncFields()};
  }
  /** 主动请求返回新游标，让手机优先使用这次回执而非暂停前的旧推送。 */
  readPausedList() {
    let rows=this.rows,syncError;
    try {
      rows=this.adapter.index.list({limit:50}).slice(0,50).map(raw=>{
        const row=threadListDisplay(raw),entry=this.adapter.conversations?.get(row.id);
        return entry?.state?this.summary(row,this.adapter.snapshot(entry.state)):this.unknown(row);
      });
    } catch {syncError='电脑聊天索引暂时不可用';}
    return {threads:catchupRows(rows),revision:++this.revision,catchup:true,...(syncError?{syncError}:{})};
  }
  async watch(deviceId) {
    const wasMaintaining=this.maintaining();this.devices.add(deviceId);this.start();
    if(!wasMaintaining&&this.maintaining()){this.armCycle();if(!this.running)this.kick();}
    return this.list();
  }
  unwatch(deviceId) {this.devices.delete(deviceId);if(!this.maintaining())this.stop();return {ok:true};}
  syncFields() {return {...(this.syncing?{syncing:true}:{}),...(this.syncError?{syncError:this.syncError}:{})};}
  /** 固定首个三百毫秒窗口，持续写入也不会重置计时器而饿死索引更新。 */
  attachWatcher() {
    if(this.watcher||!this.adapter.index?.filePath||this.closed||!this.backgroundSyncEnabled)return;
    const file=this.adapter.index.filePath,name=path.basename(file);
    try {
      const watcher=fs.watch(path.dirname(file),{persistent:false},(_event,filename)=>{
        if(this.watcher!==watcher)return;
        if(filename==null||[name,name+'-wal','session_index.jsonl'].includes(String(filename)))this.schedule();
      });
      this.watcher=watcher;
      watcher.on('error',()=>{if(this.watcher===watcher){watcher.close();this.watcher=null;}});
    } catch { /* 索引未创建时由周期读取恢复。 */ }
  }
  schedule() {
    if(this.closed||!this.backgroundSyncEnabled)return;this.dirty=true;
    if(this.mode==='light'||!this.maintaining()||this.timer)return;
    this.timer=setTimeout(()=>{this.timer=null;this.kick();},300);this.timer.unref?.();
  }
  /** 在线和宽限两秒核对，轻量十五秒；所有设备共用同一计时器。 */
  armCycle() {
    clearTimeout(this.cycleTimer);this.cycleTimer=null;if(!this.maintaining())return;
    this.cycleTimer=setTimeout(()=>{this.cycleTimer=null;this.kick();this.armCycle();},this.mode==='light'?15000:2000);this.cycleTimer.unref?.();
  }
  kick() {this.refresh().catch(()=>{});}
  /** 索引文件通知不增加整批活动查询频率，未完成的同类读取继续共享。 */
  activityRead(generation) {
    if(!this.activityReading&&Date.now()>=this.nextActivityAt) {
      this.nextActivityAt=Date.now()+(this.mode==='light'?15000:2000);
      const reading={generation,promise:Promise.resolve().then(()=>{
        if(generation===this.generation&&this.maintaining())return this.adapter.readActivityInventory?.({rows:[...this.indexRows.values()]});
      })};
      this.activityReading=reading;
      reading.promise.finally(()=>{if(this.activityReading===reading)this.activityReading=null;}).catch(()=>{});
    }
    return this.activityReading;
  }
  unknown(row) {return {...row,contentRevision:savedContentRevision(row),status:'unknown',activeTurnId:'',approvalCount:0,pendingQuestionCount:0,unansweredQuestionCount:0};}
  /** 失败保留完整旧索引；持久化仅使用展示白名单，绝不恢复实时权限。 */
  readIndex() {
    if(this.closed||!this.backgroundSyncEnabled)return false;
    try {
      const rows=this.adapter.index.list({limit:50}).slice(0,50).map(threadListDisplay);
      const previous=new Map((this.pendingRows??this.rows).map(row=>[row.id,row]));
      const wasWarm=this.indexRows.size>0;
      for(const row of rows)if(wasWarm&&JSON.stringify(this.indexRows.get(row.id))!==JSON.stringify(row)){this.changed.add(row.id);this.settled.delete(row.id);}
      const ids=new Set(rows.map(row=>row.id));
      if(this.resumeBaselineIds&&!this.catchupStarted)this.resumeBaselineIds=new Set(ids);
      for(const id of this.ids)if(!ids.has(id)){const lease=this.probeLeases.get(id);if(lease)lease.active=false;this.release(id);this.changed.delete(id);this.initialized.delete(id);this.nextProbe.delete(id);this.pendingSnapshots.delete(id);}
      this.ids=ids;this.indexRows=new Map(rows.map(row=>[row.id,row]));
      const result=rows.map(row=>{
        const entry=this.adapter.conversations?.get(row.id);
        if(entry?.state&&!this.initialized.has(row.id)){this.initialized.add(row.id);this.resumeBaselineIds?.delete(row.id);return this.summary(row,this.adapter.snapshot(entry.state));}
        return previous.has(row.id)?{...previous.get(row.id),...row}:this.unknown(row);
      });
      this.replace(result,true,!this.catchupStarted);try {this.store.save(rows);} catch { /* 磁盘展示副本失败不阻断实时读取。 */ }
      return true;
    } catch {this.setSync(false,'电脑聊天索引暂时不可用');return false;}
  }
  /** 并发通知合并到同一轮；刷新 Promise 仅供后台协调，watch/list 不等待它。 */
  async refresh() {
    if(this.closed||!this.backgroundSyncEnabled)return;
    if(!this.started){this.start();if(this.running)return this.running;}
    if(this.running){this.dirty=true;return this.running;}
    this.dirty=false;if(!this.readIndex()||!this.maintaining())return;
    const generation=this.generation;this.running=this.reconcile(generation);
    try {await this.running;} finally {
      this.running=null;
      if(this.dirty&&this.maintaining()){
        if(generation!==this.generation)this.kick();
        else if(this.mode!=='light')this.schedule();
      }
    }
  }
  /** 活动清单只给候选，缺席或查询失败都不能伪造空闲状态。 */
  async reconcile(generation) {
    const current=()=>!this.closed&&generation===this.generation&&this.maintaining();
    let error,timedOut=false;const catchup=!this.catchupStarted;
    const deadline=setTimeout(()=>{if(current()){timedOut=true;error='聊天状态同步较慢，正在后台重试';this.setSync(false,error,catchup);}},5000);deadline.unref?.();
    // 持续输出引起的索引时间变化属于普通增量，不反复重置通知基线或闪烁加载图标。
    if(catchup){this.catchupStarted=true;this.setSync(true,undefined,true);}
    // 原生未读可能较慢，独立追平且同一实例只允许一份任务，不能阻塞首帧或活动发现。
    if(!this.readStateRunning&&this.adapter.refreshReadState&&Date.now()>=this.nextReadStateAt) {
      this.nextReadStateAt=Date.now()+(this.mode==='light'?15000:2000);
      this.readStateGeneration=generation;
      this.readStateRunning=Promise.resolve().then(()=>{if(current())return this.adapter.refreshReadState([...this.ids]);}).then(()=>{
        if(current())this.replace((this.pendingRows??this.rows).map(row=>this.adapter.native?.unread?.has(row.id)?{...row,hasUnreadTurn:this.adapter.native.unread.get(row.id)}:row));
      }).catch(()=>{}).finally(()=>{this.readStateRunning=null;});
    }
    try {
      let inventory,inventoryTimeout;const reading=this.activityRead(generation);
      if(reading) {
        try {
          const value=await Promise.race([reading.promise,new Promise((_,reject)=>{inventoryTimeout=setTimeout(()=>reject(new Error('活动清单读取超时')),1800);inventoryTimeout.unref?.();})]);
          if(reading.generation===generation)inventory=value;
        } catch {error='电脑聊天活动状态暂时不可用';}
        finally {clearTimeout(inventoryTimeout);}
      }
      if(!current())return;
      if(inventory&&Array.isArray(inventory.threadIds)) {
        const activity=new Set(inventory.threadIds);
        for(const id of activity)if(!this.activity.has(id))this.settled.delete(id);
        if(inventory.complete===true)for(const id of this.activity)if(!activity.has(id)&&this.needsAttention((this.pendingRows??this.rows).find(row=>row.id===id)))this.recheck.add(id);
        this.activity=activity;this.inventoryKnown=true;
        this.onActivity({complete:inventory.complete===true,threadIds:[...this.activity]});
      }
      if(this.mode==='light'){this.releaseAll();return;}
      const rows=this.pendingRows??this.rows;
      const candidates=[...this.ids].filter(id=>this.changed.has(id)||this.needsAttention(rows.find(row=>row.id===id))||(this.activity.has(id)&&!this.settled.has(id)));
      let next=0;
      const worker=async()=>{
        while(next<candidates.length&&current()&&this.realtime()) {
          const id=candidates[next++];if(!this.ids.has(id))continue;
          const entry=this.adapter.conversations?.get(id);
          if(entry?.state&&!this.recheck.has(id)) {
            const snapshot=this.adapter.snapshot(entry.state);this.consume(snapshot,!this.initialized.has(id));this.follow(id,snapshot);this.changed.delete(id);continue;
          }
          if(Date.now()<(this.nextProbe.get(id)??0))continue;
          if(this.probeLeases.has(id))continue;
          this.nextProbe.set(id,Date.now()+RETRY_MS);
          let timeout;const lease={active:true,finished:false};this.probeLeases.set(id,lease);
          const valid=()=>lease.active&&current()&&this.realtime()&&this.probeLeases.get(id)===lease;
          const operation=Promise.resolve().then(()=>valid()?this.adapter.watch(id,OWNER,{history:false,snapshotTimeoutMs:1000,ownerTimeoutMs:350,isCurrent:valid,...(this.recheck.has(id)?{fresh:true}:{})}):undefined);
          // 旧连接或探测迟到时清理自己的内部跟随，不遗留超时后的正文订阅。
          operation.then(()=>{lease.finished=true;if(!valid()&&this.probeLeases.get(id)===lease)this.release(id);},()=>{lease.finished=true;}).finally(()=>{if(!lease.active&&this.probeLeases.get(id)===lease)this.probeLeases.delete(id);});
          try {
            const snapshot=await Promise.race([
              operation,
              new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('聊天候选快照超时')),1800);timeout.unref?.();}),
            ]);
            if(!valid()||!this.ids.has(id)){this.release(id);continue;}
            const value={...snapshot,threadId:snapshot.threadId??id};
            this.consume(value,!this.initialized.has(id));this.follow(id,value);this.changed.delete(id);this.recheck.delete(id);this.nextProbe.delete(id);
          } catch {this.release(id);if(current())error='部分聊天状态暂时未知，正在后台重试';}
          finally {clearTimeout(timeout);lease.active=false;if(lease.finished&&this.probeLeases.get(id)===lease)this.probeLeases.delete(id);}
        }
      };
      await Promise.all(Array.from({length:Math.min(2,candidates.length)},worker));
    } finally {clearTimeout(deadline);if(current())this.setSync(false,error??(timedOut?this.syncError:undefined),catchup);}
  }
  needsAttention(row) {return !!row&&(row.status==='active'||!!row.activeTurnId||row.approvalCount>0||row.pendingQuestionCount>0||row.unansweredQuestionCount>0||(row.activeFlags??[]).some(flag=>['waitingOnUserInput','waitingOnApproval'].includes(flag))||(row.notificationState?.pending?.length??0)>0);}
  /** 只释放列表自己的跟随，真实详情和 CACHE_WATCHER 保持独立。 */
  follow(id,snapshot) {
    if(this.realtime()&&this.needsAttention(this.stateSummary({id},snapshot))) {this.adapter.conversations?.get(id)?.watchers.add(OWNER);this.owned.add(id);}
    else this.release(id);
  }
  release(id) {this.owned.delete(id);this.adapter.unwatch?.(id,OWNER);}
  releaseAll() {for(const id of new Set([...this.owned,...this.ids]))this.release(id);}
  /** 已确认归档删除立即清理内存、待写及磁盘展示副本，不让迟到帧重新登记。 */
  forget(ids) {
    const removed=new Set(ids);
    for(const id of removed) {
      const lease=this.probeLeases.get(id);if(lease)lease.active=false;
      this.release(id);this.ids.delete(id);this.indexRows.delete(id);this.changed.delete(id);this.initialized.delete(id);
      this.nextProbe.delete(id);this.pendingSnapshots.delete(id);this.activity.delete(id);this.recheck.delete(id);this.settled.delete(id);
    }
    const rows=(this.pendingRows??this.rows).filter(row=>!removed.has(row.id));
    if(this.backgroundSyncEnabled)this.replace(rows,true);else this.publishRows(rows,false,false,true);
    for(const id of removed)this.resumeBaselineIds?.delete(id);
    try {this.store.forget([...removed]);}catch{/* 展示清理失败不改变真实归档删除结果，后续新鲜成员核对会重试。 */}
    if(!this.backgroundSyncEnabled){clearTimeout(this.store.timer);this.store.timer=null;}
  }
  /** 状态比较不计算正文哈希；纯流式变化在一秒尾帧才计算内容版本。 */
  stateSummary(row,snapshot,includeNotification=true) {
    const {notificationState,...base}=row;
    return {...base,latestTurn:snapshot.latestTurn?{turnId:snapshot.latestTurn.turnId,status:snapshot.latestTurn.status}:undefined,...(includeNotification&&snapshot.notificationState?{notificationState:snapshot.notificationState}:{}),title:snapshot.title||row.title,hasUnreadTurn:snapshot.hasUnreadTurn,activeFlags:snapshot.activeFlags,status:snapshot.status??'unknown',activeTurnId:snapshot.activeTurnId??'',approvalCount:snapshot.approvals?.length??0,...questionCounts(snapshot)};
  }
  summary(row,snapshot,includeNotification=true) {return {...this.stateSummary(row,snapshot,includeNotification),contentRevision:this.contentSummary(row,snapshot).contentRevision};}
  /** 保存时间只用于未知历史，不把已取得实时快照误换为磁盘版本。 */
  contentSummary(row,snapshot) {
    let contentRevision;
    if(row.archived||row.deleted||snapshot?.readOnly)contentRevision=savedContentRevision(row);
    else if(snapshot)contentRevision=conversationContentRevision(snapshot);
    else if(this.adapter.conversations?.get(row.id)?.state)contentRevision=conversationContentRevision(existingConversationSnapshot(this.adapter,row.id));
    else if(!row.status||row.status==='unknown')contentRevision=savedContentRevision(row);
    return {...row,contentRevision};
  }
  /** 首份快照建立通知基线；终态先交缓存保存，再由 follow 释放内部订阅。 */
  consume(snapshot,baseline=false) {
    if(!this.backgroundSyncEnabled||!this.ids.has(snapshot.threadId))return;
    const resumed=this.resumeBaselineIds?.delete(snapshot.threadId)===true;
    this.pendingSnapshots.delete(snapshot.threadId);
    this.replace((this.pendingRows??this.rows).map(row=>row.id===snapshot.threadId?this.summary(row,snapshot):row),resumed,baseline||resumed);
    this.initialized.add(snapshot.threadId);
    const settled=!this.needsAttention(this.stateSummary({id:snapshot.threadId},snapshot))&&snapshot.status==='idle';
    const terminal=!snapshot.activeTurnId&&snapshot.status!=='active'&&['completed','failed','interrupted','reviewStopped'].includes(snapshot.latestTurn?.status);
    if(settled||terminal){
      // 终态先推送内存结果，再尽力保存展示字段；缓存故障不能阻止正文保存和内部订阅释放。
      try {this.store.save(this.pendingRows??this.rows);this.store.flush();}catch{}
    }
    if(settled){
      this.settled.add(snapshot.threadId);
      this.onSettled(snapshot);
    }else this.settled.delete(snapshot.threadId);
  }
  update(snapshot) {
    if(!this.started||this.closed||!this.realtime()||!this.ids.has(snapshot.threadId))return;
    const row=(this.pendingRows??this.rows).find(value=>value.id===snapshot.threadId),baseline=!this.initialized.has(snapshot.threadId);
    const state=this.stateSummary(row,snapshot);
    if(!baseline&&!this.resumeBaselineIds?.has(snapshot.threadId)&&statusSummary([state])===statusSummary([row])) {
      this.pendingSnapshots.set(snapshot.threadId,snapshot);this.armContent();
    } else this.consume(snapshot,baseline);
    this.follow(snapshot.threadId,snapshot);
  }
  /** 同步提示变化也推进游标，首轮结束和失败事件明确标记追平。 */
  setSync(syncing,error,catchup=false) {if(this.syncing===syncing&&this.syncError===error)return;this.syncing=syncing;this.syncError=error;this.publishRows(this.pendingRows??this.rows,catchup,true);}
  replace(rows,immediate=false,catchup=false) {
    if(JSON.stringify(rows)===JSON.stringify(this.rows)){if(!this.pendingSnapshots.size){clearTimeout(this.contentTimer);this.contentTimer=null;}this.pendingRows=null;return;}
    if(immediate||statusSummary(rows)!==statusSummary(this.rows)){this.publishRows(rows,catchup);return;}
    this.pendingRows=rows;this.pendingCatchup=catchup;this.armContent();
  }
  armContent() {
    if(this.contentTimer||!this.backgroundSyncEnabled)return;
    this.contentTimer=setTimeout(()=>{if(!this.closed)this.publishRows(this.pendingRows??this.rows,this.pendingCatchup===true);},1000);this.contentTimer.unref?.();
  }
  /** 发布前一次性计算各会话最新正文版本，再清理尾帧，允许发送回调重入。 */
  publishRows(rows,catchup=false,force=false,explicit=false) {
    if(!this.backgroundSyncEnabled&&!explicit)return;
    // 尾帧只补正文版本和标题；运行、未读等状态可能已被后续事件更新，不能重放旧快照。
    if(this.pendingSnapshots.size){rows=rows.map(row=>{const snapshot=this.pendingSnapshots.get(row.id);return snapshot?this.contentSummary({...row,title:snapshot.title||row.title},snapshot):row;});this.pendingSnapshots.clear();}
    clearTimeout(this.contentTimer);this.contentTimer=null;this.pendingRows=null;this.pendingCatchup=false;
    if(!force&&!catchup&&JSON.stringify(rows)===JSON.stringify(this.rows))return;
    this.rows=rows;this.revision++;
    if(this.devices.size)this.send({v:1,type:'threads.event',threads:catchup?catchupRows(rows):rows,revision:this.revision,...(catchup?{catchup:true}:{}),...this.syncFields()});
  }
  /** 中转断开释放正文维护，但保留展示索引；驻留模式由上层中转状态切换。 */
  stop() {
    this.generation++;clearTimeout(this.timer);this.timer=null;clearTimeout(this.cycleTimer);this.cycleTimer=null;
    clearTimeout(this.contentTimer);this.contentTimer=null;this.pendingRows=null;this.pendingSnapshots.clear();this.releaseAll();
    if(this.mode!=='legacy'&&!this.closed&&this.backgroundSyncEnabled){this.armCycle();this.kick();}
  }
  close() {
    if(this.closed)return;
    // 关闭前只提取最新展示字段，不为尚未发送的正文尾帧额外计算哈希。
    const latest=(this.pendingRows??this.rows).map(row=>{const snapshot=this.pendingSnapshots.get(row.id);return snapshot?.title?{...row,title:snapshot.title}:row;});
    try {this.store.save(latest);}catch{}
    this.closed=true;this.devices.clear();this.stop();this.watcher?.close();this.watcher=null;
    this.adapter.off('conversation',this.onConversation);this.adapter.off('readState',this.onReadState);this.store.close();
  }
}
