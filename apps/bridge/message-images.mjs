import fs from 'node:fs';
import path from 'node:path';
import {BridgeError} from '../../packages/protocol/contracts.mjs';
import {MAX_IMAGE_BYTES, validateImages} from '../../packages/protocol/images.mjs';

/** 仅从桌面回复的 Markdown 图片语法提取本地附件；代码示例不作为文件读取。 */
export function assistantImages(text) {
  const parts = [];
  const masked = text.replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?\1|`+[^`\n]*`+/g, match => ' '.repeat(match.length));
  const pattern = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|([^\n]*?))\s*\)/g;
  const replacements = [];
  for (const match of masked.matchAll(pattern)) {
    let file = (match[2] ?? match[3]).trim();
    if (!path.isAbsolute(file) || /^\\\\|^\/\//.test(file)) continue;
    if (parts.length < 3) parts.push({type:'localImage',path:file});
    replacements.push({start:match.index,end:match.index+match[0].length});
  }
  // 路径仅留在桌面快照中，手机正文不包含本地图片地址。
  for (const replacement of replacements.reverse()) text = text.slice(0,replacement.start) + '\n' + text.slice(replacement.end);
  return {text,parts};
}

/** 仅读取桌面用户消息已附加的本地图片，不接受手机提供路径或网络地址。 */
function readAttachedImage(file, maxBytes = MAX_IMAGE_BYTES) {
  if(typeof file!=='string'||!path.isAbsolute(file)||/^\\\\|^\/\//.test(file)||file.includes('\0')||!['.png','.jpg','.jpeg'].includes(path.extname(file).toLowerCase()))throw new BridgeError('IMAGE_UNAVAILABLE','这张图片的保存格式暂不支持预览，请重新发送 PNG 或 JPEG 图片');
  let fd;
  try {
    // 拒绝链接、目录和特殊文件；打开后再次核对类型与大小，限定读取量。
    const entry=fs.lstatSync(file);
    if(!entry.isFile()||entry.isSymbolicLink())throw new BridgeError('IMAGE_UNAVAILABLE','这张图片的文件类型不支持预览');
    fd=fs.openSync(file,'r');
    const stat=fs.fstatSync(fd);
    if(!stat.isFile())throw new BridgeError('IMAGE_UNAVAILABLE','这张图片的文件类型不支持预览');
    if(stat.size>maxBytes)throw new BridgeError('IMAGE_TOO_LARGE','这张图片超过预览大小限制，请压缩后重新发送');
    const data=Buffer.alloc(stat.size);
    if(fs.readSync(fd,data,0,data.length,0)!==data.length)throw new BridgeError('IMAGE_UNAVAILABLE','图片文件发生变化，请重新加载');
    const mime=path.extname(file).toLowerCase()==='.png'?'png':'jpeg';
    return validateImages([`data:image/${mime};base64,${data.toString('base64')}`],maxBytes)[0];
  } catch(error) {
    if(error instanceof BridgeError)throw error;
    // 系统异常可能包含个人路径，统一转为不含路径的提示。
    throw new BridgeError('IMAGE_UNAVAILABLE',error.code==='ENOENT'?'电脑上的原图已不存在，请重新发送':'暂时无法读取电脑上的原图，请稍后重试');
  } finally { if(fd!==undefined)fs.closeSync(fd); }
}

/** 正常快照仅传图片数量；只有显式查看目标消息时才读取图片正文。 */
export function readMessageImages(parts, imageIndex) {
  // 分片预览允许较大的设计稿，但每次只读取目标图片，上传限制保持原值。
  const selected=imageIndex === undefined ? parts : parts.slice(imageIndex,imageIndex+1);
  const limit=imageIndex === undefined ? MAX_IMAGE_BYTES : 12 * 1024 * 1024;
  return selected.map(part=>part.type==='localImage'?readAttachedImage(part.path,limit):validateImages([part.url],limit)[0]);
}
