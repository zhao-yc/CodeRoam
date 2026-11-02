import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { EventEmitter } from 'node:events';
import { DesktopGoalController } from '../apps/bridge/desktop-goals.mjs';

/** 执行组件真实事件方法，核对折叠、草稿和版本绑定，而非只匹配模板字符串。 */
function mobile() {
  const props = { goal: { objective: '原目标', status: 'active', tokensUsed: 1, timeUsedSeconds: 1 }, revision: 'version-a', disabled: false, busy: false, openRequest: 0, closeRequest: 0, resetKey: 'pc:thread', contentHeight: 100 };
  const calls = [], modals = [], watchers = [];
  const component = fs.readFileSync('apps/mobile/components/goal-card/goal-card.uvue', 'utf8').split('<script setup lang="uts">')[1].split('</script>')[0].replace(/^import .*$/gm, '');
  const service = fs.readFileSync('apps/mobile/services/goals.uts', 'utf8').replace(/export /g, '');
  const context = vm.createContext({ defineProps: () => props, defineEmits: () => (...args) => calls.push(args), ref: value => ({ value }), computed: getter => ({ get value() { return getter(); } }), watch: (read, callback) => watchers.push({ read, callback }), uni: { hideKeyboard() {}, showModal(options) { modals.push(options); } } });
  vm.runInContext(stripTypeScriptTypes(service + component + ';globalThis.ui = { expanded, editing, objective, edit, toggle, save, operate, clear, collapse };'), context);
  return { props, calls, modals, watchers, ui: context.ui };
}

test('目标默认折叠，点击展开只改变显示，编辑保存绑定原版本', () => {
  const { props, ui, calls } = mobile();
  assert.equal(ui.expanded.value, false); ui.toggle(); assert.equal(ui.expanded.value, true); assert.equal(calls.filter(call => call[0] === 'operate').length, 0);
  ui.edit(); ui.objective.value = '手机新目标'; ui.save();
  assert.deepEqual([...calls.at(-1)], ['operate', 'edit', '手机新目标', 'version-a']);
  props.revision = 'version-b'; const count = calls.length; ui.save(); assert.equal(calls.length, count); assert.equal(ui.objective.value, '手机新目标');
});

test('离线与待核对状态禁止目标写入，但仍允许查看和收起', () => {
  const { props, ui, calls, modals } = mobile(); props.disabled = true;
  ui.edit(); ui.operate('pause'); ui.clear(); assert.equal(calls.length, 0); assert.equal(modals.length, 0);
  ui.toggle(); assert.equal(ui.expanded.value, true); ui.collapse(); assert.equal(ui.expanded.value, false);
});

test('清除必须明确确认，确认框期间变化仍携带最初目标版本', () => {
  const { props, ui, calls, modals } = mobile(); ui.clear(); assert.equal(calls.length, 0);
  props.revision = 'new-version'; modals[0].success({ confirm: true }); assert.deepEqual([...calls.at(-1)], ['operate', 'clear', '', 'version-a']);
});

test('新建目标使用独立正文，失败时保留，成功回读后结束编辑', () => {
  const { props, ui, calls, watchers } = mobile(); props.goal = null; props.revision = 'none'; ui.edit(); ui.objective.value = '新目标'; ui.save();
  assert.deepEqual([...calls.at(-1)], ['operate', 'create', '新目标', 'none']);
  const watcher = watchers.at(-1); props.busy = false; watcher.callback(false, true); assert.equal(ui.editing.value, true);
  props.goal = { objective: '新目标' }; watcher.callback(false, true); assert.equal(ui.editing.value, false);
});

/** 模拟固定帮助程序的分阶段协议，正文只能通过标准输入到达，提交前必须完成复核。 */
function nativeFixture(mode, failure = {}) {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  const writes = []; child.stdin.end = () => {}; child.kill = () => {};
  child.stdin.write = line => { const value = JSON.parse(line); writes.push(value); queueMicrotask(() => {
    if (mode === 'before-error' || (mode === 'after-error' && writes.length > 1)) child.stdout.emit('data', Buffer.from(JSON.stringify({ stage: 'error', ...failure }) + '\n'));
    else if (writes.length === 1) child.stdout.emit('data', Buffer.from('{"stage":"ready"}\n'));
    else if (mode === 'lost') child.emit('exit');
    else child.stdout.emit('data', Buffer.from('{"stage":"done"}\n'));
  }); };
  let launch;
  const controller = new DesktopGoalController({ platform: 'win32', executable: process.execPath, launch: (...args) => { launch = args; return child; } });
  return { controller, writes, get launch() { return launch; } };
}

