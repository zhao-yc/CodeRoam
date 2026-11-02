import {WebSocket} from 'ws';

/** 复用只读调试连接；每条连接绑定已核对的进程与页面，断开后由发现流程重新授权。 */
export class PredictionConnections {
  constructor({onDisconnect=()=>{}}={}){this.onDisconnect=onDisconnect;this.connections=new Map();this.closed=false;}
  open(url,identity){
    if(this.closed)return Promise.reject(new Error('预测连接已停止'));
    const cached=this.connections.get(url);
    if(cached?.identity===identity)return cached.ready;
    if(cached)this.remove(cached,false);
    const socket=new WebSocket(url,{handshakeTimeout:2000,maxPayload:256*1024,perMessageDeflate:false});
    const entry={url,identity,socket,pending:new Map(),nextId:1,closed:false,ready:null};
    entry.ready=new Promise((resolve,reject)=>{
      entry.rejectReady=reject;
      entry.connectTimer=setTimeout(()=>this.remove(entry,true),2500);
      socket.once('open',()=>{clearTimeout(entry.connectTimer);resolve(entry);});
    });
    this.connections.set(url,entry);
    socket.on('error',()=>this.remove(entry,true));
    socket.on('close',()=>this.remove(entry,true));
    socket.on('message',data=>{
      let message;try{message=JSON.parse(data.toString());}catch{this.remove(entry,true);return;}
      const request=entry.pending.get(message.id);if(!request)return;
      entry.pending.delete(message.id);clearTimeout(request.timer);
      if(message.error||message.result?.exceptionDetails)request.reject(new Error('桌面预测结构暂不兼容'));
      else request.resolve(message.result?.result?.value);
    });
    return entry.ready;
  }
  /** 仅发送固定只读表达式，保留副作用检查和执行上限；迟到响应不能匹配后续请求。 */
  async evaluate(url,expression,identity){
    const entry=await this.open(url,identity);
    if(entry.closed||entry.pending.size>=8)throw new Error('预测读取暂忙');
    return new Promise((resolve,reject)=>{
      const id=entry.nextId++;
      const timer=setTimeout(()=>this.remove(entry,true),3000);
      entry.pending.set(id,{resolve,reject,timer});
      try{entry.socket.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,throwOnSideEffect:true,timeout:1500}}));}
      catch{this.remove(entry,true);}
    });
  }
  /** 故障连接不能使用旧端口自动重连；先通知读取器撤销该进程的缓存身份。 */
  remove(entry,notify){
    if(entry.closed)return;entry.closed=true;
    clearTimeout(entry.connectTimer);
    if(this.connections.get(entry.url)===entry)this.connections.delete(entry.url);
    entry.rejectReady(new Error('预测连接不可用'));
    for(const request of entry.pending.values()){clearTimeout(request.timer);request.reject(new Error('预测连接已关闭'));}
    entry.pending.clear();entry.socket.terminate();
    if(notify)this.onDisconnect(entry.identity);
  }
  retain(identities){for(const entry of this.connections.values())if(!identities.has(entry.identity))this.remove(entry,false);}
  close(){this.closed=true;for(const entry of this.connections.values())this.remove(entry,false);}
}
