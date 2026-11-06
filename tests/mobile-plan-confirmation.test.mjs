import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { componentContext } from './helpers/component-context.mjs';

const source = fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue', 'utf8');
const submissionSource = fs.readFileSync('apps/mobile/services/interaction-submissions.uts', 'utf8');
const planNoticeCondition = source.match(/<view v-if="([^"]+)" id="notice-plan"/)[1]
  .replace(/\b(pendingPlan|hiddenPlanId|planInteraction)\b/g, '$1.value');
const ref = value => ({ value });
const computed = read => ({ get value() { return read(); } });
const slice = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

/** 执行详情页真实入口，手动控制回执、快照顺序和连点间隔。 */
function fixture() {
  let now = 10_000, timer, status = { state: 'unknown' };
  const calls = [], checks = [], watchers = [];
  const snapshot = {
    threadId: 'thread', pendingPlan: { id: 'plan', turnId: 'turn', text: '合成计划' },
    approvals: [{ id: 'approval', turnId: 'turn' }],
    questionGroups: [{ id: 'question', turnId: 'turn', state: 'pending', questions: [{id:'sub',options:[],isSecret:false}] }]
  };
  const context = componentContext({
    ref, computed, reactive: value => value, watch: (read, changed) => watchers.push({ read, changed, previous: read() }),
    Date: { now: () => now }, setTimeout: callback => { timer = callback; return 1; }, clearTimeout() {},
    busy: ref(false), pendingAction: ref(''), operationError: ref(''), goalHostOnline: ref(true),
    pageHostId: ref('host'), pageThreadId: ref('thread'),
    connection: { hostId: 'host', activeThreadId: 'thread', connected: true, snapshot },
    liveConversation: ref(snapshot), pendingQuestionGroups: computed(() => snapshot.questionGroups),
    liveApprovals: computed(() => snapshot.approvals), uni: { hideKeyboard() {} },
    newSubmissionId: () => 'interaction-' + calls.length,
    canWrite: computed(() => !context.busy.value),
    isCurrentPage: () => context.connection.hostId === context.pageHostId.value && context.connection.activeThreadId === context.pageThreadId.value,
    pauseFollowing() {}, notify() {}, refresh() {}, supportsSubmissionTasks: () => false,
    bridge: {
      submitInteraction: (...request) => new Promise((resolve, reject) => calls.push({ request, resolve, reject })),
      readCommandStatus: async (...request) => { checks.push(request); return { ...status, getString: key => status[key] }; },
      watch: async () => {}, clearCommand() {}
    }
  });
  const code = [
    submissionSource.replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, ''),
    'const interactionCoolingDown = ref(false); let interactionUnlockAt = 0, interactionUnlockTimer = 0, layoutUntil = 0',
    slice('const hiddenPlanId =', '// 运行中显示电脑确认值'),
    slice('const interactionScope =', '\nfunction isCurrentPage'),
    slice('// 取消只收起编辑区', 'function copyText('),
    slice('function interactionFor(', '// 继续指令与输入框草稿独立'),
    slice('function reply(id: string', '// 目标表单与聊天草稿独立'),
    'globalThis.api={replyPlan,reply,submitAnswers,checkInteraction,interactionFor,detachedInteractions,planFeedback,planEditing,editPlan,cancelPlanFeedback,hidePlan,interactionCoolingDown,interactionSubmissions,planNoticeVisible:()=>(' + planNoticeCondition + ')}'
  ].join('\n');
  vm.runInContext(stripTypeScriptTypes(code), context);
  return {
    ...context.api, context, snapshot, calls, checks,
    answer: () => context.api.submitAnswers('question', 'turn', [{ questionId: 'sub', text: '合成回答' }]),
    approve: (decision = 'accept') => context.api.reply('approval', 'turn', decision),
    tick: (ms, unlock = true) => { now += ms; if (unlock) timer?.(); },
    sync: () => { for (const watcher of watchers) { const value = watcher.read(); if (value !== watcher.previous) { const previous = watcher.previous; watcher.previous = value; watcher.changed(value, previous); } } },
    setStatus: value => { status = value; }
  };
}

