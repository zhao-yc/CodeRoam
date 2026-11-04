import { BridgeError } from '../../packages/protocol/contracts.mjs';

/** 只保留用户显式选择，不能把发送时的电脑默认值当成手机已经确认过的权限。 */
function settingChanges(settings, choices) {
  const changes = {};
  for (const key of ['model', 'effort', 'serviceTier', 'mode']) {
    if (choices[key] != null && (choices[key] !== settings[key] || key !== 'model' && choices.model != null && choices.model !== settings.model)) changes[key] = choices[key];
  }
  return changes;
}

/** 上传及原生处理期间桌面可能自行更改设置，发送前必须再次按完整选择核对。 */
function assertSettings(snapshot, choices, images) {
  for (const key of ['model', 'effort', 'serviceTier', 'mode']) if (choices[key] != null && snapshot.settings[key] !== choices[key]) throw new BridgeError('SETTINGS_CHANGED', '电脑执行设置已变化，请重新确认后发送');
  if (images.length && snapshot.models?.find(model => model.id === snapshot.settings.model)?.supportsImages !== true) throw new BridgeError('IMAGES_UNSUPPORTED', '当前模型不支持图片，请切换模型');
}

/** 跟随电脑权限也不能自动接受完整访问；必须保留用户的显式确认。 */
function assertPermissions(current, choices) {
  const selected = choices.permissionMode === 'desktop-default' ? '' : choices.permissionMode ?? '';
  if (selected && current.mode !== selected) throw new BridgeError('PERMISSIONS_CHANGED', '电脑权限已变化，请重新确认后发送');
  if (current.mode === 'full-access' && (selected !== 'full-access' || choices.confirmedFullAccess !== true)) throw new BridgeError('PERMISSION_CONFIRMATION_REQUIRED', '请先在手机选择并确认电脑完整访问权限');
  if (!['default', 'auto-review', 'read-only', 'full-access'].includes(current.mode)) throw new BridgeError('PERMISSIONS_UNAVAILABLE', '无法确认电脑权限，请重新选择后发送');
}

/** 新聊天的全部阶段由守护进程完成；手机只负责提交不可变的输入快照。 */
export async function runNewConversationTask(agent, task, context) {
  const input = task.payload, choices = input.choices ?? {}, images = input.images ?? [], attachments = input.attachments ?? [];
  if (choices.permissionMode === 'full-access' && choices.confirmedFullAccess !== true) throw new BridgeError('PERMISSION_CONFIRMATION_REQUIRED', '请先确认电脑完整访问权限');
  // 项目必须重新从原实例已保存项目中解析，手机不能指定工作目录。
  const project = await agent.newThreads.project(input.projectId);
  if (!project || project.id !== input.projectId) throw new BridgeError('PROJECT_NOT_FOUND', '项目已不存在，请重新选择电脑端项目');
  const command = (method, params, commandId, guard) => agent.runTaskCommand(method, params, task.deviceId, commandId, guard);
  if (input.mode === 'nativeDraft') return runNative(agent, task, context, command, choices, images, attachments);
  if (input.mode !== 'desktopIpc') throw new BridgeError('BAD_TASK', '不支持此新聊天创建方式');

  const created = await context.step('创建聊天', commandId => command('thread.create', { projectId: input.projectId, title: task.title || '新聊天' }, commandId));
  const threadId = created?.threadId;
  if (typeof threadId !== 'string' || !threadId) throw new BridgeError('OUTCOME_UNKNOWN', '创建回执缺少聊天编号，请核对电脑端', true);
  context.update({ threadId, stage: '正在连接电脑聊天' });
  const openingWatcher = 'submission-open:' + task.id;
  let release = () => {};
  try {
  // 创建服务只登记空聊天；先由独立观察者让原桌面加载它，再取得后台可写租约。
  await agent.adapter.watch(threadId, openingWatcher, { activate: true, fresh: true, history: false });
  release = await agent.retainTaskThread(threadId, task.deviceId, task.id);
  await agent.adapter.watch(threadId, task.deviceId, { fresh: true, history: false });

  const settings = await agent.adapter.readSettings(threadId, task.deviceId), changes = settingChanges(settings.settings, choices);
  if (Object.keys(changes).length) await context.step('应用执行设置', commandId => command('thread.settings.update', { threadId, changes }, commandId));
  let permissions = await agent.adapter.readPermissions(threadId, task.deviceId);
  const selected = choices.permissionMode === 'desktop-default' ? '' : choices.permissionMode ?? '';
  if (selected && permissions.mode !== selected) {
    await context.step('应用权限', commandId => command('thread.permissions.update', { threadId, mode: selected, expectedRevision: permissions.revision, confirmedFullAccess: choices.confirmedFullAccess === true }, commandId));
    permissions = await agent.adapter.readPermissions(threadId, task.deviceId);
  }
  assertPermissions(permissions, choices);
  context.update({ stage: '正在绑定附件' });
  context.retainScope?.(threadId);
  await agent.adapter.attachments.bindScope(task.deviceId, 'task:' + task.id, threadId, attachments);

  // 最后一次只读核对在附件落盘之后，首条 guard 再由桌面适配器验证。
  await agent.adapter.watch(threadId, task.deviceId, { fresh: true, history: false });
  assertSettings(await agent.adapter.readSettings(threadId, task.deviceId), choices, images);
  permissions = await agent.adapter.readPermissions(threadId, task.deviceId); assertPermissions(permissions, choices);
  const params = { threadId, text: input.text ?? '', images, attachments };
  if (input.pluginIds?.length) params.pluginIds = input.pluginIds;
  if (input.threadMentionIds?.length) params.threadMentionIds = input.threadMentionIds;
  const guard = { permissionRevision: permissions.revision, confirmedFullAccess: choices.permissionMode === 'full-access' && choices.confirmedFullAccess === true };
  const sent = await context.step('发送首条消息', commandId => command('turn.send', params, commandId, guard));
  if (sent?.ok !== true) throw new BridgeError('OUTCOME_UNKNOWN', '首条消息回执尚未确认，请核对电脑端', true);
  return { ok: true, threadId };
  } finally { release(); agent.adapter.unwatch?.(threadId, openingWatcher); }
}

