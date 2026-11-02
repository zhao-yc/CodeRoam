import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { MAX_ATTACHMENTS, FILE_CHUNK_BYTES, validateAttachmentInfo, validateUploadId, decodeFileChunk } from '../../packages/protocol/attachments.mjs';

const EXPIRY = 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');

/** 附件使用独立分片存储；只有用户实际发送时才复制到原会话的工作目录。 */
export class AttachmentStore {
  constructor({ root = '.local/bridge/attachments', now = Date.now } = {}) {
    this.root = path.resolve(root); this.now = now;
  }

  /** 创建目录前核验现有祖先，避免符号链接把上传引到项目外。 */
  safeDirectory(directory) {
    const resolved = path.resolve(directory);
    const ancestors = [];
    for (let entry = resolved; ; entry = path.dirname(entry)) {
      ancestors.push(entry); if (path.dirname(entry) === entry) break;
    }
    for (const entry of ancestors.reverse()) {
      if (fs.existsSync(entry)) {
        const stat = fs.lstatSync(entry);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BridgeError('UNSAFE_ATTACHMENT_PATH', '附件目录不可用，请检查电脑工作目录');
      } else fs.mkdirSync(entry);
    }
    return resolved;
  }

  directory(deviceId, threadId, id) {
    validateUploadId(id);
    return path.join(this.root, digest(deviceId + '\0' + threadId), id);
  }

  metadata(deviceId, threadId, id) {
    const directory = this.directory(deviceId, threadId, id);
    this.safeDirectory(path.dirname(directory));
    if (!fs.existsSync(directory)) throw new BridgeError('UPLOAD_NOT_FOUND', '附件已过期，请移除后重新选择');
    this.safeDirectory(directory);
    const file = path.join(directory, 'metadata.json');
    if (fs.lstatSync(file).isSymbolicLink()) throw new BridgeError('UNSAFE_ATTACHMENT_PATH', '附件元数据不可用');
    const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (metadata.deviceId !== deviceId || metadata.threadId !== threadId || metadata.id !== id) throw new BridgeError('UPLOAD_FORBIDDEN', '附件不属于当前聊天');
    if (!metadata.sent && this.now() - metadata.createdAt >= EXPIRY) throw new BridgeError('UPLOAD_EXPIRED', '附件已过期，请移除后重新选择');
    return { directory, metadata };
  }

