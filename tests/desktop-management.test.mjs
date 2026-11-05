import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {startManagementServer, readManagementLogs} from '../apps/bridge/management-server.mjs';
import {connectManagement, readManagementConnection} from '../apps/bridge/management-client.mjs';
import {installManagementChild} from '../apps/bridge/management-child.mjs';
import {BridgeAgent} from '../apps/bridge/agent.mjs';
import {Journal} from '../apps/bridge/journal.mjs';

/** 每例只创建合成托管配置，所有路径和进程均属于本测试。 */
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-management-'));
  const worker={entry:path.join(root,'fixture.mjs'),bridgeConfig:path.join(root,'bridge.json'),projectRoot:root,runDirectory:path.join(root,'run'),statusFile:path.join(root,'status.json'),logDirectory:path.join(root,'logs')};
  fs.mkdirSync(worker.runDirectory);fs.mkdirSync(worker.logDirectory);
  fs.writeFileSync(worker.bridgeConfig,JSON.stringify({label:'合成电脑',relayUrl:'wss://relay.example.com',token:'synthetic-private-value',hostId:'synthetic-host'}));
  const workerConfigPath=path.join(root,'worker.json');fs.writeFileSync(workerConfigPath,JSON.stringify(worker));
  const after=[];
  t.after(async()=>{for(const hook of after.reverse())await hook();await new Promise(resolve=>setTimeout(resolve,100));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^codex-management-/);fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  return {root,worker,workerConfigPath,after};
}

test('真实本机管道仅返回配置投影，保存后保留敏感字段并产生独立修订',async t=>{
  const f=fixture(t);let restarts=0;
  const server=await startManagementServer({...f,status:async()=>({running:true,connected:true}),restart:async()=>{restarts++;return {accepted:true};}});f.after.push(()=>server.close());
  const client=connectManagement(f.workerConfigPath),before=await client.request('config.read');
  assert.equal(before.tokenConfigured,true);assert.equal(JSON.stringify(before).includes('synthetic-private-value'),false);
  const saved=await client.request('config.save',{expectedRevision:before.revision,values:{label:'新的合成电脑',newConversationSettingsCache:{ttlMs:60000}}});
  assert.notEqual(saved.revision,before.revision);assert.equal(saved.values.label,'新的合成电脑');
  assert.equal(JSON.parse(fs.readFileSync(f.worker.bridgeConfig)).token,'synthetic-private-value');
  assert.equal(restarts,0);assert.deepEqual(await client.request('service.restart'),{accepted:true});assert.equal(restarts,1);
  await assert.rejects(client.request('config.save',{expectedRevision:before.revision,values:{label:'旧版本覆盖'}}),{code:'MANAGEMENT_CONFIG_CHANGED'});
  await assert.rejects(client.request('config.save',{expectedRevision:saved.revision,values:{token:'new-secret'}}),{code:'MANAGEMENT_CONFIG_INVALID'});
});

test('伪造能力令牌、超限请求和未授权方法均不能执行服务动作',async t=>{
  const f=fixture(t);let actions=0;
  const server=await startManagementServer({...f,status:async()=>({}),restart:async()=>{actions++;return {};}});f.after.push(()=>server.close());
  const connection=readManagementConnection(f.workerConfigPath);
  const raw=body=>new Promise(resolve=>{let output='';const socket=net.createConnection(connection.address);socket.on('error',()=>{});socket.on('data',data=>output+=data);socket.once('connect',()=>socket.write(body));socket.once('close',()=>resolve(output));});
  assert.equal(await raw(JSON.stringify({version:1,id:randomUUID(),token:'0'.repeat(64),method:'service.restart',params:{}})+'\n'),'');
  assert.equal(await raw('x'.repeat(65537)),'');
  await assert.rejects(connectManagement(f.workerConfigPath).request('shell.exec',{}),{code:'MANAGEMENT_METHOD_INVALID'});
  const error=JSON.parse(await raw(JSON.stringify({version:1,id:randomUUID(),token:connection.token,method:'shell.exec',params:{}})+'\n'));
  assert.equal(error.error.code,'MANAGEMENT_METHOD_INVALID');assert.equal(actions,0);
});

