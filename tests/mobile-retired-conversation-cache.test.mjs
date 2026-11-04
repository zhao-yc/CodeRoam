import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const source = name => fs.readFileSync(new URL(`../apps/mobile/services/${name}.uts`, import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace(/^export /gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));

/** 直接执行升级清理服务，模拟存储失败和仍在提交的数据库事务。 */
function fixture() {
  const purges = [], removed = [];
  const context = vm.createContext({
    purgeConversationCacheBodies: () => new Promise((resolve, reject) => purges.push({ resolve, reject })),
    uni: { removeStorageSync: key => removed.push(key) },
  });
  vm.runInContext(stripTypeScriptTypes(source('retired-conversation-cache'), { mode: 'transform' }) + ';globalThis.retire=retireConversationCacheBodies;', context);
  return { purges, removed, retire: context.retire };
}

test('启动与前台并行清理共用事务，成功提交后只移除旧正文 Storage', async () => {
  const f = fixture();
  const first = f.retire(), second = f.retire();
  assert.equal(first, second); assert.equal(f.purges.length, 1);
  assert.deepEqual(f.removed, []);
  f.purges[0].resolve(); await first;
  assert.deepEqual(f.removed, ['codex-mobile-conversation-cache-v1']);
  await f.retire(); assert.equal(f.purges.length, 1);
});

test('清理失败保留旧 Storage，后续前台可重试且失败不向在线流程抛出', async () => {
  const f = fixture();
  const first = f.retire(); f.purges[0].reject(new Error('模拟数据库被占用'));
  await first; assert.deepEqual(f.removed, []);
  const retry = f.retire(); assert.equal(f.purges.length, 2);
  f.purges[1].resolve(); await retry;
  assert.deepEqual(f.removed, ['codex-mobile-conversation-cache-v1']);
});

test('文件差异清理继续覆盖更换配对与明确撤权，普通离线保留内容', async () => {
  const calls = [], watchers = [];
  const connection = { connected: false, cacheNamespace: '配对一', computers: [] };
  const context = vm.createContext({
    connection,
    clearFileReportCache: namespace => calls.push(['清理', namespace]),
    retainFileReportCacheHosts: (namespace, hosts) => calls.push(['核对授权', namespace, Array.from(hosts)]),
    watch: (read, callback) => watchers.push({ read, callback }),
  });
  vm.runInContext(stripTypeScriptTypes(source('conversation-cache-lifecycle'), { mode: 'transform' }) + ';startConversationCacheLifecycle();startConversationCacheLifecycle();', context);
  assert.equal(watchers.length, 2);
  watchers[1].callback(); assert.deepEqual(calls, []);
  connection.connected = true; connection.computers = [{ id: '离线电脑', online: false }];
  watchers[1].callback();
  assert.deepEqual(calls, [['核对授权', '配对一', ['离线电脑']]]);
  connection.computers = []; watchers[1].callback();
  assert.deepEqual(calls.at(-1), ['核对授权', '配对一', []]);
  watchers[0].callback('配对二', '配对一');
  assert.deepEqual(calls.at(-1), ['清理', '配对一']);
  await tick();
});

test('Android 与 iOS 的实际清理 SQL 只移除旧正文，保留列表与其他记录', () => {
  const base = new URL('../apps/mobile/uni_modules/codex-conversation-db/utssdk/', import.meta.url);
  const kotlin = fs.readFileSync(new URL('app-android/CodexConversationSQLite.kt', base), 'utf8');
  const swift = fs.readFileSync(new URL('app-ios/CodexConversationSQLite.swift', base), 'utf8');
  const nativeWhere = kotlin.match(/db\.delete\("cache_rows", "([^"]+)", arrayOf\(([^)]+)\)\)/);
  const iosDelete = swift.match(/try execute\(db, "(DELETE FROM cache_rows[^"]+)"\)/);
  assert.ok(nativeWhere); assert.ok(iosDelete);
  const bindings = Array.from(nativeWhere[2].matchAll(/"([^"]+)"/g), match => match[1]);
  const records = [
    ['配对一', 'h:聊天', '合成索引'], ['旧配对', 'm:消息', '合成正文'],
    ['thread-list-v1:配对一', 'thread:聊天', '合成列表'],
    ['thread-list-v1:配对二', 'h:保留', '合成其他列表记录'],
    ['其他命名空间', 'setting:保留', '合成配置'],
  ];
  for (const [statement, arguments_] of [[`DELETE FROM cache_rows WHERE ${nativeWhere[1]}`, bindings], [iosDelete[1], []]]) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE cache_rows(namespace TEXT, row_key TEXT, value TEXT)');
      const insert = db.prepare('INSERT INTO cache_rows VALUES (?, ?, ?)');
      for (const row of records) insert.run(...row);
      db.prepare(statement).run(...arguments_);
      assert.deepEqual(db.prepare('SELECT namespace,row_key,value FROM cache_rows ORDER BY rowid').all().map(row => [row.namespace, row.row_key, row.value]), records.slice(2));
    } finally { db.close(); }
  }
});
