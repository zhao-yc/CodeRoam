import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeConversation } from '../apps/bridge/conversation.mjs';
import { normalizeGoal, goalRevision } from '../apps/bridge/goals.mjs';
import { DesktopAdapter } from '../apps/bridge/desktop-adapter.mjs';
import { BridgeAgent } from '../apps/bridge/agent.mjs';
import { Journal } from '../apps/bridge/journal.mjs';
import { validateRequest } from '../packages/protocol/contracts.mjs';
import { conversationUpdate, applyConversationUpdate } from '../apps/bridge/updates.mjs';
import { withDesktopUi } from '../apps/bridge/desktop-ui-coordinator.mjs';

const goal = () => ({ threadId: 'thread', objective: '完成目标', status: 'active', tokenBudget: null, tokensUsed: 12, timeUsedSeconds: 9, createdAt: 1, updatedAt: 2 });

/** 模拟原桌面快照，操作后只经正常广播修改目标。 */
class GoalDesktop extends EventEmitter {
  constructor() { super(); this.socket = { writable: true }; this.state = { id: 'thread', title: '验收', threadGoal: goal(), turns: [], requests: [] }; }
  async connect() {}
  async findOwner() { return { clientId: 'desktop', hostId: 'local' }; }
  broadcast(method, params) { if (method === 'thread-stream-following-changed' && params.following) this.publish(); }
  publish() { queueMicrotask(() => this.emit('broadcast', { method: 'thread-stream-state-changed', version: 11, sourceClientId: 'desktop', params: { hostId: 'local', conversationId: 'thread', change: { type: 'snapshot', revision: 1, conversationState: structuredClone(this.state) } } })); }
  close() {}
}

function fixture(t) {
  const client = new GoalDesktop(), calls = [];
  const goalController = { available: true, async perform(params, verify) { await verify(); calls.push(params); if (params.action === 'clear') client.state.threadGoal = null; else if (params.action === 'pause') client.state.threadGoal.status = 'paused'; else if (params.action === 'resume') client.state.threadGoal.status = 'active'; else client.state.threadGoal = { ...goal(), objective: params.objective.trim() }; client.publish(); } };
  const adapter = new DesktopAdapter({ client, goalController }); t.after(() => adapter.close());
  return { client, calls, adapter, goalController };
}

test('目标仅来自匹配会话的原生字段，用量增长不改变版本，清除版本明确', () => {
  const state = { id: 'thread', threadGoal: goal() }, normalized = normalizeGoal(state);
  assert.equal(normalized.objective, '完成目标'); assert.equal(goalRevision(null), 'none');
  assert.equal(goalRevision(normalized), goalRevision({ ...normalized, tokensUsed: 999, timeUsedSeconds: 99, updatedAt: 999 }));
  assert.notEqual(goalRevision(normalized), goalRevision({ ...normalized, status: 'paused' }));
  assert.equal(normalizeGoal({ ...state, id: 'other' }), null);
  assert.equal(normalizeConversation({ id: 'thread', turns: [], requests: [] }).supportsGoals, false);
});

test('完整快照和增量保持目标、空值及能力标记', () => {
  const first = normalizeConversation({ id: 'thread', threadGoal: goal(), turns: [{ items: [{ id: 'long', type: 'agentMessage', text: '正文'.repeat(1000) }] }] });
  const cleared = { ...first, goal: null, goalRevision: 'none', supportsGoalControl: true };
  const event = { ...conversationUpdate({ snapshot: first, seq: 1 }, cleared), epoch: 'epoch', seq: 2 };
  const result = applyConversationUpdate({ snapshot: first, epoch: 'epoch', seq: 1 }, event);
  assert.equal(result.snapshot.goal, null); assert.equal(result.snapshot.goalRevision, 'none'); assert.equal(result.snapshot.supportsGoalControl, true);
});

test('目标白名单拒绝任意字段、无版本操作、空目标及超长目标', () => {
  const request = params => ({ v: 1, type: 'request', requestId: 'goal-request-123456', method: 'thread.goal.update', params: { threadId: 'thread', ...params } });
  assert.doesNotThrow(() => validateRequest(request({ action: 'create', objective: '目标', expectedRevision: 'none' })));
  for (const params of [{ action: 'shell', expectedRevision: 'none' }, { action: 'clear' }, { action: 'clear', expectedRevision: 'none', selector: 'button' }, { action: 'pause', expectedRevision: 'none', objective: '越权字段' }, { action: 'create', expectedRevision: 'none', objective: ' ' }, { action: 'edit', expectedRevision: 'none', objective: '字'.repeat(4001) }]) assert.throws(() => validateRequest(request(params)));
});

