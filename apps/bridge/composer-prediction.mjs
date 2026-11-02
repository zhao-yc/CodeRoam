import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { predictionExpression } from './prediction-expression.mjs';
import { predictionTurnId } from './prediction-turn.mjs';
const execFileAsync=promisify(execFile);

/** 只扫描已开启且归属于已验证桌面版本的回环端口。 */
export async function discoverPredictionPorts(){
  if(process.platform!=='win32')return [];
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./windows-prediction-ports.ps1',import.meta.url))],{windowsHide:true,timeout:8000,maxBuffer:32768});
  const ports=JSON.parse(stdout.replace(/^\uFEFF/,''));
  return Array.isArray(ports)?ports.filter(p=>Number.isInteger(p.port)&&p.port>0&&p.port<=65535).slice(0,4):[];
}

/** CDP 只执行固定只读表达式；关闭压缩并限制消息大小、连接和执行时间。 */
export function evaluatePrediction(url,expression){
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(url,{handshakeTimeout:2000,maxPayload:256*1024,perMessageDeflate:false});
    const finish=(error,value)=>{clearTimeout(timer);socket.removeAllListeners();socket.on('error',()=>{});socket.terminate();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(new Error('预测读取超时')),3000);
    socket.on('error',()=>finish(new Error('预测连接不可用')));
    socket.on('close',()=>finish(new Error('预测连接已关闭')));
    socket.on('open',()=>socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,throwOnSideEffect:true,timeout:1500}})));
    socket.on('message',data=>{try{const m=JSON.parse(data.toString());if(m.id!==1)return;if(m.error||m.result?.exceptionDetails)return finish(new Error('桌面预测结构暂不兼容'));finish(null,m.result?.result?.value);}catch{finish(new Error('预测响应格式无效'));}});
  });
}

/** 实时订阅和轮次须在读取前后都有效；任何不确定、无建议或不兼容状态均返回空。 */
export class ComposerPredictionReader {
  constructor({discover=discoverPredictionPorts,fetcher=fetch,evaluate=evaluatePrediction,now=Date.now}={}){this.discover=discover;this.fetcher=fetcher;this.evaluate=evaluate;this.now=now;this.ports=[];this.discoveredAt=0;this.discovery=null;this.inflight=new Map();}
  async endpoints(){
    if(this.now()-this.discoveredAt<15000)return this.ports;
    if(!this.discovery)this.discovery=this.discover().then(ports=>{this.ports=ports;this.discoveredAt=this.now();return ports;}).finally(()=>{this.discovery=null;});
    return this.discovery;
  }
  async scan(hostId,threadId,turnId){
    const expression=predictionExpression(hostId,threadId,turnId),found=[];
    for(const {port} of await this.endpoints()){
      try {
        const response=await this.fetcher(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000),redirect:'error'});
        if(!response.ok)continue;
        const body=await response.text();if(body.length>256*1024)continue;
        const targets=JSON.parse(body);if(!Array.isArray(targets))continue;
        const pages=targets.filter(t=>t.type==='page'&&typeof t.url==='string'&&/^app:\/\/-\/index\.html(?:[?#]|$)/.test(t.url)&&typeof t.id==='string'&&/^[a-zA-Z0-9-]{1,100}$/.test(t.id)).slice(0,12);
        const values=await Promise.allSettled(pages.map(t=>this.evaluate(`ws://127.0.0.1:${port}/devtools/page/${t.id}`,expression)));
        for(const value of values)if(value.status==='fulfilled'&&Array.isArray(value.value))found.push(...value.value);
      }catch{this.discoveredAt=0;}
    }
    if(found.length!==1)return null;
    const p=found[0];return p?.threadId===threadId&&p.sourceTurnId===turnId&&typeof p.text==='string'&&p.text.length>0&&p.text.length<=32000?{threadId,sourceTurnId:turnId,text:p.text}:null;
  }
  async read(adapter,threadId,deviceId){
    const entry=adapter.subscribed(threadId,deviceId),owner=entry.owner,turnId=predictionTurnId(entry.state);
    const current=()=>{const item=adapter.conversations.get(threadId);return item===entry&&item.watchers.has(deviceId)&&item.owner===owner&&predictionTurnId(item.state)===turnId&&!adapter.snapshot(item.state).activeTurnId&&!['active','running','inProgress'].includes(adapter.snapshot(item.state).status);};
    if(typeof turnId!=='string'||!turnId||!current())return {prediction:null};
    const key=JSON.stringify([owner.hostId,threadId,turnId]);
    if(!this.inflight.has(key))this.inflight.set(key,this.scan(owner.hostId,threadId,turnId).catch(()=>null).finally(()=>this.inflight.delete(key)));
    const prediction=await this.inflight.get(key);
    return {prediction:current()?prediction:null};
  }
}
