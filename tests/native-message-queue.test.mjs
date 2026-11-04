import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { runNativeMessageQueue, nativeMessageQueueExpression } from '../apps/bridge/native-message-queue-expression.mjs';

const threadId = 'synthetic-thread', hostId = 'local';
const modules = { kind: 'esm', shared: 'synthetic-services.js', services: 'appServices' };
const image = 'data:image/png;base64,c3ludGhldGlj';
beforeEach(() => { globalThis.__codexMobileNativeQueueReceipts = new Map(); });
afterEach(() => { globalThis.__codexMobileNativeQueueReceipts.clear(); });

/** 所有正文、路径和原生回执均为合成数据。 */
function message(id = 'native-one', extra = {}) {
  return { id, text: '合成正文', cwd: '/example/workspace', context: { prompt: '合成正文', workspaceRoots: ['/example/workspace'] }, ...extra };
}

/** 订阅返回独立快照；恢复始终在最新存储上插入，模拟 PC 并发写入。 */
function fixture(initial = [message()]) {
  const f = { rows: structuredClone(initial), calls: [], disposed: [], role: 'owner', execution: { inProgress: true, activeTurnId: 'turn-one' } };
  f.coordinator = {
    async restoreQueuedMessage(thread, receipt) {
      f.calls.push({ type: 'restore', thread, receipt });
      await f.beforeRestore?.(receipt);
      f.rows.splice(Math.min(receipt.index, f.rows.length), 0, receipt.message);
      return receipt.message.id;
    },
    async removeQueuedMessage(thread, id) {
      f.calls.push({ type: 'remove', thread, id });
      await f.beforeRemove?.(id);
      const index = f.rows.findIndex(row => row.id === id);
      if (index < 0) return null;
      const previousMessageId = f.rows[index - 1]?.id ?? null, nextMessageId = f.rows[index + 1]?.id ?? null;
      return { message: f.rows.splice(index, 1)[0], index, previousMessageId, nextMessageId };
    },
    async sendQueuedMessageNow(thread, id, options, prepare, assertTurn) {
      f.calls.push({ type: 'send', thread, id, options });
      if (f.onSend) return f.onSend({ prepare, assertTurn });
      f.prepared = await prepare();
      await assertTurn();
      f.rows = f.rows.filter(row => row.id !== id);
      return { status: 'sent' };
    },
  };
  f.manager = {
    async getStreamRole(thread) { assert.equal(thread, threadId); return { role: f.role }; },
    async getTurnCoordinator() { return f.coordinator; },
    async getThreadExecutionState(thread) { assert.equal(thread, threadId); return f.execution; },
    subscribe(options) {
      assert.equal(options.type, 'thread'); assert.equal(options.field, 'queuedMessages');
      assert.equal(options.key.hostId, hostId); assert.equal(options.key.threadId, threadId);
      f.subscriptions = (f.subscriptions ?? 0) + 1;
      const call = Promise.resolve().then(() => {
        options.listener(structuredClone(f.rows));
        f.afterSnapshot?.();
        return { [Symbol.dispose]() { f.disposed.push('subscription'); } };
      });
      call[Symbol.dispose] = () => f.disposed.push('call');
      return call;
    },
  };
  f.services = { clientCoordination: { threadStreamFollowingStatusRequested() { assert.fail('队列操作不得触发归属探测'); } }, appServerManagers: { async open(host) { assert.equal(host, hostId); return { status: 'ready', manager: f.manager }; } } };
  f.run = (action, input = {}) => runNativeMessageQueue(f.services, action, { hostId, threadId, commandId: 'command-one', id: 'native-one', ...input });
  return f;
}