test('未订阅手机和历史状态不能触发目标控制，旧版本不能覆盖新目标', async t => {
  const { adapter, client, calls } = fixture(t);
  await assert.rejects(adapter.readGoal('thread', 'other'), error => error.code === 'SUBSCRIPTION_REQUIRED');
  await adapter.watch('thread', 'phone');
  const current = await adapter.readGoal('thread', 'phone');
  client.state.threadGoal.objective = '电脑已编辑';
  await assert.rejects(adapter.operate('thread.goal.update', { threadId: 'thread', action: 'clear', expectedRevision: current.goalRevision }, 'cmd', 'phone'), error => error.code === 'GOAL_CHANGED');
  assert.equal(calls.length, 0);
});

test('新建、编辑、暂停、继续和清除均以原桌面回读为准', async t => {
  const { adapter, client, calls } = fixture(t); await adapter.watch('thread', 'phone');
  for (const action of ['pause', 'resume', 'edit', 'clear', 'create']) {
    const before = await adapter.readGoal('thread', 'phone');
    const result = await adapter.operate('thread.goal.update', { threadId: 'thread', action, expectedRevision: before.goalRevision, ...(['edit', 'create'].includes(action) ? { objective: '新目标' } : {}) }, action, 'phone');
    assert.equal(result.ok, true); assert.deepEqual(result.goal, normalizeGoal(client.state));
  }
  assert.equal(calls.length, 5);
});

test('界面准备后目标再变化时，最终提交检查拒绝覆盖', async t => {
  const { adapter, client, goalController, calls } = fixture(t); await adapter.watch('thread', 'phone');
  const before = await adapter.readGoal('thread', 'phone');
  goalController.perform = async (_params, verify) => { client.state.threadGoal.status = 'blocked'; await verify(); calls.push('错误提交'); };
  await assert.rejects(adapter.operate('thread.goal.update', { threadId: 'thread', action: 'clear', expectedRevision: before.goalRevision }, 'cmd', 'phone'), error => error.code === 'GOAL_CHANGED');
  assert.equal(calls.length, 0);
});

test('相同目标写请求通过现有账本去重，结果未知时不重放', async t => {
  const { adapter, goalController, calls } = fixture(t), journal = new Journal();
  const agent = new BridgeAgent({ config: {}, adapter, journal }); t.after(() => agent.close());
  await adapter.watch('thread', 'phone');
  const before = await adapter.readGoal('thread', 'phone');
  const request = { v: 1, type: 'request', requestId: 'goal-operation-123456', deviceId: 'phone', method: 'thread.goal.update', params: { threadId: 'thread', action: 'pause', expectedRevision: before.goalRevision } };
  const first = await agent.handleRequest(request); assert.equal(first.error, undefined); assert.deepEqual(await agent.handleRequest(request), first); assert.equal(calls.length, 1);
  goalController.perform = async () => { calls.push('unknown'); throw Object.assign(new Error('执行结果待确认'), { outcomeUnknown: true }); };
  const unknown = { ...request, requestId: 'goal-operation-unknown', params: { ...request.params, action: 'resume', expectedRevision: (await adapter.readGoal('thread', 'phone')).goalRevision } };
  assert.equal((await agent.handleRequest(unknown)).error.outcomeUnknown, true); await agent.handleRequest(unknown); assert.equal(calls.filter(item => item === 'unknown').length, 1);
});

test('同机目标操作与会话导航共享串行队列，前一操作失败不阻塞后续', async () => {
  const calls = []; let release;
  const first = withDesktopUi(async () => { calls.push('开始'); await new Promise(resolve => { release = resolve; }); calls.push('完成'); throw new Error('模拟失败'); });
  const second = withDesktopUi(() => calls.push('导航'));
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, ['开始']); release();
  await Promise.allSettled([first, second]); assert.deepEqual(calls, ['开始', '完成', '导航']);
});

