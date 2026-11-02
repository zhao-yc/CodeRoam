import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAccountUsage,readAccountUsage} from '../apps/bridge/account-usage.mjs';

test('额度只来自真实百分比，优先 Codex 限额且不泄露账号或额外字段',()=>{
  const result=normalizeAccountUsage({rateLimits:{primary:{usedPercent:10,windowDurationMins:300}},rateLimitsByLimitId:{codex:{secondary:{usedPercent:52,windowDurationMins:10080},email:'synthetic@example.com'}}});
  assert.deepEqual(result,{available:true,windows:[{label:'本周',remainingPercent:48}]});
  for(const response of [null,{}, {rateLimits:{primary:{usedPercent:'10',windowDurationMins:300}}},{rateLimits:{primary:{usedPercent:120,windowDurationMins:300}}},{rateLimits:{primary:{usedPercent:20}}}])assert.equal(normalizeAccountUsage(response).available,false);
});
test('读取额度仅调用只读账户接口，失败不回传原始鉴权错误',async()=>{
  const calls=[],service={codexHome:'/synthetic',creation:{run:async(cwd,action)=>{assert.equal(cwd,'/synthetic');return action((method,params)=>{calls.push({method,params});return {rateLimits:{primary:{usedPercent:25,windowDurationMins:300}}};});}}};
  assert.deepEqual(await readAccountUsage(service),{available:true,windows:[{label:'5 小时',remainingPercent:75}]});assert.deepEqual(calls,[{method:'account/rateLimits/read',params:{}}]);
  service.creation.run=()=>{throw Error('私有诊断');};assert.deepEqual(await readAccountUsage(service),{available:false,windows:[]});
});
