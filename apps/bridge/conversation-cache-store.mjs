import {conversationProjection,conversationContentRevision} from './conversation-prefetch.mjs';
import {CACHE_PERSISTENCE_INTERVAL_MS} from './cache-persistence.mjs';

const RECORD_LIMIT=20, SNAPSHOT_BYTES_LIMIT=512*1024, DELETE_BARRIER_LIMIT=128;

/** 展示正文先在内存接管；SQLite 只在首个固定合并窗口或显式终态刷新时保存。 */
export class ConversationCacheStore {
  constructor({db,visible=()=>null,blocked=()=>false,onMissing=()=>{},intervalMs=CACHE_PERSISTENCE_INTERVAL_MS}={}) {
    Object.assign(this,{db,visible,blocked,onMissing});
    this.intervalMs=Number.isFinite(intervalMs)&&intervalMs>0?intervalMs:CACHE_PERSISTENCE_INTERVAL_MS;
    this.records=new Map();this.pending=new Map();this.deleteBarriers=new Set();
    this.timer=null;this.deadline=0;this.paused=false;this.closed=false;this.closing=false;this.flushing=false;this.transactionActive=false;
    this.diskFallbackBlocked=false;
  }

  /** 阶段一只做纯展示投影、版本与预算核对，不能查库或等待持久化定时器。 */
  stage(source,savedSource) {
    if(this.closed||this.closing||!source||typeof source.threadId!=='string'||!source.threadId||this.blocked(source.threadId))return undefined;
    const snapshot=conversationProjection(source),serialized=JSON.stringify(snapshot);
    if(Buffer.byteLength(serialized)>SNAPSHOT_BYTES_LIMIT)return undefined;
    const revision=conversationContentRevision(snapshot),id=snapshot.threadId,old=this.records.get(id),sourceVersion=savedSource??old?.savedSource;
    let record=old;
    if(!old||old.current.revision!==revision||old.savedSource!==sourceVersion) {
      const current=old?.current.revision===revision?old.current:{snapshot,serialized,revision};
      record={current,previous:old?.current.revision===revision?old.previous:old?.current,savedSource:sourceVersion,touchedAt:old?.current.revision===revision?old.touchedAt:Date.now()};
      this.pending.set(id,record);
    }
    // 新的 stage 必须由调用方先经新鲜成员或实时所有者核验，才能解除失败删除屏障。
    this.deleteBarriers.delete(id);this.records.delete(id);this.records.set(id,record);
    while(this.records.size>RECORD_LIMIT){const oldest=this.records.keys().next().value;this.records.delete(oldest);this.pending.delete(oldest);}
    this.schedule();
    return {snapshot:record.current.snapshot,revision,baseRevision:record.previous?.revision,baseSnapshot:record.previous?.snapshot};
  }

  /** 内存行只暴露既有 SQLite 展示行形状，未知来源必须保留 undefined。 */
  row(id) {
    if(this.closed||this.deleteBarriers.has(id))return undefined;
    const record=this.records.get(id);
    if(record)return {thread_id:id,revision:record.current.revision,snapshot:record.current.serialized,previous_revision:record.previous?.revision??null,previous_snapshot:record.previous?.serialized??null,saved_source:record.savedSource,touched_at:record.touchedAt};
    if(this.diskFallbackBlocked)return undefined;
    try{return this.db?.prepare('SELECT * FROM conversation_cache WHERE thread_id=?').get(id);}catch{return undefined;}
  }

  /** 高频来源核对只读取小元数据；RAM 首帧不会因此访问 SQLite。 */
  metadata(id) {
    if(this.closed||this.deleteBarriers.has(id))return undefined;
    const record=this.records.get(id);
    if(record)return {thread_id:id,revision:record.current.revision,previous_revision:record.previous?.revision??null,saved_source:record.savedSource,source:record.savedSource,touched_at:record.touchedAt};
    if(this.diskFallbackBlocked)return undefined;
    try {const row=this.db?.prepare('SELECT thread_id,revision,previous_revision,saved_source,touched_at FROM conversation_cache WHERE thread_id=?').get(id);return row?{...row,source:row.saved_source}:undefined;}catch{return undefined;}
  }

  /** 当前与上一版均返回独立副本；RAM 没有对应版本时才按需回查磁盘两版。 */
  baseline(id,revision) {
    if(this.closed||!revision||this.deleteBarriers.has(id))return undefined;
    const record=this.records.get(id),current=record?.current,previous=record?.previous;
    if(current?.revision===revision)return JSON.parse(current.serialized);
    if(previous?.revision===revision)return JSON.parse(previous.serialized);
    if(this.diskFallbackBlocked)return undefined;
    try {
      const row=this.db?.prepare('SELECT revision,snapshot,previous_revision,previous_snapshot FROM conversation_cache WHERE thread_id=?').get(id);
      const serialized=row?.revision===revision?row.snapshot:row?.previous_revision===revision?row.previous_snapshot:undefined;
      return serialized?JSON.parse(serialized):undefined;
    }catch{return undefined;}
  }

  /** 后续热更新不重置首个截止点；失败只在下一固定窗口重试。 */
  schedule() {
    if(!this.pending.size){this.cancelTimer();return;}
    if(this.timer||this.closed||this.closing||this.paused||!this.db)return;
    this.deadline=Date.now()+this.intervalMs;
    this.timer=setTimeout(()=>{this.timer=null;this.deadline=0;this.flush();},this.intervalMs);this.timer.unref?.();
  }

  /** 清理定时器时同时移除截止点，关闭和暂停后不能继续后台写入。 */
  cancelTimer() {clearTimeout(this.timer);this.timer=null;this.deadline=0;}

