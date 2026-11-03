import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const source = fs.readFileSync('apps/mobile/components/message-composer/message-composer.uvue', 'utf8');

/** 执行真实组件脚本，区分 Web 与原生条件编译，并控制迟到布局回调。 */
function fixture({web = true, id = 'composer-a', onSubmit = () => {}} = {}) {
  const events = [], frames = [], timers = new Map(), unmounts = [], reads = [];
  let timerId = 0;
  const props = {instanceId: id, resetKey: 'host:thread', active: true, text: '合成草稿', expanded: true, inputHeight: 64,
    images: [], files: [], plugins: [], mentions: [], disabled: false};
  const context = {defineProps: () => props, withDefaults: (value, defaults) => Object.assign(value, {...defaults, ...value}),
    defineEmits: () => (name, ...args) => { events.push({name, args}); if (name === 'submit') onSubmit(); }, ref: value => ({value}),
    computed: read => ({get value() { return read(); }}), watch() {}, nextTick: fn => frames.push(fn),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    onUnmounted: fn => unmounts.push(fn), fileSizeLabel: size => size + ' 字节', useLiquidGlass: () => false,
    uni: {getElementById: id => { reads.push(id); return {getBoundingClientRect: () => ({height: 134})}; }}};
  let code = source.split('<script setup lang="uts">')[1].split('</script>')[0].replace(/^import .*\n/gm, '');
  code = code.replace(web ? /\/\/ #ifndef WEB[\s\S]*?\/\/ #endif/g : /\/\/ #ifdef WEB[\s\S]*?\/\/ #endif/g, '');
  vm.runInNewContext(stripTypeScriptTypes(code, {mode: 'transform'}) + '\nglobalThis.ui={onInput,onKeydown,onConfirm,measureContent,visibleContentHeight,stageHeight,fileStatus};', context);
  return {props, events, frames, timers, reads, ui: context.ui, flush() { while (frames.length) frames.shift()(); }, unmount() { unmounts.forEach(fn => fn()); }};
}

test('Web 回车只请求提交一次，确认事件不重复提交，换行与输入法选词保持默认行为', () => {
  const f = fixture();
  let prevented = 0;
  const key = values => ({key: 'Enter', preventDefault() { prevented++; }, ...values});
  f.ui.onKeydown(key({})); f.ui.onConfirm();
  assert.equal(prevented, 1); assert.equal(f.events.filter(event => event.name === 'submit').length, 1);
  for (const value of [{shiftKey: true}, {ctrlKey: true}, {altKey: true}, {metaKey: true}, {isComposing: true}, {keyCode: 229}, {key: 'a'}]) f.ui.onKeydown(key(value));
  assert.equal(prevented, 1); assert.equal(f.events.length, 1);
  f.ui.onKeydown(key({repeat: true}));
  assert.equal(prevented, 2); assert.equal(f.events.length, 1);
});

test('原生平台通过确认提交，隐藏、禁用或卸载后的确认不提交', () => {
  const f = fixture({web: false});
  f.ui.onKeydown({key: 'Enter'}); assert.equal(f.events.length, 0);
  f.ui.onConfirm(); assert.equal(f.events.length, 1);
  f.props.active = false; f.ui.onConfirm(); f.props.active = true;
  f.props.disabled = true; f.ui.onConfirm(); f.props.disabled = false;
  f.unmount(); f.ui.onConfirm(); assert.equal(f.events.length, 1);
});

test('回车先同步尚未回调的最新正文，迟到的同一输入不覆盖发送成功后的草稿', () => {
  const f = fixture();
  f.ui.onKeydown({key: 'Enter', target: {value: '第一行\n刚输入的第二行'}, preventDefault() {}});
  assert.deepEqual(f.events.map(event => event.name), ['syncinput', 'submit']);
  assert.equal(f.events[0].args[0], '第一行\n刚输入的第二行');
  f.props.text = ''; f.ui.onInput({detail: {value: '第一行\n刚输入的第二行'}});
  assert.equal(f.events.length, 2);
  f.ui.onInput({detail: {value: '下一条新草稿'}});
  assert.equal(f.events.at(-1).name, 'input');
});

test('多实例分别测量自身节点，隐藏、目标变化和卸载使旧布局帧失效', () => {
  const a = fixture(), b = fixture({id: 'composer-b'});
  a.ui.measureContent(); b.ui.measureContent(); a.flush(); b.flush();
  assert.deepEqual(a.reads, ['composer-a-content']); assert.deepEqual(b.reads, ['composer-b-content']);
  assert.equal(a.ui.stageHeight.value, 192);
  a.props.contentHeight = 90; assert.equal(a.ui.stageHeight.value, 148);
  a.props.expanded = false; assert.equal(a.ui.stageHeight.value, 44);
  a.events.length = 0; const old = [...a.timers.values()][0];
  a.ui.measureContent(); a.props.resetKey = 'other'; a.ui.measureContent(); a.props.active = false; a.ui.measureContent();
  a.flush(); old(); assert.equal(a.events.length, 0);
  b.events.length = 0; b.ui.measureContent(); b.unmount(); b.flush();
  assert.equal(b.events.length, 0);
});

test('面板只保留一个输入节点，附件状态覆盖本地、上传、失败及暂停', () => {
  assert.equal((source.split('<script')[0].match(/<textarea\b/g) ?? []).length, 1);
  const f = fixture(), file = {size: 5, status: 'local', error: '', progress: 20};
  assert.equal(f.ui.fileStatus(file), '5 字节');
  assert.equal(f.ui.fileStatus({...file, status: 'uploading'}), '正在上传 20%');
  assert.equal(f.ui.fileStatus({...file, status: 'ready'}), '5 字节 · 已就绪');
  assert.equal(f.ui.fileStatus({...file, status: 'paused'}), '上传已暂停，点击重试');
  assert.equal(f.ui.fileStatus({...file, error: '合成错误'}), '合成错误');
});

/** 把共用组件的提交事件连到真实新建方法，确认键盘不会绕过业务校验。 */
test('新聊天回车与按钮共用创建流程，提交中不重复创建，失败保留草稿，仅附件也能发送', async () => {
  const parent = fs.readFileSync('apps/mobile/components/new-conversation/new-conversation.uvue', 'utf8');
  const pending = [], events = [], ref = value => ({value});
  const c = {props: {expanded: true}, projectReady: ref(true), existingDraft: ref(null),
    connection: {configurationRevision: 1}, newConversationMode: ref('nativeDraft'), outcomeUnknown: ref(false),
    hasCompletedConversation: ref(false), direct: ref({threadId: ''}), mentionsAvailable: ref(true),
    busy: ref(false), pendingNewAction: ref(''), imageBusy: ref(false), settingsLoading: ref(false),
    draft: ref({text: '保留的合成草稿', images: [], files: [], threadMentions: []}), modelSupportsImages: ref(true), error: ref(''), progress: ref(''), alive: true,
    computed: read => ({get value() { return read(); }}), closeMenus() {}, uni: {hideKeyboard() {}},
    emit: (...event) => events.push(event), sendNewConversation: () => new Promise((resolve, reject) => pending.push({resolve, reject}))};
  c.operationBusy = c.busy;
  const code = parent.match(/^const canSend = [^]*?(?=^const pickerHeight)/m)[0] + '\n' + parent.match(/async function send\(\) \{[^]*?\n\}/)[0];
  vm.runInNewContext(stripTypeScriptTypes(code, {mode: 'transform'}) + '\nglobalThis.send=send;', c);
  const input = fixture({onSubmit: () => { c.send(); }});
  const enter = () => input.ui.onKeydown({key: 'Enter', preventDefault() {}});
  enter(); enter(); await c.send(); assert.equal(pending.length, 1); assert.equal(c.pendingNewAction.value, 'send');
  pending.shift().reject(Error('合成发送失败')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.draft.value.text, '保留的合成草稿'); assert.equal(c.error.value, '合成发送失败'); assert.equal(c.busy.value, false); assert.equal(c.pendingNewAction.value, '');
  c.draft.value.text = ''; enter(); assert.equal(pending.length, 0);
  c.draft.value.images = [{id: 'example-image'}]; enter(); assert.equal(pending.length, 1);
  pending.shift().resolve('example-thread'); await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.some(event => event[0] === 'created' && event[1] === 'example-thread'));
  c.projectReady.value = false; enter(); assert.equal(pending.length, 0);
});

