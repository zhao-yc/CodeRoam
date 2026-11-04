import { instanceServicesExpression } from './instance-binding.mjs';

/** 固定原生队列操作程序；只调用已加载的原桌面服务，不接受手机脚本或桌面路径。 */
export async function runNativeMessageQueue(services, action, input) {
  const fail = code => { throw Error(code); };
  const opened = await services.appServerManagers.open(input.hostId);
  if (opened.status !== 'ready') fail('NATIVE_QUEUE_UNAVAILABLE');
  const manager = opened.manager;
  const assertOwner = async () => {
    if ((await manager.getStreamRole(input.threadId))?.role !== 'owner') fail('NATIVE_QUEUE_CHANGED');
  };
  await assertOwner();
  const coordinator = await manager.getTurnCoordinator();
  if (![coordinator.restoreQueuedMessage, coordinator.removeQueuedMessage, coordinator.sendQueuedMessageNow, manager.subscribe].every(value => typeof value === 'function')) fail('NATIVE_QUEUE_UNAVAILABLE');
  let rows;
  let subscription;
  const call = manager.subscribe({ type: 'thread', key: { hostId: input.hostId, threadId: input.threadId }, field: 'queuedMessages', listener: value => { rows = value; } });
  try {
    subscription = await call;
    for (let n = 0; rows == null && n < 35; n++) await new Promise(resolve => setTimeout(resolve, 80));
    if (!Array.isArray(rows) || rows.length > 200) fail('NATIVE_QUEUE_UNAVAILABLE');
    await assertOwner();
    const simple = message => {
      const context = message.context ?? {};
      const allowed = new Set(['prompt', 'addedFiles', 'fileAttachments', 'ideContext', 'imageAttachments', 'workspaceRoots', 'messageThreadId']);
      return Object.entries(context).every(([key, value]) => allowed.has(key) || value == null || Array.isArray(value) && value.length === 0) && !message.submissionOptions && !message.writingBlockAdditionalContext && !message.multiUserMessageSender && !(context.addedFiles?.length) && context.ideContext == null;
    };
    const imagesOf = message => message.context?.imageAttachments ?? [];
    const filesOf = message => message.context?.fileAttachments ?? [];
    const mutable = message => !['sending', 'outcome-unknown', 'pending'].includes(message.submission?.status);
    const editable = message => mutable(message) && simple(message) && !filesOf(message).length && imagesOf(message).length <= 3 && imagesOf(message).every(image => typeof image.src === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(image.src)) && typeof message.text === 'string' && message.text.length <= 32000;
    if (action === 'read') return { supported: true, messages: rows.map(message => ({
      id: message.id, text: String(message.text ?? '').slice(0, 32000), imageCount: imagesOf(message).length, attachmentCount: filesOf(message).length,
      state: message.submission?.status === 'outcome-unknown' ? 'unknown' : message.submission?.status === 'sending' || message.submission?.status === 'pending' ? 'sending' : message.pausedReason ? 'paused' : 'queued',
      error: message.submission?.status === 'outcome-unknown' ? '发送结果需要核对，请先查看电脑；此消息不会由手机重发' : message.pausedReason ? '电脑已暂停此消息，请在电脑核对后继续' : '',
      canEdit: editable(message), canCancel: mutable(message), canSteer: mutable(message) && simple(message) && message.canSendNow !== false && !/plugin:\/\//.test(message.context?.prompt ?? message.text ?? ''),
    })) };
    // 同一桌面页面保存操作回执；网络超时后的核对不能再次移除或投递原消息。
    const receipts = globalThis.__codexMobileNativeQueueReceipts ??= new Map();
    const key = JSON.stringify([input.threadId, input.commandId]);
    const signature = JSON.stringify([action, input.id, input.message, input.expectedTurnId]);
    if (receipts.has(key)) {
      const previous = receipts.get(key);
      if (previous.signature !== signature) fail('NATIVE_QUEUE_CHANGED');
      return await previous.promise;
    }
    if (receipts.size >= 128) {
      for (const [id, receipt] of receipts) { if (receipt.settled) { receipts.delete(id); break; } }
      if (receipts.size >= 128) fail('NATIVE_QUEUE_BUSY');
    }
    const perform = async () => {
      await assertOwner();
      if (action === 'enqueue') {
        if (rows.length >= 20) fail('NATIVE_QUEUE_FULL');
        const already = rows.find(message => message.id === input.message.id || message.clientUserMessageId === input.message.id);
        if (already) return { ok: true, queued: true, nativeId: already.id };
        const message = { ...input.message, submission: { hostId: input.hostId, status: 'queued', queueModeOverride: 'queue' } };
        // 原生恢复接口在最新队列上逐条追加，保留 PC 并发新增内容及原有调度权。
        const nativeId = await coordinator.restoreQueuedMessage(input.threadId, { message, index: 2147483647, previousMessageId: null, nextMessageId: null });
        return { ok: true, queued: true, nativeId };
      }
      const message = rows.find(value => value.id === input.id);
      if (!message || !mutable(message)) fail('NATIVE_QUEUE_CHANGED');
      if (action === 'steer') {
        if (!simple(message) || message.canSendNow === false || /plugin:\/\//.test(message.context?.prompt ?? message.text ?? '')) fail('NATIVE_QUEUE_COMPLEX');
        const assertTurn = async () => {
          await assertOwner();
          const state = await manager.getThreadExecutionState(input.threadId);
          if (!state?.inProgress || state.activeTurnId !== input.expectedTurnId) fail('NATIVE_QUEUE_TURN_CHANGED');
        };
        await assertTurn();
        const prepare = async () => {
          await assertTurn();
          const context = message.context ?? {};
          const files = filesOf(message);
          const prompt = context.prompt ?? message.text;
          const fileText = files.length ? '\n\n# 用户附带的文件\n' + files.map(file => '\n## ' + file.label + ': ' + file.path).join('\n') : '';
          const parts = [...(prompt || fileText ? [{ type: 'text', text: prompt + fileText, text_elements: [] }] : []), ...imagesOf(message).map(image => image.localPath ? { type: 'localImage', path: image.localPath } : { type: 'image', url: image.src })];
          return { conversationId: input.threadId, executionHostId: input.hostId, resume: { conversationId: input.threadId, workspaceRoots: context.workspaceRoots ?? [message.cwd], model: null, reasoningEffort: null, collaborationMode: null },
            start: { request: { threadId: input.threadId, input: parts, clientUserMessageId: message.id }, context: { inheritThreadSettings: true, restoreMessage: message } },
            steer: { input: parts, restoreMessage: message, clientUserMessageId: message.id, attachments: [] } };
        };
        const result = await coordinator.sendQueuedMessageNow(input.threadId, message.id, {}, prepare, assertTurn);
        if (result?.status !== 'sent') fail('NATIVE_QUEUE_CHANGED');
        return { ok: true, queued: false };
      }
      if (action === 'edit' && !editable(message)) fail('NATIVE_QUEUE_COMPLEX');
      if (!['edit', 'cancel'].includes(action)) fail('NATIVE_QUEUE_UNAVAILABLE');
      const removed = await coordinator.removeQueuedMessage(input.threadId, message.id);
      if (!removed?.message) fail('NATIVE_QUEUE_CHANGED');
      if (action === 'cancel') return { ok: true, canceled: true };
      // 原生撤回回执才是编辑内容的来源；PC 同时改变了富文本时恢复原记录，不能截断内容。
      if (!editable(removed.message)) {
        await coordinator.restoreQueuedMessage(input.threadId, removed);
        fail('NATIVE_QUEUE_COMPLEX');
      }
      return { ok: true, edited: true, draft: { text: removed.message.text, images: imagesOf(removed.message).map(image => image.src), attachments: [] } };
    };
    const receipt = { signature, settled: false, promise: null };
    receipt.promise = perform().finally(() => { receipt.settled = true; });
    receipts.set(key, receipt);
    return await receipt.promise;
  } finally {
    subscription?.[Symbol.dispose]?.();
    call?.[Symbol.dispose]?.();
  }
}

/** 模块入口来自核验过的安装包，操作正文仅作为 JSON 数据传入固定程序。 */
export function nativeMessageQueueExpression(modules, action, input) {
  if (!['read', 'enqueue', 'edit', 'cancel', 'steer'].includes(action)) throw Error('原生队列操作无效');
  return `(async()=>{${instanceServicesExpression(modules)}return (${runNativeMessageQueue.toString()})(services,${JSON.stringify(action)},${JSON.stringify(input)})})()`;
}
