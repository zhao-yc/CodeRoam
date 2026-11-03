import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import {stripTypeScriptTypes} from 'node:module';
import {readHistoricalPage} from '../apps/bridge/history-pager.mjs';import {normalizeConversation} from '../apps/bridge/conversation.mjs';import {validateRequest} from '../packages/protocol/contracts.mjs';
import {readHistoricalSnapshot} from '../apps/bridge/history-reader.mjs';

const message=(id,text=id)=>({id,role:'assistant',kind:'agentMessage',text,turnId:'turn',status:'completed',phase:'final_answer'});
function historyFunctions(){const context=componentContext({});const source=fs.readFileSync('apps/mobile/services/history.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={mergeHistoryMessages,conversationWithHistory}',context);return context.subject;}
const plain=value=>JSON.parse(JSON.stringify(value));

test('长任务不会再挤掉此前提问与报告，仍遵守消息与正文大小限制',()=>{
 const turns=Array.from({length:8},(_,index)=>({turnId:'old-'+index,status:'completed',items:[{id:'u-'+index,type:'userMessage',content:'早期提问'+index},{id:'f-'+index,type:'agentMessage',phase:'final_answer',text:'早期报告'+index}]}));
 turns.push({turnId:'long',status:'completed',items:[{id:'long-u',type:'userMessage',content:'增加图片'},...Array.from({length:150},(_,index)=>({id:'c-'+index,type:'commandExecution',command:'校验命令',output:'日志'.repeat(4000)})),{id:'long-f',type:'agentMessage',phase:'final_answer',text:'已完成图片功能'}]});
 const snapshot=normalizeConversation({id:'thread',turns});
 for(let index=0;index<8;index++){assert.ok(snapshot.messages.some(item=>item.id==='u-'+index));assert.ok(snapshot.messages.some(item=>item.id==='f-'+index));}
 assert.ok(snapshot.messages.some(item=>item.id==='long-u'));assert.ok(snapshot.messages.some(item=>item.id==='long-f'));assert.ok(snapshot.messages.length<=80);assert.ok(snapshot.messages.reduce((sum,item)=>sum+item.text.length,0)<=120000);
});

test('保存历史逐页向前覆盖全部可见消息，游标递减、去重并保持只读文件原样',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-history-pages-')),sessions=path.join(directory,'sessions');fs.mkdirSync(sessions);const file=path.join(sessions,'thread.jsonl');
 const rows=[{type:'session_meta',payload:{id:'thread'}}];const expected=[];
 for(let turn=0;turn<12;turn++){
  rows.push({type:'event_msg',payload:{type:'task_started',turn_id:'turn-'+turn}});
  for(let index=0;index<25;index++){const id=turn+'-'+index;expected.push(id);rows.push({type:'event_msg',payload:{type:'item_completed',thread_id:'thread',turn_id:'turn-'+turn,item:{id,type:index===0?'UserMessage':'AgentMessage',content:[{text:'中文历史 '+id}],phase:index===24?'final_answer':'commentary'}}});}
  rows.push({type:'event_msg',payload:{type:'task_complete',turn_id:'turn-'+turn,duration_ms:1000}});
 }
 const content=rows.map(JSON.stringify).join('\n')+'\n{"未写完';fs.writeFileSync(file,content);const row={id:'thread',title:'历史',cwd:'C:/project',rollout_path:file};
 try{
  const pages=[];let cursor='',last=Infinity,hasMore=true;
  for(let attempts=0;hasMore&&attempts<100;attempts++){
   const page=readHistoricalPage(row,sessions,{before:cursor},6000);assert.ok(page.messages.length<=80);assert.ok(page.messages.reduce((sum,item)=>sum+item.text.length,0)<=120000);
   pages.unshift(page.messages.map(item=>item.id));hasMore=page.hasMore;cursor=page.cursor;
   if(hasMore){const offset=JSON.parse(Buffer.from(cursor,'base64url')).offset;assert.ok(offset<last);last=offset;}
  }
  assert.equal(hasMore,false);assert.deepEqual(pages.flat(),expected);assert.equal(new Set(pages.flat()).size,expected.length);assert.equal(fs.readFileSync(file,'utf8'),content);
  const latest=readHistoricalPage(row,sessions);assert.equal(latest.messages.length,80);assert.equal(latest.messages.at(-1).id,expected.at(-1));
  const before=readHistoricalPage(row,sessions,{beforeMessageId:'0-10'});assert.deepEqual(before.messages.map(item=>item.id),expected.slice(0,10));
  const bad=Buffer.from(JSON.stringify({threadId:'other',offset:100,seek:''})).toString('base64url');assert.throws(()=>readHistoricalPage(row,sessions,{before:bad}),error=>error.code==='BAD_HISTORY_CURSOR');
  assert.throws(()=>readHistoricalPage(row,sessions,{before:'*坏游标'}),error=>error.code==='BAD_HISTORY_CURSOR');
  assert.throws(()=>readHistoricalPage({...row,id:'wrong'},sessions),error=>error.code==='HISTORY_ID_MISMATCH');
  const outside=path.join(directory,'outside.jsonl');fs.writeFileSync(outside,content);assert.throws(()=>readHistoricalPage({...row,rollout_path:outside},sessions),error=>error.code==='HISTORY_UNAVAILABLE');
 }finally{fs.rmSync(directory,{recursive:true});}
});

