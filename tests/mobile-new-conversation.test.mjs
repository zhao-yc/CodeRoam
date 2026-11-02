import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

/** 执行实际 UTS 编排，模拟明确失败、未知结果、恢复连接与多次点击。 */
function fixture(storage = new Map()) {
  const calls = [], connection = { hostId: 'pc', connected: true, computers: [{ id: 'pc', online: true }], pendingCommandId: '', snapshot: { supportsImages: true, supportsAttachments: true, supportsExecutionSettings: true } };
  const json = value => Object.assign(value, { getString(key) { return this[key] ?? null; }, getNumber(key) { return this[key] ?? null; } });
  let serial = 0, created = 0, failure = '', ledger, storageFailure = false, openedSnapshot = {};
  const bridge = {
    pendingCommand() { return connection.pendingCommandId; },
    async request(method, params, write) {
      calls.push({ method, params, write });
      if (write) connection.pendingCommandId = 'command-' + ++serial;
      if (method === failure) { connection.pendingCommandId = ''; throw new Error('明确失败'); }
      if (failure === 'unknown' && method === 'turn.send') throw new Error('结果未知');
      if (failure === 'unknown-create' && method === 'thread.create') throw new Error('创建结果未知');
      if (write) connection.pendingCommandId = '';
      if (method === 'thread.create') { created++; return json({ threadId: created === 1 ? 'created-thread' : 'created-thread-' + created }); }
      return json({});
    },
    async openCreatedThread(threadId) { calls.push({ method: 'open', params: { threadId } }); connection.snapshot = { supportsImages: true, supportsAttachments: true, supportsExecutionSettings: true, threadId, status: 'idle', activeTurnId: '', messages: [], ...openedSnapshot }; },
    async checkPending() { const result = ledger; if (result.state === 'done' || result.state === 'not_found') connection.pendingCommandId = ''; return json(result); },
  };
  // 模拟真实 request 在 Promise 返回前同步登记写请求编号。
  const originalRequest = bridge.request.bind(bridge);
  bridge.request = (method, params, write) => {
    const result = originalRequest(method, params, write);
    if (write && connection.pendingCommandId.length === 0) connection.pendingCommandId = 'command-' + serial;
    return result.then(value => { if (write) connection.pendingCommandId = ''; return value; }, error => { if (!failure.startsWith('unknown')) connection.pendingCommandId = ''; throw error; });
  };
  const context = vm.createContext({ reactive: value => value, uni: { getStorageSync: key => storage.get(key) ?? '', setStorageSync: (key, value) => { if (storageFailure) throw new Error('存储不可用'); storage.set(key, value); }, removeStorageSync: key => storage.delete(key) }, connection, bridge, saveDraft() {}, saveDraftImages() {}, saveDraftFiles() {}, rememberSubmission() {}, settleSubmission() {}, readFileBase64: async () => 'YWJj', FILE_CHUNK_BYTES: 3 });
  let source = fs.readFileSync('apps/mobile/services/new-conversation.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
  source = stripTypeScriptTypes(source, { mode: 'transform' });
  vm.runInContext(source + '\nglobalThis.subject={newDraft,beginNewConversation,assignUnselectedDraft,sendNewConversation,checkNewConversation};', context);
  return { ...context.subject, storage, calls, connection, denyStorage: () => { storageFailure = true; }, fail: method => { failure = method; }, ledger: value => { ledger = value; }, openedSnapshot: value => { openedSnapshot = value; } };
}

test('同页新建草稿按电脑和项目隔离，分配首次项目不创建真实会话', () => {
  const f = fixture(); f.newDraft('pc', '').text = '先输入'; f.assignUnselectedDraft('pc', 'project');
  assert.equal(f.newDraft('pc', 'project').text, '先输入');
  assert.equal(f.newDraft('pc', '').text, ''); assert.equal(f.newDraft('other', 'project').text, ''); assert.equal(f.newDraft('pc', 'other').text, '');
  assert.equal(f.calls.length, 0);
});

test('第一次发送顺序创建并接管会话，明确失败后保留编号，重试只发送同一会话', async () => {
  const f = fixture(), draft = f.newDraft('pc', 'project'); draft.text = '第一条消息';
  f.fail('turn.send'); await assert.rejects(f.sendNewConversation(draft, () => {}), /明确失败/);
  assert.equal(draft.threadId, 'created-thread'); assert.equal(draft.text, '第一条消息');
  assert.deepEqual(f.calls.map(call => call.method), ['thread.create', 'open', 'turn.send']);
  f.fail(''); assert.equal(await f.sendNewConversation(draft, () => {}), 'created-thread');
  assert.equal(f.calls.filter(call => call.method === 'thread.create').length, 1); assert.equal(draft.text, ''); assert.equal(draft.threadId, '');
});

test('连续点击只提交一次，离线与未选择项目不触发创建', async () => {
  const f = fixture(), draft = f.newDraft('pc', 'project'); draft.text = '消息';
  const first = f.sendNewConversation(draft, () => {}); await assert.rejects(f.sendNewConversation(draft, () => {}), /正在提交/); await first;
  assert.equal(f.calls.filter(call => call.method === 'thread.create').length, 1);
  const other = f.newDraft('pc', ''); other.text = '未选项目'; await assert.rejects(f.sendNewConversation(other, () => {}), /选择项目/);
  f.connection.connected = false; draft.text = '离线输入'; await assert.rejects(f.sendNewConversation(draft, () => {}), /连接已变化/);
});

test('未知发送保留草稿和操作编号，核对成功进入原会话且不补发', async () => {
  const f = fixture(), draft = f.newDraft('pc', 'project'); draft.text = '消息';
  f.fail('unknown'); await assert.rejects(f.sendNewConversation(draft, () => {}), /结果未知/);
  assert.equal(draft.pendingAction, 'send'); assert.ok(draft.pendingCommandId); assert.equal(draft.text, '消息');
  const saved = JSON.parse([...f.storage.values()][0]); assert.equal(saved.threadId, 'created-thread'); assert.equal(saved.text, undefined);
  const count = f.calls.length; await assert.rejects(f.sendNewConversation(draft, () => {}), /核对上次操作/); assert.equal(f.calls.length, count);
  f.ledger({ state: 'done', result: {} }); assert.equal(await f.checkNewConversation(draft), 'created-thread'); assert.equal(f.calls.length, count); assert.equal(draft.text, '');
});

test('创建结果未知时恢复账本中的编号，核对不会自动发送或重复创建', async () => {
  const f = fixture(), draft = f.newDraft('pc', 'project'); draft.text = '首条消息';
  f.fail('unknown-create'); await assert.rejects(f.sendNewConversation(draft, () => {}), /创建结果未知/);
  f.ledger({ state: 'done', result: { getString: key => key === 'threadId' ? 'created-thread' : '' } });
  assert.equal(await f.checkNewConversation(draft), ''); assert.equal(draft.threadId, 'created-thread'); assert.equal(f.calls.length, 1);
  f.fail(''); await f.sendNewConversation(draft, () => {}); assert.equal(f.calls.filter(call => call.method === 'thread.create').length, 1);
});

test('设备不能保存核对编号时，在任何创建请求之前停止，草稿保持可编辑', async () => {
  const f = fixture(), draft = f.newDraft('pc', 'project'); draft.text = '首条消息'; f.denyStorage();
  await assert.rejects(f.sendNewConversation(draft, () => {}), /无法保存新对话状态/);
  assert.equal(f.calls.length, 0); assert.equal(draft.text, '首条消息');
});

test('返回后重新打开新建页时保留输入并新建不同会话，附件重新上传且设置重新应用', async () => {
  const f = fixture(), draft = f.newDraft('pc', 'project');
  draft.text = '未发送的文字'; draft.images.push({ id: 'image', src: 'data:image/png;base64,AA==' });
  draft.files.push({ id: 'file', name: '说明.txt', size: 3, source: '/file', data: 'YWJj', status: 'local', progress: 0, error: '' });
  draft.settings = { model: 'model', effort: 'high', serviceTier: '', mode: 'default' }; draft.settingsChanged = true;
  f.fail('turn.send'); await assert.rejects(f.sendNewConversation(draft, () => {}), /明确失败/);
  assert.equal(draft.files[0].status, 'ready'); assert.equal(draft.settingsApplied, true);
  f.beginNewConversation();
  assert.equal(draft.threadId, ''); assert.equal(draft.text, '未发送的文字'); assert.equal(draft.images.length, 1);
  assert.equal(draft.settings.effort, 'high'); assert.equal(draft.settingsApplied, false); assert.equal(draft.files[0].status, 'local');
  f.fail(''); assert.equal(await f.sendNewConversation(draft, () => {}), 'created-thread-2');
  assert.deepEqual(f.calls.filter(call => call.method === 'turn.send').map(call => call.params.threadId), ['created-thread', 'created-thread-2']);
  assert.equal(f.calls.filter(call => call.method === 'attachment.begin').length, 2);
  assert.equal(f.calls.filter(call => call.method === 'thread.settings.update').length, 2);
});

test('刷新页面不恢复普通创建编号，也不影响当前流程内的空会话重试', async () => {
  const storage = new Map([['codex-mobile-new-pc-project', JSON.stringify({ threadId: 'previous-thread', pendingAction: '', pendingCommandId: '' })]]);
  const f = fixture(storage), draft = f.newDraft('pc', 'project'); draft.text = '真正的新对话';
  assert.equal(draft.threadId, '');
  await f.sendNewConversation(draft, () => {});
  assert.equal(f.calls.filter(call => call.method === 'thread.create').length, 1);
  assert.equal(f.calls.find(call => call.method === 'turn.send').params.threadId, 'created-thread');
});

test('重新打开和刷新仍保留未知发送的核对编号，核对成功不重复发送', async () => {
  const first = fixture(), draft = first.newDraft('pc', 'project'); draft.text = '待确认消息';
  first.fail('unknown'); await assert.rejects(first.sendNewConversation(draft, () => {}), /结果未知/);
  const command = draft.pendingCommandId;
  first.beginNewConversation(); assert.equal(draft.threadId, 'created-thread'); assert.equal(draft.pendingCommandId, command);
  const reloaded = fixture(first.storage), recovered = reloaded.newDraft('pc', 'project');
  reloaded.connection.pendingCommandId = command; reloaded.beginNewConversation();
  assert.equal(recovered.threadId, 'created-thread');
  recovered.text = '再次点击'; await assert.rejects(reloaded.sendNewConversation(recovered, () => {}), /核对上次操作/);
  reloaded.ledger({ state: 'done', result: {} }); assert.equal(await reloaded.checkNewConversation(recovered), 'created-thread');
  assert.equal(reloaded.calls.length, 0); assert.equal(recovered.threadId, '');
});

test('当前流程创建的空会话若已被电脑端使用，重试解除旧目标而不发送或修改其设置', async () => {
  for (const occupied of [{ messages: [{ role: 'user', text: '电脑端消息' }] }, { status: 'active', activeTurnId: 'running-turn' }]) {
    const f = fixture(), draft = f.newDraft('pc', 'project'); draft.text = '手机新消息';
    f.fail('turn.send'); await assert.rejects(f.sendNewConversation(draft, () => {}), /明确失败/);
    const count = f.calls.length;
    f.fail(''); f.openedSnapshot(occupied);
    await assert.rejects(f.sendNewConversation(draft, () => {}), /原会话已被使用/);
    assert.deepEqual(f.calls.slice(count).map(call => call.method), ['open']);
    assert.equal(draft.threadId, ''); assert.equal(draft.text, '手机新消息');
    f.openedSnapshot({}); assert.equal(await f.sendNewConversation(draft, () => {}), 'created-thread-2');
  }
});

test('新建组件每次打开都在读取草稿前开始独立创建流程', () => {
  const source = fs.readFileSync('apps/mobile/components/new-conversation/new-conversation.uvue', 'utf8');
  assert.ok(source.indexOf('beginNewConversation()') < source.indexOf('const draft = computed('));
});
