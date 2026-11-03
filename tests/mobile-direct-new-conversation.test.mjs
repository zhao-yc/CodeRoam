import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { Journal } from '../apps/bridge/journal.mjs';
import { BridgeError } from '../packages/protocol/contracts.mjs';

const source = stripTypeScriptTypes(['thread-mentions', 'direct-new-conversation'].map(name => fs.readFileSync('apps/mobile/services/' + name + '.uts', 'utf8')).join('\n')
  .replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, ''), { mode: 'transform' });
const cwd = '/example/project';
const threadId = '00000000-0000-4000-8000-000000000001';
const text = '合成手机正文';
const plain = value => JSON.parse(JSON.stringify(value));

/** 在模拟传输里保留真实协议形状及 UTSJSONObject 读取行为。 */
function json(value) {
  if (value == null || typeof value !== 'object') return value;
  Object.values(value).forEach(json);
  for (const suffix of ['String', 'Boolean', 'Number']) Object.defineProperty(value, 'get' + suffix, { value(key) { return this[key] ?? null; } });
  return value;
}

/** 使用实际写操作账本，只替换桌面和本机存储，测试不会连接或发送真实消息。 */
function fixture(t) {
  const journal = new Journal(), storage = new Map(), calls = [], desktop = { mode: 'default', revision: 'permissions-a', used: false, settings: { model: 'model-a', effort: 'medium', serviceTier: '', mode: 'default' }, hooks: new Map() };
  t.after(() => journal.close());
  const make = () => {
    const connection = { connected: true, hostId: 'pc-a', cacheNamespace: 'pair-a', configurationRevision: 1, computers: [{ id: 'pc-a', online: true, instanceGeneration: 'gen-a' }], activeThreadId: '', snapshot: null };
    const bridge = {
      pendingCommand: () => '', clearCommand: () => {},
      async openCreatedThread(id) {
        calls.push({ method: '接管', hostId: connection.hostId, params: { threadId: id } });
        connection.activeThreadId = id;
        connection.snapshot = { threadId: id, cwd, activeTurnId: '', status: 'idle', messages: desktop.used ? [{ role: 'user' }] : [], turns: [] };
      },
      async request(method, params) {
        calls.push({ method, params: plain(params) });
        if (method === 'projects.list') return json({ newConversationMode: 'desktopIpc', supportsNewChatMentions: desktop.supportsNewChatMentions, projects: [{ id: 'project-a', cwd }] });
        if (method === 'thread.history') return json({ snapshot: { threadId, cwd } });
        if (method === 'thread.settings.read') return json({ settings: { ...desktop.settings }, models: [{ id: desktop.settings.model, supportsImages: true }] });
        if (method === 'thread.permissions.read') return json({ mode: desktop.mode, revision: desktop.revision });
        if (method === 'attachment.begin') return json({ complete: false, nextChunk: 0 });
        if (method === 'attachment.chunk') return json({ received: 3, nextChunk: params.index + 1 });
        if (method === 'attachment.finish') return json({ complete: true });
        throw new Error('意外读取 ' + method);
      },
      async readCommandStatus(hostId, commandId) {
        calls.push({ method: 'command.status', params: { hostId, commandId } });
        return json(plain(journal.status('phone', commandId)));
      },
      async submitDirectNewConversationStep(method, params, commandId, expectedGeneration, firstMessageGuard) {
        const checkpoint = JSON.parse([...storage.values()].find(value => value.includes(commandId)) ?? '{}');
        assert.equal(checkpoint.pendingCommandId, commandId, '写请求必须先保存原命令编号');
        calls.push({ method, params: plain(params), commandId, expectedGeneration, firstMessageGuard: plain(firstMessageGuard) });
        const result = await journal.execute('phone', commandId, method, params, async () => {
          if (desktop.hooks.has(method)) return desktop.hooks.get(method)(commandId, params);
          if (method === 'thread.create') return { threadId };
          if (method === 'thread.settings.update') { Object.assign(desktop.settings, params.changes); return { ok: true, commandId }; }
          if (method === 'thread.permissions.update') { desktop.mode = params.mode; desktop.revision = 'permissions-b'; return { ok: true, commandId }; }
          if (method === 'turn.send') return { ok: true, commandId };
          throw new Error('意外写入 ' + method);
        });
        if (desktop.loseResponse === method) throw new Error('合成响应丢失');
        return json(result);
      },
    };
    const uni = { getStorageSync: key => storage.get(key) ?? '', setStorageSync: (key, value) => {
      if (desktop.storageUnavailable) throw new Error('合成本地存储失败');
      storage.set(key, value);
    } };
    const context = vm.createContext({ connection, bridge, uni, reactive: value => value, FILE_CHUNK_BYTES: 3, readFileBase64: async () => 'YWJj' });
    vm.runInContext(source + '\nglobalThis.subject={sendDirectNewConversation,checkDirectNewConversation,directNewConversationState,acknowledgeDirectNewConversation};', context);
    const draft = { hostId: connection.hostId, cacheNamespace: connection.cacheNamespace, projectId: 'project-a', text, images: [], files: [], plugins: [], threadMentions: [], threadMentionRevision: 0, choices: {} };
    const subject = context.subject;
    return { ...subject, connection, draft, state: subject.directNewConversationState(draft), send: () => subject.sendDirectNewConversation(draft, () => {}), check: () => subject.checkDirectNewConversation(draft) };
  };
  return { ...make(), make, journal, storage, desktop, calls };
}

