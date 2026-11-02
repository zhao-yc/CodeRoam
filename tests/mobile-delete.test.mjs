import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

/** 执行实际页面删除方法，验证确认顺序及回执归属，不连接真实电脑。 */
function fixture() {
  const source = fs.readFileSync('apps/mobile/pages/conversation/index.uvue', 'utf8');
  const methods = source.slice(source.indexOf('// 永久删除必须完成两次独立确认'), source.indexOf('// 归档只在原生回执'));
  const ref = value => ({ value }), modals = [], calls = [], cleared = [], removed = [], drafts = [], notices = [], life = {};
  let resolve, reject;
  const json = data => ({ ...data, getBoolean: key => data[key], getString: key => data[key] });
  const c = { ref, pageHostId: ref('pc'), pageThreadId: ref('root'), pageVisible: ref(true), displayTitle: ref('合成对话'), busy: ref(false), pendingAction: ref(''), operationError: ref(''), historyPage: ref({ messages: ['合成历史'] }), historyError: ref(''), historyRequest: 0, archivePromptOpen: false, connection: { connected: true, hostId: 'pc', activeThreadId: 'root', pendingCommands: [], snapshot: { threadId: 'root' }, epoch: 'e', sequence: 1 }, computed: fn => ({ get value() { return fn(); } }), watch: (_read, fn) => { life.change = fn; }, onHide: fn => { life.hide = fn; }, onUnload: fn => { life.unload = fn; }, closeActions() {}, isCurrentPage: () => c.connection.hostId === c.pageHostId.value && c.connection.activeThreadId === c.pageThreadId.value, getCurrentPages: () => [{}, {}], notify: message => notices.push(message), removeDeletedThreads: (host, ids) => removed.push([host, ids]), clearDeletedDrafts: (host, ids) => drafts.push([host, ids]), queueDeleteSuccessNotice: () => notices.push('交接成功提示'), consumeDeleteSuccessNotice() {}, returned: 0 };
  c.canWrite = { get value() { return !c.busy.value && c.connection.connected && c.connection.pendingCommands.length === 0; } };
  c.uni = { showModal: options => modals.push(options), showLoading() {}, hideLoading() {}, hideKeyboard() {}, navigateBack: () => { c.returned++; }, reLaunch: () => { c.returned++; } };
  c.bridge = { request(method, params, write) { calls.push({ method, params, write }); return new Promise((ok, fail) => { resolve = value => ok(json(value)); reject = fail; }); }, clearCommand: (...args) => cleared.push(args) };
  Object.assign(c, {clearConversationCache(){},pageCacheNamespace:{value:'synthetic-pair'},cachedDetail:{value:null},cacheDirty:false,cacheWriteTimer:0,clearTimeout(){}});
  vm.runInNewContext(stripTypeScriptTypes(methods, { mode: 'transform' }) + '\nglobalThis.subject={deleteFromMenu,acceptDeleteReceipt,checkDeleteOutcome,answerDeleteFinal,deleteFinalVisible,deleteFinalContent};', c);
  return { c, ...c.subject, modals, calls, cleared, removed, drafts, notices, life, resolve: value => resolve(value), reject: error => reject(error) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('删除按钮在归档下方，第二次确认前不发送写请求', async () => {
  const source = fs.readFileSync('apps/mobile/pages/conversation/index.uvue', 'utf8'); assert.ok(source.indexOf('@click="archiveFromMenu"') < source.indexOf('@click="deleteFromMenu"'));
  const f = fixture(); f.deleteFromMenu(); f.deleteFromMenu(); assert.equal(f.modals.length, 1); assert.equal(f.modals[0].title, '永久删除聊天'); assert.equal(f.calls.length, 0);
  f.modals[0].success({ confirm: true }); assert.equal(f.modals.length, 1); assert.equal(f.deleteFinalVisible.value, true); assert.equal(f.deleteFinalContent.value, '正在执行的任务会先停止。确认永久删除吗？'); assert.equal(f.calls.length, 0);
  f.answerDeleteFinal(true); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'thread.delete'); assert.equal(f.calls[0].write, true); assert.equal(f.removed.length, 0); assert.equal(f.drafts.length, 0);
  f.resolve({ threadId: 'root', deleted: true, deletedThreadIds: ['root', 'child'] }); await flush();
  assert.equal(f.c.returned, 1); assert.equal(f.removed[0][0], 'pc'); assert.deepEqual(Array.from(f.removed[0][1]), ['root', 'child']); assert.equal(f.c.historyPage.value, null); assert.equal(f.c.connection.snapshot, null);
});

test('取消任一次确认均不停止任务、不删除或清理草稿', () => {
  for (const stage of [0, 1]) { const f = fixture(); f.deleteFromMenu(); if (stage) f.modals[0].success({ confirm: true }); if (stage == 0) f.modals[0].success({ confirm: false }); else f.answerDeleteFinal(false); assert.equal(f.calls.length, 0); assert.equal(f.drafts.length, 0); assert.equal(f.c.returned, 0); }
});

test('切换电脑、会话或隐藏页面后旧确认失效', () => {
  for (const change of [f => { f.c.connection.hostId = 'other'; }, f => { f.c.pageThreadId.value = 'other'; }, f => f.life.hide()]) { const f = fixture(); f.deleteFromMenu(); f.modals[0].success({ confirm: true }); change(f); f.answerDeleteFinal(true); assert.equal(f.calls.length, 0); }
});

test('失败保留历史与草稿，迟到成功不导航其他页面或清理其他电脑', async () => {
  const failed = fixture(); failed.deleteFromMenu(); failed.modals[0].success({ confirm: true }); failed.answerDeleteFinal(true); failed.reject(new Error('结果待核对')); await flush(); assert.equal(failed.removed.length, 0); assert.equal(failed.drafts.length, 0); assert.notEqual(failed.c.historyPage.value, null);
  const late = fixture(); late.deleteFromMenu(); late.modals[0].success({ confirm: true }); late.answerDeleteFinal(true); late.c.connection.hostId = 'other'; late.c.connection.activeThreadId = 'other'; late.c.pageThreadId.value = 'other';
  late.resolve({ threadId: 'root', deleted: true, deletedThreadIds: ['root'] }); await flush(); assert.equal(late.c.returned, 0); assert.equal(late.c.connection.activeThreadId, 'other'); assert.equal(late.drafts[0][0], 'pc');
});

test('未知结果只核对原命令，成功后不重发删除', async () => {
  const f = fixture(); f.c.connection.pendingCommands = [{ id: 'original-command', hostId: 'pc', threadId: 'root', method: 'thread.delete' }];
  f.checkDeleteOutcome(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'command.status');
  f.resolve({ state: 'done', result: { threadId: 'root', deleted: true, deletedThreadIds: ['root'], getBoolean: key => key === 'deleted', getString: key => key === 'threadId' ? 'root' : null } }); await flush(); assert.equal(f.c.returned, 1); assert.deepEqual(f.cleared[0], ['original-command', 'pc']);
});
