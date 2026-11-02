import fs from 'node:fs';
import {spawnSync} from 'node:child_process';

/** 仅输出文件名和结论；用本项目私有配置检测明文凭据是否意外进入暂存区。 */
const secrets=[];
for(const file of ['.local/bridge.json','.local/mobile.json','.local/android/pack.json']){
  if(!fs.existsSync(file))continue;
  const config=JSON.parse(fs.readFileSync(file,'utf8'));secrets.push(config.token,config.android?.certpassword,config.android?.storepassword);
}
const known=secrets.filter(value=>typeof value==='string'&&value.length>=16);
const listed=spawnSync('git',['diff','--cached','--name-only','-z','--diff-filter=ACMR'],{encoding:'utf8'});
if(listed.status!==0)throw new Error('无法读取暂存区');
const files=listed.stdout.split('\0').filter(Boolean);
for(const file of files){
  if(/(^|\/)(\.local|\.cache|node_modules|unpackage)\//.test(file)||/\.(p12|key|pem|jks|keystore|sqlite|apk)$/i.test(file))throw new Error(`暂存区出现私有文件或构建产物：${file}`);
  const content=spawnSync('git',['show',`:${file}`],{encoding:'utf8',maxBuffer:10*1024*1024});
  if(content.status!==0)throw new Error(`无法检查文件：${file}`);
  if(known.some(secret=>content.stdout.includes(secret))||/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(content.stdout))throw new Error(`暂存区疑似包含明文凭据：${file}`);
}
console.log(JSON.stringify({status:'暂存区检查通过',files:files.length,knownCredentialTypes:known.length}));