test('首次读取等待订阅快照，返回安全展示字段并释放两层订阅句柄', async () => {
  const original = message('native-one', { context: { prompt: '合成格式上下文', fileAttachments: [{ label: '合成文件', path: '/example/private/file.txt' }], imageAttachments: [{ src: image }], secretContext: '合成内部字段' }, submissionOptions: { approvalPolicy: 'on-request' } });
  const f = fixture([original]);
  const result = await f.run('read');
  assert.deepEqual(result, { supported: true, messages: [{ id: 'native-one', text: '合成正文', imageCount: 1, attachmentCount: 1, state: 'queued', error: '', canEdit: false, canCancel: true, canSteer: false }] });
  assert.deepEqual(f.rows, [original]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.subscriptions, 1);
  assert.deepEqual(f.disposed, ['subscription', 'call']);
  for (const value of ['secretContext', '/example/private', 'approvalPolicy', 'base64']) assert.equal(JSON.stringify(result).includes(value), false);
});

test('订阅快照后 owner 变化或队列超限时拒绝读取且仍释放订阅', async t => {
  for (const kind of ['owner变化', '超过二百条']) await t.test(kind, async () => {
    const f = fixture(kind === '超过二百条' ? Array.from({ length: 201 }, (_, n) => message('native-' + n)) : [message()]);
    if (kind === 'owner变化') f.afterSnapshot = () => { f.role = 'follower'; };
    await assert.rejects(f.run('read'), new RegExp(kind === 'owner变化' ? 'NATIVE_QUEUE_CHANGED' : 'NATIVE_QUEUE_UNAVAILABLE'));
    assert.deepEqual(f.disposed, ['subscription', 'call']);
    assert.equal(f.calls.length, 0);
  });
});

test('服务未就绪、非 owner 或缺少原生能力时不订阅不写入', async t => {
  for (const kind of ['服务未就绪', '非owner', '缺少恢复接口']) await t.test(kind, async () => {
    const f = fixture();
    if (kind === '服务未就绪') f.services.appServerManagers.open = async () => ({ status: 'starting' });
    if (kind === '非owner') f.role = 'follower';
    if (kind === '缺少恢复接口') delete f.coordinator.restoreQueuedMessage;
    await assert.rejects(f.run('cancel'), /NATIVE_QUEUE_(UNAVAILABLE|CHANGED)/);
    assert.equal(f.subscriptions ?? 0, 0); assert.equal(f.calls.length, 0);
  });
});

test('生成的固定程序把恶意外观正文作为数据传入，不执行注入内容', async () => {
  const f = fixture([]), text = '\");globalThis.injected=true;//` ${globalThis.injected=true}\n\u2028</script>';
  const input = { hostId, threadId, commandId: 'synthetic-command', message: message('mobile-one', { text, context: { prompt: text } }) };
  const source = nativeMessageQueueExpression(modules, 'enqueue', input);
  const sandbox = { syntheticModule: { appServices: f.services }, Symbol, __codexMobileNativeQueueReceipts: new Map() };
  const result = await vm.runInNewContext(source.replace('await import("app://-/assets/synthetic-services.js")', 'syntheticModule'), sandbox);
  assert.equal(result.nativeId, 'mobile-one'); assert.equal(sandbox.injected, undefined);
  assert.equal(f.rows[0].text, text); assert.equal(f.rows[0].context.prompt, text);
  assert.throws(() => nativeMessageQueueExpression(modules, 'eval', input), /操作无效/);
  assert.throws(() => nativeMessageQueueExpression({ ...modules, shared: '../escape.js' }, 'read', input), { code: 'INSTANCE_NOT_READY' });
  sandbox.__codexMobileNativeQueueReceipts.clear();
});