test('单开旧路径按原桌面设置、权限、附件与插件发送一次', async t => {
  const f = fixture(t);
  f.draft.choices = { model: 'model-b', effort: 'high', serviceTier: 'priority', mode: 'plan', permissionMode: 'read-only' };
  f.draft.images = [{ id: 'image', src: 'data:image/png;base64,AA==' }];
  f.draft.files = [{ id: 'file-upload-example', source: '合成文件', name: 'example.txt', size: 3, data: '' }];
  f.draft.plugins = [{ id: 'docs@example' }];
  assert.equal(await f.send(), threadId);
  const writes = f.calls.filter(call => call.commandId);
  assert.deepEqual(writes.map(call => call.method), ['thread.create', 'thread.settings.update', 'thread.permissions.update', 'turn.send']);
  assert.equal(writes.every(call => call.expectedGeneration === 'gen-a'), true);
  assert.equal(writes.slice(0, -1).every(call => call.firstMessageGuard === null), true);
  assert.deepEqual(writes.at(-1).firstMessageGuard, { permissionRevision: 'permissions-b', confirmedFullAccess: false });
  assert.equal(f.calls.filter(call => call.method.startsWith('attachment.')).every(call => call.params.threadId === threadId && !('draftId' in call.params)), true);
  assert.deepEqual(f.calls.at(-1).params, { threadId, text, images: ['data:image/png;base64,AA=='], attachments: ['file-upload-example'], pluginIds: ['docs@example'] });
  assert.equal(f.draft.text, '');
  assert.equal([...f.storage.values()].some(value => value.includes(text) || value.includes('docs@example')), false);
  const restored = f.make();
  assert.equal(await restored.check(), threadId);
  assert.equal(restored.draft.text, text, '刷新后已恢复的结果不消费新的本地输入');
  restored.acknowledgeDirectNewConversation(restored.draft, threadId);
  assert.equal(f.make().state.threadId, '');
  assert.equal(f.calls.filter(call => call.method === 'turn.send').length, 1);
});

test('未知创建刷新后保留原命令，只有原检查点和项目索引共同确认才允许接管', async t => {
  const f = fixture(t);
  f.desktop.hooks.set('thread.create', id => {
    f.journal.checkpoint('phone', id, { threadId });
    throw new BridgeError('OUTCOME_UNKNOWN', '合成创建超时', true);
  });
  await assert.rejects(f.send(), /核对/);
  const original = f.state.pendingCommandId;
  const restored = f.make();
  assert.equal(restored.state.pendingCommandId, original);
  await assert.rejects(restored.send(), /核对/);
  assert.equal(await restored.check(), '');
  assert.equal(restored.state.threadId, threadId);
  assert.equal(f.calls.some(call => call.method === '接管' || call.method === 'turn.send'), false);
  assert.equal(await restored.send(), threadId);
  assert.equal(f.calls.filter(call => call.method === 'thread.create').length, 1);
});

