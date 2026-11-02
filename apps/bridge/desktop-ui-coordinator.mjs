let previous = Promise.resolve();

/** 同一电脑的原生目标操作与桥接导航共用队列，避免跨会话界面互相抢占。 */
export function withDesktopUi(operation) {
  const current = previous.catch(() => {}).then(operation);
  previous = current;
  return current;
}
