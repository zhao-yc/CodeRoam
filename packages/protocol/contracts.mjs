import { createHash, timingSafeEqual } from 'node:crypto';
import { validateGoalUpdate } from './goals.mjs';

export const PROTOCOL_VERSION = 1;
export const READ_METHODS = new Set(['ping', 'threads.list', 'threads.watch', 'threads.unwatch', 'thread.watch', 'thread.unwatch', 'thread.history', 'thread.images', 'thread.settings.read', 'command.status']);
export const WRITE_METHODS = new Set(['turn.send', 'turn.steer', 'turn.stop', 'approval.reply', 'question.reply', 'thread.settings.update']);
// 分片使用独立幂等存储，正文不进入操作账本。
export const UPLOAD_METHODS = new Set(['attachment.begin', 'attachment.chunk', 'attachment.finish', 'attachment.abort']);
// 中转内的显示偏好更新不属于需要桌面核对的会话写操作。
export const RELAY_METHODS = new Set(['host.profile.update']);
READ_METHODS.add('projects.list');
READ_METHODS.add('thread.create.settings');
WRITE_METHODS.add('thread.create');
READ_METHODS.add('thread.goal.read');
READ_METHODS.add('thread.prediction.read');
WRITE_METHODS.add('thread.goal.update');
WRITE_METHODS.add('thread.archive');
READ_METHODS.add('thread.permissions.read');
READ_METHODS.add('thread.create.permissions');
WRITE_METHODS.add('thread.permissions.update');
export const METHODS = new Set([...READ_METHODS, ...WRITE_METHODS, ...UPLOAD_METHODS, ...RELAY_METHODS]);
export const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;

export class BridgeError extends Error {
  constructor(code, message, outcomeUnknown = false) { super(message); this.code = code; this.outcomeUnknown = outcomeUnknown; }
}

/** 令牌只保留哈希用于比对，禁止把明文令牌写入日志和 URL。 */
export function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
export function matchesToken(token, expected) {
  if (typeof token !== 'string' || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) return false;
  return timingSafeEqual(Buffer.from(tokenHash(token), 'hex'), Buffer.from(expected, 'hex'));
}