test('明确失败只解除对应发送命令，重试继续使用已经创建的空会话', async t => {
  const f = fixture(t);
  f.desktop.hooks.set('turn.send', () => { throw new BridgeError('TURN_REJECTED', '合成拒绝'); });
  await assert.rejects(f.send(), /合成拒绝/);
  assert.equal(f.state.outcomeUnknown, false);
  assert.equal(f.state.threadId, threadId);
  assert.equal(f.draft.text, text);
  f.desktop.hooks.delete('turn.send');
  assert.equal(await f.send(), threadId);
  assert.equal(f.calls.filter(call => call.method === 'thread.create').length, 1);
  assert.equal(new Set(f.calls.filter(call => call.method === 'turn.send').map(call => call.commandId)).size, 2);
});

test('未知发送只查原命令，未确认期间禁止重发并隔离配对与项目', async t => {
  const f = fixture(t);
  f.desktop.hooks.set('turn.send', () => { throw new BridgeError('OUTCOME_UNKNOWN', '合成发送超时', true); });
  await assert.rejects(f.send(), /核对/);
  const restored = f.make(), commandId = f.state.pendingCommandId;
  assert.equal(restored.state.pendingCommandId, commandId);
  assert.equal(restored.state.threadId, threadId);
  await assert.rejects(restored.check(), /尚未确认/);
  await assert.rejects(restored.send(), /核对/);
  assert.equal(restored.directNewConversationState({ ...restored.draft, projectId: 'project-b' }).outcomeUnknown, false);
  assert.equal(restored.directNewConversationState({ ...restored.draft, cacheNamespace: 'pair-b' }).outcomeUnknown, false);
  assert.equal(f.calls.filter(call => call.method === 'turn.send').length, 1);
  assert.equal(f.calls.filter(call => call.method === 'command.status').every(call => call.params.commandId === commandId), true);
});

test('发送成功回执丢失时，原账本确认完成而不补发', async t => {
  const f = fixture(t);
  f.desktop.loseResponse = 'turn.send';
  assert.equal(await f.send(), threadId);
  assert.equal(f.state.completedThreadId, threadId);
  assert.equal(f.calls.filter(call => call.method === 'turn.send').length, 1);
});

test('收到成功回执后本地保存失败，刷新后只核对原账本并恢复已发送会话', async t => {
  const f = fixture(t);
  f.desktop.hooks.set('turn.send', commandId => {
    f.desktop.storageUnavailable = true;
    return { ok: true, commandId };
  });
  await assert.rejects(f.send(), /本地存储失败/);
  assert.equal(f.draft.text, text);
  assert.equal(f.state.outcomeUnknown, true);
  const commandId = f.state.pendingCommandId;
  assert.equal(f.journal.status('phone', commandId).state, 'done');
  f.desktop.storageUnavailable = false;
  const restored = f.make(), before = f.calls.length;
  assert.equal(restored.state.pendingCommandId, commandId);
  await assert.rejects(restored.send(), /核对/);
  assert.equal(await restored.check(), threadId);
  assert.deepEqual(f.calls.slice(before), [{ method: 'command.status', params: { hostId: 'pc-a', commandId } }]);
  assert.equal(restored.state.completedThreadId, threadId);
  assert.equal(f.calls.filter(call => call.method === 'turn.send').length, 1);
});

test('发送期间切换电脑，迟到成功只结算原草稿，不能给新电脑返回导航编号', async t => {
  const f = fixture(t);
  let dispatched, respond;
  const started = new Promise(resolve => { dispatched = resolve; });
  f.desktop.hooks.set('turn.send', commandId => new Promise(resolve => {
    respond = () => resolve({ ok: true, commandId });
    dispatched();
  }));
  const sending = f.send();
  const rejected = assert.rejects(sending, /所选电脑连接已变化/);
  await started;
  f.connection.computers.push({ id: 'pc-b', online: true, instanceGeneration: 'gen-b' });
  f.connection.hostId = 'pc-b';
  const newThreadId = '00000000-0000-4000-8000-000000000002';
  const newSnapshot = { threadId: newThreadId };
  f.connection.activeThreadId = newThreadId;
  f.connection.snapshot = newSnapshot;
  respond();
  await rejected;
  assert.equal(f.state.completedThreadId, threadId);
  assert.equal(f.draft.text, '');
  assert.equal(f.connection.activeThreadId, newThreadId);
  assert.equal(f.connection.snapshot, newSnapshot);
  assert.equal(f.directNewConversationState({ ...f.draft, hostId: 'pc-b' }).completedThreadId, '');
  assert.deepEqual(f.calls.filter(call => call.method === '接管').map(call => call.hostId), ['pc-a']);
});

