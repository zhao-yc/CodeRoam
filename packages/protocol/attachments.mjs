import { BridgeError } from './contracts.mjs';

export const MAX_ATTACHMENTS = 3;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const FILE_CHUNK_BYTES = 192 * 1024;
export const DOCUMENT_EXTENSIONS = new Set('pdf doc docx xls xlsx csv txt md json yaml yml xml log js mjs cjs ts tsx jsx uts uvue vue py java cs c cpp h hpp go rs sh ps1 sql html css scss less toml ini conf properties'.split(' '));

/** 校验用户选中的文档名称和大小；实际保存目录始终由电脑生成。 */
export function validateAttachmentInfo(name, size) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 180 || /[\x00-\x1f<>:"/\\|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new BridgeError('BAD_FILE', '文件名不受支持，请重命名后重试');
  }
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(extension)) throw new BridgeError('BAD_FILE_TYPE', '仅支持PDF、Word、Excel、文本和常见代码文件');
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) throw new BridgeError('BAD_FILE_SIZE', '文件不能为空，且每个文件不能超过20 MiB');
  return extension;
}

/** 严格限制上传标识，拒绝路径及客户端指定的本地文件。 */
export function validateUploadId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(id)) throw new BridgeError('BAD_UPLOAD_ID', '附件编号无效');
  return id;
}

/** 文件正文仅通过有界分片传输，不写入业务操作账本。 */
export function decodeFileChunk(encoded) {
  if (typeof encoded !== 'string' || encoded.length > FILE_CHUNK_BYTES * 4 / 3 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new BridgeError('BAD_CHUNK', '附件分片无效或过大');
  const data = Buffer.from(encoded, 'base64');
  if (!data.length || data.length > FILE_CHUNK_BYTES || data.toString('base64') !== encoded) throw new BridgeError('BAD_CHUNK', '附件分片内容无效');
  return data;
}
