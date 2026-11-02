import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ThreadMentionDesktop } from '../apps/bridge/thread-mention-desktop.mjs';
import { prepareThreadMentionsNative, threadMentionExpression } from '../apps/bridge/thread-mention-expression.mjs';
import { parseThreadMentionModules, threadMentionModules } from '../apps/bridge/thread-mention-modules.mjs';
import { nativeDraftExpression } from '../apps/bridge/native-draft-expression.mjs';

const currentId = '11111111-1111-4111-8111-111111111111', otherId = '22222222-2222-4222-8222-222222222222';
const modules = { initial: 'app-initial-abc.js', primary: 'app-primary-def.js', capability: 'thread-reference-capability-abc.js', formatter: 'fmt', readCapability: 'read', managerHostAtom: 'manager', conversationAtom: 'metadata', submitAtom: 'submit' };
const refs = [{ hostId: 'local', threadId: otherId }];
const format = values => '\n## Referenced chats with Codex:\nMUST call `read_thread`\n' + JSON.stringify(values);

/** 合成 scope 只开放能力和主机元数据，读取正文或调用写方法即失败。 */
function nativeFixture({ kind = 'local', manager = 'durable', host = 'local', available = true, destination = 'local', visible = true } = {}) {
  const calls = [];
  const service = { newThreadDestination: { kind: 'app-server', hostId: destination } };
  const scope = { node: {}, value: kind === 'local' ? { kind, conversationId: currentId } : { kind, clientThreadId: 'client-new-thread:synthetic' }, get(atom, input) {
    calls.push({ atom, input });
    if (atom === 'manager') return manager;
    if (atom === 'metadata') return { hostId: host, get turns() { throw Error('禁止读取正文'); } };
    if (atom === 'submit') return service;
    throw Error('禁止读取其他状态');
  }, set() { throw Error('禁止写状态'); } };
  const initial = { manager: 'manager', metadata: 'metadata', fmt(input) {
    assert.deepEqual(Object.keys(input).sort(), ['addedFiles', 'fileAttachments', 'ideContext', 'imageAttachments', 'prompt', 'threadReferences'].sort());
    assert.equal(input.prompt, ''); assert.equal(input.threadReferences.some(value => 'title' in value), false);
    return format(input.threadReferences);
  } };
  const root = { getBoundingClientRect: () => ({ width: visible ? 300 : 0 }), closest: () => null, getAttribute: () => null, parentElement: null, __reactFiber$test: { updateQueue: { memoCache: { data: [[scope]] } } } };
  const document = { querySelectorAll: () => [root] };
  const load = async url => url.includes('app-initial-') ? initial : url.includes('app-primary-') ? { submit: 'submit' } : { read: id => available && id === currentId };
  const run = (input, bound = null) => vm.runInNewContext('(' + prepareThreadMentionsNative.toString().replaceAll('await import(', 'await load(') + ')(modules,input,bound)', { modules, input, bound, document, load });
  return { run, scope, calls, root, initial, service };
}

/** 合成适配器模拟已鉴权订阅和绑定实例，生产读取器仍执行全部身份检查。 */
function desktopFixture({ instance = true, evaluate, targetCount = 1 } = {}) {
  const entry = { owner: { hostId: 'durable', clientId: 'desktop-synthetic' }, watchers: new Set(['phone']) };
  const adapter = { client: {}, native: { processId: 101 }, conversations: new Map([[currentId, entry]]), subscribed(id, device) { assert.equal(id, currentId); assert.ok(entry.watchers.has(device)); return entry; } };
  if (instance) adapter.client.instance = { pid: 101, port: 12345, executable: '/Synthetic.app/Contents/MacOS/Codex', generation: 'one', alive: true, verify: async () => {} };
  const evaluated = [];
  const reader = new ThreadMentionDesktop({ discover: async () => { assert.equal(instance, false, '有实例时不得扫描全局端口'); return [{ pid: 101, port: 12345, executable: '/Synthetic.app/Contents/MacOS/Codex' }]; },
    fetcher: async () => ({ ok: true, text: async () => JSON.stringify(Array.from({ length: targetCount }, (_, n) => ({ type: 'page', id: 'SYNTHETIC' + n, url: 'app://-/index.html', webSocketDebuggerUrl: 'wss://example.com/untrusted' }))) }),
    resolveModules: () => modules,
    evaluate: async (url, expression) => { evaluated.push({ url, expression }); return evaluate ? evaluate(adapter) : { supported: true, references: refs, contextText: format(refs) }; },
  });
  return { reader, adapter, entry, evaluated };
}