test('三种交互都拦截同卡连点、下一张卡，以及桌面晚到的卡片移除', async () => {
  for (const kind of ['plan', 'question', 'approval']) {
    const f = fixture();
    const send = kind === 'plan' ? () => f.replyPlan('implement') : kind === 'question' ? f.answer : f.approve;
    const next = kind === 'approval' ? f.answer : f.approve;
    send(); send(); next();
    assert.equal(f.calls.length, 1, kind);
    assert.equal(f.interactionFor(kind, kind, 'turn').state, 'sending');
    f.tick(900);
    f.calls[0].resolve({}); await Promise.resolve();
    assert.equal(f.interactionFor(kind, kind, 'turn').state, 'done');
    send(); next();
    assert.equal(f.calls.length, 1, '回执收起时相邻卡片仍锁定');
    f.sync(); f.tick(600);
    send(); assert.equal(f.calls.length, 1, '旧目标仍在快照也不能重复提交');
    if (kind === 'plan') f.snapshot.pendingPlan = null;
    if (kind === 'question') f.snapshot.questionGroups = [];
    if (kind === 'approval') f.snapshot.approvals = [];
    f.sync();
    next(); assert.equal(f.calls.length, 1, '快照移除旧卡时不能点到下一张');
    f.tick(600);
    next(); assert.equal(f.calls.length, 2, '等界面稳定后允许新的操作');
  }
});

test('未知结果只核对原编号，明确失败才恢复方案编辑并保留意见', async () => {
  const f = fixture();
  f.editPlan(); f.planFeedback.value = '保留合成意见'; f.replyPlan('feedback');
  assert.equal(f.calls[0].request[1].planAction, 'feedback');
  assert.equal(f.calls[0].request[1].text, '保留合成意见');
  f.calls[0].reject(Object.assign(new Error('合成断线'), { name: 'OUTCOME_UNKNOWN' }));
  await Promise.resolve(); f.tick(600);
  const entry = f.interactionFor('plan', 'plan', 'turn');
  assert.equal(entry.state, 'unknown');
  f.replyPlan('feedback'); await f.checkInteraction(entry);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.checks, [['host', f.calls[0].request[2]]]);
  const error = { getBoolean: () => false, getString: () => '明确拒绝' };
  f.setStatus({ state: 'done', error }); await f.checkInteraction(entry);
  assert.equal(f.interactionFor('plan', 'plan', 'turn'), null);
  assert.equal(f.planFeedback.value, '保留合成意见');
  assert.equal(f.planEditing.value, true);
  assert.equal(f.context.operationError.value, '明确拒绝');
});

test('问题提交状态持续绑定原题组，成功延迟同步及未知结果均保持锁定，明确失败才解锁', async () => {
  for (const outcome of ['done','unknown','failed']) {
    const f=fixture();f.answer();
    assert.equal(f.interactionFor('question','question','turn').state,'sending');
    if(outcome==='done') f.calls[0].resolve({});
    else f.calls[0].reject(Object.assign(new Error('合成提交结果'),{name:outcome==='unknown'?'OUTCOME_UNKNOWN':'Error'}));
    await Promise.resolve();f.tick(600);
    const entry=f.interactionFor('question','question','turn');
    assert.equal(entry?.state??'failed',outcome);
    assert.equal(f.snapshot.questionGroups[0].id,'question');
    f.answer();assert.equal(f.calls.length,outcome==='failed'?2:1);
    if(outcome==='unknown') {
      await f.checkInteraction(entry);assert.equal(f.calls.length,1);
      assert.equal(entry.state,'unknown');assert.equal(f.checks[0][1],f.calls[0].request[2]);
    }
    if(outcome==='done') {
      f.snapshot.questionGroups=[];f.sync();
      assert.equal(f.detachedInteractions('question')[0].commandId,entry.commandId);
    }
  }
});

