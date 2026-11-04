import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {instanceActivityExpression,readInstanceActivity} from '../apps/bridge/instance-activity.mjs';

const modules={kind:'webpack',entry:'100.synthetic.js',servicesModule:'SyntheticServices'};
const page={readyState:'complete',scripts:[{type:'module',src:'app://-/assets/'+modules.entry}]};
const clean=value=>JSON.parse(JSON.stringify(value));

/** 仅替换固定模块导入，实际执行生成表达式，所有写入口与模块工厂都设置为失败。 */
function evaluate(expression,open,{document=page,loaded=true}={}) {
  const fail=()=>{throw Error('禁止初始化或写入桌面服务');};
  const runtime=fail;
  runtime.c=loaded?{SyntheticServices:{exports:{appServices:{clientCoordination:{threadStreamFollowingStatusRequested:fail},appServerManagers:{open}},setAppHost:fail,setAppServices:fail}}}:{};
  return vm.runInNewContext(expression.replace(/await import\("[^"]+"\)/,'syntheticModule'),{syntheticModule:{__webpack_require__:runtime},document});
}

test('活动查询只读已加载服务，仅返回工作中且当前实例持有owner的编号',async()=>{
  const owner=randomUUID(),follower=randomUUID(),unknown=randomUUID(),opened=[],roles=[];
  const manager={
    async getWorkInProgress(){return [{conversationId:owner},{conversationId:follower},{conversationId:unknown},{conversationId:owner}];},
    async getStreamRole(id){roles.push(id);return {role:id===owner?'owner':id===follower?'follower':'unknown'};},
    getCachedThreadIds(){throw Error('禁止把缓存会话当作活动会话');},
  };
  const result=await evaluate(instanceActivityExpression(modules),async hostId=>{opened.push(hostId);return {status:'ready',manager};});
  assert.deepEqual(clean(result),{complete:true,threadIds:[owner]});
  assert.deepEqual(opened,['local','durable']);assert.equal(roles.length,8);
  await assert.rejects(evaluate(instanceActivityExpression(modules),async()=>({status:'ready',manager}),{loaded:false}),/INSTANCE_UNSUPPORTED/);
  await assert.rejects(evaluate(instanceActivityExpression(modules),async()=>({status:'ready',manager}),{document:{readyState:'loading',scripts:page.scripts}}),/INSTANCE_UNSUPPORTED/);
  await assert.rejects(evaluate(instanceActivityExpression(modules),async()=>({status:'ready',manager}),{document:{readyState:'complete',scripts:[]}}),/INSTANCE_UNSUPPORTED/);
});

test('服务不可用、异常或无效编号明确标为不完整，不能猜成完整无人清单',async()=>{
  const owned=randomUUID(),failed=randomUUID();
  for(const open of [
    async()=>({status:'unavailable'}),
    async()=>{throw Error('服务暂时不可用');},
    async()=>({status:'ready',manager:{getWorkInProgress:async()=>null}}),
  ])assert.deepEqual(clean(await evaluate(instanceActivityExpression(modules),open)),{complete:false,threadIds:[]});
  const result=await evaluate(instanceActivityExpression(modules),async()=>({status:'ready',manager:{
    getWorkInProgress:async()=>[{conversationId:owned},{conversationId:failed},{conversationId:'invalid'}],
    getStreamRole:async id=>{if(id===failed)throw Error('归属不可用');return {role:'owner'};},
  }}));
  assert.deepEqual(clean(result),{complete:false,threadIds:[owned]});
});

test('活动枚举每管理器最多256条，归属查询分批最多16个并发',async()=>{
  const ids=Array.from({length:300},()=>randomUUID());let calls=0,active=0,maxActive=0;
  const result=await evaluate(instanceActivityExpression(modules),async hostId=>hostId==='durable'?{status:'ready',manager:{getWorkInProgress:async()=>[]}}:{status:'ready',manager:{
    getWorkInProgress:async()=>ids.map(conversationId=>({conversationId})),
    async getStreamRole(){calls++;active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;return {role:'owner'};},
  }});
  assert.equal(result.complete,false);assert.equal(result.threadIds.length,256);assert.equal(calls,256);assert.ok(maxActive<=16);
});

test('读取固定同实例页面，校验结果并去重；连接不可用和旧代次结果均拒绝',async()=>{
  const id=randomUUID(),instance={alive:true,ready:true,port:12345,generation:randomUUID(),executable:'synthetic'};
  const options={resolveModules:()=>modules,pages:async()=>['first','second','third'],evaluate:async(url,expression,options)=>{
    assert.ok(expression.includes('getWorkInProgress'));assert.equal(options.timeoutMs,2000);
    if(url==='first')throw Error('页面不可用');
    return {complete:true,threadIds:[id,id]};
  }};
  assert.deepEqual(await readInstanceActivity(instance,options),{complete:true,threadIds:[id]});
  const unknown={complete:false,threadIds:[]};
  for(const change of [{alive:false},{ready:false},{port:0}])assert.deepEqual(await readInstanceActivity({...instance,...change},{pages:()=>{throw Error('不能查询未就绪实例');}}),unknown);
  assert.deepEqual(await readInstanceActivity(instance,{...options,evaluate:async()=>{instance.generation=randomUUID();return {complete:true,threadIds:[id]};}}),unknown);
  assert.deepEqual(await readInstanceActivity(instance,{...options,evaluate:async()=>{instance.ready=false;return {complete:true,threadIds:[id]};}}),unknown);
});

test('无效清单不透传，最多尝试两个核验页面且不扫描其他端点',async()=>{
  const instance={alive:true,ready:true,port:12345,generation:randomUUID(),executable:'synthetic'},calls=[];
  const result=await readInstanceActivity(instance,{resolveModules:()=>modules,pages:async()=>['one','two','three'],evaluate:async url=>{calls.push(url);return {complete:true,threadIds:['invalid']};}});
  assert.deepEqual(result,{complete:false,threadIds:[]});assert.deepEqual(calls,['one','two']);
  for(const invalid of [{complete:'true',threadIds:[]},{complete:true,threadIds:Array(257).fill(randomUUID())},null]) {
    assert.deepEqual(await readInstanceActivity(instance,{resolveModules:()=>modules,pages:async()=>['one'],evaluate:async()=>invalid}),{complete:false,threadIds:[]});
  }
});
