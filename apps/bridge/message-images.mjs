import fs from 'node:fs';
import path from 'node:path';
import {BridgeError} from '../../packages/protocol/contracts.mjs';
import {MAX_IMAGE_BYTES, validateImages} from '../../packages/protocol/images.mjs';

/** 仅读取桌面用户消息已附加的本地图片，不接受手机提供路径或网络地址。 */
function readAttachedImage(file) {
  if(typeof file!=='string'||!path.isAbsolute(file)||/^\\\\|^\/\//.test(file)||file.includes('\0')||!['.png','.jpg','.jpeg'].includes(path.extname(file).toLowerCase()))throw new BridgeError('IMAGE_UNAVAILABLE','这张图片的保存格式暂不支持预览，请重新发送 PNG 或 JPEG 图片');
  let fd;
  try {
    // 拒绝链接、目录和特殊文件；打开后再次核对类型与大小，限定读取量。
    const entry=fs.lstatSync(file);
    if(!entry.isFile()||entry.isSymbolicLink())throw new BridgeError('IMAGE_UNAVAILABLE','这张图片的文件类型不支持预览');
    fd=fs.openSync(file,'r');
    const stat=fs.fstatSync(fd);
    if(!stat.isFile())throw new BridgeError('IMAGE_UNAVAILABLE','这张图片的文件类型不支持预览');
    if(stat.size>MAX_IMAGE_BYTES)throw new BridgeError('IMAGE_TOO_LARGE','这张图片超过预览大小限制，请压缩后重新发送');
    const data=Buffer.alloc(stat.size);
    if(fs.readSync(fd,data,0,data.length,0)!==data.length)throw new BridgeError('IMAGE_UNAVAILABLE','图片文件发生变化，请重新加载');
    const mime=path.extname(file).toLowerCase()==='.png'?'png':'jpeg';
    return validateImages([`data:image/${mime};base64,${data.toString('base64')}`])[0];
  } catch(error) {
    if(error instanceof BridgeError)throw error;
    // 系统异常可能包含个人路径，统一转为不含路径的提示。
    throw new BridgeError('IMAGE_UNAVAILABLE',error.code==='ENOENT'?'电脑上的原图已不存在，请重新发送':'暂时无法读取电脑上的原图，请稍后重试');
  } finally { if(fd!==undefined)fs.closeSync(fd); }
}

/** 正常快照仅传图片数量；只有显式查看目标消息时才读取图片正文。 */
export function readMessageImages(parts) {
  return parts.map(part=>part.type==='localImage'?readAttachedImage(part.path):validateImages([part.url])[0]);
}