test('详情回车只采纳预测或发送内容，空输入不触发停止和重试，禁用或附件未就绪时保留输入', () => {
  const parent = fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue', 'utf8');
  const calls = [], ref = value => ({value});
  const c = {canWrite: ref(true), imageBusy: ref(false), filesReady: ref(true), draft: ref(''), visiblePrediction: ref('合成预测'),
    draftImages: ref([]), draftFiles: ref([]), send: () => calls.push('发送'),
    acceptPrediction: () => { calls.push('采纳'); c.draft.value = c.visiblePrediction.value; c.visiblePrediction.value = ''; }};
  vm.runInNewContext(stripTypeScriptTypes(parent.match(/function applyComposerEnter\(\) \{[^]*?\n\}/)[0]) + '\nglobalThis.submit=applyComposerEnter;', c);
  const input = fixture({onSubmit: () => c.submit()}), enter = () => input.ui.onKeydown({key: 'Enter', preventDefault() {}});
  enter(); assert.deepEqual(calls, ['采纳']); enter(); assert.deepEqual(calls, ['采纳', '发送']);
  calls.length = 0; c.draft.value = ''; enter(); assert.deepEqual(calls, []);
  c.draftFiles.value = [{id: 'example-file'}]; enter(); assert.deepEqual(calls, ['发送']);
  c.filesReady.value = false; enter(); c.filesReady.value = true; c.canWrite.value = false; enter();
  assert.deepEqual(calls, ['发送']); assert.equal(c.draftFiles.value.length, 1);
});