test('托管文件换源后拒绝旧管道，另一服务端点不能串用',async t=>{
  const f=fixture(t),other=fixture(t);
  const server=await startManagementServer({...f,status:async()=>({}),restart:async()=>({})});f.after.push(()=>server.close());
  fs.copyFileSync(path.join(f.worker.runDirectory,'management.json'),path.join(other.worker.runDirectory,'management.json'));
  assert.throws(()=>readManagementConnection(other.workerConfigPath),/不一致/);
  fs.writeFileSync(f.workerConfigPath,JSON.stringify({...f.worker,entry:path.join(f.root,'other.mjs')}));
  await assert.rejects(connectManagement(f.workerConfigPath).request('status'),/不一致/);
});

test('日志只映射允许的生命周期字段，源日志中的令牌和会话正文不会返回',async t=>{
  const f=fixture(t),file=path.join(f.worker.logDirectory,'lifecycle.jsonl');
  fs.writeFileSync(file,[{time:new Date().toISOString(),event:'bridge_started',message:'synthetic-private-value',token:'synthetic-private-value'},{time:new Date().toISOString(),event:'bridge_exit',exitCode:42,body:'合成会话正文'},{time:new Date().toISOString(),event:'unknown',message:'合成会话正文'}].map(row=>JSON.stringify(row)).join('\n'));
  const result=readManagementLogs(file);assert.equal(result.entries.length,2);
  assert.equal(JSON.stringify(result).includes('synthetic-private-value'),false);assert.equal(JSON.stringify(result).includes('合成会话正文'),false);assert.match(result.entries[1].message,/42/);
  assert.throws(()=>readManagementLogs(file,1000),{code:'MANAGEMENT_REQUEST_INVALID'});
});

test('父子排空拒绝忙碌实例并恢复所有实例，正常关闭才退出子进程',async()=>{
  const channel=new EventEmitter();channel.connected=true;const responses=[];channel.send=(value,callback)=>{responses.push(value);callback?.();};
  let busy=true,closed=0,exited=0;const states=[false,false],agents=states.map((_,index)=>({setManagementDraining:value=>states[index]=value,managementIdle:()=>index!==1||!busy}));
  const remove=installManagementChild({agents:()=>agents,drain:()=>{},status:()=>({pid:123,connected:true}),close:async()=>{closed++;},channel,exit:()=>{exited++;}});
  const request=async action=>{const requestId=randomUUID();channel.emit('message',{type:'codex-mobile-management',action,requestId});await new Promise(resolve=>setImmediate(resolve));return responses.find(row=>row.requestId===requestId);};
  assert.equal((await request('prepare-restart')).error.code,'MANAGEMENT_BUSY');assert.deepEqual(states,[false,false]);assert.equal(closed,0);
  busy=false;assert.equal((await request('prepare-restart')).result.ready,true);assert.deepEqual(states,[true,true]);
  await request('cancel-restart');assert.deepEqual(states,[false,false]);
  await request('prepare-restart');assert.equal((await request('shutdown')).result.closed,true);assert.equal(closed,1);assert.equal(exited,1);remove();
});

test('排空期间拒绝手机写入和任务提交，原账本及队列保持不变',async()=>{
  const adapter=new EventEmitter();adapter.close=()=>{};const journal=new Journal();
  const agent=new BridgeAgent({config:{},adapter,journal});agent.setManagementDraining(true);
  try{
    for(const [method,params]of [['turn.send',{threadId:'thread-a',text:'合成消息'}],['tasks.submit',{taskId:'synthetic-task-0001',kind:'command',payload:{method:'turn.stop',params:{threadId:'thread-a'}}}]]){
      const result=await agent.handleRequest({v:1,type:'request',requestId:randomUUID(),deviceId:'synthetic-phone',method,params});
      assert.equal(result.error.code,'SERVICE_RESTARTING');
    }
    assert.equal(journal.db.prepare('SELECT count(*) AS n FROM commands').get().n,0);
    assert.equal(journal.db.prepare('SELECT count(*) AS n FROM submission_tasks').get().n,0);
    assert.equal(agent.managementIdle(),true);
  }finally{await agent.close();}
});

