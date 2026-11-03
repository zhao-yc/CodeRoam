/** 普通启动通过独占 IPC 或内核确认的多实例 IPC 接入，无桌面页面通道。 */
export function usesWindowsIpcWithoutPage(instance) {
  return instance?.directIpc === true || (instance?.routerManaged === true && !instance.port);
}