test('逐条原生恢复使用末尾追加，保留订阅后 PC 并发新增及原消息全部上下文', async () => {
  const original = message('pc-one', { context: { prompt: '合成插件正文', plugin: { id: 'synthetic-plugin' } }, submissionOptions: { model: 'synthetic-model' } });
  const f = fixture([original]);
  f.beforeRestore = () => { f.rows.push(message('pc-concurrent')); };
  const incoming = message('mobile-one', { submission: { status: 'sending', hostId: 'untrusted-host' } });
  await f.run('enqueue', { message: incoming });
  f.beforeRestore = undefined;
  await f.run('enqueue', { commandId: 'command-two', message: message('mobile-two') });
  assert.deepEqual(f.rows.map(row => row.id), ['pc-one', 'pc-concurrent', 'mobile-one', 'mobile-two']);
  assert.deepEqual(f.rows[0], original);
  assert.deepEqual(f.rows[2].submission, { hostId, status: 'queued', queueModeOverride: 'queue' });
  assert.deepEqual(incoming.submission, { status: 'sending', hostId: 'untrusted-host' });
  for (const call of f.calls) {
    assert.equal(call.type, 'restore'); assert.equal(call.thread, threadId);
    assert.deepEqual({ ...call.receipt, message: undefined }, { message: undefined, index: 2147483647, previousMessageId: null, nextMessageId: null });
  }
});

test('同一 commandId 在并发执行和完成后均只追加一次，改变正文则拒绝复用', async () => {
  const f = fixture([]), entered = Promise.withResolvers(), release = Promise.withResolvers();
  f.beforeRestore = async () => { entered.resolve(); await release.promise; };
  const input = { message: message('mobile-one') };
  const first = f.run('enqueue', input); await entered.promise;
  const second = f.run('enqueue', input); release.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b); assert.deepEqual(await f.run('enqueue', input), a);
  await assert.rejects(f.run('enqueue', { message: message('mobile-one', { text: '合成替换内容' }) }), /NATIVE_QUEUE_CHANGED/);
  assert.equal(f.calls.length, 1); assert.equal(f.rows.length, 1);
  assert.equal(f.disposed.length, 8);
});

test('已有原生或客户端消息编号不会重复恢复，队列满时不再追加', async t => {
  for (const field of ['id', 'clientUserMessageId']) await t.test('去重字段为' + field, async () => {
    const f = fixture([message('native-one', { [field]: 'mobile-one' })]);
    assert.equal((await f.run('enqueue', { message: message('mobile-one') })).nativeId, f.rows[0].id);
    assert.equal(f.calls.length, 0);
  });
  await t.test('二十条上限', async () => {
    const f = fixture(Array.from({ length: 20 }, (_, n) => message('native-' + n)));
    await assert.rejects(f.run('enqueue', { message: message('mobile-one') }), /NATIVE_QUEUE_FULL/);
    assert.equal(f.calls.length, 0); assert.equal(f.rows.length, 20);
  });
});

test('取消只移除目标消息，重复命令复用回执且不能改成编辑命令', async () => {
  const f = fixture([message(), message('native-two')]);
  const result = await f.run('cancel');
  assert.deepEqual(result, { ok: true, canceled: true });
  assert.deepEqual(await f.run('cancel'), result);
  await assert.rejects(f.run('edit'), /NATIVE_QUEUE_CHANGED/);
  assert.deepEqual(f.rows.map(row => row.id), ['native-two']);
  assert.deepEqual(f.calls.map(call => call.type), ['remove']);
});

test('纯文本编辑以原生撤回回执正文为准，重复编辑不再次撤回', async () => {
  const f = fixture();
  f.beforeRemove = () => { f.rows[0] = message('native-one', { text: 'PC 并发更新的合成正文' }); };
  const result = await f.run('edit');
  assert.deepEqual(result, { ok: true, edited: true, draft: { text: 'PC 并发更新的合成正文', images: [], attachments: [] } });
  assert.deepEqual(await f.run('edit'), result);
  assert.equal(f.rows.length, 0); assert.deepEqual(f.calls.map(call => call.type), ['remove']);
});

