import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

/** 从明确的提交导出手机源码，避免打包时夹带共享工作区中的未提交修改。 */
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const tree=execFileSync('git',['rev-parse',`${commit}:apps/mobile`],{encoding:'utf8'}).trim();
const root=path.resolve('.cache/release-source',commit);
if(fs.existsSync(root))throw new Error('该提交的导出目录已存在，请先核对既有构建记录，不能覆盖');
fs.mkdirSync(root,{recursive:true});
const archive=path.join(root,'source.tar');
execFileSync('git',['archive','--format=tar',`--output=${archive}`,commit,'apps/mobile'],{stdio:'pipe'});
execFileSync('tar',['-xf',archive,'-C',root],{stdio:'pipe'});
const project=path.join(root,'apps/mobile');
fs.writeFileSync(path.join(root,'release-source.json'),JSON.stringify({commit,tree,project,createdAt:new Date().toISOString()},null,2),{flag:'wx'});
console.log(JSON.stringify({status:'已导出干净的手机源码快照',commit,tree,project}));
