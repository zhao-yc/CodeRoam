import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const code = ['submission-task-state', 'submission-tasks'].map(name => fs.readFileSync('apps/mobile/services/' + name + '.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '')).join('\n');
const plain = value => JSON.parse(JSON.stringify(value));
function json(value) { if (value == null || typeof value !== 'object') return value; Object.values(value).forEach(json); for (const suffix of ['String', 'Number', 'Boolean']) Object.defineProperty(value, 'get' + suffix, { configurable: true, value(key) { return this[key] ?? null; } }); return value; }
const task = (id, overrides = {}) => ({ id, position: 1, kind: 'newConversation', method: '', title: '合成任务', threadId: '', projectId: 'project-a', state: 'queued', stage: '', error: '', createdAt: 100, startedAt: 0, completedAt: 0, updatedAt: 100, dismissed: false, steps: [], ...overrides });

/** 执行真实 UTS 服务，替换传输与附件读取，不连接真实桌面。 */
function fixture() {
  const calls = [], storage = new Map(), tasks = new Map();
  const connection = { cacheNamespace: 'pair-a', hostId: 'pc-a', connected: true, computers: [{ id: 'pc-a', online: true, instanceGeneration: 'generation-a' }] };
  let failSubmit = false, omitTask = false, failReads = 0, invalidReceipt = false, failAcceptedSave = false;
  const bridge = {
    foreground: true,
    clearCommand(id, host) { calls.push({ method: '清理手机保护', id, host }); },
    async requestTaskChannel(hostId, method, params) {
      calls.push({ hostId, method, params: plain(params) });
      if (method === 'tasks.submit') {
        if (!omitTask) tasks.set(params.taskId, task(params.taskId));
        if (failSubmit) throw new Error('合成回执丢失');
        if (invalidReceipt) return json({ accepted: true, taskId: 'synthetic-other-task' });
        return json({ accepted: true, taskId: params.taskId, task: tasks.get(params.taskId) });
      }
      if (method === 'tasks.list' && params.taskId) { if (failReads > 0) { failReads--; throw new Error('合成读取暂时超时'); } return json({ tasks: tasks.has(params.taskId) ? [tasks.get(params.taskId)] : [] }); }
      if (method === 'tasks.watch') return json({ supportsTaskQueue: true, revision: 1, paused: false, blockerId: '', tasks: [...tasks.values()], now: Date.now() });
      throw new Error('意外接口：' + method);
    },
    async requestTaskUpload(hostId, method, params) { calls.push({ hostId, method, params: plain(params) }); return json(method === 'attachment.chunk' ? { nextChunk: params.index + 1, received: 3 } : { nextChunk: 0, complete: method === 'attachment.finish' }); },
  };
  const context = vm.createContext({ reactive: value => value, settleSubmission: (hostId,id,success) => calls.push({method:'消费草稿',hostId,id,success}), watch() {}, bridge, connection, uni: { getStorageSync: key => storage.get(key) ?? '', setStorageSync(key, value) {
    if (failAcceptedSave && JSON.parse(value).some(record => record.accepted)) throw Error('合成存储失败');
    storage.set(key, value);
  } }, FILE_CHUNK_BYTES: 3, readFileBase64: async () => 'YWJj', copyThreadMentions: items => items.map(item => ({ ...item })), setTimeout, clearTimeout, setInterval });
  vm.runInContext("for (const suffix of ['String','Number','Boolean']) Object.defineProperty(Object.prototype,'get'+suffix,{value:function(key){return this[key]??null;},configurable:true});\n" + stripTypeScriptTypes(code, { mode: 'transform' }) + '\nglobalThis.subject={submissionTasks,submissionVisible,acceptSubmissionSnapshot,submitTask,submitTaskCommand,submitNewConversationTask,awaitSubmissionResult,checkPendingSubmission,acknowledgePendingSubmission,refreshSubmissionTasks};', context);
  context.subject.submissionTasks.instances.push({ hostId: 'pc-a', generation: 'generation-a', supported: true, loading: false, error: '', snapshot: null, clockOffset: 0 });
  context.subject.submissionTasks.namespace = connection.cacheNamespace;
  const draft = { hostId: 'pc-a', cacheNamespace: 'pair-a', projectId: 'project-a', choices: { model: 'model-a', effort: null }, input: { text: '合成首条消息', images: [], files: [{ id: 'synthetic-upload-0001', name: 'example.txt', size: 3, source: 'synthetic', data: '', status: 'local', progress: 0, error: '' }] }, plugins: [], threadMentions: [], threadMentionRevision: 0 };
  return { ...context.subject, bridge, calls, storage, tasks, connection, draft, loseReceipt({ missing = false } = {}) { failSubmit = true; omitTask = missing; }, failReadOnce() { failReads = 1; }, returnInvalidReceipt() { invalidReceipt = true; }, failSavingAccepted() { failAcceptedSave = true; } };
}

test('完成五秒后移出，刷新不会延长计时；异常和等待继续任务保留', () => {
  const f = fixture(), item = task('synthetic-task-0001', { state: 'succeeded', completedAt: 10000 });
  assert.equal(f.submissionVisible(item, 14999), true);
  assert.equal(f.submissionVisible(item, 15000), false);
  for (const state of ['failed', 'unknown', 'waiting_resume']) assert.equal(f.submissionVisible({ ...item, state }, 999999), true);
  assert.equal(f.submissionVisible({ ...item, state: 'unknown', dismissed: true }, 11000), false);
});

test('任务附件先完整上传再入队，手机不创建聊天；确认后消费原草稿', async () => {
  const f = fixture(), progress = [];
  const id = await f.submitNewConversationTask(f.draft, 'desktopIpc', message => progress.push(message));
  const writes = f.calls.filter(call => call.method !== 'tasks.watch');
  assert.deepEqual(writes.map(call => call.method), ['attachment.begin', 'attachment.chunk', 'attachment.finish', 'tasks.submit']);
  assert.ok(writes.slice(0, 3).every(call => call.params.taskId === id && !('threadId' in call.params) && !('draftId' in call.params)));
  assert.equal(writes.at(-1).params.kind, 'newConversation');
  assert.equal(writes.at(-1).params.payload.text, '合成首条消息');
  assert.deepEqual(writes.at(-1).params.payload.choices, { model: 'model-a', permissionMode: 'default' });
  assert.equal(f.draft.input.text, ''); assert.equal(f.draft.input.files.length, 0);
  assert.ok(progress.some(message => message.includes('99%')));
});

test('入队回执丢失只查询原编号，确认存在后继续，不再次提交', async () => {
  const f = fixture(); f.loseReceipt();
  const id = 'synthetic-task-0002';
  await f.submitTask('pc-a', id, 'newConversation', json({ projectId: 'project-a' }));
  assert.equal(f.calls.filter(call => call.method === 'tasks.submit').length, 1);
  assert.equal(f.calls.find(call => call.method === 'tasks.list').params.taskId, id);
  assert.equal(f.submissionTasks.pending[0].accepted, true);
});

test('无效入队回执保留原编号并标记结果待核对', async () => {
  const f = fixture();
  f.returnInvalidReceipt();
  const id = 'synthetic-invalid-receipt';
  await assert.rejects(f.submitTask('pc-a', id, 'newConversation', json({})), {name:'OUTCOME_UNKNOWN'});
  const record = JSON.parse([...f.storage.values()][0])[0];
  assert.equal(record.id, id);
  assert.equal(record.unknown, true);
  assert.equal(record.accepted, false);
  await assert.rejects(f.submitTask('pc-a', 'synthetic-another-task', 'newConversation', json({})), /尚未确认/);
  assert.equal(f.calls.filter(call => call.method === 'tasks.submit').length, 1);
});

test('有效入队回执不因后续本地存储失败而丢失', async () => {
  const f = fixture();
  f.failSavingAccepted();
  const id = await f.submitNewConversationTask(f.draft, 'desktopIpc', () => {});
  assert.equal(f.submissionTasks.pending[0].accepted, true);
  assert.equal(JSON.parse([...f.storage.values()][0])[0].id, id);
  assert.equal(f.draft.input.text, '');
  assert.equal(f.calls.filter(call => call.method === 'tasks.submit').length, 1);
});

test('最后一个附件完成时切换连接，原草稿保留且不会入队', async () => {
  const f = fixture();
  const upload = f.bridge.requestTaskUpload;
  f.bridge.requestTaskUpload = async (...args) => {
    const result = await upload(...args);
    if (args[1] === 'attachment.finish') f.connection.cacheNamespace = 'pair-b';
    return result;
  };
  await assert.rejects(f.submitNewConversationTask(f.draft, 'desktopIpc', () => {}), /连接目标已变化/);
  assert.equal(f.calls.some(call => call.method === 'tasks.submit'), false);
  assert.equal(f.draft.input.text, '合成首条消息');
  assert.equal(f.draft.input.files.length, 1);
});

test('新聊天提交固定界面默认强度，不能因未重复点选而丢失，也不推断权限确认', async () => {
  for (const mode of ['desktopIpc', 'nativeDraft']) {
    const f = fixture(); f.draft.choices = {};
    const execution = { model: 'model-a', effort: 'xhigh', serviceTier: '', mode: 'default' };
    await f.submitNewConversationTask(f.draft, mode, () => {
      // 附件上传与入队异步期间刷新了电脑默认值，原提交仍须保持点击时的档位。
      execution.effort = 'low';
    }, execution);
    const sent = f.calls.find(call => call.method === 'tasks.submit');
    assert.deepEqual(sent.params.payload.choices, { model: 'model-a', effort: 'xhigh', serviceTier: '', mode: 'default', permissionMode: 'default' });
    assert.deepEqual(plain(f.draft.choices), {});
  }
});

test('补全默认执行设置后仍消费原选择快照，保留上传期间新选项', async () => {
  const f = fixture(); f.draft.choices = { effort: 'xhigh' };
  await f.submitNewConversationTask(f.draft, 'desktopIpc', () => { f.draft.choices = { effort: 'high' }; },
    { model: 'model-a', effort: 'xhigh', serviceTier: '', mode: 'default' });
  assert.equal(f.calls.find(call => call.method === 'tasks.submit').params.payload.choices.effort, 'xhigh');
  assert.equal(f.draft.choices.effort, 'high');
});

test('未解析的默认强度不能开始上传或提交', async () => {
  const f = fixture();
  await assert.rejects(f.submitNewConversationTask(f.draft, 'desktopIpc', () => {},
    { model: 'model-a', effort: '', serviceTier: '', mode: 'default' }), /执行设置尚未读取完成/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.draft.input.text, '合成首条消息');
});

test('未找到的丢失回执保留本地保护和输入；重复提交被阻止直到人工核对', async () => {
  const f = fixture(); f.loseReceipt({ missing: true });
  await assert.rejects(f.submitNewConversationTask(f.draft, 'nativeDraft', () => {}), /入队尚未确认/);
  assert.equal(f.draft.input.text, '合成首条消息'); assert.equal(f.draft.input.files.length, 1);
  assert.equal(f.submissionTasks.pending[0].unknown, true);
  await assert.rejects(f.submitTask('pc-a', 'synthetic-task-0003', 'newConversation', json({})), /上次提交/);
  assert.equal(f.calls.filter(call => call.method === 'tasks.submit').length, 1);
  const original = f.submissionTasks.pending[0].id;
  await assert.rejects(f.checkPendingSubmission('pc-a', original), /尚未查到/);
  f.acknowledgePendingSubmission('pc-a', original);
  assert.equal(f.submissionTasks.pending.length, 0);
});

test('旧实例代次状态被拒绝；最终业务回执按原任务编号读取', async () => {
  const f = fixture();
  assert.equal(f.acceptSubmissionSnapshot('pc-a', 'old-generation', json({ supportsTaskQueue: true, revision: 5, tasks: [], now: Date.now() })), false);
  const id = 'synthetic-task-0004';
  f.tasks.set(id, task(id, { state: 'succeeded', completedAt: 1000, result: { edited: true, draft: { text: '合成原队列草稿', images: [] } } }));
  const result = await f.awaitSubmissionResult('pc-a', id, 'pair-a');
  assert.equal(result.draft.text, '合成原队列草稿');
  assert.equal(f.calls.find(call => call.method === 'tasks.list').params.taskId, id);
});

test('已接纳任务的状态读取暂时超时只重试读取，不重发任务', async () => {
  const f = fixture(), id = 'synthetic-task-0005';
  f.tasks.set(id, task(id, { state: 'succeeded', result: { ok: true } }));
  f.failReadOnce();
  const result = await f.awaitSubmissionResult('pc-a', id, 'pair-a');
  assert.equal(result.ok, true);
  assert.equal(f.calls.filter(call => call.method === 'tasks.list').length, 2);
  assert.equal(f.calls.filter(call => call.method === 'tasks.submit').length, 0);
});

test('后台新建任务终结后清理手机已接纳编号，不依赖新建页面等待', async () => {
  const f = fixture(), id = 'synthetic-task-0006';
  await f.submitTask('pc-a', id, 'newConversation', json({ projectId: 'project-a' }));
  assert.equal(f.submissionTasks.pending.length, 1);
  f.tasks.set(id, task(id, { state: 'succeeded', completedAt: Date.now() }));
  await f.refreshSubmissionTasks('pc-a');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.submissionTasks.pending.length, 0);
});

test('过期回执只提示核对，不将缺失的业务回执当作成功', async () => {
  const f = fixture(), id = 'synthetic-task-expired';
  f.tasks.set(id, task(id, { state: 'succeeded', historyExpired: true }));
  await assert.rejects(f.awaitSubmissionResult('pc-a', id, 'pair-a'), /执行记录已过保留期.*不会重发/);
  assert.equal(f.calls.filter(call => call.method === 'tasks.submit').length, 0);
});

test('权限入队释放操作锁但不冒充生效；旧任务完成不能解除下一项提交的锁', async () => {
  const script = fs.readFileSync('apps/mobile/components/permissions-control/permissions-control.uvue', 'utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm, '');
  const emitted = [], watches = [], writes = [];
  const permissions = { mode: 'read-only', revision: 'permissions-a', options: ['default', 'read-only', 'auto-review'].map(id => ({ id, enabled: true })) };
  const props = { threadId: 'thread-a', projectId: '', selectedMode: '', disabled: false, active: true, draftId: '', nativeDraft: false, nativeState: null, nativeStatus: '', nativeBusy: false, paneLeft: 0, paneWidth: 390 };
  const connection = { hostId: 'pc-a', connected: true, subscriptionRevision: 1, computers: [{ id: 'pc-a', online: true }], snapshot: { threadId: 'thread-a', supportsPermissionSettings: true, permissionSettings: permissions } };
  const tasks = { accepted: { revision: 0, method: '', hostId: '', threadId: '', taskId: '' } };
  const context = vm.createContext({ connection, submissionTasks: tasks, ref: value => ({ value }), computed: getter => ({ get value() { return getter(); } }), watch(source, callback, options) { watches.push({ source, callback }); if (options?.immediate) callback(source.value); }, onUnmounted() {}, defineProps: () => props, withDefaults: value => value, defineEmits: () => (...args) => emitted.push(args), permissionLabel: value => value,
    bridge: { request(method) { if (method.endsWith('.read')) return Promise.resolve(json(permissions)); return new Promise(resolve => writes.push({ resolve })); }, pendingCommand: () => 'synthetic-permission-' + writes.length },
    uni: { getWindowInfo: () => ({ windowWidth: 390, windowHeight: 760 }), getElementById: () => null },
  });
  vm.runInContext(stripTypeScriptTypes(script, { mode: 'transform' }) + '\nglobalThis.subject={load,choose,busy,pendingQueued,state};', context);
  const f = context.subject; await f.load();
  const first = f.choose('default'); assert.equal(f.busy.value, true);
  const acceptedWatch = watches.find(item => /submissionTasks\.accepted/.test(item.source.toString())).callback;
  tasks.accepted = { revision: 1, method: 'thread.permissions.update', hostId: 'pc-a', threadId: 'thread-a', taskId: 'synthetic-permission-1' }; acceptedWatch();
  assert.equal(f.busy.value, false); assert.equal(f.pendingQueued.value, true); assert.equal(f.state.value.mode, 'read-only');
  assert.equal(emitted.some(event => event[0] === 'applied'), false);
  const second = f.choose('auto-review'); assert.equal(f.busy.value, true);
  writes[0].resolve(json({ ...permissions, mode: 'default' })); await first;
  assert.equal(f.busy.value, true, '第一项迟到成功不能释放第二项的入队锁');
  tasks.accepted = { revision: 2, method: 'thread.permissions.update', hostId: 'pc-a', threadId: 'thread-a', taskId: 'synthetic-permission-2' }; acceptedWatch();
  assert.equal(f.busy.value, false);
  writes[1].resolve(json({ ...permissions, mode: 'auto-review' })); await second;
  assert.equal(f.state.value.mode, 'auto-review'); assert.equal(emitted.filter(event => event[0] === 'applied').length, 1);
});

test('汇总选项任务仅在正文成功后消费草稿，明确失败和未知结果保留输入', async () => {
  for (const state of ['succeeded','failed','unknown']) {
    const f=fixture(),id='synthetic-bundled-'+state;
    const result=f.submitTaskCommand('pc-a','turn.send',json({threadId:'thread',text:'合成正文',choices:{effort:'high'}}),id);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.calls.some(call=>call.method==='消费草稿'),false);
    Object.assign(f.tasks.get(id),{kind:'command',method:'turn.send',threadId:'thread',state,error:state==='succeeded'?'':'合成失败',result:{}});
    if(state==='succeeded')await result;else await assert.rejects(result);
    const settled=f.calls.filter(call=>call.method==='消费草稿');
    if(state==='unknown'){assert.equal(settled.length,0);assert.equal(f.calls.some(call=>call.method==='清理手机保护'),false);}
    else assert.equal(settled.at(-1).success,state==='succeeded');
  }
});
