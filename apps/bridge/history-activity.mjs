import fs from 'node:fs';
import path from 'node:path';
import {BridgeError} from '../../packages/protocol/contracts.mjs';

/** 只读已核验历史尾部的任务事件，不投影消息正文，也不用最终回复猜任务完成。 */
export function readHistoricalActivity(row,sessionDirectory) {
  let fd;
  try {
    const root=fs.realpathSync.native(sessionDirectory),file=fs.realpathSync.native(row.rollout_path);
    const relative=path.relative(root,file);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!file.endsWith('.jsonl'))throw Error('来源无效');
    fd=fs.openSync(file,'r');
    const before=fs.fstatSync(fd);let header=Buffer.alloc(Math.min(before.size,4096));
    fs.readSync(fd,header,0,header.length,0);
    let end=header.indexOf(10);
    // 官方会话元数据可包含较长的说明，仅在首个小块不足时有界补读头部。
    if(end<0&&before.size>header.length) {
      const previous=header,expanded=Buffer.alloc(Math.min(before.size,256*1024));previous.copy(expanded);
      fs.readSync(fd,expanded,previous.length,expanded.length-previous.length,previous.length);
      header=expanded;end=header.indexOf(10);
    }
    if(end<0)return {status:'unknown'};
    const metadata=JSON.parse(header.subarray(0,end).toString('utf8'));
    if(metadata.type!=='session_meta'||metadata.payload?.id!==row.id)throw Error('身份不符');
    const start=Math.max(0,before.size-64*1024),tail=Buffer.alloc(Math.min(before.size,64*1024));
    fs.readSync(fd,tail,0,tail.length,start);
    const after=fs.fstatSync(fd);
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)return {status:'unknown'};
    const lines=tail.toString('utf8').split('\n');lines.pop();if(start>0)lines.shift();
    for(let index=lines.length-1;index>=0;index--) {
      if(!/"type"\s*:\s*"(?:task_started|task_complete|turn_aborted|task_failed)"/.test(lines[index]))continue;
      try {
        const record=JSON.parse(lines[index]),event=record.payload;
        if(record.type!=='event_msg'||!event||event.thread_id&&event.thread_id!==row.id||typeof event.turn_id!=='string')continue;
        const status={task_started:'active',task_complete:'completed',turn_aborted:'interrupted',task_failed:'failed'}[event.type];
        if(status)return {status,turnId:event.turn_id};
      }catch{/* 不完整或不兼容的尾帧不能被当作终态。 */}
    }
    return {status:'unknown'};
  }catch {
    throw new BridgeError('HISTORY_UNAVAILABLE','暂时无法核对聊天的已保存任务状态');
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}
