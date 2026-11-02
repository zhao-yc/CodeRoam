import fs from 'node:fs';
import path from 'node:path';
import {questionCounts} from './questions.mjs';
import {conversationContentRevision, existingConversationSnapshot, savedContentRevision} from './conversation-prefetch.mjs';

/** 正文、标题和索引保存时间允许合并，其余列表状态摘要必须立即送达。 */
function statusSummary(rows) {
  return JSON.stringify(rows.map(({contentRevision,title,cwd,updatedAt,...status})=>status));
}

/** 共享列表只读订阅：索引变更维护成员，桌面快照推送状态，不使用周期轮询。 */
export class ThreadListFeed {
  constructor(adapter, send) {
    this.adapter=adapter;this.send=send;this.devices=new Set();this.rows=[];this.ids=new Set();this.revision=0;this.timer=null;this.contentTimer=null;this.pendingRows=null;this.generation=0;this.running=null;this.dirty=false;this.closed=false;
    this.onConversation=snapshot=>this.update(snapshot);
    adapter.on('conversation',this.onConversation);
    this.onReadState=state=>{if(this.devices.size&&!this.closed)this.replace((this.pendingRows??this.rows).map(row=>row.id===state.threadId?{...row,hasUnreadTurn:state.hasUnreadTurn}:row));};
    adapter.on('readState',this.onReadState);
  }
  async watch(deviceId) {
    this.devices.add(deviceId);this.closed=false;
    if(!this.watcher&&this.adapter.index?.filePath) {
      const file=this.adapter.index.filePath,name=path.basename(file);
      this.watcher=fs.watch(path.dirname(file),(_event,filename)=>{
        if(filename==null||String(filename)===name||String(filename)===name+'-wal'||String(filename)==='session_index.jsonl')this.schedule();
      });
      this.watcher.on('error',()=>{this.watcher?.close();this.watcher=null;});
    }
    await this.refresh();
    return {threads:this.pendingRows??this.rows,revision:this.revision};
  }
  unwatch(deviceId) {
    this.devices.delete(deviceId);
    if(!this.devices.size)this.stop();
    return {ok:true};
  }
  schedule() {
    if(!this.devices.size||this.closed)return;
    clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;this.refresh().catch(()=>{});},300);
  }
  /** 合并并发索引通知；刷新期间的新通知在结束后补读，避免丢失最终状态。 */
  async refresh() {
    if(this.running){this.dirty=true;return this.running;}
    this.running=(async()=>{
      do {
        this.dirty=false;
        if(!this.devices.size||this.closed)return;
        const generation=this.generation;
        const rows=this.adapter.index.list({});
        if(this.adapter.refreshReadState)await this.adapter.refreshReadState(rows.map(row=>row.id));
        const ids=new Set(rows.map(row=>row.id));
        for(const id of this.ids)if(!ids.has(id))this.adapter.unwatch(id,'list-status');
        this.ids=ids;
        const result=new Array(rows.length);let next=0;
        const worker=async()=>{
          while(next<rows.length&&!this.closed&&this.devices.size&&generation===this.generation){
            const position=next++,row=rows[position];
            try {
              const entry=this.adapter.conversations.get(row.id);
              const snapshot=entry?.state?this.adapter.snapshot(entry.state):await this.adapter.watch(row.id,'list-status',{history:false,snapshotTimeoutMs:1000,ownerTimeoutMs:500});
              // 即使已由详情订阅取得状态，也登记独立列表所有者，切换详情不能停止状态推送。
              if(generation===this.generation&&!this.closed&&this.devices.size)this.adapter.conversations.get(row.id)?.watchers.add('list-status');
              result[position]=this.summary(row,snapshot);
            } catch {result[position]={...row,contentRevision:savedContentRevision(row),hasUnreadTurn:this.adapter.native?.unread.get(row.id),status:'unknown',activeTurnId:'',approvalCount:0,pendingQuestionCount:0};}
            if(this.closed||!this.devices.size||generation!==this.generation)this.adapter.unwatch(row.id,'list-status');
          }
        };
        await Promise.all(Array.from({length:Math.min(8,rows.length)},worker));
        if(this.closed||!this.devices.size)return;
        if(generation!==this.generation){this.dirty=true;continue;}
        this.replace(result);
      }while(this.dirty);
    })();
    try{await this.running;}finally{this.running=null;}
  }
  summary(row,snapshot) {
    return {...this.contentSummary(row,snapshot),latestTurn:snapshot.latestTurn ? {turnId:snapshot.latestTurn.turnId,status:snapshot.latestTurn.status} : undefined,notificationState:snapshot.notificationState,title:snapshot.title||row.title,hasUnreadTurn:snapshot.hasUnreadTurn,activeFlags:snapshot.activeFlags,status:snapshot.status,activeTurnId:snapshot.activeTurnId,approvalCount:snapshot.approvals.length,...questionCounts(snapshot)};
  }
  /** 普通列表和列表订阅共用版本规则，历史版本只采用保存时间。 */
  contentSummary(row,snapshot) {
    let contentRevision;
    if(row.archived||row.deleted||snapshot?.readOnly)contentRevision=savedContentRevision(row);
    else if(snapshot)contentRevision=conversationContentRevision(snapshot);
    else if(this.adapter.conversations?.get(row.id)?.state)contentRevision=conversationContentRevision(existingConversationSnapshot(this.adapter,row.id));
    // 普通 list 的临时 watch 已释放时，实时摘要没有正文可哈希，宁可省略可选版本。
    else if(!row.status||row.status==='unknown')contentRevision=savedContentRevision(row);
    return {...row,contentRevision};
  }
  /** 内容流式变化合并到固定尾帧；终态、待交互和状态摘要变化直接发送。 */
  update(snapshot) {
    if(!this.devices.size||this.closed)return;
    this.replace((this.pendingRows??this.rows).map(row=>row.id===snapshot.threadId?this.summary(row,snapshot):row));
  }
  replace(rows) {
    if(JSON.stringify(rows)===JSON.stringify(this.rows)){
      clearTimeout(this.contentTimer);this.contentTimer=null;this.pendingRows=null;return;
    }
    if(statusSummary(rows)!==statusSummary(this.rows)){this.publishRows(rows);return;}
    this.pendingRows=rows;
    // 不在每个 token 到来时重置计时器，持续输出也不会饿死尾帧。
    if(!this.contentTimer)this.contentTimer=setTimeout(()=>{
      const pending=this.pendingRows;
      if(!this.closed&&this.devices.size&&pending)this.publishRows(pending);
    },1000);
  }
  /** 先清理待发送状态再回调，发送期间的重入更新使用独立的下一帧。 */
  publishRows(rows) {
    clearTimeout(this.contentTimer);this.contentTimer=null;this.pendingRows=null;
    this.rows=rows;this.revision++;
    this.send({v:1,type:'threads.event',threads:rows,revision:this.revision});
  }
  stop() {
    this.closed=true;this.generation++;clearTimeout(this.timer);this.timer=null;clearTimeout(this.contentTimer);this.contentTimer=null;this.pendingRows=null;this.watcher?.close();this.watcher=null;
    for(const id of this.ids)this.adapter.unwatch(id,'list-status');
    this.ids.clear();
  }
  close(){this.devices.clear();this.stop();this.adapter.off('conversation',this.onConversation);this.adapter.off('readState',this.onReadState);}
}
