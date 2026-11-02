import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const tick = () => new Promise(resolve => setImmediate(resolve));

/** 执行真实 UTS 读取逻辑，独立控制订阅回执和实时事件的先后顺序。 */
function fixture() {
  const context = vm.createContext({reactive: value => value, uni: {getStorageSync: () => ''}});
  const source = fs.readFileSync('apps/mobile/services/bridge.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
  vm.runInContext(stripTypeScriptTypes(source, {mode: 'transform'}) + '\nglobalThis.subject = {MobileBridge, connection};', context);
  const {MobileBridge, connection} = context.subject, bridge = new MobileBridge(), requests = [];
  Object.assign(connection, {connected: true, hostId: 'computer', activeThreadId: 'thread', computers: [{id: 'computer', online: true, instanceGeneration: 'current'}]});
  bridge.request = (method, params) => new Promise((resolve, reject) => requests.push({method, params, resolve, reject}));
  return {bridge, connection, requests};
}

/** 协议对象保留 UTS 字段读取接口，正文只使用合成会话。 */
function object(fields) {
  return {...fields, getString(key) {return this[key] ?? null;}, getNumber(key) {return this[key] ?? null;}};
}

function snapshot(title = '合成会话') {
  return {threadId: 'thread', title, messages: [{id: 'message', text: '正在处理', status: 'inProgress'}], approvals: [], questionGroups: []};
}

function event(fields = {}) {
  return object({type: 'event', hostId: 'computer', threadId: 'thread', generation: 'current', epoch: 'epoch', seq: 2, snapshot: snapshot(), ...fields});
}

function delta(fields = {}) {
  return event({snapshot: undefined, kind: 'delta', baseSeq: 1, update: {...snapshot(), order: ['message'], upserts: [], appends: [{id: 'message', text: '，已恢复更新', status: 'inProgress'}]}, ...fields});
}

test('订阅超时后收到当前会话快照，立即清除旧读取错误并保留其他操作状态', async () => {
  const f = fixture();
  Object.assign(f.connection, {error: '列表读取失败', desktopNavigationError: '导航需要重试', pendingCommands: [{id: 'command', hostId: 'computer', threadId: 'thread', method: 'turn.start'}]});
  f.bridge.watch('thread');
  f.requests[0].reject(new Error('电脑响应超时')); await tick();
  assert.equal(f.connection.conversationError, '电脑响应超时');
  f.bridge.receive(event());
  assert.equal(f.connection.conversationError, '');
  assert.equal(f.connection.snapshot.title, '合成会话');
  assert.equal(f.connection.error, '列表读取失败');
  assert.equal(f.connection.desktopNavigationError, '导航需要重试');
  assert.equal(f.connection.pendingCommands.length, 1);
});

test('已有快照的会话恢复增量更新后，清除超时提示且继续追加正文', async () => {
  const f = fixture(); Object.assign(f.connection, {snapshot: snapshot(), epoch: 'epoch', sequence: 1});
  f.bridge.watch('thread'); f.requests[0].reject(new Error('电脑响应超时')); await tick();
  f.bridge.receive(delta());
  assert.equal(f.connection.conversationError, '');
  assert.equal(f.connection.snapshot.messages[0].text, '正在处理，已恢复更新');
  assert.equal(f.connection.sequence, 2);
});

for (const kind of ['快照', '增量']) {
  test(`等待订阅回执时已收到${kind}，迟到超时不再覆盖恢复状态，后续真实失败仍显示`, async () => {
    const f = fixture(); Object.assign(f.connection, {snapshot: snapshot(), epoch: 'epoch', sequence: 1});
    f.bridge.watch('thread');
    f.bridge.receive(kind === '快照' ? event() : delta());
    f.requests[0].reject(new Error('电脑响应超时')); await tick();
    assert.equal(f.connection.conversationError, '');
    assert.equal(f.bridge.syncingThread, '');
    f.bridge.watch('thread'); f.requests[1].reject(new Error('新的读取失败')); await tick();
    assert.equal(f.connection.conversationError, '新的读取失败');
  });
}

test('有效订阅回执清除旧错误，较旧快照不覆盖当前实时内容', () => {
  const f = fixture(); Object.assign(f.connection, {snapshot: snapshot('较新内容'), epoch: 'epoch', sequence: 5, conversationError: '旧读取超时'});
  f.bridge.applySnapshot(object({epoch: 'epoch', seq: 4, snapshot: snapshot('较旧内容')}), 'computer', 'thread');
  assert.equal(f.connection.conversationError, '');
  assert.equal(f.connection.snapshot.title, '较新内容');
  assert.equal(f.connection.sequence, 5);
  f.connection.conversationError = '再次超时';
  f.bridge.applySnapshot(object({epoch: 'epoch', seq: 6, snapshot: snapshot('恢复内容')}), 'computer', 'thread');
  assert.equal(f.connection.conversationError, '');
  assert.equal(f.connection.snapshot.title, '恢复内容');
});

test('其他电脑、其他会话、旧实例、重复或不完整事件不能假装恢复', () => {
  const f = fixture(); Object.assign(f.connection, {snapshot: snapshot(), epoch: 'epoch', sequence: 1, conversationError: '电脑响应超时'});
  const ignored = [event({hostId: 'other'}), event({threadId: 'other'}), event({generation: 'old'}), event({seq: 1}), event({snapshot: {...snapshot(), threadId: 'other'}}), event({snapshot: undefined}), delta({update: {...delta().update, threadId: 'other'}})];
  for (const update of ignored) {
    f.bridge.receive(update);
    assert.equal(f.connection.conversationError, '电脑响应超时');
    assert.equal(f.bridge.conversationUpdateRevision, 0);
  }
  const result = object({epoch: 'epoch', seq: 2, snapshot: snapshot()});
  f.bridge.applySnapshot(result, 'other', 'thread');
  f.bridge.applySnapshot(result, 'computer', 'other');
  f.bridge.applySnapshot(object({...result, snapshot: null}), 'computer', 'thread');
  f.bridge.applySnapshot(object({...result, snapshot: {...snapshot(), threadId: 'other'}}), 'computer', 'thread');
  assert.equal(f.connection.conversationError, '电脑响应超时');
  assert.equal(f.connection.subscriptionRevision, 0);
});

test('无法应用的增量不算恢复，后续订阅失败继续显示', async () => {
  const f = fixture(); Object.assign(f.connection, {snapshot: snapshot(), epoch: 'epoch', sequence: 1});
  f.bridge.watch('thread'); f.bridge.receive(delta({baseSeq: 0}));
  assert.equal(f.bridge.conversationUpdateRevision, 0);
  f.requests[0].reject(new Error('电脑响应超时')); await tick();
  assert.equal(f.connection.conversationError, '电脑响应超时');
});
