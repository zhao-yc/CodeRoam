/** 在已核验的桌面页面只读检查原生能力及主机元数据，不读取消息、恢复线程或写入编辑器。 */
export async function prepareThreadMentionsNative(modules, input, boundScope = null) {
  const initial = await import('app://-/assets/' + modules.initial);
  const capability = await import('app://-/assets/' + modules.capability);
  const fail = () => { throw Error('THREAD_MENTION_UNSUPPORTED'); };
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = input.ids ?? [];
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !uuid.test(id)) || input.threadId != null && !uuid.test(input.threadId)) fail();
  const scopes = new Set();
  const accept = value => {
    if (value?.node && typeof value.get === 'function' && ['local', 'new'].includes(value.value?.kind)) scopes.add(value);
  };
  if (boundScope) accept(boundScope);
  else for (const root of document.querySelectorAll('[data-codex-composer-root]')) {
    if (root.getBoundingClientRect().width <= 0 || root.closest('[data-app-shell-active-page="false"]')) continue;
    let hidden = false;
    for (let element = root; element; element = element.parentElement) if (element.hidden || element.inert || element.getAttribute('aria-hidden') === 'true') hidden = true;
    if (hidden) continue;
    let fiber = root[Object.keys(root).find(key => key.startsWith('__reactFiber$'))];
    for (let depth = 0; fiber && depth < 150; fiber = fiber.return, depth++) {
      for (const row of fiber.updateQueue?.memoCache?.data ?? []) for (const value of row) accept(value);
      for (let hook = fiber.memoizedState, n = 0; hook && n < 100; hook = hook.next, n++) {
        accept(hook.memoizedState?.current);
        if (Array.isArray(hook.memoizedState)) for (const value of hook.memoizedState) accept(value);
      }
    }
  }
  if (!scopes.size || typeof initial[modules.formatter] !== 'function' || typeof capability[modules.readCapability] !== 'function') fail();
  let supported = false;
  if (input.threadId) {
    if (!['local', 'durable'].includes(input.ownerHostId) || capability[modules.readCapability](input.threadId) !== true) fail();
    // durable 是管理器编号。只有元数据明确指向原生 local 才允许转换，不能按电脑编号猜测。
    const identities = [];
    for (const scope of scopes) {
      const managerHostId = scope.get(initial[modules.managerHostAtom], input.threadId);
      const metadata = scope.get(initial[modules.conversationAtom], { hostId: managerHostId, threadId: input.threadId });
      if (managerHostId != null) identities.push({ managerHostId, hostId: metadata?.hostId ?? (managerHostId === 'local' && metadata != null ? 'local' : null) });
    }
    if (!identities.length || identities.some(value => value.managerHostId !== input.ownerHostId || value.hostId !== 'local')) fail();
    supported = true;
  } else {
    // 通用探测可复用可见的已有聊天，但只读取能力位与主机元数据，不读取正文。
    if (!boundScope && ids.length === 0) for (const scope of scopes) {
      const id = scope.value.kind === 'local' ? scope.value.conversationId : null;
      if (!id || !uuid.test(id) || capability[modules.readCapability](id) !== true) continue;
      const managerHostId = scope.get(initial[modules.managerHostAtom], id);
      if (!['local', 'durable'].includes(managerHostId)) continue;
      const metadata = scope.get(initial[modules.conversationAtom], { hostId: managerHostId, threadId: id });
      if (metadata?.hostId === 'local' || managerHostId === 'local' && metadata != null && metadata.hostId == null) supported = true;
    }
    const primary = await import('app://-/assets/' + modules.primary);
    const drafts = [...scopes].filter(scope => scope.value.kind === 'new' || scope.value.kind === 'local' && scope.value.conversationId == null);
    if (!supported && drafts.length !== 1) fail();
    const destination = drafts.length === 1 ? drafts[0].get(primary[modules.submitAtom])?.newThreadDestination : null;
    // 原生新建的预检查允许无 conversationId；真实工具检查在 requiresThreadReferences 的创建准备阶段执行。
    supported ||= destination?.kind === 'app-server' && destination.hostId === 'local';
  }
  if (!supported) fail();
  const references = [...new Set(ids)].filter(id => id !== input.threadId).map(threadId => ({ hostId: 'local', threadId }));
  if (!references.length) return { supported: true, references: [], contextText: '' };
  // 只传规范编号与主机；标题属于展示数据，不能进入原生引用格式化参数。
  const contextText = initial[modules.formatter]({ prompt: '', addedFiles: [], fileAttachments: [], imageAttachments: [], ideContext: null, threadReferences: references });
  if (typeof contextText !== 'string' || contextText.length > 32000 || !contextText.includes('read_thread') || !contextText.includes('Referenced chats') || !contextText.includes(JSON.stringify(references))) fail();
  return { supported: true, references, contextText };
}

/** 模块名仅取自本机安装包解析，表达式中所有外部值都作为 JSON 数据传递。 */
export function threadMentionExpression(modules, input) {
  const files = { initial: /^app-initial-[a-f0-9]+\.js$/, primary: /^app-primary-[a-f0-9]+\.js$/, capability: /^thread-reference-capability-[a-f0-9]+\.js$/ };
  const names = ['formatter', 'readCapability', 'managerHostAtom', 'conversationAtom', 'submitAtom'];
  if (!modules || Object.keys(modules).length !== 8 || Object.entries(files).some(([key, pattern]) => !pattern.test(modules[key] ?? '')) || names.some(key => !/^[\w$]+$/.test(modules[key] ?? ''))) throw Error('聊天引用模块无效');
  return `(${prepareThreadMentionsNative.toString()})(${JSON.stringify(modules)},${JSON.stringify(input)}).catch(()=>({supported:false}))`;
}
