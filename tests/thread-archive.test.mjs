import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { archiveThread } from '../apps/bridge/thread-archive.mjs';
import { DesktopArchiveController } from '../apps/bridge/desktop-archive.mjs';
import { DesktopAdapter } from '../apps/bridge/desktop-adapter.mjs';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { validateRequest, WRITE_METHODS } from '../packages/protocol/contracts.mjs';

/** 原生桌面快照保持真实订阅流程，归档仅替换短连接的标准输入输出。 */
function fixture({ reply = 'success', refreshed = () => {}, subscribed = true, exists = true } = {}) {
  const calls = [];
  class Desktop extends EventEmitter {
    constructor() { super(); this.socket = { writable: true }; this.state = { id: 'thread', cwd: '/项目', turns: [], requests: [], threadRuntimeStatus: { type: 'idle' } }; }
    async connect() {}
    async findOwner(_id, hostId) { return hostId === 'local' ? { clientId: 'desktop', hostId } : null; }
    broadcast(method, params) {
      if (method === 'thread-stream-following-changed' && params.following) queueMicrotask(() => {
        refreshed(this.state);
        this.emit('broadcast', { method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop', params: { conversationId: 'thread', hostId: 'local', change: { type: 'snapshot', revision: 1, conversationState: this.state } } });
      });
    }
    close() {}
  }
  const desktop = new Desktop(), adapter = new DesktopAdapter({ client: desktop, index: { containsThread: () => exists } });
  if (subscribed) adapter.conversations.set('thread', { watchers: new Set(['phone']), owner: { clientId: 'desktop', hostId: 'local' }, state: desktop.state, waiters: [], publishTimer: null });
  const launch = () => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit('exit', 0);
    child.stdin = new Writable({ write(data, _encoding, done) {
      const message = JSON.parse(data.toString()); calls.push(message);
      queueMicrotask(() => {
        if (message.commit === true && reply === 'lost') { child.emit('exit', 1); return; }
        child.stdout.write(JSON.stringify({ stage: message.commit === true ? 'done' : reply === 'rejected' ? 'error' : 'ready' }) + '\n');
      });
      done();
    } });
    child.stdin.on('finish', () => child.emit('exit', 0)); return child;
  };
  const native = new DesktopArchiveController({ launch }); native.available = true;
  return { adapter, desktop, calls, native };
}

test('归档为严格白名单写操作，不能接受目录、权限或任意原生命令', () => {
  const request = params => ({ v: 1, type: 'request', requestId: 'archive-command-001', method: 'thread.archive', params });
  assert.equal(WRITE_METHODS.has('thread.archive'), true);
  assert.doesNotThrow(() => validateRequest(request({ threadId: 'thread' })));
  for (const params of [{}, { threadId: '' }, { threadId: 'thread', cwd: '/其他项目' }, { threadId: 'thread', method: 'turn/start' }, { threadId: 'thread', approvalPolicy: 'never' }]) assert.throws(() => validateRequest(request(params)));
});

test('原生确认后才登记归档回执并取消订阅，不执行轮次或更改审批', async t => {
  const f = fixture(); t.after(() => f.adapter.close()); let receipt;
  const result = await archiveThread(f.adapter, f.native, 'thread', 'phone', value => { receipt = value; assert.equal(f.adapter.conversations.has('thread'), true); });
  assert.deepEqual(result, { threadId: 'thread', archived: true }); assert.deepEqual(receipt, result);
  assert.equal(f.calls[0].threadId, 'thread'); assert.equal(f.calls[0].hostId, 'local');
  assert.deepEqual(f.calls[1], { commit: true });
  assert.equal(f.adapter.conversations.has('thread'), false);
});

test('重新读取桌面状态后拒绝正在执行的任务，失败不取消订阅', async t => {
  const f = fixture({ refreshed: state => { state.threadRuntimeStatus.type = 'active'; state.turns = [{ turnId: 'new', status: 'inProgress', items: [] }]; } }); t.after(() => f.adapter.close());
  await assert.rejects(archiveThread(f.adapter, f.native, 'thread', 'phone'), { code: 'THREAD_BUSY' });
  assert.equal(f.calls.length, 0); assert.equal(f.adapter.conversations.has('thread'), true);
});

test('未订阅、已归档和所有者改变均不能触发归档', async t => {
  for (const options of [{ subscribed: false }, { exists: false }, {}]) {
    const f = fixture(options); t.after(() => f.adapter.close());
    if (options.subscribed === undefined && options.exists === undefined) f.adapter.subscribed('thread', 'phone').owner.hostId = 'old';
    await assert.rejects(archiveThread(f.adapter, f.native, 'thread', 'phone'));
    assert.equal(f.calls.length, 0);
  }
});

test('原生明确拒绝与响应丢失分别记录为失败和未知，保留会话与订阅', async t => {
  for (const reply of ['rejected', 'lost']) {
    const f = fixture({ reply }); t.after(() => f.adapter.close());
    await assert.rejects(archiveThread(f.adapter, f.native, 'thread', 'phone'), { code: reply === 'lost' ? 'ARCHIVE_CONNECTION_LOST' : 'ARCHIVE_REJECTED', outcomeUnknown: reply === 'lost' });
    assert.equal(f.adapter.conversations.has('thread'), true);
    assert.equal(f.calls.filter(call => call.commit === true).length, reply === 'lost' ? 1 : 0);
  }
});

test('重复归档请求共用操作账本，断线不重发且可核对原生成功回执', async t => {
  const f = fixture(), journal = new Journal();
  const agent = new BridgeAgent({ config: {}, adapter: f.adapter, journal, archiveController: f.native }); t.after(() => agent.close());
  const message = { v: 1, type: 'request', requestId: 'archive-command-001', method: 'thread.archive', deviceId: 'phone', params: { threadId: 'thread' } };
  const responses = await Promise.all([agent.handleRequest(message), agent.handleRequest(message)]);
  assert.deepEqual(responses.map(response => response.result), [{ threadId: 'thread', archived: true }, { threadId: 'thread', archived: true }]);
  assert.equal(f.calls.filter(call => call.commit === true).length, 1);
  assert.deepEqual(journal.status('phone', message.requestId), { state: 'done', result: { threadId: 'thread', archived: true } });
});

test('原生已归档但账本登记失败仍为未知结果，不能作为明确失败再次提交', async t => {
  const f = fixture(); t.after(() => f.adapter.close());
  await assert.rejects(archiveThread(f.adapter, f.native, 'thread', 'phone', () => { throw new Error('账本暂时不可写'); }), { code: 'ARCHIVE_OUTCOME_UNKNOWN', outcomeUnknown: true });
  assert.equal(f.calls.filter(call => call.commit === true).length, 1);
});

test('原生管道准备期间任务重新开始时，不提交归档，也不记录未知结果', async t => {
  let snapshots = 0;
  const f = fixture({ refreshed: state => { if (++snapshots > 1) state.threadRuntimeStatus.type = 'active'; } }); t.after(() => f.adapter.close());
  await assert.rejects(archiveThread(f.adapter, f.native, 'thread', 'phone'), { code: 'THREAD_BUSY', outcomeUnknown: false });
  assert.equal(f.calls.some(call => call.commit === true), false);
});
