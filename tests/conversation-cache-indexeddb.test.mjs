import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = stripTypeScriptTypes(fs.readFileSync(new URL('../apps/mobile/uni_modules/codex-conversation-db/utssdk/web/index.uts', import.meta.url), 'utf8'))
  .replace(/^export /gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));
const batch = (put = [], remove = [], clear = false) => JSON.stringify({ put, remove, clear });

/** 手动推进浏览器事件，核对请求完成与事务提交之间的边界。 */
function fixture() {
  const calls = [], opens = [], transactions = [];
  const db = {
    close: () => { calls.push(['关闭连接']); },
    createObjectStore: (name, options) => {
      calls.push(['建表', name, options.keyPath]);
      return { createIndex: (...args) => { calls.push(['建索引', ...args]); } };
    },
    transaction: (names, mode) => {
      calls.push(['开启事务', names, mode]);
      const marker = {}, entries = {}, cursor = {}, fullCursor = {}, selected = [];
      const transaction = {
        marker, entries, cursor, fullCursor, selected,
        objectStore: name => ({
          get: key => {
            if (name === 'revisions') { calls.push(['读取版本', key]); return marker; }
            calls.push(['读取主键', key]); const request = {}; selected.push(request); return request;
          },
          getAll: range => { calls.push(['读取范围', range]); return entries; },
          put: value => { calls.push(['写入', name, value]); },
          delete: key => { calls.push(['删除', name, key]); },
          openCursor: () => { calls.push(['扫描全部记录', name]); return fullCursor; },
          index: index => ({
            getAll: key => { calls.push(['读取索引', index, key]); return entries; },
            openCursor: key => { calls.push(['扫描索引', index, key]); return cursor; },
          }),
        }),
      };
      transactions.push(transaction);
      return transaction;
    },
  };
  const indexedDB = { open: (name, version) => {
    calls.push(['打开数据库', name, version]);
    const request = { result: db }; opens.push(request); return request;
  } };
  const context = vm.createContext({ window: { indexedDB }, IDBKeyRange: { bound: (...args) => args } });
  vm.runInContext(source + ';globalThis.subject={readConversationCacheRows,writeConversationCacheRows,purgeConversationCacheBodies};', context);
  return { db, calls, opens, transactions, ...context.subject };
}

const recorded = calls => JSON.parse(JSON.stringify(calls));

test('按命名空间在一个只读事务内恢复行和版本，提交前不返回结果', async () => {
  const f = fixture(); let complete = false;
  const promise = f.readConversationCacheRows('配对一').then(value => { complete = true; return value; });
  f.opens[0].onupgradeneeded({ oldVersion: 0 }); f.opens[0].onsuccess(); await tick();
  const transaction = f.transactions[0];
  transaction.marker.result = { revision: '持久版本' };
  transaction.entries.result = [{ namespace: '配对一', key: '会话', value: '合成正文' }];
  assert.equal(complete, false);
  transaction.oncomplete();
  assert.deepEqual(JSON.parse(await promise), { revision: '持久版本', rows: [{ key: '会话', value: '合成正文' }] });
  assert.deepEqual(recorded(f.calls).slice(1), [
    ['建表', 'rows', ['namespace', 'key']], ['建索引', 'namespace', 'namespace'], ['建表', 'revisions', 'namespace'],
    ['开启事务', ['rows', 'revisions'], 'readonly'], ['读取版本', '配对一'], ['读取索引', 'namespace', '配对一'],
  ]);
});

test('索引读取以复合主键范围限定会话头，正文读取只请求指定消息键', async () => {
  const f = fixture();
  const headers = f.readConversationCacheRows('配对一', 'headers');
  f.opens[0].onsuccess(); await tick();
  const scan = f.transactions[0];
  assert.deepEqual(recorded(f.calls).slice(1), [
    ['开启事务', ['rows', 'revisions'], 'readonly'], ['读取版本', '配对一'],
    ['读取范围', [['配对一', 'h:'], ['配对一', 'h;'], false, true]],
  ]);
  scan.marker.result = { revision: '版本一' };
  scan.entries.result = [{ key: 'h:会话', value: '合成会话头' }];
  scan.oncomplete();
  assert.deepEqual(JSON.parse(await headers), { revision: '版本一', rows: [{ key: 'h:会话', value: '合成会话头' }] });

  const before = f.calls.length;
  const messages = f.readConversationCacheRows('配对一', JSON.stringify(['m:消息一', 'm:已删除', 'm:消息一'])); await tick();
  const lookup = f.transactions[1];
  assert.deepEqual(recorded(f.calls).slice(before), [
    ['开启事务', ['rows', 'revisions'], 'readonly'], ['读取版本', '配对一'],
    ['读取主键', ['配对一', 'm:消息一']], ['读取主键', ['配对一', 'm:已删除']],
  ]);
  lookup.marker.result = { revision: '版本二' };
  lookup.selected[0].result = { key: 'm:消息一', value: '合成正文' };
  lookup.oncomplete();
  assert.deepEqual(JSON.parse(await messages), { revision: '版本二', rows: [{ key: 'm:消息一', value: '合成正文' }] });
});

test('空键列表仅读取版本，无效选择在发出事务前拒绝', async () => {
  const f = fixture();
  await assert.rejects(f.readConversationCacheRows('配对一', '[1]'), /范围无效/);
  await assert.rejects(f.readConversationCacheRows('配对一', 'null'), /范围无效/);
  assert.equal(f.opens.length, 0);
  const empty = f.readConversationCacheRows('配对一', '[]');
  f.opens[0].onsuccess(); await tick();
  const transaction = f.transactions[0];
  assert.deepEqual(recorded(f.calls).slice(1), [['开启事务', ['rows', 'revisions'], 'readonly'], ['读取版本', '配对一']]);
  transaction.marker.result = { revision: '保留版本' };
  transaction.oncomplete();
  assert.deepEqual(JSON.parse(await empty), { revision: '保留版本', rows: [] });
});

