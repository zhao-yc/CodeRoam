import {CACHE_PERSISTENCE_INTERVAL_MS} from './cache-persistence.mjs';

/** 列表磁盘副本只允许四个展示字段，运行、审批、权限和通知状态始终留在内存。 */
export function threadListDisplay(row) {
  return {id:String(row.id),title:typeof row.title==='string'?row.title:'未命名聊天',cwd:typeof row.cwd==='string'?row.cwd:'',updatedAt:Number.isFinite(row.updatedAt)?row.updatedAt:0};
}

/** 与实例自有账本共用连接，绝不打开或写入桌面原生数据库。 */
export class ThreadListStore {
  constructor(db,{verifyVisible,flushIntervalMs=CACHE_PERSISTENCE_INTERVAL_MS}={}) {
    this.db=db;this.verifyVisible=verifyVisible;this.flushIntervalMs=flushIntervalMs;
    this.pending=null;this.timer=null;this.closed=false;this.persisted=new Map();this.loaded=false;
    db?.exec('CREATE TABLE IF NOT EXISTS thread_list_index (id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, position INTEGER NOT NULL)');
  }
  load() {
    const rows=this.db?.prepare('SELECT id,title,cwd,updated_at AS updatedAt FROM thread_list_index ORDER BY position LIMIT 50').all()??[];
    this.saved=JSON.stringify(rows);this.persisted=new Map(rows.map(row=>[row.id,threadListDisplay(row)]));this.loaded=true;return rows;
  }
  /** 内存只保留最新展示投影；首个固定窗口不随持续更新重置。 */
  save(rows) {
    if(!this.db||this.closed)return;
    if(!this.loaded)this.load();
    const display=rows.slice(0,50).map(threadListDisplay),serialized=JSON.stringify(display);
    const ids=new Set(display.map(row=>row.id)),removed=[...new Set([...this.persisted.keys(),...(this.pending?.rows??[]).map(row=>row.id)])].filter(id=>!ids.has(id));
    if(removed.length)this.forget(removed);
    if(serialized===this.saved){this.pending=null;clearTimeout(this.timer);this.timer=null;return;}
    this.pending={rows:display,serialized};this.schedule();
  }
  /** 同一窗口的后续修改只替换待写值，写失败也在下一窗口重试。 */
  schedule() {
    if(this.timer||this.closed||!this.pending)return;
    this.timer=setTimeout(()=>{this.timer=null;this.flush();},this.flushIntervalMs);this.timer.unref?.();
  }
  /** 归档删除立即取消待写和删除展示副本，不能等合并窗口结束。 */
  forget(ids) {
    if(!this.db||this.closed||!ids.length)return true;
    if(!this.loaded)this.load();
    const removed=new Set(ids),latest=(this.pending?.rows??[...this.persisted.values()]).filter(row=>!removed.has(row.id));
    this.pending={rows:latest,serialized:JSON.stringify(latest)};
    try {
      const remove=this.db.prepare('DELETE FROM thread_list_index WHERE id=?');
      for(const id of removed){remove.run(id);this.persisted.delete(id);}
      this.saved=JSON.stringify([...this.persisted.values()]);
      if(this.pending.serialized===this.saved){this.pending=null;clearTimeout(this.timer);this.timer=null;}
      else this.schedule();
      return true;
    } catch {this.saved=undefined;this.schedule();return false;}
  }
  /** 保存前重新核对成员；未知时保留待写，绝不回灌已经被账本清掉的旧成员。 */
  flush() {
    if(this.closed)return !this.pending;
    clearTimeout(this.timer);this.timer=null;
    if(!this.db||!this.pending)return true;
    const pending=this.pending;
    try {
      const visible=this.verifyVisible?.(pending.rows.map(row=>row.id));
      const rows=visible?pending.rows.filter(row=>visible.has(row.id)):pending.rows;
      this.persist(rows);
      if(this.pending===pending)this.pending=null;
      this.schedule();return true;
    } catch {this.schedule();return false;}
  }
  /** 仅更新变化行及位置；事务保证中断时仍保留一份完整索引。 */
  persist(display) {
    const serialized=JSON.stringify(display);
    const previous=this.db.prepare('SELECT id,title,cwd,updated_at AS updatedAt,position FROM thread_list_index').all();
    const byId=new Map(previous.map(row=>[row.id,row])),ids=new Set(display.map(row=>row.id));
    this.db.exec('SAVEPOINT thread_list_save');
    try {
      const remove=this.db.prepare('DELETE FROM thread_list_index WHERE id=?');
      for(const row of previous)if(!ids.has(row.id))remove.run(row.id);
      const upsert=this.db.prepare('INSERT INTO thread_list_index(id,title,cwd,updated_at,position) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,cwd=excluded.cwd,updated_at=excluded.updated_at,position=excluded.position');
      display.forEach((row,position)=>{const old=byId.get(row.id);if(!old||old.title!==row.title||old.cwd!==row.cwd||old.updatedAt!==row.updatedAt||old.position!==position)upsert.run(row.id,row.title,row.cwd,row.updatedAt,position);});
      this.db.exec('RELEASE thread_list_save');
      this.saved=serialized;this.persisted=new Map(display.map(row=>[row.id,row]));this.loaded=true;
    } catch(error) {
      this.db.exec('ROLLBACK TO thread_list_save; RELEASE thread_list_save');
      throw error;
    }
  }
  /** 正常关闭尽力保存最新值，关闭后取消重试，不能在账本关闭后再触发计时器。 */
  close() {
    if(this.closed)return true;
    const saved=this.flush();this.closed=true;clearTimeout(this.timer);this.timer=null;return saved;
  }
}
