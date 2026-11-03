import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const detail = fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue', 'utf8');
const windowSource = detail.slice(detail.indexOf("const timelineBoundary = ref('')"), detail.indexOf('const messagePresentations = computed('));
const fillSource = detail.slice(detail.indexOf('function waitForTimelinePaint('), detail.indexOf('// 所有异步布局共用一条补偿链')) + detail.match(/^function scheduleTimelineFill\(\) \{[\s\S]*?^\}/m)[0];
const jumpSource = detail.slice(detail.indexOf('function jumpTo(anchor: string)'), detail.indexOf('// 点击通知后等待目标快照'));

// 用真实页面窗口方法测试首次挂载和后续批次，布局锚点由现有页面钩子接手。
function fixture() {
  const timers = [];
  const layouts = [];
  const entries = Array.from({ length: 80 }, (_, index) => ({ id: 'm' + index, text: '长段落加粗文字与行内代码\n'.repeat(45) }));
  const context = vm.createContext({
    timeline: { value: entries }, ref: value => ({ value }), computed: getter => ({ get value() { return getter(); } }),
    props: { paneWidth: 430, paneHeight: 900 }, pageVisible: { value: true }, cacheFilling: { value: false },
    isCurrentPage: () => true, touchingTimeline: false, cacheInitialPositioning: false, readingCorrectionPending: false,
    beforeMarkdownLayout: () => layouts.push('记录锚点'), afterMarkdownLayout: () => layouts.push('恢复锚点'),
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    nextTick: callback => callback(), checkShortHistory() {}, closeActions() {}, pauseFollowing() {},
    scrollTarget: { value: '' }, historyGesture: 0, layoutUntil: 0, cancelReadingCorrection: () => layouts.push('取消锚点'), entryAnchor: entry => 'message-' + entry.id
  });
  vm.runInContext(stripTypeScriptTypes(windowSource + fillSource + jumpSource, { mode: 'transform' }) + ';globalThis.api={visibleTimeline, firstScreenTimelineStart, scheduleTimelineFill, timelinePaintReady, cancelTimelinePaintWait, localTimelineHasMore, jumpTo};', context);
  return { ...context.api, context, entries, timers, layouts };
}

test('长消息首帧只挂载靠底部的内容，后台分批前插并保持阅读锚点', () => {
  const f = fixture();
  assert.match(detail, /v-for="entry in renderedTimeline"/);
  assert.deepEqual(Array.from(f.visibleTimeline.value, entry => entry.id), ['m79']);
  f.scheduleTimelineFill();
  assert.equal(f.timers[0].delay, 150);
  f.context.touchingTimeline = true;
  f.timers.shift().callback();
  assert.equal(f.visibleTimeline.value.length, 1);
  assert.deepEqual(f.layouts, []);
  f.context.touchingTimeline = false;
  f.timers.shift().callback();
  assert.deepEqual(Array.from(f.visibleTimeline.value, entry => entry.id), f.entries.slice(73).map(entry => entry.id));
  assert.deepEqual(f.layouts, ['记录锚点', '恢复锚点']);
  assert.equal(f.timers[0].delay, 48);
  while (f.timers.length > 0) f.timers.shift().callback();
  assert.equal(f.visibleTimeline.value.length, 80);
  assert.equal(f.localTimelineHasMore(), false);
});

test('Web 首条消息在视口内经历两次帧回调才开放补齐，退出后作废旧回调', () => {
  const f = fixture();
  let rowTop = 901, sequence = 0, reads = 0;
  const frames = new Map();
  f.context.window = {
    requestAnimationFrame: callback => { frames.set(++sequence, callback); return sequence; },
    cancelAnimationFrame: id => frames.delete(id)
  };
  f.context.uni = { getElementById: id => ({ getBoundingClientRect: () => id == 'conversation-timeline'
    ? { top: 0, bottom: 900, height: 900 } : { top: rowTop, bottom: rowTop + 100, height: 100 } }) };
  f.context.scheduleCacheFill = () => { reads++; };
  const nextFrame = () => {
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    callback();
  };
  f.scheduleTimelineFill();
  const stale = frames.values().next().value;
  f.cancelTimelinePaintWait();
  f.scheduleTimelineFill();
  stale();
  assert.equal(frames.size, 1);
  nextFrame();
  assert.equal(f.timers.length, 0);
  rowTop = 50;
  nextFrame();
  assert.equal(f.timers.length, 0);
  assert.equal(reads, 0);
  nextFrame();
  assert.equal(f.timers[0].delay, 150);
  assert.equal(reads, 1);
});

test('Web 无正文时直接开放完整缓存读取', () => {
  const f = fixture();
  f.context.timeline.value = [];
  f.context.window = { requestAnimationFrame: () => assert.fail('空预览不等待动画帧') };
  assert.equal(f.timelinePaintReady(), true);
});

test('冷预览补齐时保留首批边界，消息通知可立即定位到未挂载的目标', () => {
  const f = fixture();
  f.context.cacheFilling.value = true;
  f.context.timeline.value = f.entries.slice(-1);
  f.scheduleTimelineFill();
  assert.equal(f.localTimelineHasMore(), true);
  assert.equal(f.timers.length, 0);
  f.context.timeline.value = f.entries;
  assert.deepEqual(Array.from(f.visibleTimeline.value, entry => entry.id), ['m79']);
  f.jumpTo('message-m13');
  assert.equal(f.visibleTimeline.value[0].id, 'm13');
  assert.equal(f.context.scrollTarget.value, 'message-m13');
  assert.deepEqual(f.layouts, ['取消锚点']);
});
