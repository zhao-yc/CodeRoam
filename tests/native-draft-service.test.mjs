import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeDraftService } from '../apps/bridge/native-draft-service.mjs';
import { AttachmentStore } from '../apps/bridge/attachment-store.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { BridgeError, READ_METHODS, WRITE_METHODS, UPLOAD_METHODS, validateRequest } from '../packages/protocol/contracts.mjs';

/** 全部控制器动作使用合成状态，既不连接桌面，也不读取本机凭据和配置。 */
function nativeSnapshot(revision = 1) {
  return {
    revision, status: 'ready', settings: { model: 'model-a', effort: 'high', serviceTier: '', mode: 'default', windowId: 'synthetic-window' },
    models: [{ id: 'model-a', label: '测试模型', defaultEffort: 'high', efforts: ['high', 'medium'], speeds: [{ id: '', label: '常速', description: '', cwd: 'synthetic-private' }], supportsImages: true, nativeHandle: 'synthetic-private' }],
    permissions: { mode: 'default', revision: 'permission-1', options: [{ id: 'default', label: '默认权限', description: '测试权限', enabled: true, disabledReason: '', nativeHandle: 'synthetic-private' }], nativeHandle: 'synthetic-private' },
    hasDesktopText: false, windowId: 'synthetic-window', clientDraftId: 'synthetic-client', binding: { private: true },
  };
}

/** 附件夹具使用真实的临时目录，只销毁本测试创建的目录，不触碰用户项目目录。 */
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-draft-service-')));
  const records = new Map(), nativeProjects = new Map(), calls = { open: [], read: [], update: [], send: [], close: 0 };
  const projects = new Map(['project-a', 'project-b'].map(id => {
    const cwd = path.join(root, id); fs.mkdirSync(cwd); return [id, { id, label: id, cwd }];
  }));
  const controller = {
    async capabilities() { return true; },
    async open(project, commandId) {
      calls.open.push({ project, commandId });
      const previous = nativeProjects.get(project.id);
      if (previous && records.get(previous)?.status === 'ready') return { binding: { ...previous }, snapshot: structuredClone(records.get(previous)) };
      const binding = { windowId: 'synthetic-window-' + calls.open.length, clientDraftId: 'synthetic-client-' + calls.open.length };
      records.set(binding, nativeSnapshot());
      nativeProjects.set(project.id, binding);
      return { binding, snapshot: structuredClone(records.get(binding)) };
    },
    async read(binding) { calls.read.push(binding); return structuredClone(records.get(binding) ?? [...records].find(([key]) => key.clientDraftId === binding.clientDraftId)?.[1]); },
    async update(binding, changes, options) {
      calls.update.push({ binding, changes, options });
      const snapshot = records.get(binding) ?? [...records].find(([key]) => key.clientDraftId === binding.clientDraftId)?.[1];
      if (snapshot.revision !== options.expectedRevision) throw new BridgeError('DRAFT_CHANGED', '草稿已变化');
      const { permissionMode, ...settings } = changes;
      Object.assign(snapshot.settings, settings);
      if (permissionMode) snapshot.permissions.mode = permissionMode;
      snapshot.revision++;
      return structuredClone(snapshot);
    },
    async send(binding, input, options) {
      calls.send.push({ binding, input, options });
      const snapshot = records.get(binding) ?? [...records].find(([key]) => key.clientDraftId === binding.clientDraftId)?.[1];
      if (snapshot.revision !== options.expectedRevision) throw new BridgeError('DRAFT_CHANGED', '草稿已变化');
      Object.assign(snapshot, { status: 'promoted', revision: snapshot.revision + 1, threadId: 'synthetic-thread-' + calls.send.length });
      await options.onCreated({ threadId: snapshot.threadId, windowId: 'synthetic-window' });
      return { threadId: snapshot.threadId, snapshot: structuredClone(snapshot) };
    },
    close() { calls.close++; },
  };
  const attachments = new AttachmentStore({ root: path.join(root, 'uploads') });
  const service = new NativeDraftService({ controller, projects: { project(id) { return projects.get(id); } }, attachments, now: () => 12345 });
  const changed = []; service.on('changed', event => changed.push(event));
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, projects, controller, attachments, service, records, calls, changed,
    open: (deviceId = 'phone-a', projectId = 'project-a', checkpoint) => service.open({ projectId }, deviceId, randomUUID(), checkpoint),
    state(draft) {
      const entry = service.sessions.get(draft.draftId);
      // 夹具与真实控制器一样可返回新的 binding 对象，原生身份仍指向相同合成记录。
      if (!records.has(entry.binding)) records.set(entry.binding, [...records].find(([key]) => key.clientDraftId === entry.binding.clientDraftId)?.[1]);
      return entry;
    } };
}

/** 可控延迟用于证明锁与关闭边界，不依赖真实桌面或定时等待。 */
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const request = (method, params) => ({ v: 1, type: 'request', requestId: randomUUID(), method, params });
const sendParams = (draft, extra = {}) => ({ draftId: draft.draftId, expectedRevision: draft.revision, text: '合成验收消息', ...extra });

/** 使用真实 AttachmentStore 完成上传，验证 scope 而不以宽松的 mock 代替鉴权。 */
async function upload(f, draft, deviceId = 'phone-a', id = randomUUID()) {
  const data = Buffer.from('合成草稿附件\n');
  await f.service.transfer('attachment.begin', { draftId: draft.draftId, uploadId: id, name: '说明.txt', size: data.length }, deviceId);
  await f.service.transfer('attachment.chunk', { draftId: draft.draftId, uploadId: id, index: 0, data: data.toString('base64') }, deviceId);
  await f.service.transfer('attachment.finish', { draftId: draft.draftId, uploadId: id }, deviceId);
  return id;
}

