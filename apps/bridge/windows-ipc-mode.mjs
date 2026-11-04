/** 普通启动通过独占 IPC 或内核确认的多实例 IPC 接入，无桌面页面通道。 */
export function usesWindowsIpcWithoutPage(instance) {
  return instance?.directIpc === true || (instance?.routerManaged === true && !instance.port);
}

/** 新聊天可复用已核验的 Windows IPC，页面草稿能力失效不会撤销有效的实例绑定。 */
export function supportsDesktopIpcNewConversation(adapter) {
  const client = adapter?.client, instance = client?.instance;
  if (adapter?.stopped || !instance || (instance.platform !== undefined && instance.platform !== 'win32') ||
      instance.alive !== true || instance.ready !== true || typeof instance.generation !== 'string' || instance.generation.length === 0 ||
      typeof client.assertCurrent !== 'function') return false;
  try {
    // 路由客户端会在这里刷新当前集合，先检查过期连接再判断非空绑定。
    client.assertCurrent();
    if (instance.directIpc === true) return true;
    const hasBoundClients = client.allowedClients instanceof Set && client.allowedClients.size > 0;
    return hasBoundClients && (instance.routerManaged === true || Number.isInteger(instance.port) && instance.port > 0 && instance.port <= 65535);
  } catch { return false; }
}
