import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from '../../packages/protocol/contracts.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
const unavailable = () => new BridgeError('NATIVE_QUEUE_UNAVAILABLE', '电脑原生队列暂时无法读取，请重新同步后重试');
const plainMap = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const sameFile = (left, right) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);

/** 配置目录仅由电脑端指定，固定读取官方存储键；原始行只供上层私有缓存和投影。 */
export function readStoredMessageQueue(codexHome, threadId) {
  let descriptor;
  try {
    if (typeof codexHome !== 'string' || !path.isAbsolute(codexHome) ||
        typeof threadId !== 'string' || !threadId.length || threadId.length > 200) throw unavailable();
    const file = path.join(codexHome, '.codex-global-state.json');
    let before;
    try {
      before = fs.lstatSync(file, { bigint: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_BYTES)) throw unavailable();
    descriptor = fs.openSync(file, 'r');
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFile(before, opened)) throw unavailable();

    // 多读一个字节检测增长，始终限制内存占用，不因并发追加而无界读取。
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_BYTES || length !== Number(opened.size)) throw unavailable();
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(file, { bigint: true });
    // 句柄固定读取对象，再核对路径与纳秒时间戳，拒绝替换、链接及读取期间的变更。
    if (!after.isFile() || !current.isFile() || current.isSymbolicLink() ||
        !sameFile(opened, after) || !sameFile(after, current)) throw unavailable();

    const state = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!plainMap(state)) throw unavailable();
    if (!Object.hasOwn(state, 'queued-follow-ups')) return [];
    const queues = state['queued-follow-ups'];
    if (!plainMap(queues)) throw unavailable();
    if (!Object.hasOwn(queues, threadId)) return [];
    const rows = queues[threadId];
    if (!Array.isArray(rows) || rows.length > 200 || rows.some(row =>
      !plainMap(row) || typeof row.id !== 'string' || row.id.length > 200 || typeof row.text !== 'string')) throw unavailable();
    return rows;
  } catch {
    // JSON、系统异常及私有正文只留在本机，边界统一转换为固定提示。
    throw unavailable();
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { throw unavailable(); }
    }
  }
}
