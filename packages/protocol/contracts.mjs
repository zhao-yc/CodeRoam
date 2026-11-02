import { createHash, timingSafeEqual } from 'node:crypto';
import { validateGoalUpdate } from './goals.mjs';

export const PROTOCOL_VERSION = 1;
export const READ_METHODS = new Set(['ping', 'threads.list', 'threads.watch', 'threads.unwatch', 'thread.watch', 'thread.unwatch', 'thread.history', 'thread.images', 'thread.settings.read', 'command.status']);
export const WRITE_METHODS = new Set(['turn.send', 'turn.retry', 'turn.steer', 'turn.stop', 'approval.reply', 'question.reply', 'thread.settings.update']);
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
WRITE_METHODS.add('thread.delete');
READ_METHODS.add('thread.permissions.read');
READ_METHODS.add('thread.create.permissions');
READ_METHODS.add('thread.plugins.read');
READ_METHODS.add('thread.create.plugins');
READ_METHODS.add('threads.mentions');
WRITE_METHODS.add('thread.permissions.update');
READ_METHODS.add('thread.draft.read');
READ_METHODS.add('thread.draft.unwatch');
WRITE_METHODS.add('thread.draft.open');
WRITE_METHODS.add('thread.draft.update');
WRITE_METHODS.add('thread.draft.send');
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
  // 原生草稿使用独立编号，不能落入既有聊天编号与发送参数的校验分支。
  if (message.method.startsWith('thread.draft.')) {
    validateDraftRequest(message.method, message.params);
    return message;
  }
  if (message.method === 'threads.mentions') {
    const p = message.params;
    if (Object.keys(p).some(key => !['search','offset','limit','excludeThreadId'].includes(key)) || (p.search !== undefined && (typeof p.search !== 'string' || p.search.length > 100)) || (p.limit !== undefined && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 100)) || (p.offset !== undefined && (!Number.isInteger(p.offset) || p.offset < 0 || p.offset > 10000))) throw new BridgeError('BAD_PARAMS', '引用聊天搜索参数无效');
    if (p.excludeThreadId !== undefined) requireString(p.excludeThreadId, '排除聊天编号', 200);
  }
  if (message.params.threadMentionIds !== undefined) {
    if (!['turn.send','turn.steer'].includes(message.method) || (message.params.queueAction !== undefined && message.params.queueAction !== 'enqueue') || message.params.planAction !== undefined) throw new BridgeError('BAD_PARAMS', '聊天引用只能随发送、追加或入队提交');
    validateThreadMentionIds(message.params.threadMentionIds);
  }
  if (message.params.pluginIds !== undefined) {
    if (!['turn.send', 'turn.steer'].includes(message.method) || (message.params.queueAction !== undefined && message.params.queueAction !== 'enqueue')) throw new BridgeError('BAD_PARAMS', '插件只能随发送、追加指令或入队提交');
    validatePluginIds(message.params.pluginIds);
  }
  if (['turn.send', 'turn.steer'].includes(message.method)) validateTurnInput(message.params);
  if (message.method === 'turn.retry') validateTurnRetry(message.params);
  if (message.method === 'threads.list') {
    const p=message.params;
    if(Object.keys(p).some(key=>!['limit','offset','search','archived','includeUsage'].includes(key)) || (p.archived!==undefined&&typeof p.archived!=='boolean') || (p.includeUsage!==undefined&&typeof p.includeUsage!=='boolean') || (p.limit!==undefined&&(!Number.isInteger(p.limit)||p.limit<1||p.limit>100)) || (p.offset!==undefined&&(!Number.isInteger(p.offset)||p.offset<0||p.offset>10000)) || (p.search!==undefined&&(typeof p.search!=='string'||p.search.length>100)))throw new BridgeError('BAD_PARAMS','聊天列表参数无效');
  }
  if (message.method === 'host.profile.update') {
    requireString(message.hostId, '电脑编号', 200);
    const { displayName, icon, expectedRevision } = message.params;
    requireString(displayName, '显示名称', 100);
    if (/[\u0000-\u001f\u007f]/.test(displayName) || !['code', 'terminal', 'laptop', 'desktop'].includes(icon) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || Object.keys(message.params).some(key => !['displayName', 'icon', 'expectedRevision'].includes(key))) throw new BridgeError('BAD_PARAMS', '连接显示信息参数无效');
    return message;
  }
  // 沿用协议 v1 的历史方法；静默视图不能夹带订阅、分页或任何操作参数。
  if(message.method==='thread.history'&&message.params.view!==undefined&&!['prefetch','file-report'].includes(message.params.view))throw new BridgeError('BAD_PARAMS','不支持此历史只读视图');
  if(message.params.view==='prefetch') {
    if(message.method!=='thread.history'||Object.keys(message.params).some(key=>!['threadId','view'].includes(key)))throw new BridgeError('BAD_PARAMS','静默预加载仅接受聊天编号和只读视图');
    requireString(message.params.threadId,'聊天编号',200);
  }
  if(message.params.reportId!==undefined||message.params.view==='file-report'){
    if(message.method!=='thread.history'||message.params.view!=='file-report')throw new BridgeError('BAD_PARAMS','文件报告只能通过历史只读视图查看');
    requireString(message.params.reportId,'报告编号',1000);
    if(message.params.fileId!==undefined&&(typeof message.params.fileId!=='string'||!/^[a-f0-9]{24}$/.test(message.params.fileId)))throw new BridgeError('BAD_PARAMS','文件编号无效');
    if(Object.keys(message.params).some(key=>!['threadId','view','reportId','fileId'].includes(key)))throw new BridgeError('BAD_PARAMS','文件汇总仅接受聊天、报告和文件编号');
  }
  if(message.params.planAction!==undefined) {
    if(message.method!=='turn.send')throw new BridgeError('BAD_PARAMS','计划确认只能用于新一轮消息');
    requireString(message.params.threadId,'聊天编号',200);requireString(message.params.planId,'计划编号',300);
    if(!['implement','feedback'].includes(message.params.planAction)||Object.keys(message.params).some(key=>!['threadId','planId','planAction','text'].includes(key)))throw new BridgeError('BAD_PARAMS','计划确认参数无效');
    if(message.params.planAction==='feedback')requireString(message.params.text,'修改意见',32000);
  }
  if(message.params.planMode!==undefined&&(!['turn.send','turn.steer'].includes(message.method)||!['default','plan'].includes(message.params.planMode)||message.params.resetPlanAfterSend!==true))throw new BridgeError('BAD_PARAMS','本次计划模式参数无效');
  if(message.params.resetPlanAfterSend===true&&!['default','plan'].includes(message.params.planMode))throw new BridgeError('BAD_PARAMS','请明确本次消息的执行模式');
  if(message.params.resetPlanAfterSend!==undefined&&(!['turn.send','turn.steer'].includes(message.method)||typeof message.params.resetPlanAfterSend!=='boolean'))throw new BridgeError('BAD_PARAMS','一次性计划标记只能用于发送消息');
  if(message.params.activate!==undefined&&(message.method!=='thread.watch'||typeof message.params.activate!=='boolean'))throw new BridgeError('BAD_PARAMS','仅聊天订阅可使用布尔值加载标记');
  if(message.params.page!==undefined&&(message.method!=='thread.history'||message.params.page!==true))throw new BridgeError('BAD_PARAMS','历史分页标记无效');
  if(message.params.before!==undefined&&(message.method!=='thread.history'||typeof message.params.before!=='string'||message.params.before.length>2000))throw new BridgeError('BAD_PARAMS','历史游标无效');
  if(message.params.beforeMessageId!==undefined&&(message.method!=='thread.history'||typeof message.params.beforeMessageId!=='string'||message.params.beforeMessageId.length>1000))throw new BridgeError('BAD_PARAMS','历史消息起点无效');
  if(message.params.images!==undefined&&(!['turn.send','turn.steer'].includes(message.method)||!Array.isArray(message.params.images)||message.params.images.length>3))throw new BridgeError('BAD_PARAMS','图片只能随发送或追加指令提交，每次最多3张');
  if (UPLOAD_METHODS.has(message.method)) validateAttachmentScope(message.params);
  if (message.params.attachments !== undefined && (!['turn.send', 'turn.steer'].includes(message.method) || !Array.isArray(message.params.attachments) || message.params.attachments.length > 3)) throw new BridgeError('BAD_ATTACHMENTS', '附件只能随发送或追加指令提交，每次最多3个');
  if (message.method === 'thread.create' || message.method === 'thread.create.settings' || message.method === 'thread.create.permissions' || message.method === 'thread.create.plugins') {
    requireString(message.params.projectId, '项目编号', 200);
    const allowed = message.method === 'thread.create' ? ['projectId', 'title'] : ['projectId'];
    if (Object.keys(message.params).some(key => !allowed.includes(key))) throw new BridgeError('BAD_PARAMS', '创建聊天仅接受电脑端项目编号与标题');
    if (message.params.title !== undefined) requireString(message.params.title, '聊天标题', 80);
  } else if (message.method.startsWith('thread.') || message.method.startsWith('turn.') || message.method === 'approval.reply' || message.method === 'question.reply') requireString(message.params.threadId, '聊天编号', 200);
  if (message.method === 'thread.permissions.read' && Object.keys(message.params).some(key => key !== 'threadId')) throw new BridgeError('BAD_PARAMS', '权限读取仅接受聊天编号');
  if (message.method === 'thread.plugins.read' && Object.keys(message.params).some(key => key !== 'threadId')) throw new BridgeError('BAD_PARAMS', '插件读取仅接受聊天编号');
  if (message.method === 'thread.permissions.update') {
    const p = message.params;
    if (Object.keys(p).some(key => !['threadId','mode','expectedRevision','confirmedFullAccess'].includes(key)) || !['default','auto-review','read-only','full-access'].includes(p.mode) || typeof p.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(p.expectedRevision) || (p.confirmedFullAccess !== undefined && typeof p.confirmedFullAccess !== 'boolean') || (p.mode === 'full-access' && p.confirmedFullAccess !== true)) throw new BridgeError('BAD_PERMISSIONS', '权限参数无效或尚未确认完整访问');
  }
  if (message.method === 'question.reply') requireString(message.params.questionGroupId, '题组编号', 1000);
  if (message.method === 'thread.images') {
    requireString(message.params.messageId, '消息编号', 200);
    if (message.params.imageIndex !== undefined || message.params.chunkIndex !== undefined) {
      if (!Number.isInteger(message.params.imageIndex) || message.params.imageIndex < 0 || message.params.imageIndex >= 3 || !Number.isInteger(message.params.chunkIndex) || message.params.chunkIndex < 0 || message.params.chunkIndex > 16) throw new BridgeError('BAD_PARAMS','图片或分片编号不合法');
    }
    if(Object.keys(message.params).some(key=>!['threadId','messageId','imageIndex','chunkIndex'].includes(key)))throw new BridgeError('BAD_PARAMS','查看图片只接受聊天编号和消息编号');
  }
  // 排队沿用发送白名单；旧中转也能转发，由支持队列的电脑服务校验并执行。
  if (message.params.queueAction !== undefined || message.params.queueId !== undefined) {
    const p = message.params, enqueue = p.queueAction === 'enqueue';
    if (message.method !== 'turn.send' || !['enqueue','steer','cancel','edit'].includes(p.queueAction) || Object.keys(p).some(key => !(enqueue ? ['threadId','queueAction','text','images','attachments','pluginIds','threadMentionIds'] : ['threadId','queueAction','queueId','expectedTurnId']).includes(key))) throw new BridgeError('BAD_PARAMS', '排队操作参数无效');
    if (!enqueue) requireString(p.queueId, '排队消息编号', 80);
    if (p.queueAction === 'steer') requireString(p.expectedTurnId, '当前任务编号', 200);
    if (enqueue && p.attachments?.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(id))) throw new BridgeError('BAD_ATTACHMENTS', '排队附件编号无效');
  }
  if (message.method === 'thread.prediction.read' && Object.keys(message.params).some(key => key !== 'threadId')) throw new BridgeError('BAD_PARAMS', '读取预测仅接受聊天编号');
  if (message.method === 'thread.goal.update') validateGoalUpdate(message.params);
  if (message.method === 'thread.goal.read' && Object.keys(message.params).some(key => key !== 'threadId')) throw new BridgeError('BAD_PARAMS', '读取目标仅接受聊天编号');
  if (message.method === 'thread.archive' && Object.keys(message.params).some(key => key !== 'threadId')) throw new BridgeError('BAD_PARAMS', '归档仅接受聊天编号');
  if (message.method === 'thread.delete' && Object.keys(message.params).some(key => key !== 'threadId')) throw new BridgeError('BAD_PARAMS', '永久删除仅接受聊天编号');
  return message;
}

