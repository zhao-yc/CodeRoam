/** 列表磁盘副本只允许四个展示字段，运行、审批、权限和通知状态始终留在内存。 */
export function threadListDisplay(row) {
  return {id:String(row.id),title:typeof row.title==='string'?row.title:'未命名聊天',cwd:typeof row.cwd==='string'?row.cwd:'',updatedAt:Number.isFinite(row.updatedAt)?row.updatedAt:0};
}

/** 与实例自有账本共用连接，绝不打开或写入桌面原生数据库。 */
export class ThreadListStore {
  constructor(db) {
    this.db=db;
    db?.exec('CREATE TABLE IF NOT EXISTS thread_list_index (id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, position INTEGER NOT NULL)');
  }
  load() {
    const rows=this.db?.prepare('SELECT id,title,cwd,updated_at AS updatedAt FROM thread_list_index ORDER BY position LIMIT 50').all()??[];
    this.saved=JSON.stringify(rows);return rows;
  }
  /** 仅更新变化行及位置；事务保证中断时仍保留一份完整索引。 */
  save(rows) {
    if(!this.db)return;
    const display=rows.slice(0,50).map(threadListDisplay),serialized=JSON.stringify(display);
    if(serialized===this.saved)return;
    const previous=this.db.prepare('SELECT id,title,cwd,updated_at AS updatedAt,position FROM thread_list_index').all();
    const byId=new Map(previous.map(row=>[row.id,row])),ids=new Set(display.map(row=>row.id));
    this.db.exec('SAVEPOINT thread_list_save');
    try {
      const remove=this.db.prepare('DELETE FROM thread_list_index WHERE id=?');
      for(const row of previous)if(!ids.has(row.id))remove.run(row.id);
      const upsert=this.db.prepare('INSERT INTO thread_list_index(id,title,cwd,updated_at,position) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,cwd=excluded.cwd,updated_at=excluded.updated_at,position=excluded.position');
      display.forEach((row,position)=>{const old=byId.get(row.id);if(!old||old.title!==row.title||old.cwd!==row.cwd||old.updatedAt!==row.updatedAt||old.position!==position)upsert.run(row.id,row.title,row.cwd,row.updatedAt,position);});
      this.db.exec('RELEASE thread_list_save');
      this.saved=serialized;
    } catch(error) {
      this.db.exec('ROLLBACK TO thread_list_save; RELEASE thread_list_save');
      throw error;
    }
  }
}
