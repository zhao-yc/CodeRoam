import fs from 'node:fs';
import path from 'node:path';
import {questionCounts} from './questions.mjs';

/** 共享列表只读订阅：索引变更维护成员，桌面快照推送状态，不使用周期轮询。 */
export class ThreadListFeed {
  constructor(adapter, send) {
    this.adapter=adapter;this.send=send;this.devices=new Set();this.rows=[];this.ids=new Set();this.revision=0;this.timer=null;this.running=null;this.dirty=false;this.closed=false;
    this.onConversation=snapshot=>this.update(snapshot);
    adapter.on('conversation',this.onConversation);
    this.onReadState=state=>{if(this.devices.size&&!this.closed)this.replace(this.rows.map(row=>row.id===state.threadId?{...row,hasUnreadTurn:state.hasUnreadTurn}:row));};
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
    return {threads:this.rows,revision:this.revision};
  }
  unwatch(deviceId) {
    this.devices.delete(deviceId);
    if(!this.devices.size)this.stop();
    return {ok:true};
  }
  schedule() {
    if(!this.devices.size||this.closed)return;
    clearTimeout(this.timer);this.timer=setTimeout(()=>this.refresh().catch(()=>{}),300);
  }
  /** 合并并发索引通知；刷新期间的新通知在结束后补读，避免丢失最终状态。 */
  async refresh() {
    if(this.running){this.dirty=true;return this.running;}
    this.running=(async()=>{
      do {
        this.dirty=false;
        if(!this.devices.size||this.closed)return;
        const rows=this.adapter.index.list({});
        if(this.adapter.refreshReadState)await this.adapter.refreshReadState(rows.map(row=>row.id));
        const ids=new Set(rows.map(row=>row.id));
        for(const id of this.ids)if(!ids.has(id))this.adapter.unwatch(id,'list-status');
        this.ids=ids;
        const result=new Array(rows.length);let next=0;
        const worker=async()=>{
          while(next<rows.length&&!this.closed&&this.devices.size){
            const position=next++,row=rows[position];
            try {
              const entry=this.adapter.conversations.get(row.id);
              const snapshot=entry?.state?this.adapter.snapshot(entry.state):await this.adapter.watch(row.id,'list-status',{history:false,snapshotTimeoutMs:1000,ownerTimeoutMs:500});
              // 即使已由详情订阅取得状态，也登记独立列表所有者，切换详情不能停止状态推送。
              this.adapter.conversations.get(row.id)?.watchers.add('list-status');
              result[position]=this.summary(row,snapshot);
            } catch {result[position]={...row,hasUnreadTurn:this.adapter.native?.unread.get(row.id),status:'unknown',activeTurnId:'',approvalCount:0,pendingQuestionCount:0};}
            if(this.closed||!this.devices.size)this.adapter.unwatch(row.id,'list-status');
          }
        };
        await Promise.all(Array.from({length:Math.min(8,rows.length)},worker));
        if(this.closed||!this.devices.size)return;
        this.replace(result);
      }while(this.dirty);
    })();
    try{await this.running;}finally{this.running=null;}
  }
  summary(row,snapshot) {
    return {...row,notificationState:snapshot.notificationState,title:snapshot.title||row.title,hasUnreadTurn:snapshot.hasUnreadTurn,activeFlags:snapshot.activeFlags,status:snapshot.status,activeTurnId:snapshot.activeTurnId,approvalCount:snapshot.approvals.length,...questionCounts(snapshot)};
  }
  /** 只发布列表摘要，正文流式变化不制造重复列表事件。 */
  update(snapshot) {
    if(!this.devices.size||this.closed)return;
    this.replace(this.rows.map(row=>row.id===snapshot.threadId?this.summary(row,snapshot):row));
  }
  replace(rows) {
    if(JSON.stringify(rows)===JSON.stringify(this.rows))return;
    this.rows=rows;this.revision++;
    this.send({v:1,type:'threads.event',threads:rows,revision:this.revision});
  }
  stop() {
    this.closed=true;clearTimeout(this.timer);this.watcher?.close();this.watcher=null;
    for(const id of this.ids)this.adapter.unwatch(id,'list-status');
    this.ids.clear();
  }
  close(){this.devices.clear();this.stop();this.adapter.off('conversation',this.onConversation);this.adapter.off('readState',this.onReadState);}
}