export function requireString(value, label, maximum = 32000) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) throw new BridgeError('BAD_PARAMS', `${label}为空或超出允许长度`);
  return value;
}

/** 草稿编号只接受桥接生成的随机 UUID，不能指定原生窗口、路径或内部草稿编号。 */
export function validateDraftId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) throw new BridgeError('BAD_PARAMS', '草稿编号无效，请重新打开新聊天');
  return value;
}

/** 上传必须明确选择一个公开作用域；内部 draft: 命名空间不接受手机直接指定。 */
export function validateAttachmentScope(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.hasOwn(params, 'draftId') === Object.hasOwn(params, 'threadId')) throw new BridgeError('BAD_PARAMS', '附件必须且只能指定草稿编号或聊天编号');
  if (Object.hasOwn(params, 'draftId')) return { draftId: validateDraftId(params.draftId) };
  requireString(params.threadId, '聊天编号', 200);
  if (params.threadId.startsWith('draft:')) throw new BridgeError('BAD_PARAMS', '不能直接指定内部附件作用域');
  return { threadId: params.threadId };
}

/** 草稿修订号保持原生类型，按原值比较，不把未知值降级为旧配置或默认设置。 */
export function validDraftRevision(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value) || Number.isSafeInteger(value) && value >= 0;
}