test('跨读取块寻找当前消息起点，不重复返回当前消息之后的记录',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-history-seek-'));const file=path.join(directory,'thread.jsonl');
 const records=[{type:'session_meta',payload:{id:'thread'}},...Array.from({length:60},(_,index)=>({type:'event_msg',payload:{type:'item_completed',turn_id:'turn',item:{id:'m-'+index,type:'AgentMessage',phase:'commentary',text:'消息'+index+'内容'.repeat(60)}}}))];fs.writeFileSync(file,records.map(JSON.stringify).join('\n')+'\n');
 const row={id:'thread',rollout_path:file};try{let options={beforeMessageId:'m-10'},found=false;for(let count=0;count<100;count++){const page=readHistoricalPage(row,directory,options,1000);assert.ok(page.messages.every(item=>Number(item.id.slice(2))<10));if(page.messages.length)found=true;if(!page.hasMore)break;options={before:page.cursor};}assert.equal(found,true);}finally{fs.rmSync(directory,{recursive:true});}
});

test('旧格式只读快照与分页使用一致的消息编号，能够从截断窗口继续向前读取',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-legacy-pages-')),file=path.join(directory,'thread.jsonl');
 const records=[{type:'session_meta',payload:{id:'thread'}},...Array.from({length:150},(_,index)=>({type:'event_msg',payload:{type:index%2?'agent_message':'user_message',turn_id:'turn-'+index,message:'旧格式中文消息'+index}}))];
 fs.writeFileSync(file,records.map(JSON.stringify).join('\n')+'\n');
 const row={id:'thread',rollout_path:file};
 try{
  const current=readHistoricalSnapshot(row,directory,6000),older=readHistoricalPage(row,directory,{beforeMessageId:current.messages[0].id});
  assert.ok(current.messages.length>0);assert.ok(older.messages.length>0);
  const numbers=[...older.messages,...current.messages].map(message=>Number(message.text.replace('旧格式中文消息','')));
  assert.deepEqual(numbers,[...numbers].sort((a,b)=>a-b));assert.equal(new Set(numbers).size,numbers.length);
 }finally{fs.rmSync(directory,{recursive:true});}
});

test('历史合并按共同消息对齐，实时新值和操作状态保留，旧内容不被新快照清掉',()=>{
 const f=historyFunctions();
 const older=[message('old'),message('a','旧值'),message('c')],newer=[message('a','新值'),message('b'),message('c'),message('d')];
 const merged=f.mergeHistoryMessages(older,newer);assert.deepEqual(plain(merged.map(item=>item.id)),['old','a','b','c','d']);assert.equal(merged[1].text,'新值');
 const live={threadId:'thread',title:'标题',cwd:'',status:'active',activeTurnId:'running',messages:newer,turns:[{turnId:'turn',status:'inProgress'}],approvals:[{id:'approval'}],questionGroups:[{id:'question'}],updatedAt:1,readOnly:false,supportsImages:true,supportsHistoryPages:true};
 const combined=f.conversationWithHistory(live,{messages:older,turns:[{turnId:'turn',status:'completed'}],cursor:'c',hasMore:true});
 assert.equal(combined.status,'active');assert.equal(combined.readOnly,false);assert.equal(combined.activeTurnId,'running');assert.equal(combined.turns[0].status,'inProgress');assert.deepEqual(plain(combined.approvals),live.approvals);assert.equal(combined.messages[0].id,'old');
 assert.equal(f.conversationWithHistory(null,null),null);
});

