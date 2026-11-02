import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

/** 仅配置当前仓库，不覆盖使用者已有的其他钩子目录或全局设置。 */
const directory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=args=>spawnSync('git',args,{cwd:directory,encoding:'utf8',windowsHide:true});
const root=run(['rev-parse','--show-toplevel']);
if(root.status!==0||path.resolve(root.stdout.trim())!==directory)throw new Error('请先克隆开源仓库，再安装本仓库钩子');
const current=run(['config','--get','core.hooksPath']);
if(current.status!==0&&current.status!==1)throw new Error('无法核对当前钩子配置');
if(current.stdout.trim()&&current.stdout.trim()!=='.githooks')throw new Error('已有其他 Git 钩子目录，保留配置，请人工整合隐私检查');
const configured=run(['config','--local','core.hooksPath','.githooks']);
if(configured.status!==0)throw new Error('无法安装本仓库隐私检查钩子');
console.log('已安装：提交前扫描实际暂存内容、作者及提交说明，推送前扫描所有可达提交和历史来源。');
