import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { readHistoricalSnapshot } from './history-reader.mjs';
import { readHistoricalPage } from './history-pager.mjs';
import { readProjectedHistory } from './projected-history.mjs';

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
  list({ limit = 50, offset = 0, search = '' } = {}) {
    if (!fs.existsSync(this.filePath)) throw new BridgeError('INDEX_NOT_FOUND', '未找到 Codex 会话索引，请先打开桌面客户端');
    const db = new DatabaseSync(this.filePath, { readOnly: true });
    try {
      const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(column => column.name));
      const time = columns.has('updated_at_ms') ? 'COALESCE(updated_at_ms,updated_at*1000)' : 'updated_at*1000';
      const title = columns.has('name') ? "COALESCE(NULLIF(name,''),title)" : 'title';
      // 按来源排除内部审核和子智能体，在搜索与分页前过滤；不凭标题或消息是否为空隐藏普通聊天。
      const visible = ['archived=0'];
      // 已命名的新会话也属于正常列表；标题和首条消息索引可能滞后，不能据此隐藏会话。
      if(columns.has('thread_source')) visible.push("COALESCE(thread_source,'') NOT IN ('guardian_review','subagent')");
      // 旧索引可能没有规范来源字段；只识别结构化 subagent 来源，兼容空值、未知来源和非 JSON 字符串。
      if(columns.has('source')) visible.push("CASE WHEN json_valid(source) THEN COALESCE(json_type(source,'$.subagent'),'null') = 'null' ELSE 1 END");
      const rows = db.prepare(`SELECT id,${title} AS title,cwd,${time} AS updatedAt FROM threads WHERE ${visible.join(' AND ')} AND (${title} LIKE ? OR cwd LIKE ?) ORDER BY ${time} DESC LIMIT ? OFFSET ?`).all(`%${String(search).slice(0,100)}%`, `%${String(search).slice(0,100)}%`, Math.max(1,Math.min(100,Number(limit)||50)), Math.max(0,Math.min(10000,Number(offset)||0)));
      return rows.map(row => ({ ...row, title: row.title || '未命名会话' }));
    } finally { db.close(); }
  }
}
