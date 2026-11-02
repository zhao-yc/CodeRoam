/** 固定桌面交互只定位明确编号的侧栏行和原生删除弹窗，不接受手机传入脚本。 */
function desktopDeletionStep(phase, expectedHost, expectedThread, commandId) {
  const rendered = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
  const visible = element => { const rect = element.getBoundingClientRect(); return rendered(element) && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight; };
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(visible);
  const key = '__codexMobileDeletion';
  /** 新建会话的侧栏键可能仍是临时编号；只信任同一行组件明确绑定的正式编号。 */
  const matchesRow = element => {
    if (element.getAttribute('data-app-action-sidebar-thread-host-id') !== expectedHost) return false;
    const rowId = element.getAttribute('data-app-action-sidebar-thread-id');
    if (rowId === expectedHost + ':' + expectedThread) return true;
    const prefix = expectedHost + ':client-new-thread:';
    if (!rowId?.startsWith(prefix) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(rowId.slice(prefix.length))) return false;
    let fiber = element[Object.keys(element).find(name => name.startsWith('__reactFiber$'))];
    const pairs = [];
    for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps, attributes = props?.dataAttributes;
      // 属性必须与当前 DOM 行完全一致，不能使用共享祖先中其他会话的编号。
      if (attributes?.['data-app-action-sidebar-thread-id'] !== rowId || attributes['data-app-action-sidebar-thread-host-id'] !== expectedHost) continue;
      if (typeof props.conversationId === 'string' && typeof props.hostId === 'string') pairs.push([props.hostId, props.conversationId]);
    }
    return pairs.length > 0 && pairs.every(([host, thread]) => host === expectedHost && thread === expectedThread);
  };
  const targetRows = () => [...document.querySelectorAll('[data-app-action-sidebar-thread-id]')].filter(matchesRow);
  /** 菜单必须来自该行已绑定正式编号的组件，不能调用共享容器或其他会话的动作。 */
  const rowMenu = row => {
    const rowId = row.getAttribute('data-app-action-sidebar-thread-id');
    let fiber = row[Object.keys(row).find(name => name.startsWith('__reactFiber$'))], bound = false;
    for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps, attributes = props?.dataAttributes;
      if (attributes?.['data-app-action-sidebar-thread-id'] === rowId && attributes['data-app-action-sidebar-thread-host-id'] === expectedHost && typeof props.conversationId === 'string' && typeof props.hostId === 'string') {
        if (props.conversationId !== expectedThread || props.hostId !== expectedHost) return null;
        bound = true;
      }
      if (typeof props?.getItems === 'function') return bound ? props.getItems : null;
    }
    return null;
  };
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
    const rows = targetRows();
    // 侧栏多选状态与当前打开的对话独立；先按编号找到已渲染行，视口外的行稍后滚动。
    const target = rows.some(rendered);
    return { target, targetCount: rows.length, visibleCount: rows.filter(visible).length, aliasCount: rows.filter(row => row.getAttribute('data-app-action-sidebar-thread-id') !== expectedHost + ':' + expectedThread).length, dialog: dialogs.length > 0, matched: !!dialog, ready: !!dialog && !dialog.confirm.disabled };
  }
  if (phase === 'open') {
    if (dialogs.length) return { state: 'blocked' };
    const rows = targetRows().filter(rendered);
    if (!rows.length) return { state: 'missing' };
    const row = rows.find(visible) ?? rows[0]; row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // 滚动后再次核对身份，原桌面菜单动作始终绑定明确会话，不依赖鼠标坐标或标题。
    if (!matchesRow(row) || !visible(row)) return { state: 'changed' };
    const getItems = rowMenu(row);
    if (!getItems || window[key]) return { state: 'unavailable' };
    const guard = { host: expectedHost, thread: expectedThread, commandId, submitted: false };
    window[key] = guard;
    return (async () => {
      try {
        const items = await getItems();
        if (window[key] !== guard || !matchesRow(row) || rowMenu(row) !== getItems || !rendered(row)) return { state: 'changed' };
        if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(visible)) return { state: 'blocked' };
        const actions = Array.isArray(items) ? items.filter(item => item?.id === 'delete-thread') : [];
        if (actions.length !== 1) return { state: 'unavailable' };
        const action = actions[0];
        // 原动作声明为打开确认框；拒绝同名、禁用、批量或不兼容的菜单定义。
        if (action.message?.id !== 'sidebarElectron.deleteThread' || action.selectAfterClose !== true || action.enabled === false || action.disabled === true || typeof action.onSelect !== 'function') return { state: 'unavailable' };
        action.onSelect();
        return { state: 'opened' };
      } catch { return { state: 'unavailable' }; }
    })();
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
