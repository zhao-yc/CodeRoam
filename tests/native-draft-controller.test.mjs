import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeDraftController} from '../apps/bridge/native-draft-controller.mjs';
import {nativeDraftExpression} from '../apps/bridge/native-draft-expression.mjs';

const modules={initial:'app-initial-abc123.js',newChat:'newChat',draftAtom:'draftAtom',draftLocation:'draftLocation',routeAtom:'routeAtom',promotionAtom:'promotionAtom'};
const settings={model:'model-a',effort:'high',serviceTier:'',mode:'default'};

/** 可控原生端只模拟动作与广播顺序；读写、版本核验、项目绑定执行真实控制器。 */
function fixture(){
  const controller=new NativeDraftController(),calls=[];
  let revision=0,state={status:'ready',settings:{...settings},models:[],permissions:{mode:'default'},hasDesktopText:false};
  controller.candidates=async()=>[{port:{pid:101,port:12345},url:'ws://127.0.0.1:12345/devtools/page/synthetic',modules,focused:true}];
  controller.assertBinding=async binding=>{assert.equal(binding.port.pid,101);};
  controller.invoke=async(binding,action,input={})=>{
    calls.push({action,input});
    if(action==='open')return{clientDraftId:'client-new-thread:synthetic'};
    if(action==='read')return{...state,settings:{...state.settings},nativeRevision:String(revision)};
    if(action==='update'){
      assert.equal(input.expectedNativeRevision,String(revision));
      for(const [key,value]of Object.entries(input.changes))if(key==='permissionMode')state.permissions={mode:value};else state.settings[key]=value;
      revision++;return{submitted:true};
    }
    if(action==='send'){revision++;state.status='promoted';state.threadId='11111111-1111-4111-8111-111111111111';return{threadId:state.threadId};}
  };
  return{controller,calls,get state(){return state;},set state(value){state=value;revision++;}};
}

test('原生新建只打开并读取草稿，不提交正式聊天，保持项目和实例绑定',async()=>{
  const f=fixture();try{
    const opened=await f.controller.open({id:'project-a',cwd:'/project-a'},'open-synthetic');
    assert.equal(opened.binding.projectId,'project-a');assert.equal(opened.binding.cwd,'/project-a');
    assert.equal(opened.binding.clientDraftId,'client-new-thread:synthetic');assert.equal(opened.snapshot.status,'ready');
    assert.deepEqual(f.calls.map(call=>call.action),['open','read']);
    assert.match(opened.snapshot.revision,/^[a-f0-9]{64}$/);assert.equal(opened.snapshot.nativeRevision,undefined);
  }finally{f.controller.close();}
});

test('多个桌面窗口无唯一焦点时拒绝新建，不向任一窗口写入',async()=>{
  const f=fixture();f.controller.candidates=async()=>[{focused:false},{focused:false}];
  try{await assert.rejects(f.controller.open({id:'project-a'},'open'),{code:'DRAFT_WINDOW_AMBIGUOUS'});assert.equal(f.calls.length,0);}finally{f.controller.close();}
});

test('新建已获原生编号但首次回读失败时，仅恢复原绑定，不再次打开',async()=>{
  const f=fixture();f.controller.settle=async()=>{throw Error('合成读取失败');};
  try{
    const project={id:'project-a',cwd:'/project-a'};
    await assert.rejects(f.controller.open(project,'open-unknown'),error=>error.code==='OUTCOME_UNKNOWN'&&error.outcomeUnknown);
    const recovered=await f.controller.recoverOpen(project,'open-unknown');
    assert.equal(recovered.binding.clientDraftId,'client-new-thread:synthetic');assert.equal(recovered.snapshot.status,'ready');
    assert.equal(f.calls.filter(call=>call.action==='open').length,1);
    await assert.rejects(f.controller.recoverOpen({id:'other'},'open-unknown'),{code:'OUTCOME_UNKNOWN'});
  }finally{f.controller.close();}
});

test('模型、强度及权限分步原生应用，每一步等待回读，拒绝旧修订',async()=>{
  const f=fixture();try{
    const {binding,snapshot}=await f.controller.open({id:'project-a',cwd:'/project-a'},'open');
    const result=await f.controller.update(binding,{model:'model-b',effort:'medium',permissionMode:'read-only'},{expectedRevision:snapshot.revision,commandId:'update'});
    assert.equal(result.settings.model,'model-b');assert.equal(result.settings.effort,'medium');assert.equal(result.permissions.mode,'read-only');
    assert.deepEqual(f.calls.filter(call=>call.action==='update').map(call=>call.input.changes),[{model:'model-b'},{effort:'medium'},{permissionMode:'read-only'}]);
    await assert.rejects(f.controller.update(binding,{effort:'high'},{expectedRevision:snapshot.revision,commandId:'stale'}),{code:'DRAFT_CHANGED'});
    assert.equal(f.calls.filter(call=>call.action==='update').length,3);
  }finally{f.controller.close();}
});

test('PC 已有正文或离开草稿时不能提交手机内容，原生发送只执行一次并回传正式编号',async()=>{
  const f=fixture();try{
    const {binding,snapshot}=await f.controller.open({id:'project-a',cwd:'/project-a'},'open');
    f.state={...f.state,hasDesktopText:true};const withText=await f.controller.read(binding);
    await assert.rejects(f.controller.send(binding,{text:'合成测试'},{expectedRevision:withText.revision,commandId:'send-blocked'}),{code:'DRAFT_DESKTOP_TEXT'});
    f.state={...f.state,hasDesktopText:false,status:'detached'};const detached=await f.controller.read(binding);
    await assert.rejects(f.controller.send(binding,{text:'合成测试'},{expectedRevision:detached.revision,commandId:'detached'}),{code:'DRAFT_CHANGED'});
    f.state={...f.state,status:'ready'};const ready=await f.controller.read(binding),created=[];
    const result=await f.controller.send(binding,{text:'合成测试',images:[],attachments:[]},{expectedRevision:ready.revision,commandId:'send-once',onCreated:value=>created.push(value)});
    assert.equal(result.snapshot.status,'promoted');assert.equal(created[0].threadId,result.threadId);
    assert.equal(f.calls.filter(call=>call.action==='send').length,1);
    await assert.rejects(f.controller.send(binding,{text:'合成测试'},{expectedRevision:snapshot.revision,commandId:'send-again'}),{code:'DRAFT_CHANGED'});
    assert.equal(f.calls.filter(call=>call.action==='send').length,1);
  }finally{f.controller.close();}
});

test('原生表达式入口拒绝未知动作及不可信模块，数据不能转义为执行代码',()=>{
  assert.throws(()=>nativeDraftExpression({...modules,initial:'https://example.com/module.js'},'read',{}));
  assert.throws(()=>nativeDraftExpression(modules,'execute',{}));
  const text='合成文本 "); globalThis.unexpected = true; //';
  const expression=nativeDraftExpression(modules,'send',{text});
  assert.ok(expression.includes(JSON.stringify(text)));assert.ok(!expression.includes('eval('));
});
