import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { acquireBridgeLock } from './runtime-lock.mjs';
import { StateReader } from './state-reader.mjs';
import { DesktopAdapter } from './desktop-adapter.mjs';
import { Journal } from './journal.mjs';
import { ModelCatalog } from './model-settings.mjs';
import { AttachmentStore } from './attachment-store.mjs';
import { DesktopGoalController } from './desktop-goals.mjs';
import { BridgeAgent } from './agent.mjs';
import { IpcClient, defaultIpcSocketPath } from '../../packages/protocol/ipc-client.mjs';

const {values}=parseArgs({options:{config:{type:'string',default:'.local/bridge.json'}}});
let releaseBridgeLock=()=>{};
try {
  // 先取得进程级排他，再打开操作账本；避免第二个启动入口扰动正在提交的请求。
  releaseBridgeLock=await acquireBridgeLock(values.config);
  const config=JSON.parse(fs.readFileSync(values.config,'utf8'));
  const dataPath=path.resolve(config.dataPath??'.local/bridge');fs.mkdirSync(dataPath,{recursive:true});
  const client=new IpcClient({socketPath:config.ipcSocketPath??defaultIpcSocketPath({codexHome:config.codexHome})});
  const adapter=new DesktopAdapter({client,index:new StateReader(config.codexHome),modelCatalog:new ModelCatalog({codexHome:config.codexHome}),attachments:new AttachmentStore({root:path.join(dataPath,'attachments')}),goalController:new DesktopGoalController({diagnosticPath:path.join(dataPath,'goal-ui-diagnostics.jsonl')})});
  const agent=new BridgeAgent({config,adapter,journal:new Journal(path.join(dataPath,'journal.sqlite'))});
  const writeStatus=connected=>fs.writeFileSync(path.join(dataPath,'runtime-status.json'),JSON.stringify({pid:process.pid,connected,updatedAt:Date.now()}));
  agent.on('connected',()=>{writeStatus(true);console.log('电脑已连接中转服务');});
  agent.on('disconnected',()=>{writeStatus(false);console.log('中转连接已断开');});
  agent.on('warning',warning=>console.log(`${warning.code}：${warning.message}`));
  adapter.connect().catch(()=>console.log('等待 Codex 桌面客户端启动'));
  agent.predictions.start().catch(()=>{});
  agent.start();
  let closing=false;const close=async()=>{if(closing)return;closing=true;try{agent.predictions.close();await agent.close();}finally{releaseBridgeLock();}};
  process.on('SIGINT',close);process.on('SIGTERM',close);
}catch(error){releaseBridgeLock();console.error(`电脑连接服务启动失败：${error.message}`);process.exitCode=1;}