test('已有聊天的 durable 管理器仅在明确映射到原生 local 且真实能力为真时通过', async () => {
  const f = nativeFixture();
  const result = await f.run({ threadId: currentId, ownerHostId: 'durable', ids: [otherId, otherId, currentId] });
  assert.equal(result.supported, true); assert.equal(JSON.stringify(result.references), JSON.stringify(refs)); assert.equal(result.contextText, format(refs));
  assert.equal(f.calls.some(value => !['manager', 'metadata'].includes(value.atom)), false);
});

test('具体聊天无须当前可见；只使用现有 scope 查询编号对应的元数据', async () => {
  const f = nativeFixture(); f.scope.value.conversationId = otherId;
  assert.equal((await f.run({ threadId: currentId, ownerHostId: 'durable', ids: [otherId] })).supported, true);
});

test('无编号探测可使用可见已有聊天，不能把 read_thread 缺省、远端或错误归属当支持', async () => {
  const result = await nativeFixture().run({ ids: [] });
  assert.equal(JSON.stringify(result), JSON.stringify({ supported: true, references: [], contextText: '' }));
  for (const options of [{ available: false }, { host: 'remote' }, { host: null }, { visible: false }]) await assert.rejects(nativeFixture(options).run({ ids: [] }), /THREAD_MENTION_UNSUPPORTED/);
  for (const options of [{ available: false }, { host: null }, { host: 'remote' }, { manager: 'local' }]) await assert.rejects(nativeFixture(options).run({ threadId: currentId, ownerHostId: 'durable', ids: [otherId] }), /THREAD_MENTION_UNSUPPORTED/);
});

test('新草稿及 boundScope 必须有已注册的原生 local 目标，不借用别的可见聊天', async () => {
  const f = nativeFixture({ kind: 'new', visible: false });
  assert.equal((await f.run({ ids: [otherId] }, f.scope)).contextText, format(refs));
  await assert.rejects(nativeFixture({ kind: 'new', destination: 'durable' }).run({ ids: [] }), /THREAD_MENTION_UNSUPPORTED/);
  const existing = nativeFixture(); await assert.rejects(existing.run({ ids: [otherId] }, existing.scope), /THREAD_MENTION_UNSUPPORTED/);
});

test('规范输出不接受任意编号、模块路径或格式化器返回异常', async () => {
  const f = nativeFixture();
  await assert.rejects(f.run({ threadId: currentId, ownerHostId: 'durable', ids: ['x");send()'] }), /THREAD_MENTION_UNSUPPORTED/);
  f.initial.fmt = () => '未包含原生读线程指令';
  await assert.rejects(f.run({ threadId: currentId, ownerHostId: 'durable', ids: [otherId] }), /THREAD_MENTION_UNSUPPORTED/);
  assert.throws(() => threadMentionExpression({ ...modules, initial: 'https://example.com/module.js' }, {}));
  assert.throws(() => threadMentionExpression({ ...modules, formatter: 'x);send()' }, {}));
});

test('默认实例从 adapter.client.instance 获取端口，Mac 不调用 Windows 发现器', async () => {
  const f = desktopFixture();
  try {
    assert.deepEqual(await f.reader.prepare(f.adapter, { threadId: currentId, deviceId: 'phone', ids: [otherId] }), { supported: true, references: refs, contextText: format(refs) });
    assert.equal(f.evaluated.length, 1); assert.equal(f.evaluated[0].url, 'ws://127.0.0.1:12345/devtools/page/SYNTHETIC0');
    assert.equal(f.reader.trusted(f.reader.ports[0]), true);
  } finally { f.reader.close(); }
});

test('无引用时返回能力探测，未知能力为 false，非空引用明确失败且不泄露路径', async () => {
  const f = desktopFixture({ evaluate: () => ({ supported: true, references: [], contextText: '' }) });
  try { assert.deepEqual(await f.reader.prepare(f.adapter), { supported: true, references: [], contextText: '' }); assert.equal(await f.reader.capabilities(f.adapter), true); } finally { f.reader.close(); }
  const bad = desktopFixture({ evaluate: () => { throw Error('/private/synthetic/token'); } });
  try {
    assert.equal((await bad.reader.prepare(bad.adapter)).supported, false);
    await assert.rejects(bad.reader.prepare(bad.adapter, { ids: [otherId] }), error => error.code === 'THREAD_MENTION_UNSUPPORTED' && !error.message.includes('/private'));
  } finally { bad.reader.close(); }
});

