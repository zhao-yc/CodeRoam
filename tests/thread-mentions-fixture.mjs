import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture as pluginFixture } from './plugins-fixture.mjs';
import { ThreadMentionService } from '../apps/bridge/thread-mentions.mjs';
import { StateReader } from '../apps/bridge/state-reader.mjs';

export const contextText = '\n## 合成引用上下文\n请先使用 read_thread 读取已引用的合成聊天。';
export const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

/** 保留真实服务、协议、适配器及队列，只替换桌面引用准备和索引数据。 */
export function fixture(t, options) {
  const f = pluginFixture(t, options);
  f.mentionRows = new Map([
    ['reference-a', { id: 'reference-a', title: '合成聊天甲' }],
    ['reference-b', { id: 'reference-b', title: 'Example 聊天乙' }],
  ]);
  f.prepares = []; f.indexReads = []; f.listReads = [];
  f.adapter.index = {
    readMentionThreads(ids) {
      f.indexReads.push([...ids]);
      return ids.flatMap(id => {
        const row = f.mentionRows.get(id);
        return row && !row.archived && !row.internal ? [{ id, title: row.title }] : [];
      });
    },
    listMentions(params) {
      f.listReads.push(structuredClone(params));
      return { threads: [{ id: 'reference-a', title: '合成聊天甲', projectLabel: 'example', updatedAt: 123 }], hasMore: false };
    },
  };
  f.mentionDesktop = {
    async prepare(adapter, input) {
      f.prepares.push(structuredClone(input));
      await f.onPrepare?.(input, adapter);
      return f.prepareResult ?? { supported: true, references: input.ids.map(threadId => ({ hostId: 'local', threadId })), contextText };
    },
    close() {},
  };
  f.adapter.threadMentions = new ThreadMentionService(f.adapter, f.mentionDesktop);
  f.agent.nativeDrafts.threadMentions = f.adapter.threadMentions;
  return f;
}

/** 门闩只延迟真正的引用选择，不延迟列表的空编号能力探测。 */
export function pausePrepare(f) {
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.onPrepare = async ({ ids }) => { if (ids.length) { entered(); await gate; } };
  return { entered: ready, release };
}

/** 索引仅写入测试自己创建的临时数据库，StateReader 仍走真实只读 SQL。 */
export function sqliteFixture(t, columns = ['name', 'thread_source', 'source', 'updated_at_ms']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-mentions-'));
  const db = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, updated_at INTEGER, archived INTEGER DEFAULT 0${columns.map(name => `,${name} ${name === 'updated_at_ms' ? 'INTEGER' : 'TEXT'}`).join('')})`);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    db, reader: new StateReader(root),
    add(row) {
      const data = { title: '合成聊天', cwd: '/example/projects/alpha', updated_at: 1, ...row }, keys = Object.keys(data);
      db.prepare(`INSERT INTO threads (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(data));
    },
  };
}

/** 原生草稿只模拟控制器边界；首条请求仍走 BridgeAgent 和 NativeDraftService。 */
export function nativeDraftFixture(t) {
  const f = fixture(t);
  f.nativeCalls = [];
  const snapshot = {
    revision: 1, status: 'ready', hasDesktopText: false,
    settings: { model: 'example-model', effort: 'medium', serviceTier: '', mode: 'default' },
    models: [{ id: 'example-model', label: '合成模型', defaultEffort: 'medium', efforts: ['medium'], speeds: [], supportsImages: true }],
    permissions: { mode: 'default', revision: 1, options: [{ id: 'default', label: '默认权限', enabled: true }] },
  };
  f.agent.nativeDrafts.controller = {
    async capabilities() { return true; },
    async open() { return { binding: { windowId: 'example-window', clientDraftId: 'example-client' }, snapshot: structuredClone(snapshot) }; },
    async read() { return structuredClone(snapshot); },
    async send(binding, input, options) {
      f.nativeCalls.push({ binding, input, options });
      Object.assign(snapshot, { status: 'promoted', revision: 2, threadId: 'example-created-thread' });
      await options.onCreated({ threadId: snapshot.threadId });
      return { threadId: snapshot.threadId, snapshot: structuredClone(snapshot) };
    },
    close() {},
  };
  return f;
}
