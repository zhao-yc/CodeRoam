import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
/** 保留 UTSJSONObject 的取值方式，模拟传输不向业务层添加额外字段。 */
function json(value) {
  if (value == null || typeof value !== 'object') return value;
  for (const entry of Object.values(value)) json(entry);
  for (const suffix of ['String', 'Number', 'Boolean']) Object.defineProperty(value, 'get' + suffix, { value(key) { return this[key] ?? null; }, configurable: true });
  return value;
}

/** 执行实际草稿、原生状态和首条消息编排，传输包含命令账本与可续传的附件。 */
function fixture(storage = new Map()) {
  const calls = [], snapshots = new Map(), uploads = new Map(), commands = new Map();
  const connection = { hostId: 'pc', cacheNamespace: 'example', connected: true, computers: [{ id: 'pc', online: true }, { id: 'other', online: true }], snapshot: null };
  let serial = 0, opened = 0, pending = '', failure = null, denied = false;
  const bridge = {
    pendingCommand: () => pending,
    clearCommand: id => { if (id === pending) pending = ''; },
    request(method, params, write = false) {
      const commandId = write ? 'command-' + ++serial : '';
      calls.push({ method, params: plain(params), write, commandId });
      if (write) pending = commandId;
      return Promise.resolve().then(() => {
        if (failure?.method === method && (failure.index == null || failure.index === params.index)) {
          const failed = failure; failure = null;
          if (write) { commands.set(commandId, { state: failed.unknown ? 'unknown' : 'failed' }); if (!failed.unknown) pending = ''; }
          throw Error(failed.unknown ? '结果未知' : '明确失败');
        }
        let result = {};
        if (method === 'thread.draft.open') {
          let value = [...snapshots.values()].find(item => item.hostId === connection.hostId && item.projectId === params.projectId && item.status === 'ready');
          if (!value) {
            value = { hostId: connection.hostId, draftId: 'native-draft-' + ++opened, projectId: params.projectId, revision: 1, status: 'ready', settings: { model: 'example-model', effort: 'medium', serviceTier: '', mode: 'default' }, models: [{ id: 'example-model', label: '示例模型', defaultEffort: 'medium', efforts: ['medium', 'high'], speeds: [{ id: '' }], supportsImages: true }], permissions: { mode: 'default', revision: 'permission-1', options: [] }, hasDesktopText: false };
            snapshots.set(value.draftId, value);
          }
          result = value;
        } else if (method === 'thread.draft.read') result = snapshots.get(params.draftId);
        else if (method === 'thread.draft.send') {
          const value = snapshots.get(params.draftId); value.status = 'promoted'; value.revision++; value.threadId = 'thread-' + params.draftId;
          result = { threadId: value.threadId, snapshot: value };
        } else if (method === 'thread.draft.unwatch') result = {};
        else if (method === 'command.status') result = commands.get(params.commandId) ?? { state: 'not_found' };
        else if (method === 'attachment.begin') {
          const key = params.draftId + ':' + params.uploadId;
          if (!uploads.has(key)) uploads.set(key, { nextChunk: 0, received: 0 });
          result = uploads.get(key);
        } else if (method === 'attachment.chunk') {
          const upload = uploads.get(params.draftId + ':' + params.uploadId);
          assert.equal(params.index, upload.nextChunk); upload.nextChunk++; upload.received += 3; result = upload;
        } else if (method !== 'attachment.finish') throw Error('不允许旧创建或会话补写接口：' + method);
        if (write) { commands.set(commandId, { state: 'done', result: plain(result) }); pending = ''; }
        return json(plain(result));
      });
    },
    async openThread(threadId) { calls.push({ method: 'thread.watch', params: { threadId } }); connection.activeThreadId = threadId; },
  };
  const c = vm.createContext({ connection, bridge, reactive: value => value, FILE_CHUNK_BYTES: 3, readFileBase64: async () => 'YWJjZGVm',
    uni: { getStorageSync: key => storage.get(key) ?? '', removeStorageSync: key => storage.delete(key), setStorageSync: (key, value) => { if (denied) throw Error('存储不可用'); storage.set(key, value); } },
  });
  const source = ['composer', 'native-draft', 'new-conversation'].map(name => fs.readFileSync('apps/mobile/services/' + name + '.uts', 'utf8')).join('\n').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.subject={newDraft,beginNewConversation,assignUnselectedDraft,sendNewConversation,nativeDraftState,watchNativeDraft,closeNativeDraft,checkNativeDraftCommand,openPromotedConversation,applyNativeDraftSnapshot,readDraft};', c);
  return { ...c.subject, storage, calls, connection, snapshots, commands,
    denyStorage() { denied = true; }, fail(method, unknown = false, index = null) { failure = { method, unknown, index }; },
    async open(projectId = 'project') { await c.subject.watchNativeDraft('pc', projectId); return c.subject.nativeDraftState('pc', projectId); },
  };
}