test('分页参数只允许历史读取，游标大小和类型受到限制',()=>{
 const request={v:1,type:'request',requestId:'history-page-test-0001',method:'thread.history',params:{threadId:'thread',page:true,before:'',beforeMessageId:'message'}};
 assert.equal(validateRequest(request),request);assert.throws(()=>validateRequest({...request,method:'turn.send'}));assert.throws(()=>validateRequest({...request,params:{...request.params,before:{}}}));assert.throws(()=>validateRequest({...request,params:{...request.params,before:'x'.repeat(2001)}}));
});

test('页面读取早期历史不覆盖实时状态，重复点击不重复请求，保留消息锚点且忽略离页响应',async()=>{
 const functions=historyFunctions(),requests=[],unloads=[],watches=[];
 const live={threadId:'thread',title:'标题',cwd:'',status:'idle',activeTurnId:'',messages:[message('current')],turns:[],approvals:[],questionGroups:[],updatedAt:1,supportsHistoryPages:true};
 const connection={snapshot:live,connected:true,hostId:'pc',activeThreadId:'thread',computers:[]};
 const context=componentContext({hideTaskNoticeThread:()=>{},setTimeout,clearTimeout,...functions,connection,bridge:{cancelOpen(){},request(method,params){return new Promise((resolve,reject)=>requests.push({method,params,resolve,reject}));}},ref:value=>({value}),computed:get=>({get value(){return get();}}),watch:(source,callback)=>watches.push({source,callback}),onLoad:()=>{},onUnload:callback=>unloads.push(callback),onShow:()=>{},onHide:()=>{},onBackPress:()=>{},onResize:()=>{},readDraft:()=>'',readDraftImages:()=>[],reportTimeline:snapshot=>snapshot.messages.map(item=>({...item,executions:[],label:''})),nextTick:callback=>callback(),uni:{getElementById:()=>null,getWindowInfo:()=>({windowWidth:393})}});
 const source=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
 // 历史回归同时执行真实注释展示层，确保补页不会因缺少页面依赖而失败。
 for (const module of ['turn-failure','annotations','message-attachments','message-presentations']) vm.runInContext(stripTypeScriptTypes(fs.readFileSync('apps/mobile/services/'+module+'.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,''),{mode:'transform'}),context);
 vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject={loadOlder,historyPage,loadingHistory,historyError,displayConversation,pageHostId,pageThreadId,following,scrollTarget,beginTimelineTouch,endTimelineTouch};',context);
 const page=context.subject;page.pageHostId.value='pc';page.pageThreadId.value='thread';page.beginTimelineTouch();page.endTimelineTouch();assert.equal(page.following.value,false);assert.equal(page.scrollTarget.value,'');page.loadOlder();page.loadOlder();assert.equal(requests.length,1);assert.equal(requests[0].params.beforeMessageId,'current');
 requests[0].resolve({messages:[message('old')],turns:[],cursor:'cursor',hasMore:true});await Promise.resolve();await Promise.resolve();
 assert.deepEqual(plain(page.displayConversation.value.messages.map(item=>item.id)),['old','current']);assert.equal(connection.snapshot,live);assert.equal(page.following.value,false);assert.equal(page.scrollTarget.value,'');
 page.loadOlder();assert.equal(requests[1].params.before,'cursor');unloads.forEach(callback=>callback());requests[1].resolve({messages:[message('stale')],turns:[],cursor:'',hasMore:false});await Promise.resolve();await Promise.resolve();assert.equal(page.displayConversation.value.messages.some(item=>item.id==='stale'),false);
});