test('编辑只返回可还原的内嵌图文，不能返回本地图片路径', async () => {
  const f = fixture([message('native-one', { context: { prompt: '合成正文', imageAttachments: [{ src: image }] } })]);
  assert.equal((await f.run('read')).messages[0].canEdit, true);
  assert.deepEqual((await f.run('edit')).draft, { text: '合成正文', images: [image], attachments: [] });
  const local = fixture([message('native-one', { context: { imageAttachments: [{ localPath: '/example/image.png' }] } })]);
  assert.equal((await local.run('read')).messages[0].canEdit, false);
  await assert.rejects(local.run('edit', { commandId: 'command-local' }), /NATIVE_QUEUE_COMPLEX/);
  assert.equal(local.calls.length, 0);
});

test('复杂富上下文禁止编辑，不能先移除再截断上下文', async t => {
  const cases = [
    ['插件上下文', { context: { plugin: { id: 'synthetic-plugin' } } }],
    ['IDE上下文', { context: { ideContext: { text: '合成选区' } } }],
    ['新增文件', { context: { addedFiles: ['/example/file.txt'] } }],
    ['文件附件', { context: { fileAttachments: [{ path: '/example/file.txt', label: '合成附件' }] } }],
    ['提交设置', { submissionOptions: { approvalPolicy: 'on-request' } }],
    ['写作上下文', { writingBlockAdditionalContext: { text: '合成写作' } }],
    ['多用户上下文', { multiUserMessageSender: { id: 'synthetic-sender' } }],
    ['超长正文', { text: '合'.repeat(32001) }],
  ];
  for (const [label, extra] of cases) await t.test(label, async () => {
    const f = fixture([message('native-one', extra)]), before = structuredClone(f.rows);
    assert.equal((await f.run('read')).messages[0].canEdit, false);
    await assert.rejects(f.run('edit'), /NATIVE_QUEUE_COMPLEX/);
    assert.deepEqual(f.rows, before); assert.equal(f.calls.length, 0);
  });
});

test('撤回时 PC 已改为复杂内容则用完整原生位置回执恢复，保留并发新增', async () => {
  const f = fixture([message('native-before'), message(), message('native-after')]);
  const rich = message('native-one', { context: { prompt: '合成更新', threadReferences: [{ threadId: 'synthetic-reference' }] }, writingBlockAdditionalContext: { text: '合成写作块' } });
  f.beforeRemove = () => { f.rows[1] = rich; f.rows.push(message('pc-concurrent')); };
  await assert.rejects(f.run('edit'), /NATIVE_QUEUE_COMPLEX/);
  assert.deepEqual(f.rows.map(row => row.id), ['native-before', 'native-one', 'native-after', 'pc-concurrent']);
  assert.deepEqual(f.rows[1], rich);
  assert.deepEqual(f.calls[1].receipt, { message: rich, index: 1, previousMessageId: 'native-before', nextMessageId: 'native-after' });
  await assert.rejects(f.run('edit'), /NATIVE_QUEUE_COMPLEX/);
  assert.deepEqual(f.calls.map(call => call.type), ['remove', 'restore']);
});

test('未知、发送中和待确认状态禁用全部操作且不调用协调器', async t => {
  for (const status of ['outcome-unknown', 'sending', 'pending']) await t.test(status, async () => {
    const f = fixture([message('native-one', { submission: { status } })]);
    const row = (await f.run('read')).messages[0];
    assert.equal(row.state, status === 'outcome-unknown' ? 'unknown' : 'sending');
    assert.equal(row.canEdit, false); assert.equal(row.canCancel, false); assert.equal(row.canSteer, false);
    for (const action of ['edit', 'cancel', 'steer']) await assert.rejects(f.run(action, { commandId: 'command-' + action, expectedTurnId: 'turn-one' }), /NATIVE_QUEUE_CHANGED/);
    assert.equal(f.calls.length, 0); assert.equal(f.rows.length, 1);
  });
});

