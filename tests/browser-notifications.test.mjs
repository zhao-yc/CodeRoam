import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';

const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
const notice = kind => ({ key: JSON.stringify(['host', 'generation', 'thread', kind, 'turn', 'target']), hostId: 'host', generation: 'generation', threadId: 'thread', threadTitle: '合成测试聊天', turnId: 'turn', kind, targetId: 'target' });
const tag = 'codex-mobile-task-' + 'a'.repeat(64);

/** 使用真实 Worker 脚本和可观察通知列表，验证多窗口行为而非重写实现。 */
function workerFixture() {
  const listeners = {}, notifications = [], opened = [], delivered = [];
  const source = { id: 'window-one', url: 'https://example.com/mobile/#/pages/index/index', visibilityState: 'hidden', focused: false, async focus() {}, postMessage(data, ports) { delivered.push(data); ports[0].postMessage({ handled: true }); } };
  const windows = [source];
  const self = { location: { href: 'https://example.com/mobile/static/browser-notifications-sw.js' }, addEventListener: (type, listener) => { listeners[type] = listener; }, skipWaiting: async () => {}, clients: { matchAll: async () => windows, get: async id => windows.find(window => window.id === id), openWindow: async url => opened.push(url) }, registration: { getNotifications: async options => notifications.filter(item => !item.closed && (!options?.tag || item.tag === options.tag)), showNotification: async (title, options) => notifications.push({ title, ...options, close() { this.closed = true; } }) } };
  vm.runInNewContext(fs.readFileSync('apps/mobile/static/browser-notifications-sw.js', 'utf8'), { self, URL, MessageChannel, setTimeout, clearTimeout });
  async function send(data, client = source) {
    let completion, response;
    listeners.message({ data, source: client, ports: [{ postMessage(value) { response = value; } }], waitUntil(value) { completion = value; } });
    await completion; return response;
  }
  async function click(item) { let completion; listeners.notificationclick({ notification: item, waitUntil(value) { completion = value; } }); await completion; }
  return { source, windows, notifications, opened, delivered, send, click };
}

/** 模拟浏览器能力和 Worker 消息，运行真实 UTS 服务的授权及清理流程。 */
function browserFixture({ permission = 'default', enabled = false, secure = true, supported = true, failed = false } = {}) {
  const events = {}, storage = new Map(), messages = [], transports = [], opened = [], visibility = [];
  if (enabled) storage.set('codex-mobile-browser-notifications-enabled', true);
  let focused = true, permissionRequests = 0, permissionResult = 'granted';
  const Notification = { get permission() { return permission; }, async requestPermission() { permissionRequests++; permission = permissionResult; return permission; } };
  const worker = { state: 'activated', postMessage(data, ports) { messages.push(data); ports[0].postMessage({ ok: !failed }); } };
  const context = vm.createContext({ URL, TextEncoder, Uint8Array, MessageChannel, crypto: webcrypto, setTimeout, clearTimeout, reactive: value => value, taskNoticeTitle: kind => '合成事件：' + kind,
    document: { baseURI: 'https://example.com/mobile/', visibilityState: 'visible', hasFocus: () => focused, addEventListener: (type, listener) => { events[type] = listener; } },
    window: { isSecureContext: secure, ...(supported ? { Notification, MessageChannel } : {}), addEventListener: (type, listener) => { events[type] = listener; } }, Notification, location: { origin: 'https://example.com' },
    navigator: { userAgent: '合成桌面浏览器', platform: '合成平台', maxTouchPoints: 0, serviceWorker: { register: async () => { if (failed) throw Error('合成安装失败'); return { active: worker }; }, addEventListener: (type, listener) => { events['worker-' + type] = listener; } } },
    uni: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value) } });
  const code = fs.readFileSync('apps/mobile/services/browser-notifications.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replaceAll('export ', '');
  vm.runInContext(stripTypeScriptTypes(code, { mode: 'transform' }) + ';globalThis.api={browserNotifications,startBrowserNotifications,syncBrowserNotificationContext,enableBrowserNotifications,disableBrowserNotifications,deliverBrowserTaskNotice,testBrowserNotification,browserNotificationLabel};', context);
  const api = context.api;
  api.startBrowserNotifications(value => opened.push(value), value => transports.push(value), value => visibility.push(value));
  api.syncBrowserNotificationContext('synthetic-pair', [JSON.stringify(['host', 'generation'])]);
  return { ...api, events, storage, messages, transports, opened, visibility, get permissionRequests() { return permissionRequests; }, setPermission: value => { permission = value; }, setPermissionResult: value => { permissionResult = value; }, background() { focused = false; events.blur(); }, foreground() { focused = true; events.focus(); } };
}