test('切换实例后展示副本按原题组恢复，仅请求携带保密答案，实时确认结束后清理副本',async()=>{
  const f=fixture(),answer='原实例的合成长答案\n'.repeat(40);
  f.snapshot.questionGroups[0].questions=[
    {id:'choice',options:[{label:'乙'}],isSecret:false},
    {id:'long',options:[],isSecret:false},
    {id:'secret',options:[],isSecret:true}
  ];
  const answers=[{questionId:'choice',text:'乙'},{questionId:'long',text:answer},{questionId:'secret',text:'合成保密原文'}];
  f.context.api.submitAnswers('question','turn',answers,['choice','long','secret']);
  const first=f.interactionFor('question','question','turn');
  assert.deepEqual(JSON.parse(JSON.stringify(first.questionDrafts)),[
    {questionId:'choice',text:'乙',custom:true},{questionId:'long',text:answer,custom:true},{questionId:'secret',text:'',custom:true}
  ]);
  assert.doesNotMatch(JSON.stringify(f.interactionSubmissions),/合成保密原文/);
  assert.equal(f.calls[0].request[1].answers[2].text,'合成保密原文');
  f.calls[0].reject(Object.assign(new Error('合成断线'),{name:'OUTCOME_UNKNOWN'}));await Promise.resolve();f.tick(600);
  f.context.pageHostId.value='other';f.context.connection.hostId='other';
  assert.equal(f.interactionFor('question','question','turn'),null);f.sync();
  assert.equal(first.questionDrafts[1].text,answer);
  f.context.pageHostId.value='host';f.context.connection.hostId='host';f.sync();
  assert.equal(f.interactionFor('question','question','turn').questionDrafts[1].text,answer);
  f.answer();assert.equal(f.calls.length,1);
  f.snapshot.questionGroups=[];f.sync();assert.equal(first.questionDrafts.length,0);
});

test('审批决策不能被连点改写，明确失败后可重试，离页回执隔离', async () => {
  const f = fixture();
  f.approve('decline'); f.approve('accept');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].request[1].decision, 'decline');
  f.calls[0].reject(new Error('明确失败')); await Promise.resolve(); f.tick(600);
  assert.equal(f.interactionFor('approval', 'approval', 'turn'), null);
  f.approve('accept'); f.context.pageHostId.value = 'other'; f.context.connection.hostId = 'other';
  f.calls[1].resolve({}); await Promise.resolve();
  assert.equal(f.interactionFor('approval', 'approval', 'turn'), null);
});

test('方案取消编辑保留草稿，旧回执不清空新方案，空反馈和只读都不提交', async () => {
  const f = fixture();
  f.replyPlan('feedback'); assert.equal(f.calls.length, 0);
  f.editPlan(); f.planFeedback.value = '旧意见'; f.cancelPlanFeedback();
  assert.equal(f.planEditing.value, false); f.editPlan(); assert.equal(f.planFeedback.value, '旧意见');
  f.context.busy.value = true; f.replyPlan('implement'); assert.equal(f.calls.length, 0);
  f.context.busy.value = false; f.replyPlan('feedback');
  f.snapshot.pendingPlan = { id: 'new-plan', turnId: 'new-turn', text: '新方案' }; f.sync();
  f.planFeedback.value = '新方案意见';
  f.calls[0].resolve({}); await Promise.resolve();
  assert.equal(f.planFeedback.value, '新方案意见');
});

