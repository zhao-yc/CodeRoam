import fs from 'node:fs';

/** 保留与应用相同的加载顺序，Node 只剥离 UTS 类型和模块声明。 */
export const conversationCacheSource = ['conversation-cache-rows', 'conversation-cache'].map(name =>
  fs.readFileSync(new URL(`../../apps/mobile/services/${name}.uts`, import.meta.url), 'utf8')
    .replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '')).join('\n');

/** 用独立的配对命名空间模拟 CAS 原子提交，允许用例暂停请求或模拟配额错误。 */
export function conversationMemoryDatabase() {
  const namespaces = new Map();
  const writes = [];
  const empty = () => ({revision:'',rows:new Map()});
  const dump = namespace => {
    const current = namespaces.get(namespace) ?? empty();
    return {revision:current.revision,rows:[...current.rows].map(([key,value])=>({key,value}))};
  };
  const db = { writes, dump, beforeRead:null, beforeWrite:null };
  db.adapter = {
    readConversationCacheRows: async namespace => {
      const snapshot = dump(namespace);
      await db.beforeRead?.(namespace, snapshot);
      return JSON.stringify(snapshot);
    },
    writeConversationCacheRows: async (namespace, expectedRevision, nextRevision, raw) => {
      const changes = JSON.parse(raw);
      const write = {namespace, expectedRevision, nextRevision, changes, applied:false};
      writes.push(write);
      await db.beforeWrite?.(write);
      const current = namespaces.get(namespace) ?? empty();
      if (current.revision !== expectedRevision) return false;
      const rows = changes.clear ? new Map() : new Map(current.rows);
      changes.remove.forEach(key => rows.delete(key));
      changes.put.forEach(({key,value}) => rows.set(key,value));
      namespaces.set(namespace, {revision:nextRevision,rows});
      write.applied = true;
      return true;
    },
  };
  return db;
}
