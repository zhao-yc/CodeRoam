import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAccountUsage,normalizeAccountLabel,readAccountUsage} from '../apps/bridge/account-usage.mjs';

test('额度只来自真实百分比，优先 Codex 限额且不泄露账号或额外字段',()=>{
  const result=normalizeAccountUsage({rateLimits:{primary:{usedPercent:10,windowDurationMins:300}},rateLimitsByLimitId:{codex:{secondary:{usedPercent:52,windowDurationMins:10080},email:'synthetic@example.com'}}});
  assert.deepEqual(result,{available:true,windows:[{label:'本周',remainingPercent:48}]});
  for(const response of [null,{}, {rateLimits:{primary:{usedPercent:'10',windowDurationMins:300}}},{rateLimits:{primary:{usedPercent:120,windowDurationMins:300}}},{rateLimits:{primary:{usedPercent:20}}}])assert.equal(normalizeAccountUsage(response).available,false);
});
test('读取额度仅调用只读账户接口，失败不回传原始鉴权错误',async()=>{
  const calls=[],service={codexHome:'/synthetic',creation:{run:async(cwd,action)=>{assert.equal(cwd,'/synthetic');return action((method,params)=>{calls.push({method,params});return method==='account/read'?{account:{type:'chatgpt',email:'synthetic@example.com',accessToken:'synthetic-private-value'}}:{rateLimits:{primary:{usedPercent:25,windowDurationMins:300}}};});}}};
  assert.deepEqual(await readAccountUsage(service),{available:true,windows:[{label:'5 小时',remainingPercent:75}],accountLabel:'synthetic@example.com'});assert.deepEqual(calls,[{method:'account/rateLimits/read',params:{}},{method:'account/read',params:{refreshToken:false}}]);
  service.creation.run=()=>{throw Error('私有诊断');};assert.deepEqual(await readAccountUsage(service),{available:false,windows:[],accountLabel:''});
});

test('账号只白名单提取登录邮箱，其他账号字段与控制内容不得进入手机',()=>{
  assert.equal(normalizeAccountLabel({account:{type:'chatgpt',email:' synthetic@example.com ',accountId:'private-id',token:'private-token'}}),'synthetic@example.com');
  assert.equal(normalizeAccountLabel({account:{type:'apiKey',email:'synthetic@example.com',apiKey:'private-key'}}),'API Key 登录');
  assert.equal(normalizeAccountLabel({account:null}),'未登录');
  for(const response of [null,{}, {account:{type:'unknown',email:'synthetic@example.com'}}, ...['', 'invalid', 'a\nb@example.com', '<a>@example.com', 'x'.repeat(255)+'@example.com'].map(email=>({account:{type:'chatgpt',email}}))])assert.equal(normalizeAccountLabel(response),'');
});

test('账号与额度分别失败时保留成功项，不透传原始错误',async()=>{
  const service=handler=>({codexHome:'/synthetic',creation:{run:async(_cwd,action)=>action(async method=>handler(method))}});
  const accountOnly=await readAccountUsage(service(method=>{if(method==='account/rateLimits/read')throw Error('私有错误');return {account:{type:'chatgpt',email:'synthetic@example.com'}};}));
  assert.deepEqual(accountOnly,{available:false,windows:[],accountLabel:'synthetic@example.com'});
  const usageOnly=await readAccountUsage(service(method=>{if(method==='account/read')throw Error('私有错误');return {rateLimits:{primary:{usedPercent:25,windowDurationMins:300}}};}));
  assert.deepEqual(usageOnly,{available:true,windows:[{label:'5 小时',remainingPercent:75}],accountLabel:''});
});
