import { createHash } from 'node:crypto';

/** 折叠执行项只保留摘要和内容版本，日志正文仅由按编号的详情请求返回。 */
export function executionPreview(message) {
  if (!['commandExecution', 'fileChange'].includes(message.kind)) return message;
  if (message.detailRevision && message.text === '') return message;
  const { images, ...preview } = message;
  return { ...preview, text: '', detailRevision: createHash('sha256').update(message.text ?? '').digest('hex') };
}
