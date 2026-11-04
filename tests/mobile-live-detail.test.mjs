import { componentContext } from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const message = (id, text = id) => ({ id, text, role: 'assistant', turnId: 'turn', status: 'completed', phase: 'final_answer' });
const snapshot = (text = '当前正文') => ({ threadId: 'thread', title: '合成标题', cwd: '/synthetic/project', messages: [message('recent', text)], turns: [], status: 'idle', activeTurnId: '', approvals: [], questionGroups: [], updatedAt: 1 });
const source = name => fs.readFileSync('apps/mobile/services/' + name + '.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');

/** 执行真实详情脚本，正文只来自当前连接，所有计时和布局均由合成页面控制。 */
function fixture() {
  const mounts = [], hides = [], unloads = [], watchers = [], calls = [], timers = new Map();
  let sequence = 0;
  const connection = { configured: true, cacheNamespace: 'pair', configurationRevision: 1, hostId: 'pc', activeThreadId: 'thread', snapshot: null, preview: null, connected: true, error: '', conversationError: '', epoch: '', sequence: 0, subscriptionRevision: 0, subscribedHostId: '', subscribedThreadId: '', contentRevision: '', pendingCommandId: '', pendingCommands: [], computers: [{ id: 'pc', online: true, instanceGeneration: 'one' }] };
  const geometry = { top: 20 };
  const context = componentContext({
    props: { active: true, paneWidth: 390, paneHeight: 800, target: { hostId: 'pc', threadId: 'thread', title: '列表标题', projectName: '', cacheNamespace: 'pair' } },
    connection, ref: value => ({ value }), computed: read => ({ get value() { return read(); } }),
    watch: (read, callback) => watchers.push({ read, callback }), nextTick: callback => callback?.(),
    onLoad: callback => mounts.push(callback), onHide: callback => hides.push(callback), onUnload: callback => unloads.push(callback),
    setTimeout: (callback, delay) => { timers.set(++sequence, { callback, delay }); return sequence; }, clearTimeout: id => timers.delete(id),
    uni: { getWindowInfo: () => ({ windowWidth: 390, windowHeight: 800 }), getElementById: id => id === 'conversation-timeline' ? { getBoundingClientRect: () => ({ top: 0, bottom: 500, height: 500 }) } : id === 'message-older' ? { getBoundingClientRect: () => ({ top: geometry.top, bottom: geometry.top + 40 }) } : null },
    bridge: { watch: () => { calls.push('watch'); return Promise.resolve({}); }, resume: () => calls.push('resume'), cancelOpen: () => { connection.snapshot = null; connection.preview = null; } },
    readDraft: () => '', reportTimeline: current => (current?.messages ?? []).map(item => ({ ...item, executions: [], label: '' })),
    deletedThread: () => false, taskNotifications: { focusRevision: 0 }, pendingTaskNotice: () => null, bindImagePaste: () => () => {}
  });
  const page = fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue', 'utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm, '');
  const modules = ['turn-failure', 'history', 'conversation-opening', 'annotations', 'message-attachments', 'message-presentations'].map(source).join('\n');
  vm.runInContext(stripTypeScriptTypes(modules + '\n' + page, { mode: 'transform' }) + ';globalThis.page={liveConversation,previewConversation,displayConversation,detailError,detailSyncing,syncHint,historyPage,canWrite,subscriptionReady,showingPreview,pendingQuestionGroups,approvalCount,following,pageVisible,historyScrollTop,displayTitle,projectName,isCurrentPage,loadOlder,refresh,refreshButton};', context);
  vm.runInContext('paneHideCallbacks.forEach(onHide);', context);
  mounts.forEach(callback => callback());
  const api = context.page;
  let previous = api.displayConversation.value;
  const layout = () => { const current = api.displayConversation.value; watchers.find(watcher => watcher.read === api.displayConversation).callback(current, previous); previous = current; };
  return { api, context, connection, calls, watchers, geometry, timers, hides, unloads, layout };
}

test('每次进入详情先等待当前订阅，守护进程预览可显示但不能开启写操作', () => {
  const f = fixture();
  assert.deepEqual(f.calls, ['watch']);
  assert.equal(f.api.displayConversation.value, null);
  f.connection.preview = { ...snapshot('守护进程预览'), readOnly: true, approvals: [{ id: 'preview-approval' }], questionGroups: [{ id: 'preview-question', state: 'pending' }] };
  assert.equal(f.api.displayConversation.value.messages[0].text, '守护进程预览');
  assert.equal(f.api.showingPreview.value, true);
  assert.equal(f.api.canWrite.value, false);
  assert.equal(f.api.approvalCount.value, 0);
  assert.equal(f.api.pendingQuestionGroups.value.length, 0);
  assert.equal(f.api.displayTitle.value, '合成标题');
  assert.equal(f.api.projectName.value, 'project');
});

