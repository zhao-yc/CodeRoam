import path from 'node:path';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { ThreadCreationClient } from './thread-creation.mjs';

const methodParams = Object.freeze({
  'thread/loaded/list': ['cursor', 'limit'],
  'thread/queue/list': ['threadId', 'cursor', 'limit'],
  'thread/queue/add': ['threadId', 'input', 'clientUserMessageId'],
  'thread/queue/delete': ['threadId', 'queuedSubmissionId'],
});
const hints = {
  NATIVE_QUEUE_UNAVAILABLE: '电脑原生队列连接未就绪，请重新同步后重试',
  NATIVE_QUEUE_CHANGED: '电脑排队消息已变化，请同步后重试',
  NATIVE_QUEUE_FULL: '最多排队20条消息，请先处理已有消息',
  OUTCOME_UNKNOWN: '电脑队列操作结果需要核对，请勿重复提交',
};
const queueError = code => new BridgeError(code, hints[code], code === 'OUTCOME_UNKNOWN');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);

/** 只校验原生输入结构，完整保留附件、插件及文本标记，逐条能力限制由上层处理。 */
function validInput(input) {
  return Array.isArray(input) && input.length > 0 && input.every(part => {
    if (!isObject(part)) return false;
    switch (part.type) {
      case 'text':
        return typeof part.text === 'string' && (part.text_elements === undefined ||
          Array.isArray(part.text_elements) && part.text_elements.every(element =>
            isObject(element) && isObject(element.byteRange) &&
            Number.isSafeInteger(element.byteRange.start) && element.byteRange.start >= 0 &&
            Number.isSafeInteger(element.byteRange.end) && element.byteRange.end >= element.byteRange.start &&
            (element.placeholder == null || typeof element.placeholder === 'string')));
      case 'image':
        return (typeof part.url === 'string' || typeof part.fileId === 'string') &&
          (part.detail == null || ['auto', 'low', 'high', 'original'].includes(part.detail));
      case 'localImage':
        return typeof part.path === 'string' &&
          (part.detail == null || ['auto', 'low', 'high', 'original'].includes(part.detail));
      case 'audio':
        return typeof part.url === 'string';
      case 'localAudio':
        return typeof part.path === 'string';
      case 'skill':
      case 'mention':
        return typeof part.name === 'string' && typeof part.path === 'string';
      default:
        return false;
    }
  });
}
const validRow = row => isObject(row) && validId(row.id) && validId(row.clientUserMessageId) && validInput(row.input);

/** 原始 RPC 错误只在本地识别固定代码，绝不携带诊断、路径或 cause 返回上层。 */
function sanitizedError(error) {
  if (error instanceof BridgeError && Object.hasOwn(hints, error.code)) return queueError(error.code);
  if (error?.code === 'CREATION_REJECTED' && ['NATIVE_QUEUE_CHANGED', 'NATIVE_QUEUE_FULL'].includes(error.cause?.code)) {
    return queueError(error.cause.code);
  }
  return queueError('NATIVE_QUEUE_UNAVAILABLE');
}

/** 独立辅助进程只访问未加载聊天的持久队列，执行权始终留在原桌面。 */
export class NativeServerQueueClient {
  constructor({ creation, ...options } = {}) {
    this.creation = creation ?? new ThreadCreationClient(options);
  }

  /** 白名单同时约束方法及参数，不能借短连接加载聊天或覆盖执行、审批设置。 */
  async run(cwd, action) {
    let mutated = false;
    try {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || typeof this.creation?.run !== 'function') throw queueError('NATIVE_QUEUE_UNAVAILABLE');
      return await this.creation.run(cwd, async rpc => {
        const request = async (method, params) => {
          if (!Object.hasOwn(methodParams, method) || !isObject(params) ||
              Object.keys(params).some(key => !methodParams[method].includes(key))) throw queueError('NATIVE_QUEUE_UNAVAILABLE');
          const writing = method === 'thread/queue/add' || method === 'thread/queue/delete';
          try {
            const result = await rpc(method, params);
            if (writing) mutated = true;
            return result;
          } catch (error) {
            // 仅明确的 RPC 拒绝可确认未写入，其余写入异常均禁止自动补发。
            if (writing && (error?.code !== 'CREATION_REJECTED' || error.outcomeUnknown === true)) mutated = true;
            throw error;
          }
        };
        const assertUnloaded = async () => {
          const result = await request('thread/loaded/list', { limit: 1 });
          if (!Array.isArray(result?.data) || result.data.length !== 0 || result.nextCursor != null) throw queueError('NATIVE_QUEUE_UNAVAILABLE');
        };
        await assertUnloaded();
        try {
          return await action(request);
        } finally {
          // 即使 action 抛错也回查，写入后回查失败必须保留结果未知。
          await assertUnloaded();
        }
      }, { experimentalApi: true });
    } catch (error) {
      if (mutated) throw queueError('OUTCOME_UNKNOWN');
      throw sanitizedError(error);
    }
  }

  /** 完整读完最多 200 条，拒绝循环游标、重复记录和无法验证的原生数据。 */
  async readRows(request, threadId) {
    const rows = [], cursors = new Set(), ids = new Set(), commandIds = new Set();
    let cursor;
    while (true) {
      const page = await request('thread/queue/list', { threadId, limit: 200 - rows.length, ...(cursor === undefined ? {} : { cursor }) });
      if (!Array.isArray(page?.data) || rows.length + page.data.length > 200) throw queueError('NATIVE_QUEUE_UNAVAILABLE');
      for (const row of page.data) {
        if (!validRow(row)) throw queueError('NATIVE_QUEUE_UNAVAILABLE');
        if (ids.has(row.id) || commandIds.has(row.clientUserMessageId)) throw queueError('NATIVE_QUEUE_CHANGED');
        ids.add(row.id);
        commandIds.add(row.clientUserMessageId);
        rows.push(row);
      }
      const next = page.nextCursor;
      if (next == null) return rows;
      if (typeof next !== 'string' || !next.length || cursors.has(next) || cursors.size >= 200 || rows.length >= 200) throw queueError('NATIVE_QUEUE_UNAVAILABLE');
      cursors.add(next);
      cursor = next;
    }
  }

  async list(threadId, cwd) {
    if (!validId(threadId)) throw queueError('NATIVE_QUEUE_UNAVAILABLE');
    return this.run(cwd, request => this.readRows(request, threadId));
  }

  async enqueue(threadId, input, commandId, cwd) {
    if (!validId(threadId) || !validId(commandId) || !validInput(input)) throw queueError('NATIVE_QUEUE_UNAVAILABLE');
    return this.run(cwd, async request => {
      const rows = await this.readRows(request, threadId);
      const previous = rows.find(row => row.clientUserMessageId === commandId);
      // 命令编号是幂等依据，即使队列已满也优先返回原生的完整记录。
      if (previous) return previous;
      if (rows.length >= 20) throw queueError('NATIVE_QUEUE_FULL');
      const result = await request('thread/queue/add', { threadId, input, clientUserMessageId: commandId });
      const row = result?.queuedSubmission;
      if (!validRow(row) || row.clientUserMessageId !== commandId) throw queueError('OUTCOME_UNKNOWN');
      return row;
    });
  }

  async remove(threadId, id, cwd) {
    if (!validId(threadId) || !validId(id)) throw queueError('NATIVE_QUEUE_UNAVAILABLE');
    return this.run(cwd, async request => {
      const result = await request('thread/queue/delete', { threadId, queuedSubmissionId: id });
      if (typeof result?.deleted !== 'boolean') throw queueError('OUTCOME_UNKNOWN');
      return result.deleted;
    });
  }
}