/** 原生新聊天只开放定稿的设置和消息字段，权限不能混入发送参数。 */
export function validateDraftRequest(method, params) {
  const allowed = {
    'thread.draft.open': ['projectId'],
    'thread.draft.read': ['draftId'],
    'thread.draft.unwatch': ['draftId'],
    'thread.draft.update': ['draftId', 'expectedRevision', 'changes', 'confirmedFullAccess'],
    'thread.draft.send': ['draftId', 'expectedRevision', 'text', 'images', 'attachments', 'threadMentionIds'],
  }[method];
  if (!allowed) throw new BridgeError('METHOD_NOT_ALLOWED', '此操作不在允许的草稿接口列表中');
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !allowed.includes(key))) throw new BridgeError('BAD_PARAMS', '草稿参数包含不允许的字段');
  if (method === 'thread.draft.open') return requireString(params.projectId, '项目编号', 200);
  validateDraftId(params.draftId);
  if (method === 'thread.draft.read' || method === 'thread.draft.unwatch') return;
  if (!validDraftRevision(params.expectedRevision)) throw new BridgeError('BAD_PARAMS', '请提供有效的草稿修订号');
  if (method === 'thread.draft.update') {
    const changes = params.changes;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length || Object.keys(changes).some(key => !['model', 'effort', 'serviceTier', 'mode', 'permissionMode'].includes(key)) || Object.values(changes).some(value => typeof value !== 'string' || value.length > 200)) throw new BridgeError('BAD_SETTINGS', '仅支持修改草稿的模型、推理强度、速度、模式和权限');
    if (changes.model !== undefined) requireString(changes.model, '模型', 200);
    if (changes.mode !== undefined && !['default', 'plan'].includes(changes.mode)) throw new BridgeError('BAD_SETTINGS', '不支持此执行模式');
    if ((params.confirmedFullAccess !== undefined && typeof params.confirmedFullAccess !== 'boolean') || (changes.permissionMode !== undefined && !['default', 'auto-review', 'read-only', 'full-access'].includes(changes.permissionMode)) || (changes.permissionMode === 'full-access' && params.confirmedFullAccess !== true)) throw new BridgeError('BAD_PERMISSIONS', '权限参数无效或尚未确认完整访问');
    return;
  }
  if (typeof params.text !== 'string' || params.text.length > 32000) throw new BridgeError('BAD_PARAMS', '消息必须是长度不超过32000的文本');
  validateThreadMentionIds(params.threadMentionIds);
  if (params.images !== undefined && (!Array.isArray(params.images) || params.images.length > 3 || params.images.some(image => typeof image !== 'string'))) throw new BridgeError('BAD_IMAGES', '图片参数无效，每次最多3张');
  if (params.attachments !== undefined && (!Array.isArray(params.attachments) || params.attachments.length > 3 || new Set(params.attachments).size !== params.attachments.length || params.attachments.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(id)))) throw new BridgeError('BAD_ATTACHMENTS', '附件编号无效，每次最多3个不同附件');
  if ((params.images?.length ?? 0) + (params.attachments?.length ?? 0) > 3) throw new BridgeError('BAD_ATTACHMENTS', '每次最多发送3个图片或文件附件');
  if (!params.text.trim() && !params.images?.length && !params.attachments?.length) throw new BridgeError('BAD_PARAMS', '请输入消息或选择附件');
}