test('原生帮助程序先复核再提交，目标正文不进入程序参数', async () => {
  const fixture = nativeFixture(); let checked = 0;
  await fixture.controller.perform({ objective: '不能进入命令行的目标正文', deadline: Date.now() + 1000 }, async () => { checked++; assert.equal(fixture.writes.length, 1); });
  assert.equal(checked, 1); assert.equal(fixture.writes[1].commit, true); assert.ok(!JSON.stringify(fixture.launch).includes('不能进入命令行的目标正文'));
});

test('准备后复核失败不提交，提交后断线明确标记未知', async () => {
  const rejected = nativeFixture(); await assert.rejects(rejected.controller.perform({ deadline: Date.now() + 1000 }, async () => { throw Object.assign(new Error('目标已变化'), { code: 'GOAL_CHANGED' }); }), error => error.code === 'GOAL_CHANGED'); assert.equal(rejected.writes.length, 1);
  const lost = nativeFixture('lost'); await assert.rejects(lost.controller.perform({ deadline: Date.now() + 1000 }, async () => {}), error => error.outcomeUnknown === true);
});

test('侧边聊天或目标栏未就绪时返回明确原因，不进入提交阶段', async () => {
  for (const [code, hint] of [['GOAL_UI_SIDECHAT_ACTIVE', '侧边聊天'], ['GOAL_UI_LAYOUT_LOADING', '尚未加载完成'], ['GOAL_UI_THREAD_CHANGED', '当前聊天已变化'], ['GOAL_UI_FOREGROUND_CHANGED', '前台窗口已切换']]) {
    const fixture = nativeFixture('before-error', { code }); let checked = 0;
    await assert.rejects(fixture.controller.perform({ deadline: Date.now() + 2000 }, async () => { checked++; }), error => error.code === code && error.message.includes(hint) && error.outcomeUnknown === false);
    assert.equal(checked, 0); assert.equal(fixture.writes.length, 1);
  }
});

test('原生错误不透传界面正文，提交后切换会话仍须核对结果', async () => {
  const unsafe = nativeFixture('before-error', { code: '敏感目标正文', message: '敏感界面内容', phase: '敏感阶段' });
  await assert.rejects(unsafe.controller.perform({ deadline: Date.now() + 2000 }, async () => {}), error => error.code === 'GOAL_UI_UNAVAILABLE' && !error.message.includes('敏感') && error.outcomeUnknown === false);
  const committed = nativeFixture('after-error', { code: 'GOAL_UI_THREAD_CHANGED', outcomeUnknown: false });
  await assert.rejects(committed.controller.perform({ deadline: Date.now() + 2000 }, async () => {}), error => error.code === 'GOAL_UI_THREAD_CHANGED' && error.outcomeUnknown === true && error.message.includes('请勿重复操作') && !error.message.includes('重试'));
  assert.equal(committed.writes.length, 2);
});

test('目标诊断仅记录阶段及请求身份，敏感正文和任意字段不进入文件', async () => {
  fs.mkdirSync('.cache', { recursive: true });
  const directory = fs.mkdtempSync('.cache/goal-diagnostic-'), diagnosticPath = directory + '/events.jsonl';
  const fixture = nativeFixture('after-error', { code: 'GOAL_UI_UNAVAILABLE', phase: 'submit-goal', errorKind: 'MethodInvocationException', message: '敏感目标正文' });
  fixture.controller.diagnosticPath = diagnosticPath;
  await assert.rejects(fixture.controller.perform({ commandId: 'goal-diagnostic-test-1234', action: 'pause', objective: '敏感目标正文', deadline: Date.now() + 2000 }, async () => {}));
  const content = fs.readFileSync(diagnosticPath, 'utf8'), events = content.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(content.includes('敏感'), false);
  assert.ok(events.some(event => event.phase === 'submit-goal' && event.errorKind === 'MethodInvocationException'));
  assert.ok(events.some(event => event.stage === 'failed' && event.outcomeUnknown === true));
  fixture.controller.record({ commandId: '敏感编号', action: '敏感动作' }, 'error', { phase: '敏感阶段', code: '敏感代码', errorKind: '敏感异常' });
  assert.equal(fs.readFileSync(diagnosticPath, 'utf8').includes('敏感'), false);
  fixture.controller.diagnosticPath = directory + '/不存在/events.jsonl';
  assert.doesNotThrow(() => fixture.controller.record({}, 'error'));
});