test('计划成功回执立即收起整个确认区，延迟快照和切回聊天都不重新开放提交', async () => {
  for (const action of ['implement', 'feedback']) {
    const f = fixture();
    if (action === 'feedback') { f.editPlan(); f.planFeedback.value = '合成修改意见'; }
    assert.equal(f.planNoticeVisible(), true);
    f.replyPlan(action);
    assert.equal(f.planNoticeVisible(), true, '提交中保留确认区和进度');
    f.calls[0].resolve({}); await Promise.resolve();
    assert.equal(f.planNoticeVisible(), false, '旧计划仍在快照时也立即收起');
    assert.equal(f.interactionFor('plan', 'plan', 'turn').state, 'done');
    f.tick(600); f.replyPlan(action);
    assert.equal(f.calls.length, 1);
    f.context.pageThreadId.value = 'other'; f.context.connection.activeThreadId = 'other';
    f.context.pageThreadId.value = 'thread'; f.context.connection.activeThreadId = 'thread';
    assert.equal(f.planNoticeVisible(), false);
    f.snapshot.pendingPlan = null; f.sync();
    assert.equal(f.detachedInteractions('plan').length, 0, '快照移除后也没有底部成功提示');
  }
});

test('快照先移除计划时继续显示提交进度，成功回执后移除底部提示', async () => {
  const f = fixture(); f.replyPlan('implement');
  f.snapshot.pendingPlan = null; f.sync();
  assert.equal(f.planNoticeVisible(), false);
  assert.equal(f.detachedInteractions('plan')[0].state, 'sending');
  f.calls[0].resolve({}); await Promise.resolve();
  assert.equal(f.detachedInteractions('plan').length, 0);
});

test('计划未知结果保留核对入口，核对成功或确认原操作结束后收起', async () => {
  for (const receiptFound of [true, false]) {
    const f = fixture(); f.replyPlan('implement');
    f.calls[0].reject(Object.assign(new Error('合成断线'), { name: 'OUTCOME_UNKNOWN' }));
    await Promise.resolve(); f.tick(600);
    const entry = f.interactionFor('plan', 'plan', 'turn');
    assert.equal(f.planNoticeVisible(), true);
    assert.equal(entry.state, 'unknown');
    if (receiptFound) f.setStatus({ state: 'done' });
    else {
      f.snapshot.pendingPlan = null; f.sync(); f.tick(600);
      assert.equal(f.detachedInteractions('plan')[0].state, 'unknown');
    }
    await f.checkInteraction(entry);
    assert.equal(entry.state, receiptFound ? 'done' : 'resolved');
    assert.equal(f.planNoticeVisible(), false);
    assert.equal(f.detachedInteractions('plan').length, 0);
    assert.equal(f.calls.length, 1, '核对不重发计划');
  }
});

test('失败恢复计划入口，新计划及其他实例的同编号计划正常显示', async () => {
  const f = fixture(); f.replyPlan('implement');
  f.calls[0].reject(new Error('合成失败')); await Promise.resolve(); f.tick(600);
  assert.equal(f.planNoticeVisible(), true);
  f.replyPlan('implement'); f.calls[1].resolve({}); await Promise.resolve(); f.tick(600);
  assert.equal(f.planNoticeVisible(), false);
  f.context.pageHostId.value = 'other-host'; f.context.connection.hostId = 'other-host';
  assert.equal(f.planNoticeVisible(), true, '其他实例不沿用旧实例的提交记录');
  f.context.pageHostId.value = 'host'; f.context.connection.hostId = 'host';
  assert.equal(f.planNoticeVisible(), false);
  f.snapshot.pendingPlan = { id: 'new-plan', turnId: 'new-turn', text: '合成新方案' }; f.sync(); f.tick(600);
  assert.equal(f.planNoticeVisible(), true);
  f.replyPlan('implement'); assert.equal(f.calls.length, 3);
});

test('计划提示收起规则保留问答和审批的现有成功提示', async () => {
  for (const kind of ['question', 'approval']) {
    const f = fixture();
    if (kind === 'question') f.answer(); else f.approve();
    f.calls[0].resolve({}); await Promise.resolve();
    if (kind === 'question') f.snapshot.questionGroups = []; else f.snapshot.approvals = [];
    assert.equal(f.detachedInteractions(kind)[0].state, 'done');
  }
});
