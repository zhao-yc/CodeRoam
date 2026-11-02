import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopAdapter } from '../apps/bridge/desktop-adapter.mjs';
import fs from 'node:fs';

class DesktopFixture extends EventEmitter {
  constructor(){super();this.socket={writable:true};this.calls=[];this.state={id:'thread',title:'验收',turns:[{turnId:'turn',status:'completed',items:[]}],requests:[],threadRuntimeStatus:{type:'idle'}};}
  async connect(){}
  async findOwner(_thread,hostId){return hostId==='local'?{clientId:'desktop',hostId}:null;}
  broadcast(method,params){if(method==='thread-stream-following-changed'&&params.following)queueMicrotask(()=>this.emit('broadcast',{method:'thread-stream-state-changed',version:11,sourceClientId:'desktop',params:{conversationId:'thread',hostId:'local',change:{type:'snapshot',revision:1,conversationState:this.state}}}));}
  async request(method,params,version,options){this.calls.push({method,params,version,options});return{resultType:'success',result:{ok:true}};}
  close(){}
}

test('图文和纯图片通过原所有者发送，追加图片保留轮次核对及可恢复附件',async()=>{
  const image='data:image/png;base64,'+fs.readFileSync('apps/mobile/static/icons/check-dark.png').toString('base64');
  for(const active of [false,true]){
    const client=new DesktopFixture();if(active){client.state.turns[0].status='inProgress';client.state.threadRuntimeStatus.type='active';}
    const adapter=new DesktopAdapter({client});
    await adapter.operate(active?'turn.steer':'turn.send',{threadId:'thread',text:active?'查看图片':'',images:[image],expectedTurnId:'turn'},'command','phone');
    const payload=client.calls[0].params,input=active?payload.input:payload.turnStart.request.input;
    assert.deepEqual(input.at(-1),{type:'image',url:image});assert.equal(input.length,active?2:1);
    const restore=active?payload.restoreMessage:payload.turnStart.context.restoreMessage;
    assert.deepEqual(restore.context.imageAttachments,[{id:'command:image:0',src:image}]);
    assert.equal(payload.turnStart?.context.inheritThreadSettings,active?undefined:true);assert.equal(payload.turnStart?.request.approvalPolicy,undefined);adapter.close();
  }
});

test('非法图片与空消息不触发桌面发送',async()=>{
  const client=new DesktopFixture(),adapter=new DesktopAdapter({client});
  for(const params of [{text:''},{text:'消息',images:['file:///etc/passwd']},{text:'消息',images:['https://example.com/image.png']},{text:'消息',images:['data:image/svg+xml;base64,PHN2Zz4=']}])await assert.rejects(adapter.operate('turn.send',{threadId:'thread',...params},'command','phone'));
  assert.equal(client.calls.length,0);adapter.close();
});
test('桌面发送仅使用所有者转发，继承现有设置且不传入沙箱权限覆盖',async()=>{
  const client=new DesktopFixture(),adapter=new DesktopAdapter({client});await adapter.operate('turn.send',{threadId:'thread',text:'继续任务'},'command','phone');
  assert.equal(client.calls[0].method,'thread-follower-start-turn');const request=client.calls[0].params.turnStart.request;assert.equal(request.threadId,'thread');assert.equal(request.input[0].text,'继续任务');assert.equal(request.sandboxPolicy,undefined);assert.equal(request.approvalPolicy,undefined);assert.equal(client.calls[0].options.targetClientId,'desktop');adapter.close();
  assert.deepEqual(client.calls[0].params.turnStart.context.restoreMessage.context.workspaceRoots,['/']);
});
test('旧 turnId 无法停止新任务，旧审批无法操作其他任务',async()=>{
  const client=new DesktopFixture();client.state.turns[0].status='inProgress';client.state.threadRuntimeStatus.type='active';const adapter=new DesktopAdapter({client});
  await assert.rejects(adapter.operate('turn.stop',{threadId:'thread',expectedTurnId:'old'},'c','p'),error=>error.code==='STALE_TURN');
  await assert.rejects(adapter.operate('approval.reply',{threadId:'thread',approvalId:'x',turnId:'old',decision:'accept'},'c2','p'),error=>error.code==='STALE_APPROVAL');assert.equal(client.calls.length,0);adapter.close();
});
test('有效审批保留服务端请求编号类型且限制为本次操作',async()=>{
  const client=new DesktopFixture();client.state.requests=[{id:17,method:'item/commandExecution/requestApproval',params:{turnId:'turn',command:'echo 验收'}}];const adapter=new DesktopAdapter({client});
  await adapter.operate('approval.reply',{threadId:'thread',approvalId:'17',turnId:'turn',decision:'accept'},'c','p');assert.equal(client.calls[0].params.requestId,17);
  await assert.rejects(adapter.operate('approval.reply',{threadId:'thread',approvalId:'17',turnId:'turn',decision:'acceptForSession'},'c2','p'),error=>error.code==='BAD_DECISION');assert.equal(client.calls.length,1);adapter.close();
});