test('增量事务只改指定键并更新版本，版本冲突时不写入', async () => {
  const f = fixture(); let complete = false;
  const value = batch([{ key: '新消息', value: '合成正文' }], ['旧消息']);
  const first = f.writeConversationCacheRows('配对一', '', '版本一', value).then(result => { complete = true; return result; });
  f.opens[0].onsuccess(); await tick();
  const transaction = f.transactions[0];
  transaction.marker.onsuccess(); await tick();
  assert.equal(complete, false);
  assert.deepEqual(recorded(f.calls).slice(-3), [
    ['删除', 'rows', ['配对一', '旧消息']], ['写入', 'rows', { namespace: '配对一', key: '新消息', value: '合成正文' }],
    ['写入', 'revisions', { namespace: '配对一', revision: '版本一' }],
  ]);
  transaction.oncomplete(); assert.equal(await first, true);
  const stale = f.writeConversationCacheRows('配对一', '', '过期写入', value); await tick();
  const conflicting = f.transactions[1]; conflicting.marker.result = { revision: '版本一' };
  const before = f.calls.length; conflicting.marker.onsuccess(); conflicting.oncomplete();
  assert.equal(await stale, false); assert.equal(f.calls.length, before);
});

test('清理扫描当前命名空间，事务中止时不确认写入', async () => {
  const f = fixture();
  const promise = f.writeConversationCacheRows('配对一', '旧版本', '清理版本', batch([], [], true));
  f.opens[0].onsuccess(); await tick();
  const transaction = f.transactions[0]; transaction.marker.result = { revision: '旧版本' };
  transaction.marker.onsuccess();
  assert.deepEqual(f.calls.at(-1), ['扫描索引', 'namespace', '配对一']);
  transaction.cursor.result = { delete: () => f.calls.push(['清理当前记录']), continue: () => f.calls.push(['推进游标']) };
  transaction.cursor.onsuccess(); transaction.cursor.result = null; transaction.cursor.onsuccess();
  assert.deepEqual(recorded(f.calls).slice(-3), [
    ['清理当前记录'], ['推进游标'], ['写入', 'revisions', { namespace: '配对一', revision: '清理版本' }],
  ]);
  transaction.onabort(); await assert.rejects(promise, /无法保存/);
});

test('连接被占用时释放迟到的连接，后续可以重新打开', async () => {
  const f = fixture();
  const first = f.readConversationCacheRows('配对一'), second = f.readConversationCacheRows('配对二');
  assert.equal(f.opens.length, 1);
  f.opens[0].onblocked();
  await Promise.all([assert.rejects(first, /被其他页面占用/), assert.rejects(second, /被其他页面占用/)]);
  f.opens[0].onsuccess(); assert.deepEqual(f.calls.at(-1), ['关闭连接']);
  const retry = f.readConversationCacheRows('配对一');
  assert.equal(f.opens.length, 2); f.opens[1].onsuccess(); await tick();
  f.transactions[0].entries.result = []; f.transactions[0].oncomplete();
  assert.deepEqual(JSON.parse(await retry), { revision: '', rows: [] });
});

test('已有数据库升级只变更版本，不重新创建列表表结构', async () => {
  const f = fixture();
  const reading = f.readConversationCacheRows('thread-list-v1:配对一');
  assert.deepEqual(f.calls[0], ['打开数据库', 'codex-mobile-conversation-cache', 2]);
  f.opens[0].onupgradeneeded({ oldVersion: 1 }); f.opens[0].onsuccess(); await tick();
  assert.equal(f.calls.some(call => call[0] === '建表'), false);
  f.transactions[0].entries.result = []; f.transactions[0].oncomplete();
  assert.deepEqual(JSON.parse(await reading), { revision: '', rows: [] });
});

test('升级清理只删除旧正文行，列表摘要与其他记录保留，提交后才确认完成', async () => {
  const f = fixture(); let complete = false;
  const promise = f.purgeConversationCacheBodies().then(() => { complete = true; });
  f.opens[0].onsuccess(); await tick();
  const transaction = f.transactions[0];
  assert.deepEqual(recorded(f.calls).slice(1), [['开启事务', 'rows', 'readwrite'], ['扫描全部记录', 'rows']]);
  const removed = [];
  const candidates = [
    { namespace: '配对一', key: 'h:合成聊天' },
    { namespace: '旧配对', key: 'm:合成消息' },
    { namespace: 'thread-list-v1:配对一', key: 'thread:合成聊天' },
    { namespace: 'thread-list-v1:配对二', key: 'h:保留记录' },
    { namespace: '其他命名空间', key: 'setting:保留记录' },
  ];
  for (const row of candidates) {
    transaction.fullCursor.result = { value: row, delete: () => removed.push(row), continue: () => {} };
    transaction.fullCursor.onsuccess();
  }
  transaction.fullCursor.result = null; transaction.fullCursor.onsuccess();
  assert.equal(complete, false);
  assert.deepEqual(removed, candidates.slice(0, 2));
  transaction.oncomplete(); await promise;
  assert.equal(complete, true);
});

test('旧正文清理事务失败时拒绝确认，下一次可以重新执行', async () => {
  const f = fixture();
  const first = f.purgeConversationCacheBodies();
  f.opens[0].onsuccess(); await tick();
  f.transactions[0].onabort(); await assert.rejects(first, /无法清理旧聊天正文/);
  const retry = f.purgeConversationCacheBodies(); await tick();
  f.transactions[1].oncomplete(); await retry;
});
