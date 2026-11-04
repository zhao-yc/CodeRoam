import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';
import {EventEmitter} from 'node:events';

test('聊天行的未读与已读采用列表最新值，旧详情和缺字段回退不会遮蔽新结果',()=>{
 const source=fs.readFileSync('apps/mobile/components/chat-list/chat-list.uvue','utf8');
 const start=source.indexOf('function threadState('),method=source.slice(start,source.indexOf('\n}',start)+2);
 const connection={hostId:'host',snapshot:{threadId:'thread',hasUnreadTurn:false}};
 const context=vm.createContext({connection,conversationTaskState:()=> 'idle',threadIndicator:(state,unread)=>unread===true?'unread':state});
 vm.runInContext(stripTypeScriptTypes(method)+'; globalThis.subject=threadState',context);
 const thread={id:'thread',hostId:'host',online:true,hasUnreadTurn:true};
 assert.equal(context.subject(thread),'unread');
 delete connection.snapshot.hasUnreadTurn;assert.equal(context.subject(thread),'unread');
 connection.snapshot.hasUnreadTurn=true;thread.hasUnreadTurn=false;assert.equal(context.subject(thread),'idle');
 delete thread.hasUnreadTurn;assert.equal(context.subject(thread),'unread');
});

/** 执行实际状态判定，覆盖等待、结束和断线时不应持续旋转的边界。 */
test('任务状态区分运行、等待、空闲与断连，不把未知当空闲',()=>{
  const source=fs.readFileSync('apps/mobile/services/bridge.uts','utf8');
  const method=source.slice(source.indexOf('export function taskState('),source.indexOf('\ntype TextAppend'));
  const context=vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(method.replaceAll('export ',''))+'; globalThis.subject=taskState; globalThis.conversation=conversationTaskState',context);
  const state=context.subject;
  assert.equal(state('active','',0,0,true),'running');
  assert.equal(state('idle','turn',0,0,true),'running');
  assert.equal(state('active','turn',1,0,true),'approval');
  assert.equal(state('active','turn',1,1,true),'question');
  assert.equal(state('idle','',0,0,true),'idle');
  assert.equal(state('unknown','',0,0,true),'unknown');
  assert.equal(state('active','turn',0,0,false),'offline');
  const snapshot={status:'active',activeTurnId:'turn',approvals:[],questionGroups:[{state:'pending',kind:'async'}]};
  assert.equal(context.conversation(snapshot,true),'running');
  snapshot.questionGroups[0].kind='native';assert.equal(context.conversation(snapshot,true),'question');
  snapshot.status='idle';snapshot.activeTurnId='';assert.equal(context.conversation(snapshot,true),'question');
});

/** 无须先在手机打开会话，也能通过只读跟随获取列表状态；读取失败保留未知。 */
test('列表读取每条会话状态并清理临时订阅，不影响原有订阅',async()=>{
  class Client extends EventEmitter {
    socket={writable:true};
    async connect(){}
    async findOwner(id){return id==='missing'?null:{clientId:'desktop',hostId:'local'};}
    broadcast(method,params){if(method==='thread-stream-following-changed'&&params.following)queueMicrotask(()=>this.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'desktop',params:{conversationId:params.conversationId,hostId:'local',change:{type:'snapshot',revision:1,conversationState:{id:params.conversationId,turns:[{turnId:'turn',status:params.conversationId==='running'?'inProgress':'completed',items:[]}],requests:[],threadRuntimeStatus:{type:params.conversationId==='running'?'active':'idle'}}}}}));}
    close(){}
  }
  const adapter=new DesktopAdapter({client:new Client(),index:{list:()=>['running','idle','missing'].map(id=>({id,title:id}))}});
  await adapter.watch('running','phone');
  const rows=await adapter.list({});
  assert.equal(rows[0].status,'active');assert.equal(rows[0].activeTurnId,'turn');
  assert.equal(rows[1].status,'idle');assert.equal(rows[2].status,'unknown');
  assert.deepEqual([...adapter.conversations.keys()],['running']);
  assert.deepEqual([...adapter.conversations.get('running').watchers],['phone']);
  adapter.close();
});
