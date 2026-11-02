import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { applyConversationUpdate } from '../apps/bridge/updates.mjs';

/** 仅对用户明确授权的新建验收会话执行消息、去重、追加和停止测试。 */
const {values}=parseArgs({options:{thread:{type:'string'},approval:{type:'boolean',default:false}}});
if(!values.thread)throw new Error('必须显式指定用户已授权的验收会话');
const directory=path.resolve('.cache/acceptance');fs.mkdirSync(directory,{recursive:true});
const config=JSON.parse(fs.readFileSync('.local/mobile.json','utf8'));
const socket=new WebSocket(config.relayUrl,{headers:{Authorization:`Bearer ${config.token}`}});
const pending=new Map();let snapshot=null;let current=null;let ready;
const connected=new Promise((resolve,reject)=>{ready={resolve,reject};});
socket.on('error',error=>ready.reject(error));
socket.on('message',data=>{const message=JSON.parse(data);if(message.type==='welcome')ready.resolve();if(message.type==='event'&&message.threadId===values.thread){const updated=applyConversationUpdate(current,message);if(updated){current=updated;snapshot=updated.snapshot;}}if(message.type==='response'){const entry=pending.get(message.requestId);if(!entry)return;clearTimeout(entry.timer);pending.delete(message.requestId);if(message.error)entry.reject(Object.assign(new Error(message.error.message),message.error));else entry.resolve(message.result);}});
function request(method,params,requestId=randomUUID()){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error(`请求超时：${method}`));},25000);pending.set(requestId,{resolve,reject,timer});socket.send(JSON.stringify({v:1,type:'request',requestId,hostId:config.hostId,method,params}));});}
async function waitFor(predicate,label,timeout=90000){const start=Date.now();while(Date.now()-start<timeout){if(snapshot&&predicate(snapshot))return;await new Promise(resolve=>setTimeout(resolve,250));}throw new Error(`真实验收等待超时：${label}`);}
const reports=[];
try{
  await connected;current=await request('thread.watch',{threadId:values.thread});snapshot=current.snapshot;
  await waitFor(state=>state.activeTurnId===''&&state.status!=='active','初始会话完成');
  if(values.approval){
    await request('turn.send',{threadId:values.thread,text:`这是已授权的审批验收。请仅调用 exec_command，在工作目录 ${directory} 执行 PowerShell 命令 Get-Location，必须使用 sandbox_permissions=require_escalated，justification 为“手机客户端审批验收：只读当前验收目录”。等待正常审批，不要改变审批或沙箱配置；完成后仅回复 MOBILE_APPROVAL_DONE。`});
    await waitFor(state=>state.approvals.length>0||state.messages.some(message=>message.role==='assistant'&&message.text.includes('MOBILE_APPROVAL_DONE')),'真实审批请求');
    if(snapshot.approvals.length){const approval=snapshot.approvals[0];await request('approval.reply',{threadId:values.thread,approvalId:approval.id,turnId:approval.turnId,decision:'accept'});reports.push({scenario:'真实审批转发',status:'通过'});}
    else reports.push({scenario:'真实审批转发',status:'未触发',reason:'该无害命令被当前自动审批策略处理，未产生手机可处理的待审批项'});
    await waitFor(state=>state.activeTurnId===''&&state.status!=='active','审批验收结束');
  }else{
    const marker=`MOBILE_ACK_${Date.now()}`,requestId=randomUUID(),params={threadId:values.thread,text:`这是自建手机客户端的真实消息验收。不要调用工具，不要改文件，仅回复 ${marker}。`};
    await request('turn.send',params,requestId);await waitFor(state=>state.messages.some(message=>message.role==='assistant'&&message.text.includes(marker))&&state.activeTurnId==='','真实消息响应');
    const countBefore=snapshot.messages.filter(message=>message.role==='user'&&message.text.includes(marker)).length;
    if(countBefore!==1)throw new Error('时间线中未找到唯一的真实用户消息');
    await request('turn.send',params,requestId);await new Promise(resolve=>setTimeout(resolve,1000));
    if(snapshot.messages.filter(message=>message.role==='user'&&message.text.includes(marker)).length!==countBefore)throw new Error('相同请求编号触发了重复用户消息');reports.push({scenario:'真实消息及重复编号去重',status:'通过'});
    await request('turn.send',{threadId:values.thread,text:`这是追加指令和停止验收。请只调用 exec_command，在工作目录 ${directory} 执行 Start-Sleep -Seconds 20。不要访问其他目录，不要修改文件；完成后仅回复 MOBILE_WAIT_DONE。`});
    await waitFor(state=>state.activeTurnId.length>0&&state.messages.some(message=>message.role==='tool'&&message.text.includes('Start-Sleep')),'实际命令开始');const turnId=snapshot.activeTurnId;
    await request('turn.steer',{threadId:values.thread,expectedTurnId:turnId,text:'追加验收：结束后改为只回复 MOBILE_STEER_ACK。'});reports.push({scenario:'真实执行中追加指令',status:'通过'});
    await request('turn.stop',{threadId:values.thread,expectedTurnId:turnId});await waitFor(state=>state.activeTurnId===''&&state.status!=='active','任务停止');reports.push({scenario:'真实停止任务',status:'通过'});
  }
  await request('thread.unwatch',{threadId:values.thread});
  const result={threadId:values.thread,createdAt:new Date().toISOString(),reports};fs.writeFileSync(path.join(directory,values.approval?'approval-result.json':'write-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error(JSON.stringify({status:'真实写操作验收未通过',code:error.code,message:error.message}));process.exitCode=1;}finally{for(const entry of pending.values())clearTimeout(entry.timer);socket.close();}