test('草稿协议明确读写分类，公开编号与插件接口分别校验', () => {
  const draftId = randomUUID();
  for (const method of ['thread.draft.read', 'thread.draft.unwatch']) {
    assert.ok(READ_METHODS.has(method)); assert.equal(WRITE_METHODS.has(method), false);
    assert.doesNotThrow(() => validateRequest(request(method, { draftId })));
  }
  for (const [method, params] of [
    ['thread.draft.open', { projectId: 'project-a' }],
    ['thread.draft.update', { draftId, expectedRevision: 'revision-1', changes: { mode: 'plan', permissionMode: 'full-access' }, confirmedFullAccess: true }],
    ['thread.draft.send', { draftId, expectedRevision: 1, text: '消息' }],
  ]) {
    assert.ok(WRITE_METHODS.has(method)); assert.equal(READ_METHODS.has(method), false);
    assert.doesNotThrow(() => validateRequest(request(method, params)));
    for (const extra of [{ threadId: 'synthetic-thread' }, { windowId: 'synthetic-window' }, { clientDraftId: 'synthetic-client' }, { cwd: '/synthetic' }, { pluginIds: ['plugin-a'] }]) assert.throws(() => validateRequest(request(method, { ...params, ...extra })));
  }
  // 保留同文件已有的插件目录及普通消息白名单，不把新草稿字段混入旧接口。
  assert.doesNotThrow(() => validateRequest(request('thread.plugins.read', { threadId: 'synthetic-thread' })));
  assert.doesNotThrow(() => validateRequest(request('thread.create.plugins', { projectId: 'project-a' })));
  assert.doesNotThrow(() => validateRequest(request('turn.send', { threadId: 'synthetic-thread', text: '消息', pluginIds: ['plugin-a'] })));
  assert.throws(() => validateRequest(request('turn.send', { threadId: 'synthetic-thread', draftId, text: '消息' })));
});

test('草稿协议拒绝空修订、越权设置、未确认完整访问和无效消息', () => {
  const draftId = randomUUID(), update = { draftId, expectedRevision: 1, changes: { effort: 'medium' } };
  for (const extra of [{ expectedRevision: undefined }, { expectedRevision: -1 }, { expectedRevision: '' }, { expectedRevision: {} }, { changes: {} }, { changes: { approvalPolicy: 'never' } }, { changes: { permissionMode: 'full-access' } }, { changes: { mode: 'invalid' } }, { confirmedFullAccess: 'true' }]) assert.throws(() => validateRequest(request('thread.draft.update', { ...update, ...extra })));
  for (const extra of [{ text: undefined }, { text: '' }, { text: 'x'.repeat(32001) }, { images: [4] }, { attachments: ['../escape'] }, { attachments: ['same-upload-0001', 'same-upload-0001'] }, { images: ['one', 'two'], attachments: [randomUUID(), randomUUID()] }]) assert.throws(() => validateRequest(request('thread.draft.send', { draftId, expectedRevision: 1, text: '消息', ...extra })));
  assert.throws(() => validateRequest(request('thread.draft.read', { draftId: 'synthetic-client' })));
});

test('附件协议只接受 draftId 与 threadId 二选一，禁止冒用内部命名空间', () => {
  const draftId = randomUUID();
  for (const method of UPLOAD_METHODS) {
    assert.equal(WRITE_METHODS.has(method), false);
    for (const scope of [{ draftId }, { threadId: 'synthetic-thread' }]) assert.doesNotThrow(() => validateRequest(request(method, scope)));
    for (const scope of [{}, { draftId, threadId: 'synthetic-thread' }, { draftId, threadId: undefined }, { threadId: 'draft:' + draftId }, { draftId: 'draft:' + draftId }]) assert.throws(() => validateRequest(request(method, scope)));
  }
});

test('同设备同项目复用随机 token，设备与项目均隔离且快照不泄露内部身份', async t => {
  const f = fixture(t), checkpoints = [];
  const a = await f.open('phone-a', 'project-a', result => checkpoints.push(result));
  const again = await f.open(), b = await f.open('phone-b'), other = await f.open('phone-a', 'project-b');
  assert.equal(again.draftId, a.draftId); assert.notEqual(b.draftId, a.draftId); assert.notEqual(other.draftId, a.draftId); assert.equal(f.calls.open.length, 4);
  assert.match(a.draftId, /^[a-f0-9-]{36}$/); assert.equal(a.projectId, 'project-a'); assert.equal(a.permissions.options[0].enabled, true);
  assert.equal(JSON.stringify(checkpoints).includes('synthetic-window'), false);
  assert.equal(JSON.stringify(checkpoints).includes('synthetic-client'), false);
  assert.equal(JSON.stringify(a).includes('synthetic-private'), false);
  assert.deepEqual(checkpoints, [{ draftId: a.draftId, snapshot: a }]);
  a.settings.model = 'tampered'; a.models[0].efforts.push('tampered'); a.permissions.options[0].enabled = false;
  assert.equal(f.state(a).snapshot.settings.model, 'model-a'); assert.equal(f.state(a).snapshot.models[0].efforts.includes('tampered'), false); assert.equal(f.state(a).snapshot.permissions.options[0].enabled, true);
  for (const operation of [() => f.service.read({ draftId: a.draftId }, 'phone-b'), () => f.service.update({ draftId: a.draftId, expectedRevision: 1, changes: { mode: 'plan' } }, 'phone-b', randomUUID()), () => f.service.send(sendParams(again), 'phone-b', randomUUID()), () => f.service.transfer('attachment.abort', { draftId: a.draftId, uploadId: randomUUID() }, 'phone-b')]) await assert.rejects(operation, { code: 'DRAFT_NOT_FOUND' });
  assert.throws(() => f.service.unwatch({ draftId: a.draftId }, 'phone-b'), { code: 'DRAFT_NOT_FOUND' });
});