  save(directory, metadata) { fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify(metadata), { flag: 'w', mode: 0o600 }); }

  /** 在开始新上传时回收过期临时目录，只遍历本模块创建的哈希和编号目录。 */
  cleanup() {
    this.safeDirectory(this.root);
    for (const scope of fs.readdirSync(this.root)) {
      if (!/^[a-f0-9]{64}$/.test(scope)) continue;
      const parent = path.join(this.root, scope);
      if (fs.lstatSync(parent).isSymbolicLink() || !fs.statSync(parent).isDirectory()) continue;
      for (const id of fs.readdirSync(parent)) {
        if (!/^[a-zA-Z0-9-]{16,80}$/.test(id)) continue;
        const directory = path.join(parent, id);
        if (fs.lstatSync(directory).isSymbolicLink() || !fs.statSync(directory).isDirectory()) continue;
        // 未完成和已发送的临时副本均可清理，已发送的项目附件不会在这里删除。
        if (this.now() - fs.statSync(directory).mtimeMs >= EXPIRY) fs.rmSync(directory, { recursive: true });
      }
    }
  }

  begin(deviceId, threadId, { uploadId, name, size }) {
    validateUploadId(uploadId); validateAttachmentInfo(name, size); this.cleanup();
    const directory = this.directory(deviceId, threadId, uploadId);
    if (fs.existsSync(directory)) {
      const { metadata } = this.metadata(deviceId, threadId, uploadId);
      if (metadata.name !== name || metadata.size !== size) throw new BridgeError('UPLOAD_ID_REUSED', '同一附件编号不能用于不同文件');
      return this.summary(metadata);
    }
    const parent = this.safeDirectory(path.dirname(directory));
    if (fs.readdirSync(parent).length >= 12) throw new BridgeError('UPLOAD_LIMIT', '未发送附件过多，请移除旧附件后重试');
    this.safeDirectory(directory);
    const metadata = { id: uploadId, deviceId, threadId, name, size, received: 0, chunks: [], complete: false, createdAt: this.now() };
    fs.writeFileSync(path.join(directory, 'data'), Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
    this.save(directory, metadata); return this.summary(metadata);
  }

  summary(metadata) { return { id: metadata.id, name: metadata.name, size: metadata.size, received: metadata.received, nextChunk: metadata.chunks.length, complete: metadata.complete }; }

  chunk(deviceId, threadId, { uploadId, index, data }) {
    const { directory, metadata } = this.metadata(deviceId, threadId, uploadId);
    if (!Number.isSafeInteger(index) || index < 0) throw new BridgeError('BAD_CHUNK', '附件分片序号无效');
    const decoded = decodeFileChunk(data), hash = digest(decoded);
    if (index < metadata.chunks.length) {
      if (metadata.chunks[index] !== hash) throw new BridgeError('CHUNK_CONFLICT', '重复分片内容不一致，请重新选择附件');
      return this.summary(metadata);
    }
    if (metadata.complete || index !== metadata.chunks.length || index * FILE_CHUNK_BYTES !== metadata.received || metadata.received + decoded.length > metadata.size || (decoded.length < FILE_CHUNK_BYTES && metadata.received + decoded.length !== metadata.size)) {
      throw new BridgeError('BAD_CHUNK', '附件分片顺序或大小不正确');
    }
    const file = path.join(directory, 'data');
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
    try { if (!fs.fstatSync(fd).isFile()) throw new BridgeError('BAD_FILE', '附件临时文件无效'); fs.writeSync(fd, decoded, 0, decoded.length, metadata.received); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    metadata.received += decoded.length; metadata.chunks.push(hash); this.save(directory, metadata);
    return this.summary(metadata);
  }

  finish(deviceId, threadId, { uploadId }) {
    const { directory, metadata } = this.metadata(deviceId, threadId, uploadId);
    if (metadata.received !== metadata.size) throw new BridgeError('UPLOAD_INCOMPLETE', '附件尚未上传完成');
    const data = this.readData(directory, metadata);
    const extension = validateAttachmentInfo(metadata.name, metadata.size);
    if (data[0] === 0x4d && data[1] === 0x5a || data.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new BridgeError('BAD_FILE_TYPE', '不支持上传可执行文件');
    if (extension === 'pdf' && !data.subarray(0, 1024).includes(Buffer.from('%PDF-')) || ['docx', 'xlsx'].includes(extension) && !data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4])) || ['doc', 'xls'].includes(extension) && !data.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) || !['pdf', 'docx', 'xlsx', 'doc', 'xls'].includes(extension) && data.includes(0)) {
      throw new BridgeError('BAD_FILE_TYPE', '文件内容与格式不匹配，请重新选择');
    }
    metadata.complete = true; metadata.sha256 = digest(data); this.save(directory, metadata); return this.summary(metadata);
  }

  /** 重新检查每个分片，进程中断后不会把写入不完整的文件发送给桌面。 */
  readData(directory, metadata) {
    const file = path.join(directory, 'data');
    if (fs.lstatSync(file).isSymbolicLink()) throw new BridgeError('UNSAFE_ATTACHMENT_PATH', '附件文件不可用');
    const data = fs.readFileSync(file);
    if (data.length !== metadata.size || metadata.chunks.some((hash, index) => digest(data.subarray(index * FILE_CHUNK_BYTES, Math.min(data.length, (index + 1) * FILE_CHUNK_BYTES))) !== hash)) throw new BridgeError('UPLOAD_CORRUPT', '附件校验失败，请重新上传');
    return data;
  }

  abort(deviceId, threadId, { uploadId }) {
    const directory = this.directory(deviceId, threadId, uploadId);
    if (!fs.existsSync(directory)) return { ok: true };
    this.metadata(deviceId, threadId, uploadId);
    fs.rmSync(directory, { recursive: true }); return { ok: true };
  }

  /** 手机仅传附件编号，文件引用由桥接在原会话工作目录内生成。 */
  materialize(deviceId, threadId, ids, cwd, imageCount = 0) {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.length + imageCount > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) throw new BridgeError('BAD_ATTACHMENTS', '每次最多发送3个不同附件');
    if (!ids.length) return [];
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) throw new BridgeError('ATTACHMENT_CWD_UNAVAILABLE', '当前聊天的电脑工作目录不可用，无法发送文件');
    const workspace = fs.realpathSync(cwd);
    return ids.map(id => {
      const { directory, metadata } = this.metadata(deviceId, threadId, id);
      if (!metadata.complete) throw new BridgeError('UPLOAD_INCOMPLETE', '附件尚未上传完成');
      const data = this.readData(directory, metadata);
      if (digest(data) !== metadata.sha256) throw new BridgeError('UPLOAD_CORRUPT', '附件校验失败，请重新上传');
      const targetDirectory = this.safeDirectory(path.join(workspace, '.codex-remote-attachments', digest(threadId), validateUploadId(id)));
      const target = path.join(targetDirectory, metadata.name);
      if (fs.existsSync(target)) {
        if (fs.lstatSync(target).isSymbolicLink() || digest(fs.readFileSync(target)) !== metadata.sha256) throw new BridgeError('ATTACHMENT_CONFLICT', '电脑附件文件已发生变化，请重新上传');
      } else fs.writeFileSync(target, data, { flag: 'wx', mode: 0o600 });
      metadata.sent = true; this.save(directory, metadata);
      return { id, label: metadata.name, path: target, size: metadata.size };
    });
  }
}