test('读取期间实例、所有者、订阅或端口变化丢弃结果', async () => {
  for (const change of [f => f.adapter.client.instance.generation = 'two', f => f.entry.owner.clientId = 'changed', f => f.entry.watchers.clear(), f => f.adapter.client.instance.port = 12346, f => f.adapter.client.instance = { ...f.adapter.client.instance }]) {
    const f = desktopFixture({ evaluate: () => { change(f); return { supported: true, references: refs, contextText: format(refs) }; } });
    try { await assert.rejects(f.reader.prepare(f.adapter, { threadId: currentId, deviceId: 'phone', ids: [otherId] }), { code: 'THREAD_MENTION_CHANGED' }); } finally { f.reader.close(); }
  }
});

test('切换实例清空端口缓存；无端口及已停止实例不回退扫描', async () => {
  const f = desktopFixture();
  try {
    await f.reader.prepare(f.adapter, { ids: [otherId] });
    f.adapter.client.instance = { ...f.adapter.client.instance, pid: 102, port: 12346, generation: 'two' };
    await f.reader.prepare(f.adapter, { ids: [otherId] });
    assert.equal(f.reader.ports.length, 1); assert.equal(f.reader.ports[0].pid, 102); assert.match(f.evaluated.at(-1).url, /:12346\//);
    f.adapter.client.instance.port = undefined;
    await assert.rejects(f.reader.prepare(f.adapter, { ids: [otherId] }), { code: 'THREAD_MENTION_UNSUPPORTED' });
    f.adapter.client.instance.alive = false; assert.equal((await f.reader.prepare(f.adapter)).supported, false);
  } finally { f.reader.close(); }
});

test('拒绝重复页面、伪造原生主机、附加字段和错误上下文', async () => {
  for (const options of [{ targetCount: 2 }, { evaluate: () => ({ supported: true, references: [{ hostId: 'bridge-computer', threadId: otherId }], contextText: format(refs) }) }, { evaluate: () => ({ supported: true, references: [{ ...refs[0], title: '不可信标题' }], contextText: format(refs) }) }, { evaluate: () => ({ supported: true, references: refs, contextText: '任意文本' }) }]) {
    const f = desktopFixture(options); try { await assert.rejects(f.reader.prepare(f.adapter, { ids: [otherId] }), { code: 'THREAD_MENTION_UNSUPPORTED' }); } finally { f.reader.close(); }
  }
});

/** 整个安装包均为合成字符串，用不同压缩名验证定位算法而非安装版本快照。 */
function moduleFixture() {
  const initial = 'function FormatX({prompt:p,threadReferences:r=[]}){return p}function KeyX(x){return`thread-reference-capability:${x}`}function StoredX(x,y){return typeof window>"u"?y:cache.get(x)};' +
    'MgrX=atom(root,(x,{get:g})=>g(g(ParentX,x))?.managerHostId??null);let row=scope.get(MetaX,{hostId:h,threadId:id});if(row!=null)return saved=h,{managerHostId:h,conversationHostId:row.hostId??null};' +
    'const heading="## Referenced chats with Codex:";const instruction="MUST call `read_thread`";export{FormatX as changedFmt,KeyX as changedKey,StoredX as changedStored,MgrX as changedManager,MetaX as changedMetadata};';
  const primary = 'function RegX(s,v){s.set(SubmitX,v)}RegX(s,{submit:f,clearDraftAttachments:g});export{SubmitX as changedSubmit};';
  const capability = 'import{changedStored as st,changedKey as ky}from"./app-initial-abc.js";function GateX(id){return st(ky(id),!1)}export{GateX as changedGate};';
  const files = new Map([['webview/assets/app-initial-abc.js', initial], ['webview/assets/app-primary-def.js', primary], ['webview/assets/thread-reference-capability-abc.js', capability]]);
  return { files, text: name => files.get(name) };
}

test('安装包解析按语义和 export 动态定位，版本不兼容及缺省开启都失败', () => {
  const f = moduleFixture();
  assert.deepEqual(parseThreadMentionModules(f), { initial: modules.initial, primary: modules.primary, capability: modules.capability, formatter: 'changedFmt', readCapability: 'changedGate', managerHostAtom: 'changedManager', conversationAtom: 'changedMetadata', submitAtom: 'changedSubmit' });
  const key = 'webview/assets/thread-reference-capability-abc.js'; f.files.set(key, f.files.get(key).replace('!1', '!0'));
  assert.throws(() => parseThreadMentionModules(f), { code: 'THREAD_MENTION_UNSUPPORTED' });
  assert.throws(() => threadMentionModules('/private/other/app.exe'), error => error.code === 'THREAD_MENTION_UNSUPPORTED' && !error.message.includes('/private'));
});

/** 执行生产发送函数，权限入口及传输均为合成替身，不触碰真实桌面。 */
function draftFixture({ gate = async () => {}, destination = 'local' } = {}) {
  const source = fs.readFileSync(new URL('../apps/bridge/native-draft-expression.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('async function sendNativeDraft('), source.indexOf('\nexport function nativeDraftExpression'));
  const commands = new Map(), sent = [];
  const input = { clientDraftId: 'client-new-thread:synthetic', projectId: 'synthetic', projectCwd: '/synthetic', commandId: 'one', text: '合成首条消息', threadReferences: refs };
  const service = { newThreadDestination: { kind: 'app-server', hostId: destination }, async submit(value) { sent.push(value); } };
  const scope = { value: { kind: 'new', clientThreadId: input.clientDraftId }, get: () => service };
  const editor = { textContent: '' }, root = { getBoundingClientRect: () => ({ width: 300 }), closest: () => null, querySelector: selector => selector.startsWith('.ProseMirror') ? editor : null, __reactFiber$test: { memoizedProps: { onSubmitLocal() {}, setSelectedCollaborationMode() {}, selectedProject: { id: 'synthetic' }, currentLocalExecutionHostId: 'local', currentLocalExecutionCwd: '/synthetic' } } };
  const send = vm.runInNewContext('(' + code.replaceAll('await import(', 'await load(') + ')', { load: async () => ({ atom: 'submit' }), readPermissionsNative: async () => ({ root, composerScope: scope }), prepareThreadMentionsNative: gate, setTimeout });
  const run = (overrides = {}) => send({ get: () => currentId }, { promotion: 'promotion' }, { primary: modules.primary, nativeSubmitAtom: 'atom', promotionAtom: 'promotion', threadMentions: modules }, [], { ...input, ...overrides }, commands);
  return { run, sent, commands, input, root, editor, scope };
}

test('首次草稿传递规范引用，成功后相同命令回读且不重复发送', async () => {
  const f = draftFixture();
  assert.equal((await f.run()).threadId, currentId); assert.equal(f.sent.length, 1); assert.equal(JSON.stringify(f.sent[0].threadReferences), JSON.stringify(refs));
  assert.equal(f.sent[0].prompt, f.input.text); await f.run(); assert.equal(f.sent.length, 1);
});

test('草稿引用 gate 失败、主机伪造和导出缺失均不提交，也不留下命令 guard', async () => {
  for (const f of [draftFixture({ gate: async () => { throw Error('不可用'); } }), draftFixture({ destination: 'durable' })]) {
    await assert.rejects(f.run(), /DRAFT_SEND_UNAVAILABLE/); assert.equal(f.sent.length, 0); assert.equal(f.commands.size, 0);
  }
  const f = draftFixture(); await assert.rejects(f.run({ threadReferences: [{ threadId: otherId, hostId: 'computer-synthetic' }] }), /DRAFT_SEND_UNAVAILABLE/); assert.equal(f.sent.length, 0);
  await assert.rejects(f.run({ threadReferences: [{ ...refs[0], title: '额外标题' }] }), /DRAFT_SEND_UNAVAILABLE/);
});

test('草稿 gate 等待期间项目、正文和并发变化仍由原 guard 拒绝', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = draftFixture({ gate: () => pending });
  const first = f.run(); const second = f.run({ commandId: 'two' }); release();
  const results = await Promise.allSettled([first, second]); assert.equal(f.sent.length, 1); assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  const g = draftFixture({ gate: async () => { g.editor.textContent = '电脑新增正文'; } });
  await assert.rejects(g.run(), /DRAFT_DESKTOP_TEXT/); assert.equal(g.sent.length, 0);
  const h = draftFixture({ gate: async () => { h.root.__reactFiber$test.memoizedProps.selectedProject.id = 'changed'; } });
  await assert.rejects(h.run(), /DRAFT_PROJECT_CHANGED/); assert.equal(h.sent.length, 0);
});

test('无引用草稿不调用引用 gate，未知提交结果保留幂等 guard 且不能重发', async () => {
  const f = draftFixture({ gate: async () => { throw Error('无引用不得调用'); } });
  await f.run({ threadReferences: [] }); assert.equal('threadReferences' in f.sent[0], false);
  const g = draftFixture(); const original = g.scope.get(); original.submit = async () => { throw Error('模拟未知回执'); };
  await assert.rejects(g.run(), /DRAFT_SEND_OUTCOME_UNKNOWN/); await assert.rejects(g.run(), /DRAFT_SEND_OUTCOME_UNKNOWN/); assert.equal(g.commands.size, 1);
  const minimal = { initial: modules.initial, primary: modules.primary, threadMentions: { ...modules, primary: 'https://example.com/a.js' } };
  assert.throws(() => nativeDraftExpression(minimal, 'send', {}), /聊天引用模块无效/);
});
