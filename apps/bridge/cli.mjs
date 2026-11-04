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
import { DesktopDeleteController } from './desktop-delete.mjs';
import { BridgeAgent } from './agent.mjs';
import { IpcClient, defaultIpcSocketPath } from '../../packages/protocol/ipc-client.mjs';
import { InstanceHub } from './instance-hub.mjs';
import { WindowsIpcHost } from './windows-ipc-host.mjs';
import { createRequestDiagnostics } from '../../packages/protocol/request-diagnostics.mjs';

const {values}=parseArgs({options:{config:{type:'string',default:'.local/bridge.json'}}});
let releaseBridgeLock=()=>{};
try {
  // 先取得进程级排他，再打开操作账本；避免第二个启动入口扰动正在提交的请求。
  releaseBridgeLock=await acquireBridgeLock(values.config);
  const config=JSON.parse(fs.readFileSync(values.config,'utf8'));
  const diagnostics=createRequestDiagnostics({component:'bridge'});
  const dataPath=path.resolve(config.dataPath??'.local/bridge');fs.mkdirSync(dataPath,{recursive:true});
  if(['win32','darwin'].includes(process.platform) && config.multiInstance!==false) {
    const defaultSocket=defaultIpcSocketPath();
    const ipcHost=process.platform==='win32'&&(config.ipcSocketPath??defaultSocket)===defaultSocket
      ? new WindowsIpcHost({onState:state=>console.log(state==='ready'?'本机多实例管道已就绪':'等待现有桌面释放本机管道')}) : null;
    const hub=new InstanceHub({config,dataPath,diagnostics,ipcHost});
    // 私有运行状态只记录模式计数，方便核验降频，不包含电脑或会话编号。
    const status=connected=>{const maintenance={online:0,grace:0,light:0,legacy:0};for(const runtime of hub.runtimes.values()){const mode=runtime.agent.clientPresence?.mode;if(Object.hasOwn(maintenance,mode))maintenance[mode]++;}fs.writeFileSync(path.join(dataPath,'runtime-status.json'),JSON.stringify({pid:process.pid,connected,updatedAt:Date.now(),maintenance}));};
    hub.on('maintenance',()=>status(hub.socket?.readyState===1&&hub.supported));
    hub.on('connected',()=>{status(true);console.log('电脑多实例连接已就绪');});
    hub.on('disconnected',detail=>{status(false);console.log(`中转连接已断开（代码 ${detail.code}）`);});
    hub.on('warning',warning=>console.log(`${warning.code}：${warning.message}`));
    let closing=false;const close=async()=>{if(closing)return;closing=true;try{await hub.close();}finally{releaseBridgeLock();}};
    process.on('SIGINT',close);process.on('SIGTERM',close);hub.start();
  } else {
  const client=new IpcClient({socketPath:config.ipcSocketPath??defaultIpcSocketPath({codexHome:config.codexHome})});
  const adapter=new DesktopAdapter({client,index:new StateReader(config.codexHome),modelCatalog:new ModelCatalog({codexHome:config.codexHome}),attachments:new AttachmentStore({root:path.join(dataPath,'attachments')}),goalController:new DesktopGoalController({diagnosticPath:path.join(dataPath,'goal-ui-diagnostics.jsonl')})});
  const agent=new BridgeAgent({config,adapter,journal:new Journal(path.join(dataPath,'journal.sqlite')),deleteController:new DesktopDeleteController({diagnosticPath:path.join(dataPath,'delete-ui-diagnostics.jsonl')}),diagnostics});
  const writeStatus=connected=>fs.writeFileSync(path.join(dataPath,'runtime-status.json'),JSON.stringify({pid:process.pid,connected,updatedAt:Date.now(),maintenance:agent.clientPresence.mode}));
  agent.on('maintenance',()=>writeStatus(agent.socket?.readyState===1));
  agent.on('connected',()=>{writeStatus(true);diagnostics.record('connection.open',null,{role:'host'});console.log('电脑已连接中转服务');});
  agent.on('disconnected',()=>{writeStatus(false);diagnostics.record('connection.close',null,{role:'host'});console.log('中转连接已断开');});
  agent.on('warning',warning=>{diagnostics.record('connection.warning',null,{errorCode:warning.code});console.log(`${warning.code}：${warning.message}`);});
  adapter.connect().catch(()=>console.log('等待 Codex 桌面客户端启动'));
  agent.predictions.start().catch(()=>{});
  agent.start();
  let closing=false;const close=async()=>{if(closing)return;closing=true;try{agent.predictions.close();await agent.close();}finally{releaseBridgeLock();}};
  process.on('SIGINT',close);process.on('SIGTERM',close);
  }
}catch(error){releaseBridgeLock();console.error(`电脑连接服务启动失败：${error.message}`);process.exitCode=1;}