test('关闭已开始后失败会明确退出交由守护恢复，不永久保留排空锁',async()=>{
  const channel=new EventEmitter();channel.connected=true;const responses=[],exits=[];channel.send=(value,callback)=>{responses.push(value);callback?.();};
  const agent={setManagementDraining(){},managementIdle:()=>true};
  const remove=installManagementChild({agents:()=>[agent],drain(){},status:()=>({}),close:async()=>{throw new Error('合成关闭失败');},channel,exit:code=>exits.push(code)});
  channel.emit('message',{type:'codex-mobile-management',requestId:randomUUID(),action:'prepare-restart'});
  const requestId=randomUUID();channel.emit('message',{type:'codex-mobile-management',requestId,action:'shutdown'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(responses.find(row=>row.requestId===requestId).error.code,'MANAGEMENT_RESTARTING');assert.deepEqual(exits,[1]);remove();
});

test('真实托管管理重启只关闭合成子进程，保存配置要等重启后才标为生效',async t=>{
  const f=fixture(t),helper=pathToFileURL(path.resolve('apps/bridge/management-child.mjs')).href;
  const setting=pathToFileURL(path.resolve('apps/bridge/background-sync-setting.mjs')).href;
  fs.writeFileSync(f.worker.entry,`
    import {installManagementChild} from ${JSON.stringify(helper)};
    import {applyBackgroundSyncSetting,readBackgroundSyncSetting} from ${JSON.stringify(setting)};
    const file='background-sync.json',agents=()=>[];
    const config={backgroundSyncEnabled:readBackgroundSyncSetting(file)};
    const timer=setInterval(()=>{},1000);
    installManagementChild({
      agents,drain:()=>{},
      status:()=>({pid:process.pid,connected:true,version:'synthetic',...config}),
      setBackgroundSync:enabled=>applyBackgroundSyncSetting(file,config,agents,enabled),
      close:async()=>clearInterval(timer),
    });
  `);
  const child=spawn(process.execPath,['apps/bridge/service-supervisor.mjs','--config',f.workerConfigPath],{windowsHide:true,stdio:'ignore'});
  f.after.push(async()=>{let pid;try{pid=JSON.parse(fs.readFileSync(path.join(f.worker.runDirectory,'bridge.json'))).pid;}catch{}child.kill();await new Promise(resolve=>{child.once('close',resolve);setTimeout(resolve,1000).unref();});if(pid)try{process.kill(pid);}catch{}});
  const client=connectManagement(f.workerConfigPath);
  const wait=async predicate=>{const until=Date.now()+15000;while(Date.now()<until){try{const value=await predicate();if(value)return value;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.fail('合成托管未在期限内达到目标状态');};
  const before=await wait(async()=>{const value=await client.request('status');return value.connected?value:null;});
  assert.equal(before.backgroundSyncEnabled,true);
  await assert.rejects(client.request('sync.set',{enabled:'false'}),{code:'MANAGEMENT_REQUEST_INVALID'});
  assert.deepEqual(await client.request('sync.set',{enabled:false}),{backgroundSyncEnabled:false});
  const paused=await client.request('status');
  assert.equal(paused.backgroundSyncEnabled,false);
  assert.equal(paused.pid,before.pid);
  assert.equal(paused.restartRequired,false);
  const config=await client.request('config.read');await client.request('config.save',{expectedRevision:config.revision,values:{label:'合成已保存'}});
  assert.equal((await client.request('status')).restartRequired,true);
  assert.equal((await client.request('service.restart')).accepted,true);
  const after=await wait(async()=>{const value=await client.request('status');return value.pid!==before.pid&&value.connected?value:null;});
  assert.equal(after.supervisorPid,before.supervisorPid);assert.equal(after.restartRequired,false);assert.equal(after.activeRevision,after.savedRevision);
  assert.equal(after.backgroundSyncEnabled,false);
  assert.deepEqual(await client.request('sync.set',{enabled:true}),{backgroundSyncEnabled:true});
  assert.equal((await client.request('status')).pid,after.pid);
});
