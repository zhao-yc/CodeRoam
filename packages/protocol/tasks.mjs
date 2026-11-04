import { BridgeError, WRITE_METHODS, validateRequest, validateDraftRequest, validatePluginIds, requireString } from './contracts.mjs';
import { validateImages } from './images.mjs';

export const TASK_METHODS = new Set(['tasks.submit','tasks.list','tasks.watch','tasks.unwatch','tasks.control']);
export const TASK_STATES = ['queued','running','succeeded','failed','unknown','cancelled','canceled','skipped','waiting_resume'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const text = (value, max = 1000) => typeof value === 'string' && value.length <= max;
const integer = value => Number.isSafeInteger(value) && value >= 0;
/** 业务结果可包含设置等对象，但绝不能回传任务原文、设备身份或凭据。 */
const safeResult = (value, depth = 0) => depth < 12 && (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ||
  Array.isArray(value) && value.length <= 1000 && value.every(item => safeResult(item,depth+1)) || object(value) && Object.entries(value).every(([key,item]) =>
    !['deviceId','device_id','payload','token','accessToken','refreshToken','secret','password','authorization','firstMessageGuard'].includes(key) && safeResult(item,depth+1)));

/** 任务只包装既有白名单业务，不能把持久化队列变成任意接口或脚本执行入口。 */
export function validateTaskRequest(method, params, requestId) {
  const fail = message => { throw new BridgeError('BAD_TASK',message); };
  if (method === 'tasks.watch' || method === 'tasks.unwatch') {
    if (!keys(params,[]) || Object.keys(params).length) fail('任务订阅不接受额外参数');
    return;
  }
  if (method === 'tasks.list') {
    if (!keys(params,['view','taskId','before','limit','state']) || !['active','history'].includes(params.view ?? 'active') ||
        params.taskId !== undefined && !id(params.taskId) || params.before !== undefined && !integer(params.before) ||
        params.limit !== undefined && (!integer(params.limit) || params.limit < 1 || params.limit > 100) ||
        params.state !== undefined && !TASK_STATES.includes(params.state)) fail('任务查询参数无效');
    return;
  }
  if (method === 'tasks.control') {
    if (!keys(params,['taskId','action','confirmed','expectedAttempt']) || !id(params.taskId) || !['cancel','dismiss','reconcile','resume','skip','retry'].includes(params.action) ||
        params.confirmed !== undefined && typeof params.confirmed !== 'boolean' || ['skip','retry'].includes(params.action) && params.confirmed !== true ||
        params.action === 'retry' && !integer(params.expectedAttempt) || params.action !== 'retry' && params.expectedAttempt !== undefined) fail('任务控制参数无效或尚未确认操作');
    return;
  }
  if (method !== 'tasks.submit' || !keys(params,['taskId','kind','payload']) || !id(params.taskId) || !['command','newConversation'].includes(params.kind) || !object(params.payload)) fail('任务提交参数无效');
  const payload = params.payload;
  if (params.kind === 'command') {
    if (!keys(payload,['method','params','firstMessageGuard']) || !WRITE_METHODS.has(payload.method)) fail('任务只能提交已开放的桌面写操作');
    validateRequest({v:1,type:'request',requestId,method:payload.method,params:payload.params});
    if (payload.firstMessageGuard !== undefined) {
      const guard = payload.firstMessageGuard;
      if (payload.method !== 'turn.send' || !keys(guard,['permissionRevision','confirmedFullAccess']) || Object.keys(guard).length !== 2 ||
          !/^[a-f0-9]{64}$/.test(guard.permissionRevision ?? '') || typeof guard.confirmedFullAccess !== 'boolean' ||
          Object.keys(payload.params).some(key => !['threadId','text','images','attachments','pluginIds','threadMentionIds'].includes(key))) fail('任务首条消息保护参数无效');
    }
    // 普通旧入口由适配层校验图片；持久化前即限制体积和内容，防止无效正文占据数据库。
    if (payload.params.images !== undefined) validateImages(payload.params.images);
    return;
  }
  if (!keys(payload,['projectId','mode','text','images','attachments','choices','pluginIds','threadMentionIds']) || !['desktopIpc','nativeDraft'].includes(payload.mode)) fail('新建聊天任务参数无效');
  requireString(payload.projectId,'项目编号',200);
  validateDraftRequest('thread.draft.send',{draftId:'00000000-0000-4000-8000-000000000000',expectedRevision:0,text:payload.text,images:payload.images,attachments:payload.attachments,threadMentionIds:payload.threadMentionIds});
  validateImages(payload.images);
  const plugins = validatePluginIds(payload.pluginIds);
  if (payload.mode === 'nativeDraft' && plugins.length) fail('原生草稿暂不支持插件，请先移除插件后发送');
  const choices = payload.choices ?? {};
  if (!keys(choices,['model','effort','serviceTier','mode','permissionMode','confirmedFullAccess']) ||
      Object.entries(choices).some(([key,value]) => key === 'confirmedFullAccess' ? typeof value !== 'boolean' : !text(value,200)) ||
      choices.model !== undefined && !choices.model.trim() || choices.mode !== undefined && !['default','plan'].includes(choices.mode) ||
      choices.permissionMode !== undefined && !['desktop-default','default','auto-review','read-only','full-access'].includes(choices.permissionMode) ||
      choices.permissionMode === 'full-access' && choices.confirmedFullAccess !== true) fail('新建聊天选项无效或尚未确认完整访问');
}

/** 展示事件采用字段白名单，阻断误把数据库执行正文、原设备身份或桌面原始回执推送给手机。 */
export function validTaskSnapshot(snapshot) {
  if (!keys(snapshot,['supportsTaskQueue','revision','paused','blockerId','tasks','now','nextCursor']) || snapshot.supportsTaskQueue !== true || !integer(snapshot.revision) ||
      typeof snapshot.paused !== 'boolean' || !text(snapshot.blockerId,80) || snapshot.blockerId && !id(snapshot.blockerId) || !integer(snapshot.now) ||
      !Array.isArray(snapshot.tasks) || snapshot.tasks.length > 1000 || snapshot.nextCursor !== undefined && snapshot.nextCursor !== null && !integer(snapshot.nextCursor)) return false;
  return snapshot.tasks.every(task => keys(task,['id','position','kind','method','title','threadId','projectId','state','stage','error','createdAt','startedAt','completedAt','updatedAt','dismissed','steps','result','historyExpired','attempt','canRetry']) &&
    id(task.id) && integer(task.position) && ['command','newConversation'].includes(task.kind) && text(task.method,100) && text(task.title,300) && text(task.threadId,200) && text(task.projectId,200) &&
    TASK_STATES.includes(task.state) && text(task.stage,300) && text(task.error,2000) && integer(task.createdAt) && (task.startedAt === null || integer(task.startedAt)) &&
    (task.completedAt === null || integer(task.completedAt)) && integer(task.updatedAt) && typeof task.dismissed === 'boolean' && (task.historyExpired === undefined || typeof task.historyExpired === 'boolean') && (task.attempt === undefined || integer(task.attempt)) && (task.canRetry === undefined || typeof task.canRetry === 'boolean') && (task.result === undefined || object(task.result) && safeResult(task.result)) && Array.isArray(task.steps) && task.steps.length <= 100 &&
    task.steps.every(step => keys(step,['name','state','at','startedAt','completedAt','error']) && text(step.name,300) && ['queued','running','succeeded','failed','unknown','done'].includes(step.state) &&
      (step.at === undefined || integer(step.at)) && (step.startedAt === undefined || step.startedAt === null || integer(step.startedAt)) &&
      (step.completedAt === undefined || step.completedAt === null || integer(step.completedAt)) && (step.error === undefined || text(step.error,2000))));
}
