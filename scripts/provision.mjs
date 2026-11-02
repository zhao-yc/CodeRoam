import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { tokenHash } from '../packages/protocol/contracts.mjs';

/** 首次生成独立设备凭据，完成用户指定的备份后才写入本地配置。 */
const {values}=parseArgs({options:{'relay-url':{type:'string'},'host-id':{type:'string',default:'windows-main'},label:{type:'string'},'backup-root':{type:'string',default:process.env.CODEX_MOBILE_BACKUP_ROOT}}});
try {
  if(!values['backup-root'])throw new Error('请通过 --backup-root 或 CODEX_MOBILE_BACKUP_ROOT 指定项目私有备份目录');
  if(!values['relay-url'])throw new Error('请使用 --relay-url 指定中转地址');
  const url=new URL(values['relay-url']);
  if(url.pathname!=='/ws'||url.search||url.hash||url.username||url.password)throw new Error('中转地址必须以 /ws 结尾且不能携带凭据');
  if(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&['127.0.0.1','localhost'].includes(url.hostname)))throw new Error('跨网络配置必须使用 WSS');
  if(fs.existsSync('.local/bridge.json'))throw new Error('凭据已存在，已停止生成以避免意外更换手机配对');
  const hostToken=randomBytes(32).toString('base64url'),mobileToken=randomBytes(32).toString('base64url');
  // 未指定别名时不固化名称，由电脑连接服务在每次连接时读取系统电脑名。
  const bridge={relayUrl:url.href,token:hostToken,hostId:values['host-id'],label:values.label,dataPath:'.local/bridge'};
  const mobile={relayUrl:url.href,token:mobileToken,hostId:values['host-id']};
  const relay={identities:[{id:values['host-id'],role:'host',hostId:values['host-id'],tokenSha256:tokenHash(hostToken)},{id:'my-phone',role:'mobile',hostIds:[values['host-id']],tokenSha256:tokenHash(mobileToken)}],allowedOrigins:['http://localhost:5173','http://127.0.0.1:5173','http://localhost:18789','http://127.0.0.1:18789']};
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');const backup=path.resolve(values['backup-root'],stamp);fs.mkdirSync(backup,{recursive:true});
  const configs={'bridge.json':bridge,'mobile.json':mobile,'relay.json':relay};
  for(const[name,value]of Object.entries(configs))fs.writeFileSync(path.join(backup,name),JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
  fs.writeFileSync(path.join(backup,'备份说明.md'),`# Codex 自建客户端连接凭据\n\n生成时间：${new Date().toISOString()}。\n\nbridge.json 是电脑连接配置，mobile.json 是手机导入配置，relay.json 仅包含鉴权哈希并部署在自有中转服务。三者配套使用，不能提交 Git。恢复时先核对中转地址与主机编号。撤销手机访问请删除 relay.json 中对应的手机身份并重启中转；重新配对时必须同步替换三份配置。当前若使用 localhost 地址，表示通过 SSH 隧道联调，不能当作手机公网入口。\n`,{mode:0o600,flag:'wx'});
  fs.mkdirSync('.local',{recursive:true});for(const[name,value]of Object.entries(configs))fs.writeFileSync(path.join('.local',name),JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
  fs.writeFileSync('.local/backup-record.json',JSON.stringify({backup,createdAt:new Date().toISOString()},null,2));
  console.log(JSON.stringify({status:'配置与备份已完成',backup,configDirectory:path.resolve('.local'),relayUrl:url.href}));
}catch(error){console.error(error.message);process.exitCode=1;}