/** 校验移动请求的最小边界，桌面适配层继续逐项校验业务参数。 */
export function validateRequest(message) {
  if (!message || message.v !== PROTOCOL_VERSION || message.type !== 'request') throw new BridgeError('BAD_MESSAGE', '请求格式或协议版本不受支持');
  if (typeof message.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(message.requestId)) throw new BridgeError('BAD_REQUEST_ID', '请求编号不合法');
  if (!METHODS.has(message.method)) throw new BridgeError('METHOD_NOT_ALLOWED', '此操作不在允许的接口列表中');
  if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) throw new BridgeError('BAD_PARAMS', '请求参数必须是对象');
  if (message.method === 'host.profile.update') {
    requireString(message.hostId, '电脑编号', 200);
    const { displayName, icon, expectedRevision } = message.params;
    requireString(displayName, '显示名称', 100);
    if (/[\u0000-\u001f\u007f]/.test(displayName) || !['code', 'terminal', 'laptop', 'desktop'].includes(icon) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || Object.keys(message.params).some(key => !['displayName', 'icon', 'expectedRevision'].includes(key))) throw new BridgeError('BAD_PARAMS', '连接显示信息参数无效');
    return message;
  }
  if(message.params.planMode!==undefined&&(!['turn.send','turn.steer'].includes(message.method)||!['default','plan'].includes(message.params.planMode)||message.params.resetPlanAfterSend!==true))throw new BridgeError('BAD_PARAMS','本次计划模式参数无效');
  if(message.params.resetPlanAfterSend===true&&!['default','plan'].includes(message.params.planMode))throw new BridgeError('BAD_PARAMS','请明确本次消息的执行模式');
  if(message.params.resetPlanAfterSend!==undefined&&(!['turn.send','turn.steer'].includes(message.method)||typeof message.params.resetPlanAfterSend!=='boolean'))throw new BridgeError('BAD_PARAMS','一次性计划标记只能用于发送消息');
  if(message.params.activate!==undefined&&(message.method!=='thread.watch'||typeof message.params.activate!=='boolean'))throw new BridgeError('BAD_PARAMS','仅会话订阅可使用布尔值加载标记');
  if(message.params.page!==undefined&&(message.method!=='thread.history'||message.params.page!==true))throw new BridgeError('BAD_PARAMS','历史分页标记无效');
  if(message.params.before!==undefined&&(message.method!=='thread.history'||typeof message.params.before!=='string'||message.params.before.length>2000))throw new BridgeError('BAD_PARAMS','历史游标无效');
  if(message.params.beforeMessageId!==undefined&&(message.method!=='thread.history'||typeof message.params.beforeMessageId!=='string'||message.params.beforeMessageId.length>1000))throw new BridgeError('BAD_PARAMS','历史消息起点无效');
  if(message.params.images!==undefined&&(!['turn.send','turn.steer'].includes(message.method)||!Array.isArray(message.params.images)||message.params.images.length>3))throw new BridgeError('BAD_PARAMS','图片只能随发送或追加指令提交，每次最多3张');
  if (UPLOAD_METHODS.has(message.method)) requireString(message.params.threadId, '会话编号', 200);
  if (message.params.attachments !== undefined && (!['turn.send', 'turn.steer'].includes(message.method) || !Array.isArray(message.params.attachments) || message.params.attachments.length > 3)) throw new BridgeError('BAD_ATTACHMENTS', '附件只能随发送或追加指令提交，每次最多3个');
  if (message.method === 'thread.create' || message.method === 'thread.create.settings' || message.method === 'thread.create.permissions') {
    requireString(message.params.projectId, '项目编号', 200);
    const allowed = message.method === 'thread.create' ? ['projectId', 'title'] : ['projectId'];
    if (Object.keys(message.params).some(key => !allowed.includes(key))) throw new BridgeError('BAD_PARAMS', '创建会话仅接受电脑端项目编号与标题');
    if (message.params.title !== undefined) requireString(message.params.title, '会话标题', 80);
  } else if (message.method.startsWith('thread.') || message.method.startsWith('turn.') || message.method === 'approval.reply' || message.method === 'question.reply') requireString(message.params.threadId, '会话编号', 200);
  if (message.method === 'thread.permissions.read' && Object.keys(message.params).some(key => key !== 'threadId')) throw new BridgeError('BAD_PARAMS', '权限读取仅接受会话编号');
  if (message.method === 'thread.permissions.update') {
    const p = message.params;
    if (Object.keys(p).some(key => !['threadId','mode','expectedRevision','confirmedFullAccess'].includes(key)) || !['default','auto-review','read-only','full-access'].includes(p.mode) || typeof p.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(p.expectedRevision) || (p.confirmedFullAccess !== undefined && typeof p.confirmedFullAccess !== 'boolean') || (p.mode === 'full-access' && p.confirmedFullAccess !== true)) throw new BridgeError('BAD_PERMISSIONS', '权限参数无效或尚未确认完整访问');
  }
  if (message.method === 'question.reply') requireString(message.params.questionGroupId, '题组编号', 1000);
  if (message.method === 'thread.images') requireString(message.params.messageId, '消息编号', 200);
  if (message.method === 'thread.prediction.read' && Object.keys(message.params).some(key => key !== 'threadId')) throw new BridgeError('BAD_PARAMS', '读取预测仅接受会话编号');
  if (message.method === 'thread.goal.update') validateGoalUpdate(message.params);
  if (message.method === 'thread.goal.read' && Object.keys(message.params).some(key => key !== 'threadId')) throw new BridgeError('BAD_PARAMS', '读取目标仅接受会话编号');
  if (message.method === 'thread.archive' && Object.keys(message.params).some(key => key !== 'threadId')) throw new BridgeError('BAD_PARAMS', '归档仅接受会话编号');
  return message;
}

export function requireString(value, label, maximum = 32000) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) throw new BridgeError('BAD_PARAMS', `${label}为空或超出允许长度`);
  return value;
}

export function errorPayload(error) {
  return { code: error.code ?? 'INTERNAL_ERROR', message: error.message ?? '连接服务出现异常', outcomeUnknown: error.outcomeUnknown === true };
}

/** 使用固定字段顺序计算指纹，避免同一请求编号承载不同操作。 */
export function requestFingerprint(method, params) {
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return tokenHash(JSON.stringify({ method, params: stable(params) }));
}