test('默认不申请权限；允许后就绪，前台不投递，后台五类事件均投递且仅带标题', async () => {
  const f = browserFixture(); assert.equal(f.permissionRequests, 0); assert.equal(f.browserNotificationLabel(), '未授权');
  await f.enableBrowserNotifications(); assert.equal(f.browserNotifications.ready, true); assert.equal(f.transports.at(-1), true);
  await f.deliverBrowserTaskNotice(notice('completed')); assert.equal(f.messages.length, 0);
  f.background();
  for (const kind of ['completed', 'failed', 'question', 'approval', 'plan']) await f.deliverBrowserTaskNotice(notice(kind));
  assert.equal(f.messages.length, 5); assert.equal(f.messages[0].body, '合成测试聊天');
  assert.deepEqual(Object.keys(f.messages[0]).sort(), ['body', 'tag', 'test', 'title', 'type']);
  assert.ok(f.messages.every(message => /^codex-mobile-task-[a-f0-9]{64}$/.test(message.tag)));
  assert.equal(JSON.stringify(f.messages).includes('synthetic-pair'), false);
  f.foreground(); assert.equal(f.messages.length, 5, '回前台不重放');
});

test('取消、拒绝、不安全来源和缺失 API 不会被当成开启', async () => {
  for (const result of ['default', 'denied']) { const f = browserFixture(); f.setPermissionResult(result); await f.enableBrowserNotifications(); assert.equal(f.browserNotifications.enabled, false); assert.equal(f.browserNotifications.ready, false); }
  const denied = browserFixture({ permission: 'denied' }); await denied.enableBrowserNotifications(); assert.equal(denied.permissionRequests, 0); assert.match(denied.browserNotifications.error, /站点设置/);
  for (const options of [{ secure: false }, { supported: false }]) { const f = browserFixture(options); await f.enableBrowserNotifications(); assert.equal(f.permissionRequests, 0); assert.equal(f.transports.at(-1), false); }
});

test('已开启偏好启动时恢复，初始化失败降级；权限撤回和关闭清理系统通知', async () => {
  const failed = browserFixture({ permission: 'granted', enabled: true, failed: true }); await settle(); assert.equal(failed.browserNotifications.ready, false); assert.match(failed.browserNotifications.error, /初始化失败/);
  const f = browserFixture({ permission: 'granted', enabled: true }); await settle(); assert.equal(f.browserNotifications.ready, true); assert.equal(f.permissionRequests, 0);
  f.background(); await f.deliverBrowserTaskNotice(notice('question')); f.setPermission('denied'); f.foreground(); await settle();
  assert.equal(f.transports.at(-1), false); assert.equal(f.browserNotifications.ready, false); assert.equal(f.messages.at(-1).type, 'codex-notice-close');
  f.disableBrowserNotifications(); assert.equal(f.browserNotifications.enabled, false); assert.equal(f.storage.get('codex-mobile-browser-notifications-enabled'), false);
});

test('实例和配对切换清除映射，只有有效通知点击交给现有导航', async () => {
  const f = browserFixture(); await f.enableBrowserNotifications(); f.background(); await f.deliverBrowserTaskNotice(notice('approval'));
  const ticket = f.messages[0].tag, replies = [];
  const click = () => f.events['worker-message']({ data: { type: 'codex-notice-click', ticket }, origin: 'https://example.com', ports: [{ postMessage: value => replies.push(value) }] });
  click(); assert.equal(replies.at(-1).handled, true); assert.equal(f.opened.length, 1);
  await f.deliverBrowserTaskNotice(notice('approval')); f.syncBrowserNotificationContext('synthetic-pair', []); click();
  assert.equal(replies.at(-1).handled, false); assert.equal(f.opened.length, 1);
  f.syncBrowserNotificationContext('other-pair', [JSON.stringify(['host', 'generation'])]); click(); assert.equal(replies.at(-1).handled, false);
});

test('Worker 在任一前台应用窗口存在时抑制系统通知，显式测试允许前台显示', async () => {
  const f = workerFixture(); f.windows.push({ id: 'other', url: f.source.url, focused: true, visibilityState: 'visible' });
  await f.send({ type: 'codex-notice-show', tag, title: '合成通知', body: '合成聊天' }); assert.equal(f.notifications.length, 0);
  await f.send({ type: 'codex-notice-show', tag: 'codex-mobile-test-00000000-0000-4000-8000-000000000000', title: '合成测试', body: '合成测试', test: true }); assert.equal(f.notifications.length, 1);
});

