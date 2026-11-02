import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {checkPublicFiles,checkStagedFiles,checkHistory,checkPush,checkCommitMessage} from '../scripts/check-public-files.mjs';

/** 临时仓库只保存合成资料，作者使用匿名地址，不访问任何真实远端。 */
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'privacy-hooks-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
  git('init','-q','-b','main');git('config','user.name','privacy-test');git('config','user.email','privacy-test@users.noreply.github.com');
  const write=(file,body)=>{const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,body);};
  write('.gitignore','.local/\n');write('README.md','合成项目');git('add','.');git('commit','-qm','初始化合成项目');
  return {root,git,write,first:git('rev-parse','HEAD')};
}
const mockToken=()=>'gh'+'p_'+'x'.repeat(36);

test('暂存区含敏感内容时，工作区改回安全文本也不能掩盖',t=>{
  const f=fixture(t);f.write('note.txt',mockToken());f.git('add','note.txt');f.write('note.txt','已改成普通文本但尚未暂存');
  assert.equal(checkPublicFiles(f.root).problems.length,0);
  const result=checkStagedFiles(f.root);assert.ok(result.problems.some(p=>p.file==='note.txt'&&p.reason==='常见访问令牌格式'));
  assert.equal(JSON.stringify(result).includes(mockToken()),false);
});

test('待推送中间提交曾包含敏感数据，即使最后删除也必须阻止',t=>{
  const f=fixture(t);f.write('note.txt',mockToken());f.git('add','note.txt');f.git('commit','-qm','合成泄露提交');
  f.git('rm','-q','note.txt');f.git('commit','-qm','删除合成泄露文件');
  assert.equal(checkStagedFiles(f.root).problems.length,0);
  const result=checkHistory(f.root,['HEAD'],{requiredRoot:f.first});
  assert.equal(result.commits,3);assert.ok(result.problems.some(p=>p.reason==='常见访问令牌格式'));
});

test('本机规则与凭据指纹拦截不带供应商前缀的秘密，不记录正文',t=>{
  const f=fixture(t),secret='opaque_'+'q'.repeat(35);
  f.write('.local/privacy-policy.json',JSON.stringify({secretFingerprints:[createHash('sha256').update(secret).digest('hex')],blockedPatterns:['private-service'+String.raw`\.invalid`]}));
  f.write('note.txt',secret+'\n'+'private-'+'service.invalid');f.git('add','note.txt');
  const result=checkStagedFiles(f.root);assert.ok(result.problems.some(p=>p.reason==='已登记凭据指纹'));assert.ok(result.problems.some(p=>p.reason==='本机登记的内部或个人信息'));
  assert.equal(JSON.stringify(result).includes(secret),false);
});

test('内网地址、私人邮箱与主目录被拦截，示例和匿名邮箱可使用',t=>{
  const f=fixture(t);f.write('note.txt',[['192','168','1','2'].join('.'),['C:','Users','private-person'].join('/'),['personal','mail.example-person.com'].join('@')].join('\n'));f.git('add','note.txt');
  const reasons=checkStagedFiles(f.root).problems.map(p=>p.reason);
  for(const expected of ['内网地址','个人主目录路径','非示例或非匿名邮件地址'])assert.ok(reasons.includes(expected));
  f.write('note.txt','relay.example.com\nmaintainer@users.noreply.github.com');f.git('add','note.txt');assert.equal(checkStagedFiles(f.root).problems.length,0);
});

test('未经批准的历史根和异常推送输入均被拦截，删除引用无需扫描',t=>{
  const f=fixture(t);assert.ok(checkHistory(f.root).problems.some(p=>p.reason.includes('旧私有仓库')));
  assert.throws(()=>checkPush(f.root,'格式不完整'));
  assert.equal(checkPush(f.root,'refs/heads/test '+'0'.repeat(40)+' refs/heads/test '+f.first).problems.length,0);
});

test('Git 提交钩子实际阻止暂存的秘密，即使工作区已清除',t=>{
  const f=fixture(t);f.write('scripts/check-public-files.mjs',fs.readFileSync('scripts/check-public-files.mjs'));
  f.write('.githooks/pre-commit','#!/bin/sh\nexec node scripts/check-public-files.mjs --staged\n');
  f.git('config','core.hooksPath','.githooks');
  if(process.platform!=='win32')fs.chmodSync(path.join(f.root,'.githooks/pre-commit'),0o755);
  f.git('add','scripts','.githooks');f.git('commit','-qm','安装合成检查钩子');
  const before=f.git('rev-parse','HEAD');f.write('note.txt',mockToken());f.git('add','note.txt');f.write('note.txt','工作区安全文本');
  const result=spawnSync('git',['commit','-m','不得提交合成秘密'],{cwd:f.root,encoding:'utf8'});
  assert.notEqual(result.status,0);assert.equal(f.git('rev-parse','HEAD'),before);assert.match(result.stdout+result.stderr,/隐私检查未通过/);assert.equal((result.stdout+result.stderr).includes(mockToken()),false);
});

test('推送检查也拦截提交说明中的敏感内容',t=>{
  const f=fixture(t);f.write('README.md','合成更新');f.git('add','README.md');f.git('commit','-qm',mockToken());
  assert.ok(checkHistory(f.root,['HEAD'],{requiredRoot:f.first}).problems.some(p=>p.file==='提交元信息'));
});

test('创建提交前检查说明与作者，普通说明和匿名身份通过',t=>{
  const f=fixture(t);
  assert.equal(checkCommitMessage(f.root,'普通中文提交说明').problems.length,0);
  assert.ok(checkCommitMessage(f.root,mockToken()).problems.some(p=>p.reason==='常见访问令牌格式'));
  f.git('config','user.email',['personal','mail.example-person.com'].join('@'));
  assert.ok(checkCommitMessage(f.root,'普通说明').problems.some(p=>p.reason==='非示例或非匿名邮件地址'));
});