test('追加要求预期轮次仍在运行，旧轮次或空闲都保留消息', async t => {
  for (const execution of [{ inProgress: true, activeTurnId: 'turn-two' }, { inProgress: false, activeTurnId: 'turn-one' }]) await t.test(JSON.stringify(execution), async () => {
    const f = fixture(); f.execution = execution;
    await assert.rejects(f.run('steer', { expectedTurnId: 'turn-one' }), /NATIVE_QUEUE_TURN_CHANGED/);
    assert.equal(f.rows.length, 1); assert.equal(f.calls.length, 0);
  });
});

test('追加在 prepare 和最终回调再次核对轮次，变化后不能投递', async t => {
  for (const phase of ['prepare', '最终回调']) await t.test(phase, async () => {
    const f = fixture(); let delivered = false;
    f.onSend = async ({ prepare, assertTurn }) => {
      if (phase === '最终回调') await prepare();
      f.execution.activeTurnId = 'turn-two';
      if (phase === 'prepare') await prepare(); else await assertTurn();
      delivered = true; return { status: 'sent' };
    };
    await assert.rejects(f.run('steer', { expectedTurnId: 'turn-one' }), /NATIVE_QUEUE_TURN_CHANGED/);
    assert.equal(delivered, false); assert.equal(f.rows.length, 1);
    assert.deepEqual(f.calls.map(call => call.type), ['send']);
  });
});

test('追加 prepare 保留原文附件和恢复对象，并继承桌面设置而不覆盖权限', async () => {
  const original = message('native-one', { context: { prompt: '合成格式正文', workspaceRoots: ['/example/project'], fileAttachments: [{ label: '合成文件', path: '/example/file.txt' }], imageAttachments: [{ localPath: '/example/image.png' }, { src: image }] } });
  const f = fixture([original]);
  const result = await f.run('steer', { expectedTurnId: 'turn-one' });
  assert.deepEqual(result, { ok: true, queued: false });
  const prepared = f.prepared;
  assert.equal(prepared.conversationId, threadId); assert.equal(prepared.executionHostId, hostId);
  assert.deepEqual(prepared.resume, { conversationId: threadId, workspaceRoots: ['/example/project'], model: null, reasoningEffort: null, collaborationMode: null });
  assert.deepEqual(prepared.start.context, { inheritThreadSettings: true, restoreMessage: original });
  assert.deepEqual(prepared.steer.restoreMessage, original);
  assert.deepEqual(prepared.steer.input, [
    { type: 'text', text: '合成格式正文\n\n# 用户附带的文件\n\n## 合成文件: /example/file.txt', text_elements: [] },
    { type: 'localImage', path: '/example/image.png' }, { type: 'image', url: image },
  ]);
  assert.deepEqual(prepared.start.request.input, prepared.steer.input);
  assert.equal(prepared.start.request.clientUserMessageId, original.id);
  for (const key of ['approvalPolicy', 'sandbox', 'sandboxPolicy', 'permissions', 'permissionProfile']) assert.equal(JSON.stringify(prepared).includes('"' + key + '"'), false);
  assert.deepEqual(f.calls[0].options, {});
  assert.deepEqual(await f.run('steer', { expectedTurnId: 'turn-one' }), result);
  assert.equal(f.calls.length, 1); assert.equal(f.rows.length, 0);
});

test('插件引用和桌面禁止立即发送的消息不能追加，不接受非 sent 回执', async t => {
  for (const extra of [{ context: { prompt: 'plugin://synthetic/tool' } }, { canSendNow: false }]) await t.test(JSON.stringify(extra), async () => {
    const f = fixture([message('native-one', extra)]);
    assert.equal((await f.run('read')).messages[0].canSteer, false);
    await assert.rejects(f.run('steer', { expectedTurnId: 'turn-one' }), /NATIVE_QUEUE_COMPLEX/);
    assert.equal(f.calls.length, 0);
  });
  await t.test('未投递回执', async () => {
    const f = fixture(); f.onSend = async () => ({ status: 'queued' });
    await assert.rejects(f.run('steer', { expectedTurnId: 'turn-one' }), /NATIVE_QUEUE_CHANGED/);
    assert.equal(f.rows.length, 1);
  });
});
