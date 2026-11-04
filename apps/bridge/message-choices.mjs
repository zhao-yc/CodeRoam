import { BridgeError, validateMessageChoices } from '../../packages/protocol/contracts.mjs';
import { executionSettings, validateSettings, resolveExecutionEffort } from './model-settings.mjs';
import { permissionState, permissionRequest } from './permissions.mjs';

/** 把本条消息的选择编译为原生发送参数，全程不提前写入聊天设置。 */
export async function sendWithChoices(adapter, method, params, commandId, deviceId, checkpoint, firstMessageGuard) {
  const choices = validateMessageChoices(params.choices), { choices: _choices, ...message } = params;
  await adapter.watch(params.threadId, deviceId, { fresh: true, history: false });
  const entry = adapter.subscribed(params.threadId, deviceId), owner = { ...entry.owner };
  const assertTurn = () => {
    const snapshot = adapter.snapshot(entry.state);
    if (snapshot.readOnly) throw new BridgeError('HISTORY_READ_ONLY', '请先连接原桌面聊天再发送');
    if (method === 'turn.send' && (snapshot.activeTurnId || snapshot.status === 'active')) throw new BridgeError('TURN_ACTIVE', '任务正在运行，请使用排队或追加指令');
    if (method === 'turn.steer' && (!snapshot.activeTurnId || snapshot.activeTurnId !== params.expectedTurnId)) throw new BridgeError('STALE_TURN', '运行中的任务已变化，请重新同步后操作');
  };
  assertTurn();
  if (method === 'turn.steer' && choices.mode !== undefined) throw new BridgeError('BAD_SETTINGS', '此消息包含计划模式选择，请改为排队发送');
  const changes = Object.fromEntries(['model', 'effort', 'serviceTier', 'mode'].filter(key => choices[key] !== undefined).map(key => [key, choices[key]]));
  let baselineSettings, selected, models;
  const nativeRequest = {};
  if (Object.keys(changes).length) {
    const current = await adapter.readSettings(params.threadId, deviceId); models = current.models; baselineSettings = current.settings;
    const validated = validateSettings(changes, current.settings, models, entry.state.latestCollaborationMode);
    selected = validated.selected;
    if (params.images?.length && models.find(model => model.id === selected.model)?.supportsImages === false) throw new BridgeError('IMAGES_UNSUPPORTED', '当前模型不支持图片，请切换模型');
    if (method === 'turn.steer') {
      if (['model', 'effort', 'mode'].some(key => selected[key] !== current.settings[key])) throw new BridgeError('CHOICES_REQUIRE_QUEUE', '原生追加接口不能携带所选模型或强度，请改为排队发送，草稿已保留');
      if (choices.serviceTier !== undefined) nativeRequest.serviceTier = selected.serviceTier || null;
    } else Object.assign(nativeRequest, { model: selected.model, effort: selected.effort, serviceTier: selected.serviceTier || null, collaborationMode: validated.threadSettings.collaborationMode });
  }
  let permissions;
  if (choices.permissionMode !== undefined) {
    permissions = await adapter.readPermissions(params.threadId, deviceId);
    if (permissions.revision !== choices.permissionRevision) throw new BridgeError('PERMISSIONS_CHANGED', '电脑权限已变化，请重新选择后发送');
    if (!permissions.options?.some(option => option.id === choices.permissionMode && option.enabled)) throw new BridgeError('PERMISSION_NOT_ALLOWED', '电脑不允许所选权限');
    if (method === 'turn.steer') {
      if (permissions.mode !== choices.permissionMode) throw new BridgeError('CHOICES_REQUIRE_QUEUE', '原生追加接口不能携带所选权限，请改为排队发送，草稿已保留');
    } else Object.assign(nativeRequest, permissionRequest(choices.permissionMode, permissions.reviewer, choices.confirmedFullAccess));
  }
  // 插件解析、附件准备期间只核对原快照；所选值在真正发送时由原生接口一次接收。
  const beforeSend = () => {
    if (adapter.subscribed(params.threadId, deviceId) !== entry || entry.owner?.clientId !== owner.clientId || entry.owner?.hostId !== owner.hostId) throw new BridgeError('OWNER_UNAVAILABLE', '桌面聊天所有者已变化，请重新同步');
    assertTurn();
    if (baselineSettings) {
      const snapshot = executionSettings(entry.state);
      if (!snapshot) throw new BridgeError('SETTINGS_UNAVAILABLE', '电脑执行设置暂不可用，请重新读取后发送');
      const current = resolveExecutionEffort(snapshot, models);
      if (Object.keys(baselineSettings).some(key => current[key] !== baselineSettings[key])) throw new BridgeError('SETTINGS_CHANGED', '电脑执行设置已变化，请核对后发送');
    }
    if (permissions && permissionState(entry.state).revision !== permissions.revision) throw new BridgeError('PERMISSIONS_CHANGED', '电脑权限已变化，请重新选择后发送');
  };
  beforeSend();
  checkpoint({ threadId: params.threadId, choicesStage: 'ready', messageAccepted: false });
  const result = await adapter.operate(method, message, commandId, deviceId, checkpoint, firstMessageGuard, beforeSend, nativeRequest);
  // 正文已被接受后，账本记录失败不能要求用户重新发送。
  try { checkpoint({ ...result, threadId: params.threadId, choicesStage: 'sent', messageAccepted: true }); } catch {}
  return result;
}