test('当前实时订阅确认后正文接管，断线保留画面并立即关闭操作权限', () => {
  const f = fixture();
  f.connection.preview = { ...snapshot('预览'), readOnly: true };
  f.connection.snapshot = snapshot('实时正文');
  assert.equal(f.api.canWrite.value, false);
  Object.assign(f.connection, { subscribedHostId: 'pc', subscribedThreadId: 'thread' });
  assert.equal(f.api.displayConversation.value.messages[0].text, '实时正文');
  assert.equal(f.api.showingPreview.value, false);
  assert.equal(f.api.canWrite.value, true);
  f.connection.connected = false;
  assert.equal(f.api.displayConversation.value.messages[0].text, '实时正文');
  assert.equal(f.api.canWrite.value, false);
  f.api.refresh();
  assert.deepEqual(f.calls, ['watch', 'resume']);
});

test('同号其他电脑和旧配对正文不进入当前详情，卸载后清除当前页面正文', () => {
  const f = fixture();
  f.connection.preview = { ...snapshot(), readOnly: true };
  f.connection.hostId = 'other';
  assert.equal(f.api.displayConversation.value, null);
  f.connection.hostId = 'pc';
  f.connection.cacheNamespace = 'new-pair';
  assert.equal(f.api.displayConversation.value, null);
  assert.equal(f.api.isCurrentPage(), false);
  f.unloads.forEach(callback => callback());
  assert.equal(f.connection.preview, null);
  assert.equal(f.connection.snapshot, null);
});

test('实时接管保留当前页历史与阅读选择，流式正文不调用存储', () => {
  const f = fixture();
  f.connection.preview = { ...snapshot('预览'), readOnly: true };
  f.api.historyPage.value = { messages: [message('older', '更早正文')], turns: [], cursor: 'cursor', hasMore: true };
  f.api.following.value = false;
  f.layout();
  f.context.nextTick = callback => { f.geometry.top = 70; callback?.(); };
  f.connection.snapshot = snapshot('实时正文');
  f.layout();
  assert.deepEqual(Array.from(f.api.displayConversation.value.messages, item => item.id), ['older', 'recent']);
  assert.equal(f.api.historyPage.value.cursor, 'cursor');
  assert.equal(f.api.following.value, false);
  assert.equal(f.api.historyScrollTop.value, 50);
  for (let i = 0; i < 12; i++) { f.connection.snapshot.messages[0].text = '流式分片 ' + i; f.layout(); }
  assert.equal(f.api.displayConversation.value.messages.at(-1).text, '流式分片 11');
  assert.deepEqual(f.calls, ['watch']);
});


test('实时连接失败时保留本次预览，提示失败并允许重新同步', () => {
  const f = fixture();
  f.connection.preview = { ...snapshot('本次预览'), readOnly: true };
  f.connection.conversationError = '读取超时';
  assert.equal(f.api.displayConversation.value.messages[0].text, '本次预览');
  assert.equal(f.api.canWrite.value, false);
  assert.equal(f.api.detailSyncing.value, false);
  assert.equal(f.api.detailError.value, '读取超时');
  assert.equal(f.api.syncHint.value, '聊天同步失败，可重新同步');
  f.api.refresh();
  assert.deepEqual(f.calls, ['watch', 'watch']);
});

test('缓存问题先显示但不能提交，实时确认后仅保留仍待回答的问题', () => {
  const f = fixture();
  const id = 'preview:' + 'a'.repeat(32);
  f.connection.preview = { ...snapshot(), readOnly: true, questionPreviews: [{ id, questions: [{ id: id + ':0', title: '合成问题', header: '', options: [{ label: '甲', description: '' }], isOther: true, isSecret: false }] }] };
  assert.equal(f.api.pendingQuestionGroups.value[0].questions[0].title, '合成问题');
  assert.equal(f.api.pendingQuestionGroups.value[0].kind, 'preview');
  assert.equal(f.api.pendingQuestionGroups.value[0].turnId, '');
  assert.equal(f.api.canWrite.value, false);
  const sent = [];
  f.context.bridge.request = (...args) => { sent.push(args); return Promise.resolve({}); };
  vm.runInContext(`submitAnswers('${id}', '', [{questionId: '${id}:0', text: '甲'}]);`, f.context);
  assert.equal(sent.length, 0);
  f.connection.snapshot = { ...snapshot(), questionGroups: [{ id: 'current-question', turnId: 'current-turn', kind: 'native', state: 'pending', questions: [] }] };
  Object.assign(f.connection, { subscribedHostId: 'pc', subscribedThreadId: 'thread' });
  assert.equal(f.api.canWrite.value, true);
  assert.deepEqual(Array.from(f.api.pendingQuestionGroups.value, group => group.id), ['current-question']);
  vm.runInContext(`submitAnswers('${id}', '', []);`, f.context);
  assert.equal(sent.length, 0, '旧展示编号不能借实时订阅提交');
  f.connection.snapshot.questionGroups[0].state = 'answered';
  assert.equal(f.api.pendingQuestionGroups.value.length, 0);
  vm.runInContext("submitAnswers('current-question', 'current-turn', []);", f.context);
  assert.equal(sent.length, 0, '已回答题组不能提交');
  f.connection.snapshot.questionGroups[0].state = 'pending';
  f.connection.connected = false;
  vm.runInContext("submitAnswers('current-question', 'current-turn', []);", f.context);
  assert.equal(sent.length, 0, '断线立即关闭回答入口');
});
