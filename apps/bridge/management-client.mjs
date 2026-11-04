import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const failure = (message, code = 'MANAGEMENT_UNAVAILABLE') => Object.assign(new Error(message), {code});
const digest = value => createHash('sha256').update(value).digest('hex');
const privateFiles = new Map();

/** 端点文件必须属于当前用户且不向其他普通用户开放；ACL 校验按文件身份复用。 */
function assertPrivateEndpoint(file, info) {
  if(process.platform!=='win32'){
    if(info.uid!==process.getuid()||(info.mode&0o077)!==0)throw failure('本机管理端点不一致或权限无效');
    return;
  }
  const signature=[info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs].join(':');
  if(privateFiles.get(file)===signature)return;
  const script="param([string]$target) $ErrorActionPreference='Stop'; $acl=[IO.File]::GetAccessControl($target); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if(!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid){exit 1}; foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544')){exit 1}}";
  const quoted="'"+path.resolve(file).replaceAll("'","''")+"'";
  const result=spawnSync(path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command','& { '+script+' } '+quoted],{windowsHide:true,stdio:'ignore',timeout:10000});
  if(result.status!==0)throw failure('本机管理端点不一致或权限无效');
  privateFiles.set(file,signature);if(privateFiles.size>16)privateFiles.delete(privateFiles.keys().next().value);
}

/** 有界读取选定的普通 JSON 文件；管理端不跟随链接或接受网络配置来源。 */
function readJson(file, limit, privateEndpoint = false) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw failure('本机管理配置文件无效');
  if(privateEndpoint)assertPrivateEndpoint(file,info);
  const bytes = fs.readFileSync(file);
  return {value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), revision: digest(bytes)};
}

/** 对绑定的托管路径做摘要，避免误连另一套服务或编辑后仍沿用旧管道。 */
export function managementWorkerIdentity(worker) {
  const fields = ['entry', 'bridgeConfig', 'projectRoot', 'runDirectory', 'statusFile', 'logDirectory'];
  return digest(JSON.stringify(fields.map(key => {
    if (typeof worker[key] !== 'string' || !path.isAbsolute(worker[key])) throw failure('所选托管配置缺少绝对路径');
    const value = path.resolve(worker[key]); return process.platform === 'win32' ? value.toLowerCase() : value;
  })));
}

/** 每次连接重新核对选定托管文件与私有端点，不把能力令牌返回给网页界面。 */
export function readManagementConnection(workerConfigPath) {
  try {
    if (typeof workerConfigPath !== 'string' || !path.isAbsolute(workerConfigPath)) throw failure('请先选择本机服务托管配置');
    const {value: worker, revision} = readJson(workerConfigPath, 1024 * 1024);
    const {value: connection} = readJson(path.join(worker.runDirectory, 'management.json'), 65536, true);
    if (connection.version !== 1 || connection.workerIdentity !== managementWorkerIdentity(worker) || connection.workerConfigRevision && connection.workerConfigRevision !== revision || !Number.isSafeInteger(connection.pid) || connection.pid <= 0 || typeof connection.token !== 'string' || !/^[a-f0-9]{64}$/.test(connection.token)) throw failure('本机管理端点与所选服务不一致');
    const address = connection.address;
    if (process.platform === 'win32') {
      if (typeof address !== 'string' || !/^\\\\\.\\pipe\\codex-mobile-manager-[a-f0-9-]{36}$/.test(address)) throw failure('本机管理管道地址无效');
    } else {
      const directory = path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'codex-mobile-manager-' + process.getuid());
      if (typeof address !== 'string' || path.dirname(address) !== directory || !/^[a-f0-9-]{36}\.sock$/.test(path.basename(address))) throw failure('本机管理套接字地址无效');
      const info = fs.lstatSync(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw failure('本机管理目录权限无效');
    }
    return {...connection, worker};
  } catch (error) {
    if (error.code?.startsWith('MANAGEMENT_')) throw error;
    throw failure('尚未连接管理服务，请确认服务已升级并正在运行');
  }
}

/** 一个请求使用一条本机连接，只暴露固定的管理方法，不提供任意文件或命令执行。 */
export function connectManagement(workerConfigPath) {
  return {
    async request(method, params = {}) {
      if (!['status', 'config.read', 'config.save', 'logs.read', 'service.restart'].includes(method)) throw failure('不支持的本机管理操作', 'MANAGEMENT_METHOD_INVALID');
      const connection = readManagementConnection(workerConfigPath), id = randomUUID();
      const body = JSON.stringify({version: 1, id, token: connection.token, method, params}) + '\n';
      if (Buffer.byteLength(body) > 65536) throw failure('本机管理请求过大', 'MANAGEMENT_REQUEST_INVALID');
      return new Promise((resolve, reject) => {
        const socket = net.createConnection(connection.address); let buffer = Buffer.alloc(0), settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => finish(failure('本机管理服务响应超时')), method === 'service.restart' ? 20000 : 15000);
        socket.once('connect', () => socket.write(body));
        socket.on('data', chunk => {
          buffer = Buffer.concat([buffer, chunk]);
          if (buffer.length > 262144) return finish(failure('本机管理响应过大'));
          const newline = buffer.indexOf(10); if (newline < 0) return;
          try {
            const response = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
            if (response.version !== 1 || response.id !== id || response.pid !== connection.pid) throw failure('本机管理响应身份不符');
            if (response.error) return finish(failure(response.error.message, response.error.code));
            finish(null, response.result);
          } catch { finish(failure('本机管理响应格式无效')); }
        });
        socket.once('error', () => finish(failure('无法连接本机管理服务，请确认服务正在运行')));
        socket.once('end', () => { if (!settled) finish(failure('本机管理连接提前结束')); });
      });
    },
  };
}