const file = () => ({ id: 'example-upload-000001', name: 'example.txt', size: 6, source: '/example', data: 'YWJjZGVm', status: 'local', progress: 0, error: '' });

test('手机草稿按电脑和项目隔离，首次项目分配保留文字、附件及插件且不打开原生草稿', () => {
  const f = fixture(), source = f.newDraft('pc', ''); source.text = '先输入'; source.files = [file()]; source.plugins = [{ id: 'docs@example', displayName: '文档插件' }];
  f.assignUnselectedDraft('pc', 'project');
  assert.equal(f.newDraft('pc', 'project').text, '先输入'); assert.equal(f.newDraft('pc', 'project').files.length, 1); assert.equal(f.newDraft('pc', 'project').plugins.length, 1);
  assert.equal(source.text, ''); assert.equal(source.plugins.length, 0); assert.equal(f.newDraft('other', 'project').text, ''); assert.equal(f.newDraft('pc', 'other').files.length, 0);
  assert.equal(f.calls.length, 0);
});

test('打开只取得原生草稿，首条确认后一次 native send 再订阅正式聊天，不创建空线程或补写设置', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc', 'project');
  assert.deepEqual(f.calls.map(call => call.method), ['thread.draft.open', 'thread.draft.read']); assert.equal(draft.threadId, '');
  draft.text = '首条合成消息'; const id = await f.sendNewConversation(draft, () => {});
  assert.equal(id, 'thread-native-draft-1'); assert.equal(f.connection.activeThreadId, id); assert.equal(draft.text, '');
  assert.deepEqual(f.calls.slice(2).map(call => call.method), ['thread.draft.read', 'thread.draft.read', 'thread.draft.send', 'thread.watch', 'thread.draft.unwatch']);
  assert.equal(f.calls.find(call => call.method === 'thread.draft.send').params.expectedRevision, 1); assert.equal(state.watching, false);
});

test('连续点击只发送一次，未选择项目、离线和未打开原生草稿均不隐式 open', async () => {
  const f = fixture(); await f.open(); const draft = f.newDraft('pc', 'project'); draft.text = '合成消息';
  const sending = f.sendNewConversation(draft, () => {}); await assert.rejects(f.sendNewConversation(draft, () => {}), /正在提交/); await sending;
  const empty = f.newDraft('pc', ''); empty.text = '未选项目'; await assert.rejects(f.sendNewConversation(empty, () => {}), /选择项目/);
  const unopened = f.newDraft('pc', 'other'); unopened.text = '未打开'; await assert.rejects(f.sendNewConversation(unopened, () => {}), /暂停/);
  f.connection.connected = false; await assert.rejects(f.sendNewConversation(draft, () => {}), /连接已变化/);
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.open').length, 1); assert.equal(f.calls.filter(call => call.method === 'thread.draft.send').length, 1);
});

test('明确发送失败先核对原命令，失败确认后用户重试仍复用同草稿，不自动发送', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc', 'project'); draft.text = '保留文字';
  f.fail('thread.draft.send'); await assert.rejects(f.sendNewConversation(draft, () => {}), /明确失败/);
  assert.equal(draft.text, '保留文字'); assert.equal(state.outcomeUnknown, true);
  await assert.rejects(f.sendNewConversation(draft, () => {}), /需要核对/);
  await f.checkNativeDraftCommand(state); assert.equal(state.outcomeUnknown, false);
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.send').length, 1);
  await f.sendNewConversation(draft, () => {});
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.open').length, 1); assert.equal(f.calls.filter(call => call.method === 'thread.draft.send').length, 2);
});

test('未知发送关闭重开仍保护原命令，确认成功后只打开对应聊天，不重发或覆盖本地输入', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc', 'project'); draft.text = '未知时保留的文字';
  f.fail('thread.draft.send', true); await assert.rejects(f.sendNewConversation(draft, () => {}), /结果未知/);
  const commandId = state.pendingCommandId; f.closeNativeDraft('pc', 'project');
  await assert.rejects(f.watchNativeDraft('pc', 'project'), /需要核对/); await assert.rejects(f.sendNewConversation(draft, () => {}), /需要核对/);
  const backend = f.snapshots.get(state.draftId); backend.status = 'promoted'; backend.threadId = 'confirmed-thread'; backend.revision++;
  f.commands.set(commandId, { state: 'done', result: { threadId: 'confirmed-thread' } });
  assert.equal(await f.checkNativeDraftCommand(state), 'confirmed-thread'); await f.openPromotedConversation(draft);
  assert.equal(f.readDraft('pc', 'confirmed-thread'), '未知时保留的文字'); assert.equal(draft.text, '未知时保留的文字');
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.send').length, 1);
});

