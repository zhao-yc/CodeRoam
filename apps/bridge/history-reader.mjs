import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { normalizeConversation } from './conversation.mjs';

/** 只接收桌面已保存的可见时间线，不将原始提示词、推理或工具参数当聊天正文。 */
export function historicalSnapshot(row, records, options = {}) {
  const canonical=new Map(),legacy=[],turnInfo=new Map();
  let turnId='';
  for(const record of records) {
    if(record.type!=='event_msg') continue;
    const event=record.payload??{};
    if(event.thread_id&&event.thread_id!==row.id) continue;
    if(event.turn_id) turnId=event.turn_id;
    // 截断块开头的匿名旧轮次也按首次出现登记，不能在已知最新轮次后补入旧组。
    if(!turnInfo.has(turnId))turnInfo.set(turnId,{});
    // 只相信明确的任务事件；最终回复标记本身不代表任务已经结束。
    if(turnId && ['task_started','task_complete','turn_aborted','task_failed'].includes(event.type)) {
      const status=event.type==='task_complete'?'completed':event.type==='task_started'?'inProgress':event.type==='turn_aborted'?'interrupted':'failed';
      turnInfo.set(turnId,{status,...(event.type==='task_failed'?{error:event.error??event.message}:{}),...(Number.isFinite(event.duration_ms)&&event.duration_ms>=0?{durationMs:event.duration_ms}:{})});
    }
    const item=event.item;
    if(event.type==='item_completed'&&item&&typeof item.id==='string') {
      let converted;
      if(item.type==='UserMessage') converted={...item,type:'userMessage'};
      else if(item.type==='UserInputResponse') converted={...item,type:'userInputResponse',requestId:item.requestId??item.request_id,questions:(Array.isArray(item.questions)?item.questions:[]).map(question=>({...question,isSecret:question.isSecret===true||question.is_secret===true}))};
      else if(item.type==='AgentMessage'&&item.phase!=='analysis'&&item.channel!=='analysis') converted={...item,type:'agentMessage'};
      // 已保存方案与普通回复分开记录，不能从提示词或推理中猜测方案。
      else if(item.type==='Plan'&&item.phase!=='analysis'&&item.channel!=='analysis') converted={...item,type:'plan'};
      else if(item.type==='ImageGeneration') converted={...item,type:'imageGeneration'};
      else if(item.type==='CommandExecution') converted={...item,type:'commandExecution',command:Array.isArray(item.command)?item.command.join(' '):item.command,aggregatedOutput:item.aggregated_output??item.aggregatedOutput};
      else if(item.type==='FileChange') {
        // 持久化事件按文件路径存对象，实时快照使用数组；统一后复用手机摘要逻辑。
        const changes=Array.isArray(item.changes)?item.changes:Object.entries(item.changes??{}).map(([file,change])=>({path:file,kind:{type:change?.type??change?.kind??'修改',move_path:change?.move_path??null},diff:change?.type==='update'?change.unified_diff:change?.content}));
        converted={...item,type:'fileChange',status:item.status??'completed',changes};
      }
      if(converted) canonical.set(item.id,{turnId,items:[converted]});
    } else if(['user_message','agent_message'].includes(event.type)&&typeof event.message==='string') {
      legacy.push({turnId,items:[{id:'history-'+(record.ordinal??legacy.length),type:event.type==='user_message'?'userMessage':'agentMessage',text:event.message,content:event.message}]});
    }
  }
  // 按真实轮次合并项目，保持首次出现顺序和同编号项目的最终版本。
  const grouped=new Map([...turnInfo].map(([turnId,info])=>[turnId,{turnId,...info,items:[]}]));
  for(const entry of canonical.size?canonical.values():legacy) {
    let turn=grouped.get(entry.turnId);
    if(!turn) {turn={turnId:entry.turnId,...turnInfo.get(entry.turnId),items:[]};grouped.set(entry.turnId,turn);}
    turn.items.push(...entry.items);
  }
  const turns=[...grouped.values()];
  const snapshot=normalizeConversation({id:row.id,title:row.title,cwd:row.cwd,turns,requests:[],threadRuntimeStatus:{type:'unknown'}},options);
  // 历史不能证明当前执行、审批或问答状态，必须清空可操作目标并明确只读。
  return {...snapshot,...(options.rawTurns===true?{sourceTurns:turns,historyTruncated:options.historyTruncated===true}:{}),readOnly:true,status:'unknown',activeTurnId:'',activity:'',approvals:[],questionGroups:[],pendingPlan:null,updatedAt:row.updatedAt??0};
}

/** 仅只读索引指向的本机 sessions 文件；验证实际路径和会话身份并限制读取量。 */
export function readHistoricalSnapshot(row, sessionDirectory, maximumBytes=8*1024*1024, options = {}) {
  let fd;
  try {
    // Codex 在 Windows 索引中保存 \\?\ 长路径；原生解析兼容此前缀并继续解析链接，避免普通 realpathSync 在盘符处报 EISDIR。
    const root=fs.realpathSync.native(sessionDirectory),file=fs.realpathSync.native(row.rollout_path);
    const relative=path.relative(root,file);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!file.endsWith('.jsonl')) throw new BridgeError('HISTORY_UNAVAILABLE','这条聊天的历史记录格式暂不支持');
    fd=fs.openSync(file,'r');
    const size=fs.fstatSync(fd).size,header=Buffer.alloc(Math.min(size,256*1024));
    fs.readSync(fd,header,0,header.length,0);
    const firstLine=header.toString('utf8').split('\n')[0],metadata=JSON.parse(firstLine);
    if(metadata.type!=='session_meta'||metadata.payload?.id!==row.id) throw new BridgeError('HISTORY_ID_MISMATCH','历史记录与当前聊天不匹配');
    const start=Math.max(0,size-maximumBytes),buffer=Buffer.alloc(Math.min(size,maximumBytes));
    fs.readSync(fd,buffer,0,buffer.length,start);
    // 保存真实字节位置，保证旧格式消息与向前分页使用同一个稳定编号。
    let position=start>0?buffer.indexOf(10)+1:0;
    if(start>0&&position===0)position=buffer.length;
    const records=[];
    while(position<buffer.length) {
      const newline=buffer.indexOf(10,position);if(newline<0)break;
      try{records.push({...JSON.parse(buffer.subarray(position,newline).toString('utf8')),ordinal:start+position});}catch{}
      position=newline+1;
    }
    return historicalSnapshot(row,records,{...options,historyTruncated:start>0});
  } catch(error) {
    if(error instanceof BridgeError) throw error;
    const failure=new BridgeError('HISTORY_UNAVAILABLE','暂时无法读取这条聊天的已保存历史，请稍后重新同步');
    failure.cause=error;throw failure;
  } finally {if(fd!==undefined)fs.closeSync(fd);}
}
