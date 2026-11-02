import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

/** 扫描所有已跟踪文件，拦截常见凭据、私有目录和不应公开的产物，不输出命中正文。 */
export function checkPublicFiles(directory=process.cwd()) {
  const listed=spawnSync('git',['ls-files','-z'],{cwd:directory,encoding:'utf8'});
  if(listed.status!==0)throw new Error('无法读取公开文件清单');
  const files=listed.stdout.split('\0').filter(Boolean),problems=[];
  for(const file of files){
    if(/(^|\/)(?:\.local|\.cache|\.private|backups|node_modules|unpackage)\//.test(file)||/\.(?:log|jsonl|sqlite(?:-shm|-wal)?|pem|key|p12|pfx|jks|keystore|mobileprovision|apk|ipa|aab|bundle)$/i.test(file)){
      problems.push({file,reason:'私有配置、密钥或运行产物'});continue;
    }
    const target=path.join(directory,file);
    if(!fs.existsSync(target))continue;
    if(fs.lstatSync(target).isSymbolicLink()){problems.push({file,reason:'请人工核对符号链接目标'});continue;}
    const text=fs.readFileSync(target).toString('utf8');
    if(/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text))problems.push({file,reason:'私钥标记'});
    if(/\b(?:github_pat_[A-Za-z0-9_]{40,}|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/.test(text))problems.push({file,reason:'常见访问令牌格式'});
  }
  return {files:files.length,problems};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=checkPublicFiles();
  if(result.problems.length){console.error(JSON.stringify({status:'隐私检查未通过',...result}));process.exitCode=1;}
  else console.log(JSON.stringify({status:'隐私检查通过，仍须人工复核截图与提交内容',files:result.files}));
}
