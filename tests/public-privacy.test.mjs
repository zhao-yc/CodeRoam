import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {checkPublicFiles} from '../scripts/check-public-files.mjs';

/** 用临时 Git 仓库验证拦截结果，不读取真实凭据或公开命中正文。 */
test('公开检查拦截私有配置、密钥格式和产物，允许合成示例',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'public-privacy-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:directory});
  const files={
    'README.md':'使用 relay.example.com 和自己的私有备份目录',
    '.local/mobile.json':'{"token":"合成测试值"}',
    'private.txt':['-----BEGIN','OPENSSH','PRIVATE KEY-----'].join(' '),
    'credential.txt':'gh'+'p_'+'a'.repeat(36),
    'build.apk':'合成产物'
  };
  for(const[file,body]of Object.entries(files)){const target=path.join(directory,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,body);}
  execFileSync('git',['add','.'],{cwd:directory});
  const result=checkPublicFiles(directory);
  assert.equal(result.files,5);
  assert.deepEqual(result.problems.map(p=>p.file).sort(),['.local/mobile.json','build.apk','credential.txt','private.txt']);
  assert.equal(JSON.stringify(result).includes(files['credential.txt']),false);
});
