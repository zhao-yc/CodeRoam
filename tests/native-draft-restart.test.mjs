import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{randomUUID}from'node:crypto';
import{NativeDraftService}from'../apps/bridge/native-draft-service.mjs';import{Journal}from'../apps/bridge/journal.mjs';import{BridgeError}from'../packages/protocol/contracts.mjs';

/** 只读回已保存项目，用真实自有账本模拟进程重启；控制器不得执行任何桌面动作。 */
function setup(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-open-restart-')),file=path.join(root,'journal.sqlite');
  const service=new NativeDraftService({controller:{close(){},open(){assert.fail('查账不能打开桌面');},read(){assert.fail('缺少原绑定不能读取其他草稿');},send(){assert.fail('查账不能发送');}},projects:{projects:()=>({projects:[{id:'project-a',cwd:path.join(root,'project-a')}]})}});
  let journal=new Journal(file);t.after(async()=>{journal.close();await service.close();fs.rmSync(root,{recursive:true,force:true});});
  return {service,get journal(){return journal;},restart(){journal.close();journal=new Journal(file);}};
}

test('跨进程重启后核验旧 open 指纹并关闭失效连接，保留检查点且原编号不能重放', async t=>{
  const f=setup(t),id=randomUUID(),params={projectId:'project-a'};
  await assert.rejects(f.journal.execute('phone-a',id,'thread.draft.open',params,async()=>{throw new BridgeError('OUTCOME_UNKNOWN','新建回执中断',true);}),{code:'OUTCOME_UNKNOWN'});
  f.restart();const status=await f.service.commandStatus(f.journal,'phone-a',id);
  assert.equal(status.state,'done');assert.equal(status.error.code,'DRAFT_OPEN_EXPIRED');assert.equal(status.error.outcomeUnknown,false);assert.equal(status.result,undefined);
  assert.equal(status.resolution.source,'expired-native-draft-open');assert.equal(status.resolution.previousError.code,'OUTCOME_UNKNOWN');
  await assert.rejects(f.journal.execute('phone-a',id,'thread.draft.open',params,()=>assert.fail('不能重放原新建')),{code:'DRAFT_OPEN_EXPIRED'});
  assert.deepEqual(await f.service.commandStatus(f.journal,'phone-a',id),status);
});

test('跨重启核对不能解除其他设备、更新、发送、已移除项目或进行中的保护', async t=>{
  const f=setup(t),rows=[['thread.draft.send',{draftId:randomUUID(),text:'合成消息'}],['thread.draft.update',{draftId:randomUUID(),changes:{effort:'high'}}],['thread.draft.open',{projectId:'removed-project'}]];
  for(const[method,params]of rows){const id=randomUUID();await assert.rejects(f.journal.execute('phone-a',id,method,params,async()=>{throw new BridgeError('OUTCOME_UNKNOWN','合成中断',true);}));f.restart();assert.equal((await f.service.commandStatus(f.journal,'phone-a',id)).state,'unknown');assert.equal((await f.service.commandStatus(f.journal,'phone-b',id)).state,'not_found');}
  const id=randomUUID();let finish;const gate=new Promise(resolve=>{finish=resolve;});const operation=f.journal.execute('phone-a',id,'thread.draft.open',{projectId:'project-a'},async()=>{await gate;return{done:true};});
  assert.equal((await f.service.commandStatus(f.journal,'phone-a',id)).state,'pending');finish();await operation;
});

test('旧新建已有检查点时保留原回执，不把正式会话状态伪造为手机已发送', async t=>{
  const f=setup(t),id=randomUUID(),params={projectId:'project-a'},checkpoint={draftId:randomUUID(),snapshot:{status:'ready',projectId:'project-a'}};
  await assert.rejects(f.journal.execute('phone-a',id,'thread.draft.open',params,async()=>{f.journal.checkpoint('phone-a',id,checkpoint);throw new BridgeError('OUTCOME_UNKNOWN','检查点后断线',true);}));
  f.restart();const status=await f.service.commandStatus(f.journal,'phone-a',id);assert.equal(status.error.code,'DRAFT_OPEN_EXPIRED');assert.deepEqual(status.result,checkpoint);assert.equal(status.result.threadId,undefined);
});
