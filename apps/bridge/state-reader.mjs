import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { readHistoricalSnapshot } from './history-reader.mjs';
import { readHistoricalPage } from './history-pager.mjs';
import { readProjectedHistory, readProjectedFileReport } from './projected-history.mjs';

/** 只读查询 Codex 自有索引，不启动第二个执行进程，也不更改数据库。 */
export class StateReader {
  constructor(codexHome = path.join(os.homedir(), '.codex')) { this.filePath = path.join(codexHome, 'state_5.sqlite'); }
  /** 主动加载前只读核对本机未归档会话，不接受任意会话或路径。 */
  containsThread(threadId) {
    if(!fs.existsSync(this.filePath))return false;
    const db=new DatabaseSync(this.filePath,{readOnly:true});
    try{return !!db.prepare('SELECT id FROM threads WHERE id=? AND archived=0').get(threadId);}
    finally{db.close();}
  }
  /** 只读枚举与桌面删除规则相同的附属子对话，包含已归档子对话。 */
  readDeletionTree(threadId) {
    const db = new DatabaseSync(this.filePath, { readOnly: true });
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(column => column.name));
      if (!columns.has('attached_thread_parent_id')) throw new BridgeError('DELETE_UNSUPPORTED', '此电脑版本暂不支持核对删除范围，请更新后重试');
      const rows = db.prepare('WITH RECURSIVE subtree(id) AS (SELECT id FROM threads WHERE id=? UNION SELECT t.id FROM threads t JOIN subtree p ON t.attached_thread_parent_id=p.id) SELECT id,archived FROM threads WHERE id IN (SELECT id FROM subtree) ORDER BY id').all(threadId);
      if (rows.length > 1000) throw new BridgeError('DELETE_TOO_LARGE', '关联对话过多，请在电脑端处理');
      return rows.sort((a, b) => a.id === threadId ? -1 : b.id === threadId ? 1 : a.id.localeCompare(b.id)).map(row => ({ id: row.id, archived: row.archived === 1 }));
    } finally { db.close(); }
  }
  /** 删除后的回读同时检查归档区，不能把归档误判为永久删除。 */
  existingThreadIds(ids) {
    if (!ids.length) return [];
    const db = new DatabaseSync(this.filePath, { readOnly: true });
    try { return db.prepare('SELECT id FROM threads WHERE id IN (' + ids.map(() => '?').join(',') + ')').all(...ids).map(row => row.id); }
    finally { db.close(); }
  }
  /** 实时快照可能缺少名称；按会话 ID 只读索引，不受列表分页影响。 */
  readTitle(threadId) {
    if(!fs.existsSync(this.filePath))return '';
    const db=new DatabaseSync(this.filePath,{readOnly:true});
    try {
      const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(column=>column.name));
      const title=columns.has('name')?"COALESCE(NULLIF(TRIM(name),''),title)":'title';
      return db.prepare(`SELECT ${title} AS title FROM threads WHERE id=? AND archived=0`).get(threadId)?.title ?? '';
    } finally {db.close();}
  }
  /** 后台浏览只读取索引和已保存历史，不唤醒或导航桌面。 */
  readHistory(threadId, options = {}) {
    if(!fs.existsSync(this.filePath)) throw new BridgeError('INDEX_NOT_FOUND','未找到本机的会话索引');
    const db=new DatabaseSync(this.filePath,{readOnly:true});
    let row;
    try {
      const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(column=>column.name));
      const title=columns.has('name')?"COALESCE(NULLIF(name,''),title)":'title';
      const time=columns.has('updated_at_ms')?'COALESCE(updated_at_ms,updated_at*1000)':'updated_at*1000';
      row=db.prepare(`SELECT id,${title} AS title,cwd,rollout_path,${time} AS updatedAt FROM threads WHERE id=? AND archived=0`).get(threadId);
    } finally {db.close();}
    if(!row) throw new BridgeError('THREAD_NOT_FOUND','这条会话已不存在或已经归档，请刷新会话列表');
    if(options.rawTurns===true&&options.reportId){const report=readProjectedFileReport(row,path.dirname(this.filePath),options.reportId);if(report)return report;}
    if(options.page===true) {
      // 新版分叉会话的继承消息只保存在历史投影中，不能只扫描当前日志。
      const projected=readProjectedHistory(row,path.dirname(this.filePath),options);
      if(projected)return projected;
      // 首次起点可能在多个读取块之前；有限跳过纯内部事件，避免要求用户反复点空页。
      let page;const current={...options};
      for(let attempt=0;attempt<8;attempt++) {
        page=readHistoricalPage(row,path.join(path.dirname(this.filePath),'sessions'),current);
        if(page.messages.length||!page.hasMore)break;
        current.before=page.cursor;current.beforeMessageId='';
      }
      return page;
    }
    return readHistoricalSnapshot(row,path.join(path.dirname(this.filePath),'sessions'),undefined,options);
  }
  list({ limit = 50, offset = 0, search = '', archived = false } = {}) {
    if (!fs.existsSync(this.filePath)) throw new BridgeError('INDEX_NOT_FOUND', '未找到 Codex 会话索引，请先打开桌面客户端');
    const db = new DatabaseSync(this.filePath, { readOnly: true });
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(column => column.name));
      const time = columns.has('updated_at_ms') ? 'COALESCE(updated_at_ms,updated_at*1000)' : 'updated_at*1000';
      const title = columns.has('name') ? "COALESCE(NULLIF(name,''),title)" : 'title';
      // 按来源排除内部审核和子智能体，在搜索与分页前过滤；不凭标题或消息是否为空隐藏普通聊天。
      const visible = [archived === true ? 'archived=1' : 'archived=0'];
      // 已命名的新会话也属于正常列表；标题和首条消息索引可能滞后，不能据此隐藏会话。
      if(columns.has('thread_source')) visible.push("COALESCE(thread_source,'') NOT IN ('guardian_review','subagent')");
      // 旧索引可能没有规范来源字段；只识别结构化 subagent 来源，兼容空值、未知来源和非 JSON 字符串。
      if(columns.has('source')) visible.push("CASE WHEN json_valid(source) THEN COALESCE(json_type(source,'$.subagent'),'null') = 'null' ELSE 1 END");
      const rows = db.prepare(`SELECT id,${title} AS title,cwd,${time} AS updatedAt FROM threads WHERE ${visible.join(' AND ')} AND (${title} LIKE ? OR cwd LIKE ?) ORDER BY ${time} DESC LIMIT ? OFFSET ?`).all(`%${String(search).slice(0,100)}%`, `%${String(search).slice(0,100)}%`, Math.max(1,Math.min(100,Number(limit)||50)), Math.max(0,Math.min(10000,Number(offset)||0)));
      return rows.map(row => ({ ...row, title: row.title || '未命名会话' }));
    } finally { db.close(); }
  }
}
