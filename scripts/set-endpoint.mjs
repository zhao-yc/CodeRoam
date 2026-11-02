import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';

/** 更换中转地址时保留原配对令牌，先备份配套配置再覆盖本地文件。 */
const {values}=parseArgs({options:{'relay-url':{type:'string'},'backup-root':{type:'string',default:process.env.CODEX_MOBILE_BACKUP_ROOT}}});
const url=new URL(values['relay-url']);
  if(!values['backup-root'])throw new Error('请通过 --backup-root 或 CODEX_MOBILE_BACKUP_ROOT 指定项目私有备份目录');
if(url.protocol!=='wss:'||url.pathname!=='/ws'||url.username||url.password||url.search||url.hash)throw new Error('公网连接必须是无凭据的 WSS /ws 地址');
const files=['bridge.json','mobile.json','relay.json'];
const configs=Object.fromEntries(files.map(name=>[name,JSON.parse(fs.readFileSync(path.join('.local',name),'utf8'))]));
configs['bridge.json'].relayUrl=url.href;configs['mobile.json'].relayUrl=url.href;
configs['relay.json'].allowedOrigins=[...new Set([...configs['relay.json'].allowedOrigins,url.origin.replace('wss:','https:')])];
const backup=path.resolve(values['backup-root'],new Date().toISOString().replace(/[:.]/g,'-'));
fs.mkdirSync(backup,{recursive:true});
for(const name of files)fs.writeFileSync(path.join(backup,name),JSON.stringify(configs[name],null,2),{flag:'wx',mode:0o600});
fs.writeFileSync(path.join(backup,'备份说明.md'),`# 公网中转配对备份\n\n更新时间：${new Date().toISOString()}。\n\n中转：${url.href}。保留首次生成的电脑、手机令牌，没有重新配对。mobile.json 导入手机，bridge.json 留在电脑；relay.json 仅含鉴权哈希。它们必须配套保管且不能提交 Git。\n\n服务器与站点目录由使用者自行配置，TLS 证书由自己的网关管理。撤销访问：删除 relay.json 对应身份并重新部署；令牌轮换后须重新备份、重新导入。\n`,{flag:'wx'});
for(const name of files)fs.writeFileSync(path.join('.local',name),JSON.stringify(configs[name],null,2),{mode:0o600});
fs.writeFileSync('.local/backup-record.json',JSON.stringify({backup,createdAt:new Date().toISOString()},null,2));
console.log(JSON.stringify({status:'公网地址已更新，原配对凭据已备份',relayUrl:url.href,backup}));
