import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const service = fs.readFileSync('apps/mobile/services/message-queue.uts', 'utf8');
const component = fs.readFileSync('apps/mobile/components/message-queue/message-queue.uvue', 'utf8');
const template = component.split('<script setup')[0];
const scope = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(service.replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, ''), { mode: 'transform' }), scope);
const message = { id: 'synthetic-queue', text: '合成消息', imageCount: 1, attachmentCount: 2, state: 'queued', error: '' };

/** 执行组件实际模板表达式，检查缺省能力和原有状态限制共同生效。 */
function action(name, row = message, props = {}) {
  const opening = template.match(new RegExp('<view[^>]*class="queue-' + name + ' inline-progress-button"[^>]*>'))?.[0];
  assert.ok(opening, '操作节点必须存在');
  const condition = opening.match(/v-if="([^"]+)"/)?.[1] ?? 'true';
  const body = template.slice(template.indexOf(opening) + opening.length).split('</view>')[0];
  const disabled = body.match(/:disabled="([^"]+)"/)[1];
  const context = { message: row, editable: true, running: true, disabled: false, pendingAction: '', ...props };
  return { visible: vm.runInNewContext(condition, context), disabled: vm.runInNewContext(disabled, context) };
}

/** 只执行来源标签自己的条件，确保缺省和未知来源不会冒充电脑同步。 */
function sourceLabels(row) {
  return [...template.matchAll(/<text v-if="([^"]+)" class="queue-source">([^<]+)<\/text>/g)]
    .filter(([, condition]) => vm.runInNewContext(condition, { message: row })).map(([, , label]) => label);
}

test('旧消息缺省能力维持原操作和无来源标签', () => {
  for (const name of ['edit', 'steer', 'cancel']) assert.deepEqual(action(name), { visible: true, disabled: false });
  assert.deepEqual(sourceLabels(message), []);
  assert.equal(action('edit', { ...message, state: 'editing' }).visible, true);
  assert.equal(action('steer', { ...message, state: 'editing' }).visible, false);
  assert.equal(action('cancel', { ...message, state: 'sending' }).disabled, true);
});

test('各项能力显式 false 独立隐藏对应操作，true 保持可用', () => {
  for (const [name, capability] of [['edit', 'canEdit'], ['steer', 'canSteer'], ['cancel', 'canCancel']]) {
    const row = { ...message, source: 'desktop', [capability]: false };
    for (const other of ['edit', 'steer', 'cancel']) assert.equal(action(other, row).visible, other !== name);
    assert.equal(action(name, { ...row, [capability]: true }).visible, true);
  }
});

test('允许编辑仍受全局开关限制，允许追加仍依赖运行状态，全局禁用保持', () => {
  assert.equal(action('edit', { ...message, canEdit: true }, { editable: false }).visible, false);
  assert.equal(action('steer', { ...message, canSteer: true }, { running: false }).disabled, true);
  for (const name of ['edit', 'steer', 'cancel']) assert.equal(action(name, message, { disabled: true }).disabled, true);
});

test('来源小标签区分电脑同步、手机排队和旧版排队，未知来源不显示', () => {
  assert.deepEqual(sourceLabels({ ...message, source: 'desktop' }), ['电脑同步']);
  assert.deepEqual(sourceLabels({ ...message, source: 'mobile' }), ['手机排队']);
  assert.deepEqual(sourceLabels({ ...message, source: 'legacy' }), ['旧版排队']);
  assert.deepEqual(sourceLabels({ ...message, source: 'other' }), []);
});

test('原生暂停显示排队已暂停，其余状态文案保持兼容', () => {
  assert.match(template, /statusLabel\(message.state\)/);
  assert.match(component, /return queuedMessageLabel\(state\)/);
  for (const [state, label] of Object.entries({ paused: '排队已暂停', editing: '已撤回，可继续编辑', sending: '正在发送…', dispatched: '正在确认任务开始…', unknown: '结果待核对', failed: '发送失败', queued: '等待当前任务完成', other: '等待当前任务完成' })) {
    assert.equal(scope.queuedMessageLabel(state), label);
  }
});

test('三种按钮保留各自 loading 和重复点击禁用', () => {
  for (const name of ['edit', 'steer', 'cancel']) {
    assert.ok(template.includes(':busy="pendingAction == \'queue:' + name + ':\' + message.id"'));
    assert.equal(action(name, message, { pendingAction: 'queue:' + name + ':' + message.id }).disabled, true);
    const other = name === 'edit' ? 'cancel' : 'edit';
    assert.equal(action(other, message, { pendingAction: 'queue:' + name + ':' + message.id }).disabled, false);
  }
});

test('附件展示仅使用计数，不读取原生路径或附件正文', () => {
  assert.match(template, /message.imageCount/);
  assert.match(template, /message.attachmentCount/);
  assert.doesNotMatch(template, /message\.(?:attachments|images|path|localPath|filePath|content)\b/);
  assert.match(service, /source\?: string/);
  for (const capability of ['canEdit', 'canCancel', 'canSteer']) assert.ok(service.includes(capability + '?: boolean'));
});
