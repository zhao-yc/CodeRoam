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
      const marker = {}, entries = {}, cursor = {};
      const transaction = {
        marker, entries, cursor,
        objectStore: name => ({
          get: key => { calls.push(['读取版本', key]); return marker; },
          put: value => { calls.push(['写入', name, value]); },
          delete: key => { calls.push(['删除', name, key]); },
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
  const context = vm.createContext({ window: { indexedDB } });
  vm.runInContext(source + ';globalThis.subject={readConversationCacheRows,writeConversationCacheRows};', context);
  return { db, calls, opens, transactions, ...context.subject };
}

const recorded = calls => JSON.parse(JSON.stringify(calls));

test('按命名空间在一个只读事务内恢复行和版本，提交前不返回结果', async () => {
  const f = fixture(); let complete = false;
  const promise = f.readConversationCacheRows('配对一').then(value => { complete = true; return value; });
  f.opens[0].onupgradeneeded(); f.opens[0].onsuccess(); await tick();
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
