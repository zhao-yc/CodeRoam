import fs from 'node:fs';
import path from 'node:path';
import {BridgeError} from '../../packages/protocol/contracts.mjs';
import {historicalSnapshot} from './history-reader.mjs';

/** 逐块向前读取保存历史，只返回一页可见消息；游标只表达位置，不接受文件路径。 */
export function readHistoricalPage(row, sessionDirectory, {before='',beforeMessageId=''}={}, maximumBytes=8*1024*1024) {
  let fd;
  try {
    const root=fs.realpathSync.native(sessionDirectory),file=fs.realpathSync.native(row.rollout_path);
    const relative=path.relative(root,file);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!file.endsWith('.jsonl'))throw new BridgeError('HISTORY_UNAVAILABLE','历史记录路径不受支持');
    fd=fs.openSync(file,'r');const size=fs.fstatSync(fd).size;
    const header=Buffer.alloc(Math.min(size,256*1024));fs.readSync(fd,header,0,header.length,0);
    const metadata=JSON.parse(header.toString('utf8').split('\n')[0]);
    if(metadata.type!=='session_meta'||metadata.payload?.id!==row.id)throw new BridgeError('HISTORY_ID_MISMATCH','历史记录与当前聊天不匹配');
    let end=size,seek=beforeMessageId;
    if(before){
      let cursor;try{cursor=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));}catch{throw new BridgeError('BAD_HISTORY_CURSOR','历史游标无效，请重新打开聊天');}
      if(cursor.threadId!==row.id||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.offset>size||typeof cursor.seek!=='string'||cursor.seek.length>1000)throw new BridgeError('BAD_HISTORY_CURSOR','历史游标已失效，请重新打开聊天');
      end=cursor.offset;seek=cursor.seek;
    }
    const start=Math.max(0,end-maximumBytes),buffer=Buffer.alloc(end-start);fs.readSync(fd,buffer,0,buffer.length,start);
    let position=start>0?buffer.indexOf(10)+1:0;
    if(start>0&&position===0)position=buffer.length;
    const alignedStart=start+position,records=[],offsets=new Map(),turnOffsets=new Map();let anchor=-1,currentTurn='';
    while(position<buffer.length){
      const newline=buffer.indexOf(10,position);if(newline<0)break;
      const offset=start+position;let record;try{record=JSON.parse(buffer.subarray(position,newline).toString('utf8'));}catch{position=newline+1;continue;}
      position=newline+1;record.ordinal=offset;records.push(record);
      const event=record.payload??{};if(record.type!=='event_msg'||(event.thread_id&&event.thread_id!==row.id))continue;
      if(event.turn_id)currentTurn=event.turn_id;
      if(currentTurn){const bounds=turnOffsets.get(currentTurn)??{first:offset,last:offset};bounds.last=offset;turnOffsets.set(currentTurn,bounds);}
      const id=event.type==='item_completed'&&typeof event.item?.id==='string'?event.item.id:['user_message','agent_message'].includes(event.type)?'history-'+offset:'';
      if(id){offsets.set(id,offset);if(id===seek)anchor=offset;}
    }
    if(seek&&anchor<0){
      if(start===0)throw new BridgeError('HISTORY_ANCHOR_MISSING','暂未找到当前消息的保存位置，请稍后重新同步');
      return {messages:[],turns:[],hasMore:true,cursor:encodeCursor(row.id,alignedStart<end?alignedStart:start,seek)};
    }
    const snapshot=historicalSnapshot(row,records,{maxMessages:Number.MAX_SAFE_INTEGER,maxCharacters:maximumBytes*2,preserveDialogue:false});
    const eligible=snapshot.messages.filter(message=>(offsets.get(message.id)??end)<(anchor>=0?anchor:end));
    const messages=[];let characters=0;
    // 分页保留连续片段；大小不足时在边界结束，下一页继续，不能跳过中间消息。
    for(let index=eligible.length-1;index>=0;index--){const message=eligible[index];if(messages.length>=80||characters+message.text.length>120000)break;messages.unshift(message);characters+=message.text.length;}
    let next=messages.length?Math.min(...messages.map(message=>offsets.get(message.id))):alignedStart;
    // 块内没有可见消息时仍向前推进，避免半行或纯工具内部事件造成死循环。
    if(next>=end)next=start;
    const hasMore=next>0;
    const turnIds=new Set(messages.map(message=>message.turnId));
    // 无消息失败按本页字节范围保留，但绝不把本页最后一轮标为整个会话的最新轮次。
    return {messages,turns:snapshot.turns.filter(turn=>{
      const bounds=turnOffsets.get(turn.turnId);
      return turnIds.has(turn.turnId)||(turn.status==='failed'&&bounds&&bounds.last>=next&&bounds.first<(anchor>=0?anchor:end));
    }),hasMore,cursor:hasMore?encodeCursor(row.id,next,''):''};
  }catch(error){
    if(error instanceof BridgeError)throw error;
    throw new BridgeError('HISTORY_UNAVAILABLE','读取早期记录失败，请稍后重试');
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}

function encodeCursor(threadId,offset,seek){return Buffer.from(JSON.stringify({threadId,offset,seek})).toString('base64url');}
