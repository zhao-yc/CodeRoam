import { BridgeError, validateMessageChoices } from '../../packages/protocol/contracts.mjs';
import { executionSettings, validateSettings, resolveExecutionEffort } from './model-settings.mjs';
import { permissionState } from './permissions.mjs';

/** 一条消息拥有独立选项；设置确认前不投递正文，未知结果不重放。 */
export async function sendWithChoices(adapter, method, params, commandId, deviceId, checkpoint, firstMessageGuard) {
  const choices = validateMessageChoices(params.choices), { choices: _choices, ...message } = params;
  await adapter.watch(params.threadId, deviceId, { fresh: true, history: false });
  const entry = adapter.subscribed(params.threadId, deviceId), owner = entry.owner;
  const assertTurn = () => {
    const snapshot = adapter.snapshot(entry.state);
    if (snapshot.readOnly) throw new BridgeError('HISTORY_READ_ONLY', '请先连接原桌面聊天再发送');
    if (method === 'turn.send' && (snapshot.activeTurnId || snapshot.status === 'active')) throw new BridgeError('TURN_ACTIVE', '任务正在运行，请使用排队或追加指令');
    if (method === 'turn.steer' && (!snapshot.activeTurnId || snapshot.activeTurnId !== params.expectedTurnId)) throw new BridgeError('STALE_TURN', '运行中的任务已变化，请重新同步后操作');
  };
  assertTurn();
  if (method === 'turn.steer' && choices.mode !== undefined) throw new BridgeError('BAD_SETTINGS', '此消息包含计划模式选择，请改为排队发送');
  const changes = Object.fromEntries(['model', 'effort', 'serviceTier', 'mode'].filter(key => choices[key] !== undefined).map(key => [key, choices[key]]));
  let expectedSettings, models;
  if (Object.keys(changes).length) {
    const current = await adapter.readSettings(params.threadId, deviceId); models = current.models;
    expectedSettings = validateSettings(changes, current.settings, models, entry.state.latestCollaborationMode).selected;
    if (params.images?.length && models.find(model => model.id === expectedSettings.model)?.supportsImages === false) throw new BridgeError('IMAGES_UNSUPPORTED', '当前模型不支持图片，请切换模型');
  }
  let permissions;
  if (choices.permissionMode !== undefined) {
    permissions = await adapter.readPermissions(params.threadId, deviceId);
    if (permissions.revision !== choices.permissionRevision) throw new BridgeError('PERMISSIONS_CHANGED', '电脑权限已变化，请重新选择后发送');
    if (!permissions.options?.some(option => option.id === choices.permissionMode && option.enabled)) throw new BridgeError('PERMISSION_NOT_ALLOWED', '电脑不允许所选权限');
  }
  // 所有选项先完成校验再写入；不能将组合阶段误认成独立权限操作的回执。
  assertTurn();
  const stage = value => checkpoint({ threadId: params.threadId, choicesStage: value, messageAccepted: false });
  stage('applying');
  if (expectedSettings) await adapter.operate('thread.settings.update', { threadId: params.threadId, changes }, commandId + ':settings', deviceId);
  if (permissions && permissions.mode !== choices.permissionMode) {
    await adapter.operate('thread.permissions.update', { threadId: params.threadId, mode: choices.permissionMode, expectedRevision: permissions.revision, confirmedFullAccess: choices.confirmedFullAccess === true }, commandId + ':permissions', deviceId, () => stage('permissions'));
    permissions = await adapter.readPermissions(params.threadId, deviceId);
  }
  if (expectedSettings) {
    const confirmed = await adapter.readSettings(params.threadId, deviceId);
    if (Object.keys(expectedSettings).some(key => confirmed.settings[key] !== expectedSettings[key])) throw new BridgeError('SETTINGS_CHANGED', '电脑执行设置已变化，请核对后发送');
  }
  if (permissions && permissions.mode !== choices.permissionMode) throw new BridgeError('PERMISSIONS_CHANGED', '电脑权限尚未确认，请核对后发送');
  stage('ready');
  // 插件和附件准备可能异步等待，实际投递前再次核对所有者与实时选项。
  const beforeSend = () => {
    if (adapter.subscribed(params.threadId, deviceId) !== entry || (entry.owner?.clientId !== owner.clientId || entry.owner?.hostId !== owner.hostId)) throw new BridgeError('OWNER_UNAVAILABLE', '桌面聊天所有者已变化，请重新同步');
    assertTurn();
    if (expectedSettings) {
      const snapshot = executionSettings(entry.state);
      if (!snapshot) throw new BridgeError('SETTINGS_UNAVAILABLE', '电脑执行设置暂不可用，请重新读取后发送');
      const current = resolveExecutionEffort(snapshot, models);
      if (Object.keys(expectedSettings).some(key => current[key] !== expectedSettings[key])) throw new BridgeError('SETTINGS_CHANGED', '电脑执行设置已变化，请核对后发送');
    }
    if (permissions && permissionState(entry.state).revision !== permissions.revision) throw new BridgeError('PERMISSIONS_CHANGED', '电脑权限已变化，请重新选择后发送');
  };
  const result = await adapter.operate(method, message, commandId, deviceId, checkpoint, firstMessageGuard, beforeSend);
  // 正文已被接受后，记录失败不能要求用户重发。
  try { checkpoint({ ...result, threadId: params.threadId, choicesStage: 'sent', messageAccepted: true }); } catch {}
  return result;
}
