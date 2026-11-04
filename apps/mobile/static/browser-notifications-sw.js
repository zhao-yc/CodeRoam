/* 本 Worker 只显示通知，不订阅推送、不拦截请求，也不缓存页面或会话数据。 */
const base = new URL('../', self.location.href);
const home = new URL('#/pages/index/index', base).href;
const seen = new Set();
let pending = Promise.resolve();
const belongs = client => client && new URL(client.url).origin === base.origin && new URL(client.url).pathname.startsWith(base.pathname);

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));

/** 串行消费多标签页事件，标签去重不依赖任意一个页面的倒计时。 */
self.addEventListener('message', event => {
  const port = event.ports?.[0];
  if (!port || !belongs(event.source)) return;
  const data = event.data;
  const execute = async () => {
    if (data?.type === 'codex-notice-close' && Array.isArray(data.tags)) {
      const tags = new Set(data.tags.filter(tag => typeof tag === 'string' && tag.startsWith('codex-mobile-')));
      for (const notice of await self.registration.getNotifications()) if (tags.has(notice.tag)) notice.close();
      return;
    }
    if (data?.type !== 'codex-notice-show' || typeof data.tag !== 'string' || !/^codex-mobile-(task-[a-f0-9]{64}|test-[a-f0-9-]{36})$/.test(data.tag) || typeof data.title !== 'string' || typeof data.body !== 'string') throw Error('通知参数无效');
    // 对应聊天是否正在阅读由页面生命周期判断，不按整个站点前台状态拦截。
    if (seen.has(data.tag) || (await self.registration.getNotifications({ tag: data.tag })).length) return;
    await self.registration.showNotification(data.title.slice(0, 100), {
      body: data.body.slice(0, 200), tag: data.tag, renotify: false,
      data: { ticket: data.tag, sourceId: event.source.id, test: data.test === true },
    });
    seen.add(data.tag);
    if (seen.size > 1024) seen.delete(seen.values().next().value);
  };
  pending = pending.then(execute).then(() => port.postMessage({ ok: true }), () => port.postMessage({ ok: false }));
  event.waitUntil(pending);
});

/** 用户点击才唤起页面；来源窗口或运行期映射已失效时只打开首页。 */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const data = event.notification.data;
    if (data?.sourceId && !data.test) {
      const source = await self.clients.get(data.sourceId);
      if (belongs(source)) try {
        await source.focus();
        const handled = await new Promise(resolve => {
          const channel = new MessageChannel();
          const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 1500);
          channel.port1.onmessage = reply => { clearTimeout(timer); channel.port1.close(); resolve(reply.data?.handled === true); };
          source.postMessage({ type: 'codex-notice-click', ticket: data.ticket }, [channel.port2]);
        });
        if (handled) return;
      } catch (_) { /* 窗口在点击期间关闭时，继续打开安全的站点首页。 */ }
    }
    await self.clients.openWindow(home);
  })());
});