test('原生能力缺失、项目消失、读取失败和快照残缺均拒绝，绝不走配置或缓存降级', async t => {
  const f = fixture(t);
  f.controller.capabilities = async () => false;
  await assert.rejects(f.open(), { code: 'DRAFT_UNSUPPORTED' }); assert.equal(f.calls.open.length, 0);
  f.controller.capabilities = async () => true;
  await assert.rejects(f.open('phone-a', 'missing-project'), { code: 'PROJECT_NOT_FOUND' });
  const draft = await f.open(), entry = f.state(draft);
  const saved = f.controller.read; f.controller.read = async () => { throw new BridgeError('DRAFT_UNAVAILABLE', '原生读取失败'); };
  await assert.rejects(f.service.read({ draftId: draft.draftId }, 'phone-a'), { code: 'DRAFT_UNAVAILABLE' });
  f.controller.read = saved; delete f.records.get(entry.binding).models;
  await assert.rejects(f.service.read({ draftId: draft.draftId }, 'phone-a'), { code: 'DRAFT_UNAVAILABLE' });
  assert.equal(f.calls.update.length, 0); assert.equal(f.calls.send.length, 0);
});

test('写前回读阻止电脑改动后的迟到请求，同修订并发更新仅首个执行', async t => {
  const f = fixture(t), draft = await f.open(), state = f.records.get(f.state(draft).binding);
  state.revision = 2;
  await assert.rejects(f.service.update({ draftId: draft.draftId, expectedRevision: 1, changes: { mode: 'plan' } }, 'phone-a', randomUUID()), { code: 'DRAFT_CHANGED' });
  assert.equal(f.calls.update.length, 0);
  const pending = deferred(), started = deferred(), update = f.controller.update;
  f.controller.update = async (...args) => { started.resolve(); await pending.promise; return update(...args); };
  const params = { draftId: draft.draftId, expectedRevision: 2, changes: { effort: 'medium' } };
  const first = f.service.update(params, 'phone-a', 'synthetic-command-first'); await started.promise;
  const second = f.service.update(params, 'phone-a', 'synthetic-command-second');
  const secondCheck = assert.rejects(second, { code: 'DRAFT_CHANGED' });
  pending.resolve(); assert.equal((await first).revision, 3); await secondCheck;
  assert.equal(f.calls.update.length, 1); assert.equal(f.calls.update[0].options.commandId, 'synthetic-command-first');
  assert.equal(f.state(draft).observedAt, 12345);
});

test('update 只转交定稿字段与确认标记，检查点不包含原生 binding', async t => {
  const f = fixture(t), draft = await f.open(), checkpoints = [];
  const snapshot = await f.service.update({ draftId: draft.draftId, expectedRevision: 1, changes: { mode: 'plan', permissionMode: 'full-access' }, confirmedFullAccess: true }, 'phone-a', 'synthetic-update', result => checkpoints.push(result));
  assert.equal(snapshot.settings.mode, 'plan'); assert.equal(snapshot.permissions.mode, 'full-access');
  assert.deepEqual(f.calls.update[0].changes, { mode: 'plan', permissionMode: 'full-access' });
  assert.deepEqual(f.calls.update[0].options, { expectedRevision: 1, confirmedFullAccess: true, commandId: 'synthetic-update' });
  assert.deepEqual(checkpoints, [{ draftId: draft.draftId, snapshot }]); assert.equal(JSON.stringify(checkpoints).includes('windowId'), false);
});

test('同项目两台手机共享原生 binding 时串行核对修订，不误把另一个 token 当作独立草稿状态', async t => {
  const f = fixture(t), a = await f.open(), binding = f.state(a).binding;
  f.controller.open = async () => ({ binding, snapshot: structuredClone(f.records.get(binding)) });
  const b = await f.open('phone-b'); assert.notEqual(a.draftId, b.draftId);
  const first = f.service.update({ draftId: a.draftId, expectedRevision: 1, changes: { mode: 'plan' } }, 'phone-a', randomUUID());
  const second = f.service.send(sendParams(b), 'phone-b', randomUUID());
  await first; await assert.rejects(second, { code: 'DRAFT_CHANGED' });
  assert.equal(f.calls.update.length, 1); assert.equal(f.calls.send.length, 0);
});

test('detached 与电脑 promoted 禁止写入，重新 open 使用新 token 并保留旧 token 可读', async t => {
  const f = fixture(t), draft = await f.open(), state = f.records.get(f.state(draft).binding);
  state.status = 'detached';
  await assert.rejects(f.service.update({ draftId: draft.draftId, expectedRevision: 1, changes: { mode: 'plan' } }, 'phone-a', randomUUID()), { code: 'DRAFT_DETACHED' });
  await assert.rejects(f.service.send(sendParams(draft), 'phone-a', randomUUID()), { code: 'DRAFT_DETACHED' });
  const next = await f.open(); assert.notEqual(next.draftId, draft.draftId);
  assert.equal((await f.service.read({ draftId: draft.draftId }, 'phone-a')).status, 'detached');
  const promoted = f.records.get(f.state(next).binding); Object.assign(promoted, { status: 'promoted', threadId: 'synthetic-pc-thread', revision: 2 });
  await assert.rejects(f.service.send(sendParams(next), 'phone-a', randomUUID()), { code: 'DRAFT_PROMOTED' });
  assert.equal(f.calls.send.length, 0); assert.equal(f.calls.update.length, 0);
});