/** 原生草稿按最新修订发送，已有电脑正文和已发送状态均不能被后台任务覆盖。 */
async function runNative(agent, task, context, command, choices, images, attachments) {
  const input = task.payload;
  if (input.pluginIds?.length) throw new BridgeError('PLUGINS_UNAVAILABLE', '原生草稿暂不支持插件，请移除插件后发送');
  const opened = await context.step('准备电脑草稿', commandId => command('thread.draft.open', { projectId: input.projectId }, commandId));
  const draftId = opened?.draftId ?? opened?.snapshot?.draftId;
  if (typeof draftId !== 'string' || !draftId) throw new BridgeError('OUTCOME_UNKNOWN', '电脑草稿回执缺少编号，请核对电脑端', true);
  let snapshot = await agent.nativeDrafts.read({ draftId }, task.deviceId);
  const assertReady = () => {
    if (snapshot.status !== 'ready') throw new BridgeError('DRAFT_CHANGED', '电脑草稿已切换或发送，请先核对原操作');
    if (snapshot.hasDesktopText) throw new BridgeError('DRAFT_HAS_DESKTOP_TEXT', '电脑端草稿已有正文，请先在电脑端处理后再发送');
    if (input.threadMentionIds?.length && snapshot.supportsThreadMentions !== true) throw new BridgeError('THREAD_MENTIONS_UNAVAILABLE', '当前原生草稿不支持引用聊天');
  };
  assertReady();
  const changes = settingChanges(snapshot.settings, choices), selected = choices.permissionMode === 'desktop-default' ? '' : choices.permissionMode ?? '';
  if (selected && snapshot.permissions.mode !== selected) changes.permissionMode = selected;
  if (Object.keys(changes).length) {
    await context.step('应用草稿设置和权限', commandId => command('thread.draft.update', { draftId, expectedRevision: snapshot.revision, changes, confirmedFullAccess: choices.confirmedFullAccess === true }, commandId));
    snapshot = await agent.nativeDrafts.read({ draftId }, task.deviceId); assertReady();
  }
  assertSettings(snapshot, choices, images); assertPermissions(snapshot.permissions, choices);
  context.update({ stage: '正在绑定草稿附件' });
  context.retainScope?.('draft:' + draftId);
  await agent.adapter.attachments.bindScope(task.deviceId, 'task:' + task.id, 'draft:' + draftId, attachments);
  snapshot = await agent.nativeDrafts.read({ draftId }, task.deviceId); assertReady();
  assertSettings(snapshot, choices, images); assertPermissions(snapshot.permissions, choices);
  const params = { draftId, expectedRevision: snapshot.revision, text: input.text ?? '', images, attachments };
  if (input.threadMentionIds?.length) params.threadMentionIds = input.threadMentionIds;
  const sent = await context.step('发送首条消息', commandId => command('thread.draft.send', params, commandId));
  if (typeof sent?.threadId !== 'string' || !sent.threadId) throw new BridgeError('OUTCOME_UNKNOWN', '首条消息回执缺少聊天编号，请核对电脑端', true);
  context.update({ threadId: sent.threadId });
  return { ok: true, threadId: sent.threadId };
}