test('文件首条在 draftId 范围分片上传，中断后重试从已确认分片继续且不创建线程', async () => {
  const f = fixture(); await f.open(); const draft = f.newDraft('pc', 'project'); draft.text = '有附件'; draft.files = [file()];
  f.fail('attachment.chunk', false, 1); await assert.rejects(f.sendNewConversation(draft, () => {}), /明确失败/);
  assert.equal(draft.files[0].status, 'paused'); assert.equal(draft.text, '有附件'); assert.equal(f.calls.some(call => call.method === 'thread.draft.send'), false);
  await f.sendNewConversation(draft, () => {});
  const chunks = f.calls.filter(call => call.method === 'attachment.chunk');
  assert.deepEqual(chunks.map(call => call.params.index), [0, 1, 1]);
  assert.ok(f.calls.filter(call => call.method.startsWith('attachment.')).every(call => call.params.draftId === 'native-draft-1' && !('threadId' in call.params)));
  assert.deepEqual(f.calls.find(call => call.method === 'thread.draft.send').params.attachments, ['example-upload-000001']);
  assert.equal(f.calls.filter(call => call.method === 'thread.draft.open').length, 1);
});

test('收起重开同原生草稿保留上传完成状态、文字与插件，明确失败核对后不重复上传', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc', 'project'); draft.text = '未发送内容'; draft.files = [file()];
  f.fail('thread.draft.send'); await assert.rejects(f.sendNewConversation(draft, () => {}), /明确失败/); await f.checkNativeDraftCommand(state);
  assert.equal(draft.files[0].status, 'ready');
  f.closeNativeDraft('pc', 'project'); f.beginNewConversation(); await f.open();
  assert.equal(draft.text, '未发送内容'); assert.equal(draft.files[0].status, 'ready');
  await f.sendNewConversation(draft, () => {});
  assert.equal(f.calls.filter(call => call.method === 'attachment.begin').length, 1); assert.equal(f.calls.filter(call => call.method === 'thread.draft.open').length, 1);
});

test('旧创建缓存被清理且不接管旧线程，新的原生草稿编号来自本次 open', async () => {
  const storage = new Map([['codex-mobile-new-pc-project', JSON.stringify({ threadId: 'legacy-thread', pendingCommandId: 'legacy-command' })]]);
  const f = fixture(storage), draft = f.newDraft('pc', 'project'); draft.text = '真正的新任务';
  assert.equal(storage.size, 0); assert.equal(draft.threadId, ''); assert.equal(f.calls.length, 0);
  await f.open(); await f.sendNewConversation(draft, () => {});
  assert.equal(f.connection.activeThreadId, 'thread-native-draft-1');
});

test('电脑先发送 promotion 时首条编排不发消息，手机草稿保留并打开电脑已有聊天', async () => {
  const f = fixture(), state = await f.open(), draft = f.newDraft('pc', 'project'); draft.text = '手机未发';
  f.applyNativeDraftSnapshot(json({ ...plain(state.snapshot), revision: 2, status: 'promoted', threadId: 'desktop-thread' }), 'pc');
  await assert.rejects(f.sendNewConversation(draft, () => {}), /电脑已发送/); await f.openPromotedConversation(draft);
  assert.equal(draft.text, '手机未发'); assert.equal(f.readDraft('pc', 'desktop-thread'), '手机未发'); assert.equal(f.calls.some(call => call.method === 'thread.draft.send'), false);
});

test('存储不可写时在任何原生 WRITE 前拒绝，避免丢失未知结果的原命令核对入口', async () => {
  const f = fixture(), draft = f.newDraft('pc', 'project'); draft.text = '保留手机输入'; f.denyStorage();
  await assert.rejects(f.watchNativeDraft('pc', 'project'), /无法保存/);
  assert.equal(f.calls.length, 0); assert.equal(draft.text, '保留手机输入');
});

test('只选择插件和附件超限均不提交，插件未开放时保留选择并明确拒绝', async () => {
  const f = fixture(); await f.open(); const draft = f.newDraft('pc', 'project'); draft.plugins = [{ id: 'docs@example', displayName: '文档插件' }];
  const count = f.calls.length; await assert.rejects(f.sendNewConversation(draft, () => {}), /输入内容或添加附件/);
  draft.text = '合成消息'; await assert.rejects(f.sendNewConversation(draft, () => {}), /暂不支持插件/);
  draft.plugins = []; draft.files = [file(), file(), file(), file()]; await assert.rejects(f.sendNewConversation(draft, () => {}), /最多添加3个/);
  assert.equal(f.calls.length, count); await tick(); assert.equal(f.calls.length, count);
});