test('电脑已有正文或修订冲突时拒绝发送，附件不会提前落入项目目录', async t => {
  const f = fixture(t), draft = await f.open(), id = await upload(f, draft), state = f.records.get(f.state(draft).binding);
  state.hasDesktopText = true;
  await assert.rejects(f.service.send(sendParams(draft, { attachments: [id] }), 'phone-a', randomUUID()), { code: 'DRAFT_HAS_DESKTOP_TEXT' });
  assert.equal(fs.existsSync(path.join(f.projects.get('project-a').cwd, '.codex-remote-attachments')), false);
  state.hasDesktopText = false; state.revision++;
  await assert.rejects(f.service.send(sendParams(draft, { attachments: [id] }), 'phone-a', randomUUID()), { code: 'DRAFT_CHANGED' });
  assert.equal(f.calls.send.length, 0); assert.equal(fs.existsSync(path.join(f.projects.get('project-a').cwd, '.codex-remote-attachments')), false);
});

test('秒级轮询只在 revision 或 status 变化时通知，unwatch 不删除，read 恢复订阅', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t), draft = await f.open(), state = f.records.get(f.state(draft).binding);
  t.mock.timers.tick(999); await flush(); assert.equal(f.calls.read.length, 0);
  t.mock.timers.tick(1); await flush(); assert.equal(f.calls.read.length, 1); assert.equal(f.changed.length, 0);
  state.settings.effort = 'medium'; t.mock.timers.tick(1000); await flush(); assert.equal(f.changed.length, 0);
  state.revision++; t.mock.timers.tick(1000); await flush(); assert.equal(f.changed.length, 1); assert.equal(f.changed[0].deviceId, 'phone-a');
  state.status = 'detached'; t.mock.timers.tick(1000); await flush(); assert.equal(f.changed.length, 2);
  assert.deepEqual(f.service.unwatch({ draftId: draft.draftId }, 'phone-a'), { ok: true });
  const reads = f.calls.read.length; t.mock.timers.tick(5000); await flush(); assert.equal(f.calls.read.length, reads); assert.equal(f.calls.close, 0); assert.equal(f.service.timer, null);
  await f.service.read({ draftId: draft.draftId }, 'phone-a'); t.mock.timers.tick(1000); await flush(); assert.equal(f.calls.read.length, reads + 2);
  assert.equal(f.calls.open.length, 1);
});

test('慢轮询不重叠，unwatch 与 close 使迟到结果静默且不能复活定时器', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t), draft = await f.open(), pending = deferred(); let reads = 0;
  f.controller.read = async () => { reads++; return pending.promise; };
  t.mock.timers.tick(1000); await flush(); t.mock.timers.tick(5000); await flush(); assert.equal(reads, 1);
  f.service.unwatch({ draftId: draft.draftId }, 'phone-a');
  pending.resolve({ ...nativeSnapshot(2), status: 'detached' }); await flush(); assert.equal(f.changed.length, 0); assert.equal(f.service.timer, null);
  const late = deferred(); f.controller.read = () => late.promise;
  const reading = f.service.read({ draftId: draft.draftId }, 'phone-a'); await flush();
  const check = assert.rejects(reading, { code: 'DRAFT_SERVICE_CLOSED' });
  await f.service.close(); late.resolve(nativeSnapshot(3)); await check;
  await f.service.close(); assert.equal(f.calls.close, 1); assert.equal(f.changed.length, 0); assert.equal(f.service.timer, null);
});

test('显式 read 的迟到响应不能撤销随后到达的 unwatch', async t => {
  const f = fixture(t), draft = await f.open(), pending = deferred();
  f.controller.read = () => pending.promise;
  const reading = f.service.read({ draftId: draft.draftId }, 'phone-a'); await flush();
  f.service.unwatch({ draftId: draft.draftId }, 'phone-a'); pending.resolve(nativeSnapshot(2));
  await reading; assert.equal(f.state(draft).watching, false); assert.equal(f.service.timer, null); assert.equal(f.changed.length, 0);
});

test('轮询读取失败不会伪造 detached 或触发重放，下一周期仍能观察真实状态', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t), draft = await f.open(), read = f.controller.read;
  f.controller.read = async () => { throw new BridgeError('DRAFT_UNAVAILABLE', '测试读取失败'); };
  t.mock.timers.tick(1000); await flush(); assert.equal(f.changed.length, 0); assert.equal(f.state(draft).snapshot.status, 'ready');
  f.controller.read = read; f.records.get(f.state(draft).binding).revision++;
  t.mock.timers.tick(1000); await flush(); assert.equal(f.changed.length, 1); assert.equal(f.calls.open.length, 1); assert.equal(f.calls.send.length, 0);
});

test('open 命令由 Journal 去重，不同参数不得复用编号，重放返回原公开检查点', async t => {
  const f = fixture(t), journal = new Journal(); t.after(() => journal.close());
  const commandId = randomUUID(), params = { projectId: 'project-a' }; let executed = 0;
  const operation = () => { executed++; return f.service.open(params, 'phone-a', commandId, result => journal.checkpoint('phone-a', commandId, result)); };
  const first = await journal.execute('phone-a', commandId, 'thread.draft.open', params, operation);
  assert.deepEqual(await journal.execute('phone-a', commandId, 'thread.draft.open', params, operation), first); assert.equal(executed, 1);
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.open', { projectId: 'project-b' }, operation), { code: 'REQUEST_ID_REUSED' });
});

test('open 未取得回执的异常由 Journal 保持未知，相同命令不再次执行原生 open', async t => {
  const f = fixture(t), journal = new Journal(); t.after(() => journal.close()); let opens = 0;
  f.controller.open = async () => { opens++; throw new Error('合成未知失败'); };
  const commandId = randomUUID(), params = { projectId: 'project-a' };
  const operation = () => f.service.open(params, 'phone-a', commandId, result => journal.checkpoint('phone-a', commandId, result));
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.open', params, operation), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.open', params, operation), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(journal.status('phone-a', commandId).state, 'unknown'); assert.equal(opens, 1);
});

