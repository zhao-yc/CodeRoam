/** 固定桌面交互只定位明确编号的侧栏行和原生删除弹窗，不接受手机传入脚本。 */
function desktopDeletionStep(phase, expectedHost, expectedThread, commandId) {
  const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight && getComputedStyle(element).visibility !== 'hidden'; };
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible);
  const key = '__codexMobileDeletion';
  const targetDialog = () => {
    if (dialogs.length !== 1) return null;
    const dialog = dialogs[0], pairs = [];
    let element = dialog;
    while (element && !Object.keys(element).some(name => name.startsWith('__reactFiber$'))) element = element.parentElement;
    let fiber = element?.[Object.keys(element).find(name => name.startsWith('__reactFiber$'))];
    for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps;
      if (props && typeof props.conversationId === 'string' && typeof props.hostId === 'string') pairs.push([props.hostId, props.conversationId]);
    }
    // 弹窗的 React 属性必须明确携带目标编号；标题与提示文字不能证明删除对象。
    if (!pairs.length || pairs.some(([host, thread]) => host !== expectedHost || thread !== expectedThread)) return null;
    const buttons = [...dialog.querySelectorAll('button')].filter(visible);
    const confirm = buttons.filter(button => ['删除', 'Delete'].includes(button.textContent.trim()));
    const cancel = buttons.filter(button => ['取消', 'Cancel'].includes(button.textContent.trim()));
    return confirm.length === 1 && cancel.length === 1 ? { confirm: confirm[0], cancel: cancel[0] } : null;
  };
  if (phase === 'inspect') {
    const dialog = targetDialog();
    const rows = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')].filter(element => element.getAttribute('data-app-action-sidebar-thread-id') === 'local:' + expectedThread && element.getAttribute('data-app-action-sidebar-thread-host-id') === expectedHost);
    // 侧栏多选状态与当前打开的对话独立；以明确编号的可见行定位，不依赖多选标记。
    const target = rows.some(visible);
    return { target, targetCount: rows.length, visibleCount: rows.filter(visible).length, dialog: dialogs.length > 0, matched: !!dialog, ready: !!dialog && !dialog.confirm.disabled };
  }
  if (phase === 'open') {
    if (dialogs.length) return { state: 'blocked' };
    const rows = [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')].filter(element => element.getAttribute('data-app-action-sidebar-thread-id') === 'local:' + expectedThread && element.getAttribute('data-app-action-sidebar-thread-host-id') === expectedHost && visible(element));
    if (!rows.length) return { state: 'missing' };
    const row = rows[0]; row.scrollIntoView({ block: 'nearest' });
    const rect = row.getBoundingClientRect();
    const x = rect.left + Math.min(64, rect.width / 2), y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || !row.contains(hit)) return { state: 'covered' };
    window[key] = { host: expectedHost, thread: expectedThread, commandId, submitted: false };
    // 返回刚核对节点的坐标；控制器以原生鼠标事件打开菜单，避免脚本事件被桌面忽略。
    return { state: 'ready', x, y };
  }
  const guard = window[key];
  if (!guard || guard.host !== expectedHost || guard.thread !== expectedThread || guard.commandId !== commandId) return { state: 'changed' };
  const dialog = targetDialog();
  if (phase === 'cancel') {
    if (dialog && !guard.submitted) dialog.cancel.click();
    delete window[key]; return { state: 'canceled' };
  }
  if (phase === 'commit') {
    if (!dialog || dialog.confirm.disabled || guard.submitted) return { state: 'changed' };
    guard.submitted = true;
    dialog.confirm.click();
    return { state: 'submitted' };
  }
  return { state: 'unsupported' };
}

/** 参数经过 JSON 编码，外部不能选择执行函数、页面、选择器或原生命令。 */
export function deletionExpression(phase, hostId, threadId, commandId) {
  if (!['inspect', 'open', 'commit', 'cancel'].includes(phase)) throw new Error('删除交互阶段无效');
  return '(' + desktopDeletionStep.toString() + ')(' + [phase, hostId, threadId, commandId].map(value => JSON.stringify(value)).join(',') + ')';
}
