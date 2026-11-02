import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const ZERO='0'.repeat(40);
const PUBLIC_ROOT='f8057742828a5f0adb76e197ab38d273658c014b';

/** Git 失败时中止检查；不转发可能包含凭据的错误正文。 */
function git(directory,args,input,encoding='utf8') {
  const result=spawnSync('git',args,{cwd:directory,input,encoding,maxBuffer:256*1024*1024,windowsHide:true});
  if(result.status!==0)throw new Error('无法完成 Git 隐私检查，请先核对仓库状态');
  return result.stdout;
}

/** 本机策略仅放在忽略目录，公开源码不保存内部服务名称或明文凭据。 */
function localPolicy(directory) {
  const file=path.join(directory,'.local/privacy-policy.json');
  const policy=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const known=[];
  function collect(value,key='') {
    if(typeof value==='string'&&/(token|password|secret)/i.test(key)&&value.length>=16)known.push(value);
    else if(value&&typeof value==='object')for(const[k,v]of Object.entries(value))collect(v,k);
  }
  for(const file of ['bridge.json','mobile.json','relay.json','android/pack.json']){
    const target=path.join(directory,'.local',file);
    if(fs.existsSync(target))collect(JSON.parse(fs.readFileSync(target,'utf8')));
  }
  return {...policy,known};
}

/** 只报告分类和文件名，不把命中正文、邮件地址或密钥写入日志。 */
function inspect(file,body,policy) {
  const reasons=[];
  const text=body.toString('utf8');
  if(/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text))reasons.push('私钥标记');
  if(/\b(?:github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/.test(text))reasons.push('常见访问令牌格式');
  if(policy.known.some(secret=>body.includes(Buffer.from(secret))))reasons.push('本地已知凭据');
  const fingerprints=new Set(policy.secretFingerprints??[]);
  if(fingerprints.size&&(text.match(/[A-Za-z0-9_+/=-]{16,}/g)??[]).some(value=>fingerprints.has(createHash('sha256').update(value).digest('hex'))))reasons.push('已登记凭据指纹');
  if((policy.blockedPatterns??[]).some(pattern=>new RegExp(pattern,'i').test(text)))reasons.push('本机登记的内部或个人信息');
  if(/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/.test(text))reasons.push('内网地址');
  if(/\b[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b|example\b|test\b|<)[\w.-]+|\/(?:Users|home)\/(?!example\b|test\b|<)[\w.-]+/i.test(text))reasons.push('个人主目录路径');
  const emails=text.match(/[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}/gi)??[];
  if(emails.some(email=>!/(?:@|\.)users\.noreply\.github\.com$|@(?:[\w-]+\.)?example\.(?:com|org|net)$|\.(?:invalid|test)$/i.test(email)))reasons.push('非示例或非匿名邮件地址');
  // PNG 的文本和 EXIF 元数据可能带有用户或设备信息，必须先移除或人工处理。
  if(file.endsWith('.png')&&body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    let offset=8;
    while(offset+12<=body.length){const size=body.readUInt32BE(offset),type=body.subarray(offset+4,offset+8).toString();if(['tEXt','zTXt','iTXt','eXIf'].includes(type)){reasons.push('图片包含文本或设备元数据');break;}offset+=size+12;}
  }
  return reasons.map(reason=>({file,reason}));
}

