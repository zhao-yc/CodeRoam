import {BridgeError} from './contracts.mjs';

export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 320 * 1024;

/** 只接收有限大小的内嵌图片，不允许手机指定电脑文件路径或远程抓取地址。 */
export function validateImages(images, maxBytes = MAX_IMAGE_BYTES) {
  if(images===undefined)return [];
  if(!Array.isArray(images)||images.length>MAX_IMAGES)throw new BridgeError('BAD_IMAGES','每次最多发送3张图片');
  return images.map(source=>{
    if(typeof source!=='string'||source.length>maxBytes*4/3+100)throw new BridgeError('BAD_IMAGES','图片过大，请压缩后重试');
    const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
    if(!match)throw new BridgeError('BAD_IMAGES','仅支持内嵌的PNG或JPEG图片');
    const data=Buffer.from(match[2],'base64');
    if(data.length>maxBytes||data.toString('base64')!==match[2])throw new BridgeError('BAD_IMAGES','图片内容无效或超出大小限制');
    const valid=match[1]==='png'?data.length>=24&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):data.length>=4&&data[0]===255&&data[1]===216&&data[2]===255;
    if(!valid)throw new BridgeError('BAD_IMAGES','图片格式与内容不匹配');
    return source;
  });
}