test('未知 update 既不自动重放，也不允许换命令编号或重新 read 绕过', async t => {
  const f = fixture(t), draft = await f.open(); let writes = 0;
  f.controller.update = async () => { writes++; throw new BridgeError('OUTCOME_UNKNOWN', '合成超时', true); };
  const params = { draftId: draft.draftId, expectedRevision: 1, changes: { mode: 'plan' } };
  await assert.rejects(f.service.update(params, 'phone-a', randomUUID()), { code: 'OUTCOME_UNKNOWN', outcomeUnknown: true });
  await f.service.read({ draftId: draft.draftId }, 'phone-a');
  await assert.rejects(f.service.update(params, 'phone-a', randomUUID()), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(f.service.send(sendParams(draft), 'phone-a', randomUUID()), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(writes, 1); assert.equal(f.calls.send.length, 0);
});

test('send 创建后断线保留公开 threadId 检查点，原请求重试与新编号均不二次发送', async t => {
  const f = fixture(t), draft = await f.open(), journal = new Journal(); t.after(() => journal.close()); let writes = 0;
  f.controller.send = async (_binding, _input, options) => {
    writes++; await options.onCreated({ threadId: 'synthetic-created-thread', binding: 'synthetic-private' });
    throw new BridgeError('OUTCOME_UNKNOWN', '合成连接已关闭', true);
  };
  const commandId = randomUUID(), params = sendParams(draft);
  const operation = () => f.service.send(params, 'phone-a', commandId, result => journal.checkpoint('phone-a', commandId, result));
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.send', params, operation), { code: 'OUTCOME_UNKNOWN' });
  const status = journal.status('phone-a', commandId);
  assert.equal(status.state, 'unknown'); assert.equal(status.result.draftId, draft.draftId); assert.equal(status.result.threadId, 'synthetic-created-thread'); assert.equal(status.result.snapshot.status, 'promoted');
  assert.equal(JSON.stringify(status).includes('synthetic-private'), false);
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.send', params, operation), { code: 'OUTCOME_UNKNOWN' });
  // 即使原生 read 暂时返回旧 ready，已确认的创建不能倒退成可再次发送。
  await assert.rejects(f.service.send(params, 'phone-a', randomUUID()), { code: 'DRAFT_PROMOTED' }); assert.equal(writes, 1);
});

test('send 未返回创建编号的未知结果仍封锁重放，确定业务拒绝不会永久占住草稿', async t => {
  const f = fixture(t), draft = await f.open(); let writes = 0;
  f.controller.send = async () => { writes++; throw new BridgeError('DRAFT_CHANGED', '合成冲突'); };
  await assert.rejects(f.service.send(sendParams(draft), 'phone-a', randomUUID()), { code: 'DRAFT_CHANGED' });
  f.controller.send = async () => { writes++; throw new Error('合成未知失败'); };
  await assert.rejects(f.service.send(sendParams(draft), 'phone-a', randomUUID()), { code: 'OUTCOME_UNKNOWN' });
  await f.open(); await assert.rejects(f.service.send(sendParams(draft), 'phone-a', randomUUID()), { code: 'OUTCOME_UNKNOWN' }); assert.equal(writes, 2);
});

test('两个并发 send 只产生一次原生发送，省略最终 snapshot 时仍公开已创建状态', async t => {
  const f = fixture(t), draft = await f.open(), started = deferred(), pending = deferred(); let writes = 0;
  f.controller.send = async (_binding, _input, options) => {
    writes++; started.resolve(); await pending.promise; await options.onCreated('synthetic-created-thread');
    return { threadId: 'synthetic-created-thread' };
  };
  const first = f.service.send(sendParams(draft), 'phone-a', randomUUID()); await started.promise;
  const second = f.service.send(sendParams(draft), 'phone-a', randomUUID()), check = assert.rejects(second, { code: 'DRAFT_PROMOTED' });
  pending.resolve(); const result = await first; await check;
  assert.equal(writes, 1); assert.equal(result.snapshot.status, 'promoted'); assert.equal(result.snapshot.threadId, 'synthetic-created-thread');
});

test('草稿附件真实存储使用 draft: scope，同 uploadId 的聊天与其他设备附件不能越权发送', async t => {
  const f = fixture(t), a = await f.open(), b = await f.open('phone-b'), other = await f.open('phone-a', 'project-b');
  const id = await upload(f, a);
  assert.equal(f.attachments.metadata('phone-a', 'draft:' + a.draftId, id).metadata.complete, true);
  for (const [draft, phone] of [[b, 'phone-b'], [other, 'phone-a']]) await assert.rejects(f.service.send(sendParams(draft, { attachments: [id] }), phone, randomUUID()), { code: 'UPLOAD_NOT_FOUND' });
  const threadOnly = randomUUID(); f.attachments.begin('phone-a', 'synthetic-thread', { uploadId: threadOnly, name: '聊天附件.txt', size: 1 });
  await assert.rejects(f.service.transfer('attachment.finish', { draftId: a.draftId, uploadId: threadOnly }, 'phone-a'), { code: 'UPLOAD_NOT_FOUND' });
  await assert.rejects(f.service.transfer('attachment.begin', { draftId: a.draftId, threadId: 'synthetic-thread', uploadId: id, name: '说明.txt', size: 1 }, 'phone-a'), { code: 'BAD_PARAMS' });
  await assert.rejects(f.service.transfer('attachment.abort', { threadId: 'synthetic-thread', uploadId: threadOnly }, 'phone-a'), { code: 'BAD_PARAMS' });
  await assert.rejects(f.service.transfer('attachment.materialize', { draftId: a.draftId }, 'phone-a'), { code: 'METHOD_NOT_ALLOWED' });
  assert.equal(f.calls.send.length, 0);
});

test('发送仅在所选项目 cwd 落盘，控制器收到核验文件而手机回执不带路径', async t => {
  const f = fixture(t), draft = await f.open(), id = await upload(f, draft), checkpoints = [];
  const result = await f.service.send(sendParams(draft, { attachments: [id] }), 'phone-a', 'synthetic-send-command', value => checkpoints.push(value));
  assert.equal(result.snapshot.status, 'promoted'); assert.equal(result.threadId, 'synthetic-thread-1');
  const call = f.calls.send[0], file = call.input.attachments[0], cwd = f.projects.get('project-a').cwd;
  assert.ok(file.path.startsWith(path.join(cwd, '.codex-remote-attachments') + path.sep)); assert.equal(fs.readFileSync(file.path, 'utf8'), '合成草稿附件\n');
  assert.equal(fs.existsSync(path.join(f.projects.get('project-b').cwd, '.codex-remote-attachments')), false);
  assert.deepEqual(call.input.images, []); assert.equal(call.options.expectedRevision, 1); assert.equal(call.options.commandId, 'synthetic-send-command');
  assert.equal(JSON.stringify(checkpoints).includes(file.path), false); assert.equal(JSON.stringify(checkpoints).includes('windowId'), false);
  assert.equal(checkpoints[0].threadId, result.threadId); assert.equal(checkpoints.at(-1).snapshot.revision, 2);
  await assert.rejects(f.service.send(sendParams(draft), 'phone-a', randomUUID()), { code: 'DRAFT_PROMOTED' });
  await f.service.transfer('attachment.abort', { draftId: draft.draftId, uploadId: id }, 'phone-a'); assert.ok(fs.existsSync(file.path));
});

test('附件上传与发送共享项目锁，发送期间的取消不能提前删掉附件', async t => {
  const f = fixture(t), draft = await f.open(), id = await upload(f, draft), pending = deferred(), started = deferred(), send = f.controller.send;
  f.controller.send = async (...args) => { started.resolve(); await pending.promise; return send(...args); };
  const sending = f.service.send(sendParams(draft, { attachments: [id] }), 'phone-a', randomUUID()); await started.promise;
  let aborted = false;
  const aborting = f.service.transfer('attachment.abort', { draftId: draft.draftId, uploadId: id }, 'phone-a').then(() => { aborted = true; });
  await flush(); assert.equal(aborted, false); assert.equal(f.attachments.metadata('phone-a', 'draft:' + draft.draftId, id).metadata.complete, true);
  pending.resolve(); await sending; await aborting; assert.equal(aborted, true);
});

test('无效图片在任何原生写入之前拒绝，发送成功但检查点失败必须视为未知', async t => {
  const f = fixture(t), draft = await f.open();
  await assert.rejects(f.service.send(sendParams(draft, { images: ['file:///synthetic.png'] }), 'phone-a', randomUUID()), { code: 'BAD_IMAGES' }); assert.equal(f.calls.send.length, 0);
  await assert.rejects(f.service.send(sendParams(draft), 'phone-a', randomUUID(), () => { throw new Error('合成账本失败'); }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.state(draft).snapshot.status, 'promoted');
  await assert.rejects(f.service.send(sendParams(draft), 'phone-a', randomUUID()), { code: 'DRAFT_PROMOTED' }); assert.equal(f.calls.send.length, 1);
});

test('关闭期间迟到的 open 不建立 token，关闭后的请求均被拒绝', async t => {
  const f = fixture(t), pending = deferred(), opened = deferred();
  f.controller.open = async () => { opened.resolve(); return pending.promise; };
  const opening = f.open(); await opened.promise;
  const check = assert.rejects(opening, { code: 'DRAFT_SERVICE_CLOSED' });
  await f.service.close(); pending.resolve({ binding: { windowId: 'synthetic-window' }, snapshot: nativeSnapshot() }); await check;
  assert.equal(f.service.sessions.size, 0); assert.equal(f.service.timer, null);
  await assert.rejects(f.open(), { code: 'DRAFT_SERVICE_CLOSED' });
  assert.throws(() => f.service.unwatch({ draftId: randomUUID() }, 'phone-a'), { code: 'DRAFT_SERVICE_CLOSED' });
});

test('服务关闭时在途发送即使收到控制器业务异常也保持未知，迟到回调不发布事件', async t => {
  const f = fixture(t), draft = await f.open(), started = deferred(), pending = deferred();
  f.controller.send = async (_binding, _input, options) => { started.resolve(); await pending.promise; await options.onCreated('synthetic-late-thread'); };
  const sending = f.service.send(sendParams(draft), 'phone-a', randomUUID()); await started.promise;
  const check = assert.rejects(sending, { code: 'OUTCOME_UNKNOWN', outcomeUnknown: true });
  await f.service.close(); pending.resolve(); await check; assert.equal(f.changed.length, 0); assert.equal(f.service.timer, null);
});

test('每个显式 open 都调用原生按钮，相同原生身份复用 token，原生换草稿或窗口则更换 token', async t => {
  const f = fixture(t), first = await f.open();
  const reused = await f.open(); assert.equal(f.calls.open.length, 2); assert.equal(first.draftId, reused.draftId);
  let opens = 0;
  f.controller.open = async () => { opens++; return { binding: { clientDraftId: 'synthetic-replacement', pid: 101, url: 'ws://127.0.0.1/synthetic' }, snapshot: nativeSnapshot() }; };
  const replacement = await f.open(), repeat = await f.open(); assert.notEqual(replacement.draftId, first.draftId); assert.equal(replacement.draftId, repeat.draftId);
  f.controller.open = async () => { opens++; return { binding: { clientDraftId: 'synthetic-replacement', pid: 102, url: 'ws://127.0.0.1/synthetic' }, snapshot: nativeSnapshot() }; };
  const otherWindow = await f.open(); assert.notEqual(otherWindow.draftId, replacement.draftId); assert.equal(opens, 3);
  assert.equal(JSON.stringify([replacement, repeat, otherWindow]).includes('synthetic-replacement'), false);
  assert.equal(JSON.stringify(otherWindow).includes('127.0.0.1'), false);
});

test('未知 open 在没有 entry 时也占用设备与项目，新编号或已有 ready 不能绕过', async t => {
  const f = fixture(t), ready = await f.open(), original = f.controller.open; let calls = 0;
  f.controller.open = async () => { calls++; throw new BridgeError('DRAFT_NOT_READY', '合成按钮执行后读取失败'); };
  await assert.rejects(f.open(), { code: 'OUTCOME_UNKNOWN' });
  f.controller.open = original;
  await assert.rejects(f.open(), { code: 'OUTCOME_UNKNOWN' }); assert.equal(calls, 1);
  assert.equal((await f.service.read({ draftId: ready.draftId }, 'phone-a')).status, 'ready');
  await assert.rejects(f.open(), { code: 'OUTCOME_UNKNOWN' });
  assert.equal((await f.open('phone-b')).status, 'ready'); assert.equal((await f.open('phone-a', 'project-b')).status, 'ready');
});

test('原生明确拒绝打开不会永久占位，无法取得 binding 的未知 open 核对仍保持未知', async t => {
  const f = fixture(t), original = f.controller.open;
  f.controller.open = async () => { throw new BridgeError('DRAFT_WINDOW_AMBIGUOUS', '合成多个窗口'); };
  await assert.rejects(f.open(), { code: 'DRAFT_WINDOW_AMBIGUOUS' });
  f.controller.open = original; await f.open();
  const journal = new Journal(); t.after(() => journal.close()); const commandId = randomUUID(), params = { projectId: 'project-a' }; let writes = 0;
  f.controller.open = async () => { writes++; throw new BridgeError('OUTCOME_UNKNOWN', '合成未知', true); };
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.open', params, () => f.service.open(params, 'phone-a', commandId)), { code: 'OUTCOME_UNKNOWN' });
  const reads = f.calls.read.length;
  assert.equal((await f.service.commandStatus(journal, 'phone-a', commandId)).state, 'unknown'); assert.equal(f.calls.read.length, reads);
  await assert.rejects(f.open(), { code: 'OUTCOME_UNKNOWN' }); assert.equal(writes, 1);
});

test('已取得原生 binding 的未知 open 只读核对后收口 Journal，并解除原设备项目占位', async t => {
  const f = fixture(t), journal = new Journal(); t.after(() => journal.close());
  const commandId = randomUUID(), params = { projectId: 'project-a' };
  const operation = () => f.service.open(params, 'phone-a', commandId, () => { throw new Error('合成检查点失败'); });
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.open', params, operation), { code: 'OUTCOME_UNKNOWN' });
  await assert.rejects(f.open(), { code: 'OUTCOME_UNKNOWN' });
  const status = await f.service.commandStatus(journal, 'phone-a', commandId);
  assert.equal(status.state, 'done'); assert.equal(status.result.status, 'ready'); assert.equal(status.resolution.source, 'native-draft-state');
  assert.equal(JSON.stringify(status).includes('synthetic-client'), false);
  assert.deepEqual(await journal.execute('phone-a', commandId, 'thread.draft.open', params, operation), status.result); assert.equal(f.calls.open.length, 1);
  assert.equal((await f.open()).draftId, status.result.draftId); assert.equal(f.calls.open.length, 2);
});

test('未知 update 只在所有请求字段与实际修订均核对后收口，不重放并解除写锁', async t => {
  const f = fixture(t), draft = await f.open(), journal = new Journal(); t.after(() => journal.close());
  const commandId = randomUUID(), params = { draftId: draft.draftId, expectedRevision: 1, changes: { mode: 'plan', permissionMode: 'read-only' } }; let writes = 0;
  f.controller.update = async binding => { writes++; const state = f.records.get(binding); state.settings.mode = 'plan'; state.revision++; throw new BridgeError('OUTCOME_UNKNOWN', '合成延迟落实', true); };
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.update', params, () => f.service.update(params, 'phone-a', commandId)), { code: 'OUTCOME_UNKNOWN' });
  assert.equal((await f.service.commandStatus(journal, 'phone-a', commandId)).state, 'unknown'); assert.equal(f.state(draft).uncertain, true);
  f.records.get(f.state(draft).binding).permissions.mode = 'read-only';
  const status = await f.service.commandStatus(journal, 'phone-a', commandId);
  assert.equal(status.state, 'done'); assert.equal(status.result.permissions.mode, 'read-only'); assert.equal(f.state(draft).uncertain, false); assert.equal(writes, 1);
  assert.deepEqual(await journal.execute('phone-a', commandId, 'thread.draft.update', params, () => assert.fail('不能重放')), status.result);
});

test('未知 send 没有 onCreated 证据时不能把 PC promoted 归因于手机命令', async t => {
  const f = fixture(t), draft = await f.open(), journal = new Journal(); t.after(() => journal.close());
  const commandId = randomUUID(), params = sendParams(draft); let writes = 0;
  f.controller.send = async () => { writes++; throw new BridgeError('OUTCOME_UNKNOWN', '合成未收到创建编号', true); };
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.send', params, () => f.service.send(params, 'phone-a', commandId)), { code: 'OUTCOME_UNKNOWN' });
  Object.assign(f.records.get(f.state(draft).binding), { status: 'promoted', threadId: 'synthetic-pc-thread', revision: 2 });
  assert.equal((await f.service.commandStatus(journal, 'phone-a', commandId)).state, 'unknown'); assert.equal(writes, 1);
  await assert.rejects(f.service.send(params, 'phone-a', randomUUID()), { code: 'DRAFT_PROMOTED' });
});

test('已确认 onCreated 的未知 send 核对同一个 threadId 后收口，原请求重试返回结果而不发送', async t => {
  const f = fixture(t), draft = await f.open(), journal = new Journal(); t.after(() => journal.close());
  const commandId = randomUUID(), params = sendParams(draft); let writes = 0;
  f.controller.send = async (binding, _input, options) => {
    writes++; Object.assign(f.records.get(binding), { status: 'promoted', threadId: 'synthetic-confirmed-thread', revision: 2 });
    await options.onCreated({ threadId: 'synthetic-confirmed-thread' }); throw new BridgeError('OUTCOME_UNKNOWN', '合成回执中断', true);
  };
  const operation = () => f.service.send(params, 'phone-a', commandId, result => journal.checkpoint('phone-a', commandId, result));
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.send', params, operation), { code: 'OUTCOME_UNKNOWN' });
  const status = await f.service.commandStatus(journal, 'phone-a', commandId);
  assert.equal(status.state, 'done'); assert.equal(status.result.threadId, 'synthetic-confirmed-thread');
  assert.deepEqual(await journal.execute('phone-a', commandId, 'thread.draft.send', params, operation), status.result); assert.equal(writes, 1);
});

test('command.status 拒绝跨设备、指纹变化及读取失败，普通命令状态保持原样', async t => {
  const f = fixture(t), draft = await f.open(), journal = new Journal(); t.after(() => journal.close());
  const commandId = randomUUID(), params = { draftId: draft.draftId, expectedRevision: 1, changes: { mode: 'plan' } };
  f.controller.update = async () => { throw new BridgeError('OUTCOME_UNKNOWN', '合成未知', true); };
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.update', params, () => f.service.update(params, 'phone-a', commandId)), { code: 'OUTCOME_UNKNOWN' });
  assert.equal((await f.service.commandStatus(journal, 'phone-b', commandId)).state, 'not_found');
  const unknownFingerprint = journal.unknownFingerprint.bind(journal); journal.unknownFingerprint = () => 'mismatched';
  assert.equal((await f.service.commandStatus(journal, 'phone-a', commandId)).state, 'unknown'); assert.equal(f.calls.read.length, 1);
  journal.unknownFingerprint = unknownFingerprint; f.controller.read = async () => { throw new BridgeError('DRAFT_UNAVAILABLE', '合成读取失败'); };
  assert.equal((await f.service.commandStatus(journal, 'phone-a', commandId)).state, 'unknown');
  const ordinary = randomUUID(); await journal.execute('phone-a', ordinary, 'thread.archive', { threadId: 'synthetic-thread' }, () => ({ ok: true }));
  assert.deepEqual(await f.service.commandStatus(journal, 'phone-a', ordinary), { state: 'done', result: { ok: true } });
});

test('按钮成功但 settle 失败时 recoverOpen 只查原命令，恢复公开 token 并收口未知 open', async t => {
  const f = fixture(t), journal = new Journal(); t.after(() => journal.close());
  const commandId = randomUUID(), params = { projectId: 'project-a' }, nativeOpen = f.controller.open; let recoveryCalls = 0, opened;
  f.controller.open = async (...args) => { opened = await nativeOpen(...args); throw new BridgeError('DRAFT_NOT_READY', '合成原生按钮成功但权限未就绪'); };
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.open', params, () => f.service.open(params, 'phone-a', commandId)), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(f.service.sessions.size, 0);
  f.controller.recoverOpen = async (project, originalCommandId) => {
    recoveryCalls++; assert.equal(project.id, 'project-a'); assert.equal(originalCommandId, commandId);
    return { binding: { ...opened.binding }, snapshot: opened.snapshot };
  };
  const status = await f.service.commandStatus(journal, 'phone-a', commandId);
  assert.equal(status.state, 'done'); assert.match(status.result.draftId, /^[a-f0-9-]{36}$/); assert.equal(status.result.projectId, 'project-a');
  assert.equal(f.calls.open.length, 1); assert.equal(recoveryCalls, 1); assert.equal(f.service.sessions.size, 1); assert.equal(f.service.timer, null);
  assert.equal(JSON.stringify(status).includes('synthetic-client'), false);
  assert.equal((await f.service.read({ draftId: status.result.draftId }, 'phone-a')).status, 'ready');
  f.controller.open = nativeOpen;
  assert.equal((await f.open()).draftId, status.result.draftId); assert.equal(f.calls.open.length, 2);
});

test('recoverOpen 缺少原 guard、返回残缺或只读失败时保留占位，不误查其他命令或重放按钮', async t => {
  const f = fixture(t), journal = new Journal(); t.after(() => journal.close()); let opens = 0, recoveries = 0;
  const commandId = randomUUID(), params = { projectId: 'project-a' };
  f.controller.open = async () => { opens++; throw new BridgeError('DRAFT_NOT_READY', '合成读取尚未就绪'); };
  await assert.rejects(journal.execute('phone-a', commandId, 'thread.draft.open', params, () => f.service.open(params, 'phone-a', commandId)), { code: 'OUTCOME_UNKNOWN' });
  f.controller.recoverOpen = async () => { recoveries++; throw new BridgeError('DRAFT_UNAVAILABLE', '合成原 guard 缺失'); };
  assert.equal((await f.service.commandStatus(journal, 'phone-b', commandId)).state, 'not_found'); assert.equal(recoveries, 0);
  assert.equal((await f.service.commandStatus(journal, 'phone-a', commandId)).state, 'unknown');
  f.controller.recoverOpen = async () => { recoveries++; return { binding: { windowId: 'synthetic-window', clientDraftId: 'synthetic-client' }, snapshot: { revision: 2 } }; };
  assert.equal((await f.service.commandStatus(journal, 'phone-a', commandId)).state, 'unknown'); assert.equal(f.service.sessions.size, 0);
  await assert.rejects(f.open(), { code: 'OUTCOME_UNKNOWN' }); assert.equal(opens, 1); assert.equal(recoveries, 2);
});
