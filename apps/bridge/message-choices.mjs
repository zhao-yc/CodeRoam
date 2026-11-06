import { BridgeError, validateMessageChoices } from '../../packages/protocol/contracts.mjs';
import { executionSettings, validateSettings, resolveExecutionEffort } from './model-settings.mjs';
import { permissionState, permissionRequest, updatePermissions } from './permissions.mjs';

/** 执行选项随正文发送；权限在提交前由原桌面应用并回读，保证聊天权限也同步。 */
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
  // 插件解析和附件准备后仍须核对原快照，不能覆盖桌面期间发生的变更。
  const assertCurrent = () => {
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
  const sendGuard = firstMessageGuard === undefined ? undefined : { ...firstMessageGuard };
  const beforeSend = async () => {
    assertCurrent();
    if (permissions && method === 'turn.send' && (permissions.mode !== choices.permissionMode || sendGuard !== undefined)) {
      // 单轮权限参数不会保存桌面菜单选择。复用原生设置及回读，未知结果时停止正文发送。
      permissions = await updatePermissions(adapter, {
        threadId: params.threadId, mode: choices.permissionMode, expectedRevision: permissions.revision,
        confirmedFullAccess: choices.confirmedFullAccess === true,
      }, commandId, deviceId, checkpoint, assertCurrent);
      if (sendGuard) sendGuard.permissionRevision = permissions.revision;
      checkpoint({ threadId: params.threadId, choicesStage: 'permissions-applied', messageAccepted: false });
    }
    assertCurrent();
  };
  assertCurrent();
  checkpoint({ threadId: params.threadId, choicesStage: 'ready', messageAccepted: false });
  const result = await adapter.operate(method, message, commandId, deviceId, checkpoint, sendGuard, beforeSend, nativeRequest);
  // 正文已被接受后，账本记录失败不能要求用户重新发送。
  try { checkpoint({ ...result, threadId: params.threadId, choicesStage: 'sent', messageAccepted: true }); } catch {}
  return result;
}
