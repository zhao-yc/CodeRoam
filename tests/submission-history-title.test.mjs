import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

// 直接运行页面的标题读取逻辑，核对分页、实例隔离和刷新后的迟到回执。
const page = fs.readFileSync('apps/mobile/pages/task-history/index.uvue', 'utf8');
const source = page.slice(page.indexOf('function chatTitle('), page.indexOf('function stageDetail(')).replace(/JSON.parse<ThreadSummary\[\]>/g, 'JSON.parse');
function fixture(read) {
  const context = vm.createContext({ chatTitles: { value: [] }, rows: { value: [] }, request: 1, connection: { cacheNamespace: '合成配对' }, bridge: { readComputerMenu: read } });
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.subject = { chatTitle, loadChatTitles };', context);
  return context;
}
const response = (threads, archived = false) => ({ threads, getBoolean: () => archived });
const row = (hostId, threadId) => ({ hostId, task: { threadId, kind: 'command', title: '发送消息' } });

test('执行记录按原电脑读取分页和归档标题，同编号聊天不会串实例', async () => {
  const calls = [];
  const context = fixture(async (hostId, params) => {
    calls.push([hostId, params.archived, params.offset]);
    if (hostId === '电脑乙') return response([{ id: 'same', title: '乙的聊天' }]);
    if (params.archived) return response([{ id: 'archive', title: '已归档聊天' }], true);
    if (params.offset === 0) return response(Array.from({ length: 100 }, (_, i) => ({ id: 'filler-' + i, title: '合成聊天' })));
    return response([{ id: 'same', title: '甲的聊天' }]);
  });
  context.rows.value = [row('电脑甲', 'same'), row('电脑甲', 'archive'), row('电脑乙', 'same')];
  await context.subject.loadChatTitles('电脑甲', 1, '合成配对');
  await context.subject.loadChatTitles('电脑乙', 1, '合成配对');
  assert.equal(context.subject.chatTitle('电脑甲', context.rows.value[0].task), '甲的聊天');
  assert.equal(context.subject.chatTitle('电脑乙', context.rows.value[2].task), '乙的聊天');
  assert.equal(context.subject.chatTitle('电脑甲', context.rows.value[1].task), '已归档聊天');
  assert.deepEqual(calls, [['电脑甲', false, 0], ['电脑甲', false, 100], ['电脑甲', true, 0], ['电脑乙', false, 0]]);
});

test('刷新或配对变化后不接纳迟到标题', async () => {
  for (const change of ['request', 'namespace']) {
    let resolve;
    const context = fixture(() => new Promise(done => { resolve = done; }));
    context.rows.value = [row('电脑甲', 'same')];
    const pending = context.subject.loadChatTitles('电脑甲', 1, '合成配对');
    if (change === 'request') context.request++;
    else context.connection.cacheNamespace = '其他配对';
    resolve(response([{ id: 'same', title: '旧聊天' }]));
    await pending;
    assert.equal(context.chatTitles.value.length, 0);
  }
});

test('旧服务忽略归档参数及读取失败时保留明确的标题回退', async () => {
  const context = fixture(async (_, params) => params.archived ? response([{ id: 'same', title: '错误的归档结果' }]) : response([]));
  context.rows.value = [row('电脑甲', 'same')];
  await context.subject.loadChatTitles('电脑甲', 1, '合成配对');
  assert.equal(context.subject.chatTitle('电脑甲', context.rows.value[0].task), '标题暂不可用');
  context.bridge.readComputerMenu = async () => { throw new Error('合成离线'); };
  await context.subject.loadChatTitles('电脑甲', 1, '合成配对');
  assert.equal(context.subject.chatTitle('电脑甲', { kind: 'newConversation', threadId: 'new', title: '新聊天标题' }), '新聊天标题');
});