/** 路径规则独立于正文；已删除的历史文件同样在推送时受检查。 */
function inspectPath(file,mode) {
  const problems=[];
  if(/(^|\/)(?:\.local|\.cache|\.private|backups|node_modules|unpackage|screenshots)\//.test(file)||/(^|\/)\.env(?:\..+)?$/.test(file)&&!file.endsWith('.env.example')||/\.(?:log|jsonl|sqlite(?:-shm|-wal)?|db|pem|key|p12|pfx|cer|crt|der|jks|keystore|mobileprovision|apk|ipa|aab|bundle)$/i.test(file))problems.push({file,reason:'私有配置、截图、密钥或运行产物'});
  if(mode==='120000'||mode==='160000')problems.push({file,reason:'链接或子模块需要人工核对，默认禁止公开'});
  return problems;
}

/** 一次读取唯一 Git 对象，检查暂存快照和历史对象，避免工作区覆盖掩盖问题。 */
function scanEntries(directory,entries,policy) {
  const problems=entries.flatMap(entry=>inspectPath(entry.file,entry.mode));
  const ids=[...new Set(entries.map(entry=>entry.id))];
  if(!ids.length)return {files:entries.length,problems};
  const output=git(directory,['cat-file','--batch'],ids.join('\n')+'\n',null);
  const bodies=new Map();let offset=0;
  while(offset<output.length){const end=output.indexOf(10,offset);if(end<0)throw new Error('Git 对象响应不完整');const[id,type,rawSize]=output.subarray(offset,end).toString().split(' ');const size=Number(rawSize);if(type!=='blob'||!Number.isSafeInteger(size)||size<0||end+size+2>output.length)throw new Error('Git 对象检查失败');offset=end+1;bodies.set(id,output.subarray(offset,offset+size));offset+=size+1;}
  for(const entry of entries)problems.push(...inspect(entry.file,bodies.get(entry.id),policy));
  return {files:entries.length,problems};
}

/** 常规检查核对工作区的全部跟踪文件，供开发者和 CI 使用。 */
export function checkPublicFiles(directory=process.cwd()) {
  const files=git(directory,['ls-files','-z']).split('\0').filter(Boolean),problems=[],policy=localPolicy(directory);
  for(const file of files){
    problems.push(...inspectPath(file));const target=path.join(directory,file);
    if(!fs.existsSync(target))continue;
    if(fs.lstatSync(target).isSymbolicLink()){problems.push({file,reason:'链接需要人工核对'});continue;}
    problems.push(...inspect(file,fs.readFileSync(target),policy));
  }
  return {files:files.length,problems};
}

/** 提交检查读取索引中的实际内容，不受未暂存修改影响。 */
export function checkStagedFiles(directory=process.cwd()) {
  const entries=git(directory,['ls-files','--stage','-z']).split('\0').filter(Boolean).map(row=>{
    const at=row.indexOf('\t');const[mode,id,stage]=row.slice(0,at).split(' ');
    if(stage!=='0')throw new Error('暂存区尚有冲突，不能提交');
    return {mode,id,file:row.slice(at+1)};
  });
  return scanEntries(directory,entries,localPolicy(directory));
}

/** 推送时扫描每一个可达提交，包括随后删除敏感文件的中间提交。 */
export function checkHistory(directory=process.cwd(),tips=['HEAD'],{requiredRoot=PUBLIC_ROOT}={}) {
  const policy=localPolicy(directory),problems=[],entries=[],seen=new Set(),commits=new Set();
  for(const tip of tips){
    if(!/^(?:HEAD|[a-f0-9]{40}|[a-f0-9]{64})$/.test(tip))throw new Error('待检查的提交编号不合法');
    const roots=git(directory,['rev-list','--max-parents=0',tip]).trim().split('\n');
    if(roots.length!==1||requiredRoot&&roots[0]!==requiredRoot)return {files:0,commits:0,problems:[{file:'提交历史',reason:'包含未批准的根历史，禁止将旧私有仓库历史合入开源仓库'}]};
    for(const commit of git(directory,['rev-list',tip]).trim().split('\n'))commits.add(commit);
  }
  for(const commit of commits){
    const metadata=git(directory,['show','-s','--format=%an%n%ae%n%cn%n%ce%n%B',commit]);
    problems.push(...inspect('提交元信息',Buffer.from(metadata),policy));
    const rows=git(directory,['ls-tree','-r','-z',commit]).split('\0').filter(Boolean);
    for(const row of rows){const at=row.indexOf('\t');const[mode,,id]=row.slice(0,at).split(' ');const file=row.slice(at+1),key=id+'\0'+file+'\0'+mode;if(seen.has(key))continue;seen.add(key);entries.push({mode,id,file});}
  }
  const scanned=scanEntries(directory,entries,policy);
  return {...scanned,commits:commits.size,problems:[...problems,...scanned.problems]};
}

/** Git 的标准输入给出实际待推送引用；删除引用无新内容，默认拒绝异常输入。 */
export function checkPush(directory,input) {
  const tips=[];
  for(const line of input.trim().split('\n').filter(Boolean)){
    const fields=line.trim().split(/\s+/);if(fields.length!==4)throw new Error('推送引用清单不合法');
    const sha=fields[1];if(sha!==ZERO)tips.push(sha);
  }
  return tips.length?checkHistory(directory,tips):{files:0,commits:0,problems:[]};
}

/** 提交生成前检查作者、提交者及最终提交说明，使用与文件相同的本机策略。 */
export function checkCommitMessage(directory,message) {
  const metadata=git(directory,['var','GIT_AUTHOR_IDENT'])+git(directory,['var','GIT_COMMITTER_IDENT'])+message;
  return {files:0,problems:inspect('提交元信息',Buffer.from(metadata),localPolicy(directory))};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try {
    const mode=process.argv[2]??'--working';
    const result=mode==='--staged'?checkStagedFiles():mode==='--history'?checkHistory():mode==='--push'?checkPush(process.cwd(),fs.readFileSync(0,'utf8')):mode==='--message'?checkCommitMessage(process.cwd(),fs.readFileSync(process.argv[3],'utf8')):mode==='--working'?checkPublicFiles():null;
    if(!result)throw new Error('不支持的隐私检查模式');
    const unique=[...new Map(result.problems.map(p=>[p.file+'\0'+p.reason,p])).values()];
    if(unique.length){console.error(JSON.stringify({status:'隐私检查未通过',files:result.files,commits:result.commits,problems:unique}));process.exitCode=1;}
    else console.log(JSON.stringify({status:'隐私检查通过，仍须人工复核图片和任务内容',files:result.files,commits:result.commits}));
  } catch {console.error('隐私检查执行失败，已阻止操作；请在本机核对仓库和私有策略，不要公开配置正文。');process.exitCode=1;}
}
