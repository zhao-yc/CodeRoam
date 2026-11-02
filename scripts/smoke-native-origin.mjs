import fs from 'node:fs';
import {WebSocket} from 'ws';

/** 使用 Android SDK 默认来源与网页来源对照真实公网握手，不执行任何会话写操作。 */
const config=JSON.parse(fs.readFileSync('.local/mobile.json','utf8'));
const results=[];
try{
  for(const origin of ['http://localhost',new URL(config.relayUrl).origin.replace('wss:','https:').replace('ws:','http:')]){
    const response=await fetch(config.relayUrl.replace('wss:','https:').replace('ws:','http:').replace(/\/ws$/,'/session'),{method:'POST',headers:{Authorization:`Bearer ${config.token}`},signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`获取手机连接票据失败：HTTP ${response.status}`);
    const {ticket}=await response.json();
    const result=await new Promise((resolve,reject)=>{
      const socket=new WebSocket(config.relayUrl,['codex-mobile-v1',`ticket.${ticket}`],{headers:{Origin:origin},handshakeTimeout:8000});
      const timer=setTimeout(()=>{socket.terminate();reject(new Error('等待会话欢迎消息超时'));},10000);
      socket.on('unexpected-response',(_request,res)=>{clearTimeout(timer);res.resume();socket.terminate();resolve({origin,status:res.statusCode,welcome:false});});
      socket.on('message',data=>{if(JSON.parse(data).type==='welcome'){clearTimeout(timer);socket.close();resolve({origin,status:101,welcome:true});}});
      socket.on('error',error=>{clearTimeout(timer);reject(new Error(error.message.split(ticket).join('[已隐藏]').split(config.token).join('[已隐藏]')));});
    });results.push(result);
    if(!result.welcome)throw new Error(`来源 ${origin} 握手未通过：HTTP ${result.status}`);
  }
  fs.mkdirSync('.cache/acceptance',{recursive:true});fs.writeFileSync('.cache/acceptance/native-origin-latest.json',JSON.stringify({createdAt:new Date().toISOString(),results},null,2));
  console.log(JSON.stringify({status:'原生及网页来源握手通过',results}));
}catch(error){console.error(`原生连接诊断未通过：${error.message}`);process.exitCode=1;}
