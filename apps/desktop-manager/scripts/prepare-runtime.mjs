import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), repository = path.resolve(project, '../..');
const output = path.join(project, '.runtime');
if (process.platform !== 'win32' || process.arch !== 'x64' || !process.version.startsWith('v24.')) throw new Error('Windows 首版打包需要 x64 Node.js 24');
fs.mkdirSync(output, {recursive: true});
// 输出目录固定归本桌面工程所有；打包前清理，避免把旧配置或运行数据混入产物。
if (fs.realpathSync(output) !== path.join(fs.realpathSync(project), '.runtime')) throw new Error('打包目录归属不符');
for (const name of fs.readdirSync(output)) fs.rmSync(path.join(output, name), {recursive: true, force: true});
const tracked = execFileSync('git', ['ls-files', '-z', 'apps/bridge', 'packages/protocol', 'scripts/asar-reader.mjs', 'scripts/windows', 'scripts/bridge-service.ps1'], {cwd: repository, encoding: 'utf8'}).split('\0').filter(Boolean);
for (const file of tracked) {
  const destination = path.join(output, file); fs.mkdirSync(path.dirname(destination), {recursive: true}); fs.copyFileSync(path.join(repository, file), destination);
}
// 新增管理模块在首次提交前也参与本机打包；交付时再核对整个源码快照。
for (const file of fs.readdirSync(path.join(repository, 'apps/bridge')).filter(name => name.startsWith('management-') && name.endsWith('.mjs'))) fs.copyFileSync(path.join(repository, 'apps/bridge', file), path.join(output, 'apps/bridge', file));
fs.copyFileSync(process.execPath, path.join(output, 'node.exe'));
fs.cpSync(path.join(repository, 'node_modules/ws'), path.join(output, 'node_modules/ws'), {recursive: true});
fs.copyFileSync(path.join(repository, 'package.json'), path.join(output, 'package.json'));
fs.writeFileSync(path.join(output, 'runtime-version.json'), JSON.stringify({nodeVersion: process.version, nodeSha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'), builtAt: new Date().toISOString()}));
console.log('已准备独立 Node.js 24 与桥接运行资源，不包含本机配置、令牌或账本。');