  /** 失败删除只保留有界编号屏障；极端溢出时拒绝全部磁盘回退，宁可等待实时重建。 */
  rememberDeleteBarrier(id) {
    this.deleteBarriers.delete(id);this.deleteBarriers.add(id);
    if(this.deleteBarriers.size>DELETE_BARRIER_LIMIT){this.deleteBarriers.delete(this.deleteBarriers.values().next().value);this.diskFallbackBlocked=true;}
  }

  /** 先取消内存和待写，再立即删除展示副本；不通知上层，避免 onMissing 递归。 */
  forget(id) {
    if(this.closed)return false;
    this.records.delete(id);this.pending.delete(id);this.rememberDeleteBarrier(id);this.schedule();
    try {if(!this.db)return false;this.db.prepare('DELETE FROM conversation_cache WHERE thread_id=?').run(id);if(!this.transactionActive)this.deleteBarriers.delete(id);return true;}catch{return false;}
  }

  /** 阶段二仅持久化本轮最新 dirty；子集终态 flush 不改变其他会话的原截止点。 */
  flush(ids) {
    if(this.closed||this.flushing)return false;
    let selected;
    try {const keys=ids===undefined?[...this.pending.keys()]:typeof ids==='string'?[ids]:[...new Set(ids)];selected=keys.map(id=>[id,this.pending.get(id)]).filter(([,record])=>record);}catch{return false;}
    if(!selected.length){this.schedule();return true;}
    this.flushing=true;let transaction=false,complete=true;
    try {
      if(!this.db)return false;
      const visible=this.visible(selected.map(([id])=>id));
      if(!(visible instanceof Set))return false;
      const eligible=[];
      for(const [id,record]of selected) {
        if(this.pending.get(id)!==record||this.records.get(id)!==record)continue;
        if(this.blocked(id)){complete=false;continue;}
        if(!visible.has(id)){if(!this.forget(id))complete=false;try{this.onMissing(id);}catch{};continue;}
        eligible.push([id,record]);
      }
      if(!eligible.length)return complete;
      this.db.exec('BEGIN IMMEDIATE');transaction=true;this.transactionActive=true;
      const metadata=this.db.prepare('SELECT revision,previous_revision,saved_source FROM conversation_cache WHERE thread_id=?');
      const upsert=this.db.prepare(`INSERT INTO conversation_cache(thread_id,revision,snapshot,saved_source,touched_at) VALUES (?,?,?,?,?)
        ON CONFLICT(thread_id) DO UPDATE SET previous_revision=conversation_cache.revision,previous_snapshot=conversation_cache.snapshot,
        revision=excluded.revision,snapshot=excluded.snapshot,saved_source=excluded.saved_source,touched_at=excluded.touched_at`);
      const updateSource=this.db.prepare('UPDATE conversation_cache SET saved_source=? WHERE thread_id=?'),finished=[];
      let inserted=false;
      for(const [id,record]of eligible) {
        if(this.pending.get(id)!==record||this.records.get(id)!==record)continue;
        if(this.blocked(id)){complete=false;continue;}
        const row=metadata.get(id),sourceVersion=record.savedSource??row?.saved_source??'';
        if(row?.revision!==record.current.revision){upsert.run(id,record.current.revision,record.current.serialized,sourceVersion,record.touchedAt);if(!row)inserted=true;}
        else if(row.saved_source!==sourceVersion)updateSource.run(sourceVersion,id);
        // 同步回调若在写入途中 forget/淘汰了目标，不能把旧行重新提交回磁盘。
        if(!this.records.has(id)||this.deleteBarriers.has(id)){this.db.prepare('DELETE FROM conversation_cache WHERE thread_id=?').run(id);continue;}
        finished.push([id,record,sourceVersion]);
      }
      if(inserted){
        const protectedIds=[...new Set(finished.map(([id])=>id))];
        this.db.prepare(`DELETE FROM conversation_cache WHERE thread_id IN (
          SELECT thread_id FROM conversation_cache WHERE thread_id NOT IN (SELECT value FROM json_each(?))
          ORDER BY touched_at DESC,thread_id LIMIT -1 OFFSET ?)`).run(JSON.stringify(protectedIds),Math.max(0,RECORD_LIMIT-protectedIds.length));
      }
      this.db.exec('COMMIT');transaction=false;this.transactionActive=false;
      for(const [id,record,sourceVersion]of finished)if(this.records.get(id)===record&&this.pending.get(id)===record){record.savedSource=sourceVersion;this.pending.delete(id);}
      return complete;
    }catch {if(transaction)try{this.db.exec('ROLLBACK');}catch{}return false;}
    finally {this.transactionActive=false;this.flushing=false;this.schedule();}
  }

  /** 轻维护暂停自动保存；显式终态 flush 与 close 仍可尽力落盘。 */
  setPaused(paused) {if(this.closed)return;this.paused=paused===true;if(this.paused)this.cancelTimer();else this.schedule();}

  /** 清 light 驻留时只释放已落盘 RAM，未保存的最新展示仍可恢复。 */
  trimClean() {for(const id of this.records.keys())if(!this.pending.has(id))this.records.delete(id);}

  /** 最后尽力刷新一次，成功与否都释放定时器和正文引用，重复关闭不再次写入。 */
  close() {
    if(this.closed)return this.closeResult;
    this.closing=true;const result=this.flush();this.closed=true;this.cancelTimer();
    this.records.clear();this.pending.clear();this.deleteBarriers.clear();this.closeResult=result;return result;
  }
}
