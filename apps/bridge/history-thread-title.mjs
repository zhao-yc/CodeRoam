/** 标题读取失败不能阻止任务入库；只保留受限长度的展示快照。 */
export function historyThreadTitle(readTitle, threadId) {
  if (!threadId) return '';
  try { const value = readTitle(threadId); return typeof value === 'string' ? value.trim().slice(0, 300) : ''; }
  catch { return ''; }
}

/** 旧记录仅补空标题，已有快照不随聊天改名或删除而变化。 */
export function migrateHistoryTitles(db, table, readTitle) {
  if (!db.prepare('PRAGMA table_info(' + table + ')').all().some(column => column.name === 'thread_title')) db.exec('ALTER TABLE ' + table + " ADD COLUMN thread_title TEXT NOT NULL DEFAULT ''");
  const update = db.prepare('UPDATE ' + table + " SET thread_title=? WHERE thread_id=? AND thread_title=''");
  for (const row of db.prepare('SELECT DISTINCT thread_id FROM ' + table + " WHERE thread_title='' AND thread_id!=''").all()) {
    const title = historyThreadTitle(readTitle, row.thread_id);
    if (title) update.run(title, row.thread_id);
  }
}