test('Worker 并发多标签仅显示一次，手动关闭后同一运行期也不重复提示', async () => {
  const f = workerFixture(), event = { type: 'codex-notice-show', tag, title: '合成通知', body: '合成聊天' };
  await Promise.all([f.send(event), f.send(event)]); assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].renotify, false);
  assert.deepEqual(plain(f.notifications[0].data), { ticket: tag, sourceId: 'window-one', test: false });
  f.notifications[0].close(); await f.send(event); assert.equal(f.notifications.length, 1);
});

test('Worker 点击优先唤起来源，窗口关闭或映射失效时仅打开同站点首页', async () => {
  const f = workerFixture(); await f.send({ type: 'codex-notice-show', tag, title: '合成通知', body: '合成聊天' });
  await f.click(f.notifications[0]); assert.equal(f.delivered[0].ticket, tag); assert.equal(f.opened.length, 0);
  f.source.postMessage = (_, ports) => ports[0].postMessage({ handled: false }); await f.click(f.notifications[0]); assert.deepEqual(f.opened, ['https://example.com/mobile/#/pages/index/index']);
  f.windows.length = 0; await f.click(f.notifications[0]); assert.equal(f.opened.length, 2);
});

test('Worker 只清理本功能指定的通知，不清理其他站点功能', async () => {
  const f = workerFixture(); await f.send({ type: 'codex-notice-show', tag, title: '合成通知', body: '合成聊天' });
  f.notifications.push({ tag: 'other-feature', closed: false, close() { this.closed = true; } });
  await f.send({ type: 'codex-notice-close', tags: [tag, 'other-feature'] }); assert.equal(f.notifications[0].closed, true); assert.equal(f.notifications[1].closed, false);
});

test('状态机后台仍输出当前聊天新事件，卡片不积压且恢复不补历史结果', () => {
  const code = fs.readFileSync('apps/mobile/services/task-notification-state.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replaceAll('export ', '');
  const context = vm.createContext({}); vm.runInContext(stripTypeScriptTypes(code, { mode: 'transform' }) + ';globalThis.Center=TaskNotificationCenter;', context);
  const center = new context.Center(), row = status => ({ id: 'thread', title: '合成聊天', notificationState: { latestTurnId: 'turn', latestTurnStatus: status, pending: [] } });
  center.setVisibleThread('host', 'thread', 0); center.observe('host', 'generation', [row('inProgress')], 0); center.setPresentationActive(false);
  const events = center.observe('host', 'generation', [row('completed')], 1); assert.equal(events.length, 1); assert.equal(center.current, null);
  assert.equal(center.observe('host', 'generation', [row('completed')], 2).length, 0);
  center.setPresentationActive(true); assert.equal(center.current, null); center.reset(); assert.equal(center.observe('host', 'generation', [row('failed')], 3).length, 0);
});

test('只有已授权通知允许后台连接，心跳和重连门禁一致，关闭后恢复断开', () => {
  const code = fs.readFileSync('apps/mobile/services/bridge.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replaceAll('export ', '');
  const timers = [], requests = [];
  const context = vm.createContext({ reactive: value => value, setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout() {} });
  vm.runInContext(stripTypeScriptTypes(code, { mode: 'transform' }) + ';globalThis.api={MobileBridge,connection};', context);
  const { MobileBridge, connection } = context.api, bridge = new MobileBridge();
  let disconnected = 0, connected = 0;
  bridge.disconnect = () => { disconnected++; }; bridge.connect = () => { connected++; };
  bridge.background(); assert.equal(disconnected, 1); assert.equal(bridge.shouldMaintainConnection(), false);
  bridge.config = { relayUrl: 'wss://example.com/ws' }; bridge.setBackgroundNotifications(true); assert.equal(connected, 1);
  bridge.background(); assert.equal(disconnected, 1); assert.equal(bridge.shouldMaintainConnection(), true);
  connection.connected = true; bridge.request = method => { requests.push(method); return new Promise(() => {}); };
  bridge.heartbeat(); timers.pop()(); assert.deepEqual(requests, ['ping']);
  bridge.scheduleReconnect(); assert.equal(timers.length, 1); timers.pop()(); assert.equal(connected, 2);
  bridge.setBackgroundNotifications(false); assert.equal(disconnected, 2); assert.equal(bridge.shouldMaintainConnection(), false);
  bridge.scheduleReconnect(); assert.equal(timers.length, 0);
});
