import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PredictionConnections } from './prediction-connections.mjs';
import { predictionExpression } from './prediction-expression.mjs';
import { predictionTurnId } from './prediction-turn.mjs';
const execFileAsync=promisify(execFile);
const REFRESH_MS=15000,MAX_IDENTITY_AGE_MS=60000;
const identity=endpoint=>JSON.stringify([endpoint.port,endpoint.pid]);

/** 只扫描已开启且归属于官方桌面主进程的回环端口，不限制桌面版本。 */
export async function discoverPredictionPorts(){
  if(process.platform!=='win32')return [];
  // 后台身份枚举包含 PowerShell 启动及网络查询，慢机器上允许超过原来的八秒上限。
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./windows-prediction-ports.ps1',import.meta.url))],{windowsHide:true,timeout:12000,maxBuffer:32768});
  const ports=JSON.parse(stdout.replace(/^\uFEFF/,''));
  return Array.isArray(ports)?ports.filter(p=>Number.isInteger(p.port)&&p.port>0&&p.port<=65535).slice(0,4):[];
}

/** 保留一次性只读调用入口，常驻桥接使用下面的连接池。 */
export async function evaluatePrediction(url,expression){
  const connections=new PredictionConnections();
  try{return await connections.evaluate(url,expression,'single');}finally{connections.close();}
}

/** 后台复核身份，前台复用连接；预测正文每次重新读取，不缓存过期灰字。 */
export class ComposerPredictionReader {
  constructor({discover=discoverPredictionPorts,fetcher=fetch,evaluate,now=Date.now}={}){
    this.discover=discover;this.fetcher=fetcher;this.now=now;this.ports=[];this.discoveredAt=null;this.discovery=null;this.inflight=new Map();this.timer=null;this.closed=false;this.refreshNeeded=false;
    this.connections=evaluate?null:new PredictionConnections({onDisconnect:id=>{this.ports=this.ports.filter(port=>identity(port)!==id);this.refreshNeeded=true;}});
    this.evaluate=evaluate??((url,expression,id)=>this.connections.evaluate(url,expression,id));
  }
  /** 启动时预热，扫描与连接准备不阻塞桥接上线或会话打开。 */
  start(){
    if(this.closed)return Promise.resolve();
    if(!this.timer){this.timer=setInterval(()=>this.refresh().catch(()=>{}),REFRESH_MS);this.timer.unref?.();}
    return this.refresh();
  }
  refresh(){
    if(this.closed)return Promise.resolve([]);
    if(!this.discovery)this.discovery=(async()=>{
      this.refreshNeeded=false;
      const ports=await this.discover();
      if(this.closed)return [];
      this.ports=ports;this.discoveredAt=this.now();
      this.connections?.retain(new Set(ports.map(identity)));
      // 只预建连接，不提前读其他会话内容，也不调用预测生成。
      if(this.connections)await Promise.allSettled(ports.map(async port=>{
        for(const url of await this.targets(port)){
          if(!this.trusted(port))return;
          await this.connections.open(url,identity(port)).catch(()=>{});
        }
      }));
      return this.ports;
    })().finally(()=>{this.discovery=null;});
    return this.discovery;
  }
  trusted(port){return !this.closed&&this.discoveredAt!==null&&this.now()-this.discoveredAt<MAX_IDENTITY_AGE_MS&&this.ports.some(p=>identity(p)===identity(port));}
  async endpoints(){
    if(this.closed)return [];
    const age=this.discoveredAt===null?Infinity:this.now()-this.discoveredAt;
    if(this.refreshNeeded||age>=REFRESH_MS)this.refresh().catch(()=>{});
    // 正常后台复核期间继续使用原有身份；超过硬期限或连接断开必须重新核对。
    if(this.ports.length&&age<MAX_IDENTITY_AGE_MS)return this.ports;
    try{return await this.refresh();}catch{return [];}
  }
  /** 页面地址始终由已验证回环端口和固定目标编号构造，不信任返回的任意调试 URL。 */
  async targets({port}){
    const response=await this.fetcher(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000),redirect:'error'});
    if(!response.ok)return [];
    const body=await response.text();if(body.length>256*1024)return [];
    const targets=JSON.parse(body);if(!Array.isArray(targets))return [];
    return targets.filter(t=>t.type==='page'&&typeof t.url==='string'&&/^app:\/\/-\/index\.html(?:[?#]|$)/.test(t.url)&&typeof t.id==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(t.id)).slice(0,12).map(t=>`ws://127.0.0.1:${port}/devtools/page/${t.id}`);
  }
  async scan(hostId,threadId,turnId){
    const expression=predictionExpression(hostId,threadId,turnId),found=[];
    await Promise.allSettled((await this.endpoints()).map(async port=>{
      const urls=await this.targets(port);if(!this.trusted(port))return;
      const values=await Promise.allSettled(urls.map(url=>this.evaluate(url,expression,identity(port))));
      if(!this.trusted(port))return;
      for(const value of values)if(value.status==='fulfilled'&&Array.isArray(value.value))found.push(...value.value);
    }));
    if(found.length!==1)return null;
    const p=found[0];return p?.threadId===threadId&&p.sourceTurnId===turnId&&typeof p.text==='string'&&p.text.length>0&&p.text.length<=32000?{threadId,sourceTurnId:turnId,text:p.text}:null;
  }
  async read(adapter,threadId,deviceId){
    const entry=adapter.subscribed(threadId,deviceId),owner=entry.owner,hostId=owner.hostId,clientId=owner.clientId,turnId=predictionTurnId(entry.state);
    // 重复订阅会重新创建所有者对象，只有主机或桌面客户端实际变化才使本次读取失效。
    const current=()=>{const item=adapter.conversations.get(threadId);return !this.closed&&item===entry&&item.watchers.has(deviceId)&&item.owner?.hostId===hostId&&item.owner?.clientId===clientId&&predictionTurnId(item.state)===turnId&&!adapter.snapshot(item.state).activeTurnId&&!['active','running','inProgress'].includes(adapter.snapshot(item.state).status);};
    if(typeof turnId!=='string'||!turnId||!current())return {prediction:null};
    const key=JSON.stringify([hostId,clientId,threadId,turnId]);
    if(!this.inflight.has(key))this.inflight.set(key,this.scan(hostId,threadId,turnId).catch(()=>null).finally(()=>this.inflight.delete(key)));
    const prediction=await this.inflight.get(key);
    return {prediction:current()?prediction:null};
  }
  close(){this.closed=true;clearInterval(this.timer);this.connections?.close();this.ports=[];}
}