test('未知暂停通过原生状态核对收口，保留原错误且重放编号不会再次点击', async t => {
  const { adapter, client, goalController, calls } = fixture(t), journal = new Journal();
  const agent = new BridgeAgent({ config: {}, adapter, journal }); t.after(() => agent.close());
  await adapter.watch('thread', 'phone');
  const before = await adapter.readGoal('thread', 'phone');
  const request = { v: 1, type: 'request', requestId: 'goal-reconcile-123456', deviceId: 'phone', method: 'thread.goal.update', params: { threadId: 'thread', action: 'pause', expectedRevision: before.goalRevision } };
  goalController.perform = async () => { calls.push('unknown'); throw Object.assign(new Error('执行结果待确认'), { outcomeUnknown: true }); };
  assert.equal((await agent.handleRequest(request)).error.outcomeUnknown, true);
  const check = deviceId => agent.handleRequest({ v: 1, type: 'request', requestId: 'goal-status-check-123456', deviceId, method: 'command.status', params: { commandId: request.requestId } });
  assert.equal((await check('phone')).result.state, 'unknown');
  client.state.threadGoal.status = 'paused';
  assert.equal((await check('other-phone')).result.state, 'not_found');
  const confirmed = (await check('phone')).result;
  assert.equal(confirmed.state, 'done'); assert.equal(confirmed.result.goal.status, 'paused'); assert.equal(confirmed.result.reconciled, true);
  assert.equal(confirmed.error, undefined); assert.equal(confirmed.resolution.previousError.outcomeUnknown, true);
  assert.equal((await agent.handleRequest(request)).result.reconciled, true); assert.equal(calls.length, 1);
});

test('目标正文或创建身份变化、订阅失效及非目标未知操作不能被核对成成功', async t => {
  const { adapter, client } = fixture(t), journal = new Journal();
  const agent = new BridgeAgent({ config: {}, adapter, journal }); t.after(() => agent.close());
  await adapter.watch('thread', 'phone'); const original = structuredClone(client.state.threadGoal);
  const params = { threadId: 'thread', action: 'pause', expectedRevision: (await adapter.readGoal('thread', 'phone')).goalRevision };
  await assert.rejects(journal.execute('phone', 'goal-reconcile-reject', 'thread.goal.update', params, async () => { throw Object.assign(new Error('待核对'), { outcomeUnknown: true }); }));
  const check = () => agent.handleRequest({ v: 1, type: 'request', requestId: 'goal-reconcile-check', deviceId: 'phone', method: 'command.status', params: { commandId: 'goal-reconcile-reject' } });
  for (const change of [{ objective: '电脑已编辑' }, { createdAt: 999 }, { tokenBudget: 1000 }]) {
    client.state.threadGoal = { ...original, ...change, status: 'paused' }; await adapter.readGoal('thread', 'phone');
    assert.equal((await check()).result.state, 'unknown');
  }
  client.state.threadGoal = { ...original, status: 'paused' }; await adapter.readGoal('thread', 'phone');
  adapter.unwatch('thread', 'phone'); assert.equal((await check()).result.state, 'unknown');
  await adapter.watch('thread', 'phone');
  await assert.rejects(journal.execute('phone', 'goal-other-operation', 'turn.stop', { threadId: 'thread', expectedTurnId: 'turn' }, async () => { throw Object.assign(new Error('待核对'), { outcomeUnknown: true }); }));
  const other = await agent.handleRequest({ v: 1, type: 'request', requestId: 'goal-other-check-1234', deviceId: 'phone', method: 'command.status', params: { commandId: 'goal-other-operation' } });
  assert.equal(other.result.state, 'unknown');
});

test('原生提交后订阅失效必须保持结果未知，不能当作明确失败重试', async t => {
  const { adapter, client, goalController } = fixture(t); await adapter.watch('thread', 'phone');
  const before = await adapter.readGoal('thread', 'phone');
  goalController.perform = async (_params, verify) => { await verify(); client.state.threadGoal = null; adapter.unwatch('thread', 'phone'); };
  await assert.rejects(adapter.operate('thread.goal.update', { threadId: 'thread', action: 'clear', expectedRevision: before.goalRevision }, 'cmd', 'phone'), error => error.outcomeUnknown === true);
  assert.equal(client.state.threadGoal, null);
});