/** 插件编号只能是有界的目录标识，不能携带 URI、文件路径或转义后的路径。 */
export function validatePluginIds(ids) {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._@-]{0,199}$/.test(id))) throw new BridgeError('BAD_PARAMS', '插件编号无效，每条消息最多选择20个插件');
  return [...new Set(ids)];
}

/** 手机只提交消息内容和目录编号，原生输入及恢复上下文均由电脑构造。 */
export function validateTurnInput(params) {
  const allowed = ['threadId','text','images','attachments','expectedTurnId','planMode','resetPlanAfterSend','planId','planAction','queueAction','queueId','pluginIds','threadMentionIds'];
  if (Object.keys(params).some(key => !allowed.includes(key))) throw new BridgeError('BAD_PARAMS', '发送参数包含不允许的字段');
  validateThreadMentionIds(params.threadMentionIds);
  return validatePluginIds(params.pluginIds);
}

/** 手机只指定有界的聊天编号，原生主机和链接均由电脑核验后构造。 */
export function validateThreadMentionIds(ids) {
  if (ids === undefined) return [];
  if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))) throw new BridgeError('BAD_PARAMS', '聊天引用编号无效，每条消息最多引用20个聊天');
  return [...new Set(ids)];
}

/** 重试只能指定失败轮次，正文、模型和权限等设置均由原桌面会话继承。 */
export function validateTurnRetry(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['threadId', 'expectedTurnId'].includes(key))) throw new BridgeError('BAD_PARAMS', '重试仅接受聊天编号和失败轮次编号');
  requireString(params.threadId, '聊天编号', 200);
  requireString(params.expectedTurnId, '失败轮次编号', 200);
}

export function errorPayload(error) {
  return { code: error.code ?? 'INTERNAL_ERROR', message: error.message ?? '连接服务出现异常', outcomeUnknown: error.outcomeUnknown === true };
}

/** 使用固定字段顺序计算指纹，避免同一请求编号承载不同操作。 */
export function requestFingerprint(method, params) {
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return tokenHash(JSON.stringify({ method, params: stable(params) }));
}
