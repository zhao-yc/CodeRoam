import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { METHODS } from './contracts.mjs';

export const REQUEST_DIAGNOSTICS_VERSION = 1;
const events = {
  'request.forwarded': '请求已转发电脑', 'request.completed': '电脑回执已处理',
  'request.busy': '等待请求达到上限', 'request.timeout': '等待电脑回执超时',
  'request.cancelled': '连接或实例变化，结束等待', 'request.rejected': '请求未转发',
  'response.ignored': '回执来源或实例代次不匹配', 'response.late': '回执未找到在途记录，可能已结束或属于后台退订',
  'bridge.received': '电脑收到中转请求', 'bridge.dispatch': '电脑开始分派请求',
  'bridge.execute': '电脑开始执行请求', 'bridge.completed': '电脑请求处理结束',
  'bridge.sent': '电脑已发送回执', 'bridge.dropped': '电脑连接变化，未发送回执',
  'connection.open': '连接已建立', 'connection.close': '连接已断开',
  'connection.warning': '电脑连接出现警告',
};
const codes = new Set(['BUSY', 'HOST_OFFLINE', 'HOST_FORBIDDEN', 'REQUEST_TIMEOUT', 'OUTCOME_UNKNOWN',
  'INSTANCE_CHANGED', 'INSTANCE_OFFLINE', 'INSTANCE_NOT_READY', 'BAD_DRAFT_RESPONSE',
  'BAD_MESSAGE', 'BAD_REQUEST_ID', 'BAD_PARAMS', 'METHOD_NOT_ALLOWED', 'RELAY_UNAVAILABLE',
  'INSTANCE_DISCOVERY_FAILED', 'INSTANCE_BINDING_FAILED', 'INSTANCE_OWNER_UNVERIFIED',
  'INSTANCE_DIRECTORY_SHARED', 'INSTANCES_RELAY_UNSUPPORTED', 'OWNER_UNAVAILABLE',
  'SUBSCRIPTION_REQUIRED', 'REQUEST_ID_REUSED']);
const numericFields = ['pendingTotal', 'pendingMobile', 'pendingHost', 'inFlight', 'elapsedMs', 'queueWaitMs', 'bufferedBytes', 'closeCode'];

/** 仅输出固定字段；编号进程内匿名化，随机 transportId 摘要用于跨中转和电脑关联。 */
export function createRequestDiagnostics({ component, write = line => console.log(line) }) {
  const secret = randomBytes(32), session = randomUUID();
  const reference = value => typeof value === 'string' && value.length > 0
    ? createHmac('sha256', secret).update(value.slice(0, 4096)).digest('hex').slice(0, 16) : undefined;
  const trace = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
    ? createHash('sha256').update(value).digest('hex').slice(0, 24) : undefined;
  /** 参数只读取已知枚举和布尔值，绝不复制正文、路径、令牌、搜索词或错误消息。 */
  const context = message => ({
    trace: trace(message?.transportId), method: METHODS.has(message?.method) ? message.method : 'unknown',
    host: reference(message?.hostId), device: reference(message?.deviceId), thread: reference(message?.params?.threadId),
    view: ['prefetch', 'file-report'].includes(message?.params?.view) ? message.params.view : undefined,
    activate: message?.params?.activate === true, startedAt: performance.now(),
  });
  const summary = entry => {
    const item = entry?.diagnostic;
    return item ? { trace: item.trace, method: item.method, host: item.host, device: item.device, thread: item.thread,
      view: item.view, activate: item.activate, ageMs: Math.max(0, Math.round(performance.now() - item.startedAt)) } : undefined;
  };
  /** 限流时列出本连接全部在途请求（最多 16 条），全局队列仅保留最早 16 条和方法统计。 */
  const snapshot = entries => {
    const rows = [...entries].filter(entry => entry?.diagnostic), methods = {};
    for (const entry of rows) methods[entry.diagnostic.method] = (methods[entry.diagnostic.method] ?? 0) + 1;
    const oldest = rows.sort((a, b) => a.diagnostic.startedAt - b.diagnostic.startedAt).slice(0, 16).map(summary);
    return { count: rows.length, methods, oldest, truncated: rows.length > oldest.length };
  };
  /** 日志失败不得改变请求结果；额外输入字段一律丢弃。 */
  const record = (event, item, fields = {}, queues) => {
    if (!events[event]) return;
    try {
      const row = { time: new Date().toISOString(), diagnosticsVersion: REQUEST_DIAGNOSTICS_VERSION,
        component: component === 'relay' ? 'relay' : 'bridge', session, event, message: events[event] };
      if (item) Object.assign(row, { trace: item.trace, method: item.method, host: item.host, device: item.device,
        thread: item.thread, view: item.view, activate: item.activate });
      if (fields.connection) row.connection = reference(fields.connection);
      if (['host', 'mobile'].includes(fields.role)) row.role = fields.role;
      if (fields.errorCode) row.errorCode = codes.has(fields.errorCode) ? fields.errorCode : 'OTHER';
      for (const key of numericFields) if (Number.isFinite(fields[key])) row[key] = Math.max(0, Math.round(fields[key]));
      for (const key of ['failed', 'outcomeUnknown', 'delivered', 'globalLimit', 'mobileLimit', 'lockQueued']) if (typeof fields[key] === 'boolean') row[key] = fields[key];
      if (queues) row.pending = { mobile: snapshot(queues.mobile ?? []), global: snapshot(queues.global ?? []) };
      write(JSON.stringify(row));
    } catch { /* 诊断输出故障不能中断业务。 */ }
  };
  return { context, record, trace, elapsed: item => Math.max(0, performance.now() - item.startedAt) };
}