test('跟随桌面也须显式确认完整访问，已有聊天引用时原样保留', async t => {
  const f = fixture(t);
  f.desktop.mode = 'full-access';
  f.draft.threadMentions = [{ id: 'reference', title: '合成引用' }];
  await assert.rejects(f.send(), /输入和引用已保留/);
  assert.deepEqual(f.calls.map(call => call.method), ['projects.list']);
  assert.equal(f.draft.threadMentions[0].id, 'reference');
  f.draft.threadMentions = [];
  await assert.rejects(f.send(), /完整访问/);
  assert.equal(f.calls.some(call => call.method === 'turn.send'), false);
  f.draft.choices = { permissionMode: 'full-access', confirmedFullAccess: true };
  assert.equal(await f.send(), threadId);
  assert.equal(f.calls.filter(call => call.method === 'thread.create').length, 1);
  assert.deepEqual(f.calls.find(call => call.method === 'turn.send').firstMessageGuard, { permissionRevision: 'permissions-a', confirmedFullAccess: true });
});

test('直连首条只发送去重后的引用编号，已确认后消费该批引用', async t => {
  const f = fixture(t);
  f.desktop.supportsNewChatMentions = true;
  f.draft.threadMentions = [{ id: 'reference-a', title: '合成引用' }, { id: 'reference-a', title: '合成重复' }];
  f.draft.threadMentionRevision = 2;
  assert.equal(await f.send(), threadId);
  assert.deepEqual(f.calls.find(call => call.method === 'turn.send').params.threadMentionIds, ['reference-a']);
  assert.equal(f.draft.threadMentions.length, 0);
  assert.equal(f.draft.threadMentionRevision, 3);
  assert.equal([...f.storage.values()].some(value => value.includes('reference-a') || value.includes('合成引用')), false);
});

test('旧回执保留重新选择的同一引用，未知发送与查账期间也不清除原引用', async t => {
  const f = fixture(t), chosen = { id: 'reference-a', title: '合成引用' };
  f.desktop.supportsNewChatMentions = true;
  f.draft.threadMentions = [chosen]; f.draft.threadMentionRevision++;
  f.desktop.hooks.set('turn.send', commandId => {
    f.draft.threadMentions = [{ ...chosen, title: '重新选择的引用' }];
    f.draft.threadMentionRevision++;
    return { ok: true, commandId };
  });
  assert.equal(await f.send(), threadId);
  assert.equal(f.draft.threadMentions[0].title, '重新选择的引用');
  f.acknowledgeDirectNewConversation(f.draft, threadId);
  f.draft.text = '待核对的合成正文';
  f.desktop.hooks.set('turn.send', () => { throw new BridgeError('OUTCOME_UNKNOWN', '合成发送超时', true); });
  await assert.rejects(f.send(), /核对/);
  await assert.rejects(f.check(), /尚未确认/);
  assert.equal(f.draft.threadMentions[0].title, '重新选择的引用');
  assert.equal(f.calls.filter(call => call.method === 'turn.send').length, 2);
});

test('重复点击只进入一次创建，本地检查点写失败时不会发出写请求', async t => {
  const f = fixture(t);
  f.desktop.storageUnavailable = true;
  await assert.rejects(f.send(), /本地存储失败/);
  assert.equal(f.calls.filter(call => call.commandId).length, 0);
  f.desktop.storageUnavailable = false;
  let created;
  f.desktop.hooks.set('thread.create', () => new Promise(resolve => { created = resolve; }));
  const sending = f.send();
  await assert.rejects(f.send(), /重复发送/);
  created({ threadId });
  assert.equal(await sending, threadId);
  assert.equal(f.calls.filter(call => call.method === 'thread.create').length, 1);
});

test('原会话已被桌面使用时保留草稿，不向已有轮次追加，也不自动创建', async t => {
  const f = fixture(t);
  f.desktop.used = true;
  await assert.rejects(f.send(), /电脑已使用原聊天/);
  assert.equal(f.draft.text, text);
  assert.deepEqual(f.calls.filter(call => call.commandId).map(call => call.method), ['thread.create']);
});
