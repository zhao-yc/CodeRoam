import fs from 'node:fs';
import {readHistoricalActivity} from './history-activity.mjs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
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
  /** 一次只读核对手机仍保留的缓存编号，索引不可用时明确失败。 */
  visibleThreadIds(ids) {
    if (!ids.length) return new Set();
    const db = new DatabaseSync(this.filePath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT id FROM threads WHERE archived=0 AND id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids));
      return new Set(rows.map(row => row.id));
    } finally { db.close(); }
  }
  /** 只读枚举与桌面删除规则相同的附属子对话，包含已归档子对话。 */
  readDeletionTree(threadId) {
    const db = new DatabaseSync(this.filePath, { readOnly: true });
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(column => column.name));
      if (!columns.has('attached_thread_parent_id')) throw new BridgeError('DELETE_UNSUPPORTED', '此电脑版本暂不支持核对删除范围，请更新后重试');
      const rows = db.prepare('WITH RECURSIVE subtree(id) AS (SELECT id FROM threads WHERE id=? UNION SELECT t.id FROM threads t JOIN subtree p ON t.attached_thread_parent_id=p.id) SELECT id,archived FROM threads WHERE id IN (SELECT id FROM subtree) ORDER BY id').all(threadId);
      if (rows.length > 1000) throw new BridgeError('DELETE_TOO_LARGE', '关联聊天过多，请在电脑端处理');
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
  /** 历史和缓存共用已核对的未归档会话索引。 */
  historyRow(threadId) {
    if(!fs.existsSync(this.filePath)) throw new BridgeError('INDEX_NOT_FOUND','未找到本机的聊天索引');
    const db=new DatabaseSync(this.filePath,{readOnly:true});
    let row;
    try {
      const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(column=>column.name));
      const title=columns.has('name')?"COALESCE(NULLIF(name,''),title)":'title';
      const time=columns.has('updated_at_ms')?'COALESCE(updated_at_ms,updated_at*1000)':'updated_at*1000';
      row=db.prepare(`SELECT id,${title} AS title,cwd,rollout_path,${time} AS updatedAt FROM threads WHERE id=? AND archived=0`).get(threadId);
    } finally {db.close();}
    if(!row) throw new BridgeError('THREAD_NOT_FOUND','这条聊天已不存在或已经归档，请刷新聊天列表');
    return row;
  }
  /** 轻量核对历史来源，只在会话文件或索引记录变化时重建缓存。 */
  historyCacheSource(threadId) {
    const row = this.historyRow(threadId);
    if (!row.rollout_path) return '';
    try {
      const root = fs.realpathSync.native(path.join(path.dirname(this.filePath), 'sessions'));
      const file = fs.realpathSync.native(row.rollout_path);
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !file.endsWith('.jsonl')) return '';
      const stat = fs.statSync(file, { bigint: true });
      if (!stat.isFile()) return '';
      // 路径仅用于本机指纹，SQLite 缓存不会重复保存源文件路径。
      return createHash('sha256').update(JSON.stringify([row.title, row.cwd, row.updatedAt, file, ...[stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)])).digest('hex');
    } catch { return ''; }
  }
  /** 离线轻维护只核对明确的任务尾部事件，正文解析留到确认终态或用户重新查看。 */
  historyActivity(threadId) { return readHistoricalActivity(this.historyRow(threadId),path.join(path.dirname(this.filePath),'sessions')); }
  /** 后台浏览只读取索引和已保存历史，不唤醒或导航桌面。 */
  readHistory(threadId, options = {}) {
    const row = this.historyRow(threadId);
    if(options.imageMessageId){const projected=readProjectedHistory(row,path.dirname(this.filePath),options);if(projected)return projected;}
    if(options.rawTurns===true&&options.reportId){const report=readProjectedFileReport(row,path.dirname(this.filePath),options.reportId);if(report)return report;}
    if(options.page===true) {
      // 新版分叉会话的继承消息只保存在历史投影中，不能只扫描当前日志。
      const projected=readProjectedHistory(row,path.dirname(this.filePath),options);
      if(projected)return projected;
      // 首次起点可能在多个读取块之前；有限跳过纯内部事件，避免要求用户反复点空页。
      let page;const current={...options};
      for(let attempt=0;attempt<8;attempt++) {
        page=readHistoricalPage(row,path.join(path.dirname(this.filePath),'sessions'),current);
        if(page.messages.length||page.turns?.length||!page.hasMore)break;
        current.before=page.cursor;current.beforeMessageId='';
      }
      return page;
    }
    const snapshot=readHistoricalSnapshot(row,path.join(path.dirname(this.filePath),'sessions'),undefined,options);
    // 生成图片不在旧事件正文中，使用桌面只读投影补齐同轮次可见图片。
    if(!options.rawTurns) {
      const projected=readProjectedHistory(row,path.dirname(this.filePath));
      for(const image of projected?.messages.filter(message=>message.kind==='imageGeneration')??[]) {
        if(snapshot.messages.some(message=>message.id===image.id))continue;
        const last=snapshot.messages.findLastIndex(message=>message.turnId===image.turnId);
        if(last>=0)snapshot.messages.splice(last+1,0,image);
      }
    }
    return snapshot;
  }
  /** 引用候选只读索引，不订阅、不导航，也不回传工作目录或消息正文。 */
  listMentions({ search = '', offset = 0, limit = 30, excludeThreadId = '' } = {}) {
    const rows = this.list({ search, offset, limit: limit + 1, excludeThreadId });
    return { threads: rows.slice(0, limit).map(({ id, title, cwd, updatedAt }) => ({ id, title, projectLabel: path.win32.basename(String(cwd ?? '').replaceAll('/', '\\')) || '未指定项目', updatedAt })), hasMore: rows.length > limit };
  }
  /** 发送前逐个按编号重新核验；不能因搜索分页或同名标题改为另一条聊天。 */
  readMentionThreads(ids) {
    if (!ids.length) return [];
    const db = new DatabaseSync(this.filePath, { readOnly: true });
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(column => column.name));
      const title = columns.has('name') ? "COALESCE(NULLIF(name,''),title)" : 'title';
      const visible = ['archived=0'];
      if (columns.has('thread_source')) visible.push("COALESCE(thread_source,'') NOT IN ('guardian_review','subagent')");
      if (columns.has('source')) visible.push("CASE WHEN json_valid(source) THEN COALESCE(json_type(source,'$.subagent'),'null') = 'null' ELSE 1 END");
      return db.prepare(`SELECT id,${title} AS title FROM threads WHERE ${visible.join(' AND ')} AND id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(row => ({ id: row.id, title: row.title || '未命名聊天' }));
    } finally { db.close(); }
  }
  list({ limit = 50, offset = 0, search = '', archived = false, excludeThreadId = '' } = {}) {
    if (!fs.existsSync(this.filePath)) throw new BridgeError('INDEX_NOT_FOUND', '未找到 Codex 聊天索引，请先打开桌面客户端');
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
      const rows = db.prepare(`SELECT id,${title} AS title,cwd,${time} AS updatedAt FROM threads WHERE ${visible.join(' AND ')} AND id<>? AND (${title} LIKE ? OR cwd LIKE ?) ORDER BY ${time} DESC,id ASC LIMIT ? OFFSET ?`).all(excludeThreadId, `%${String(search).slice(0,100)}%`, `%${String(search).slice(0,100)}%`, Math.max(1,Math.min(101,Number(limit)||50)), Math.max(0,Math.min(10000,Number(offset)||0)));
      return rows.map(row => ({ ...row, title: row.title || '未命名聊天' }));
    } finally { db.close(); }
  }
}
