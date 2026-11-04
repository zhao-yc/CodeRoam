import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createPrivateFile} from './management-files.mjs';

export const DEFAULT_SETTINGS_CACHE = Object.freeze({ttlMs:2 * 60 * 60 * 1000,maxEntries:64});
const MAX_CONFIG_BYTES = 1024 * 1024;
const CONFIG_KEYS = new Set(['label','relayUrl','multiInstance','newConversationSettingsCache']);
const controlCharacters = /[\u0000-\u001f\u007f]/;

/** 管理端只接收固定错误说明，异常中不拼接原始配置、路径或访问令牌。 */
function failure(code, message) { return Object.assign(new Error(message), {code}); }
const invalid = () => failure('MANAGEMENT_CONFIG_INVALID','配置参数无效，请检查名称、地址和缓存范围');
const unavailable = () => failure('MANAGEMENT_CONFIG_UNAVAILABLE','无法读取或保存服务配置，请检查文件权限');
const changed = () => failure('MANAGEMENT_CONFIG_CHANGED','配置已被其他操作修改，请重新读取后保存');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = body => createHash('sha256').update(body).digest('hex');

/** 缓存参数只开放数值范围，缺省字段沿用两小时和六十四项的默认值。 */
export function validateSettingsCache(options = undefined) {
  if (options === undefined) return {...DEFAULT_SETTINGS_CACHE};
  if (!isRecord(options) || Object.keys(options).some(key => !['ttlMs','maxEntries'].includes(key))) throw invalid();
  const ttlMs = Object.hasOwn(options,'ttlMs') ? options.ttlMs : DEFAULT_SETTINGS_CACHE.ttlMs;
  const maxEntries = Object.hasOwn(options,'maxEntries') ? options.maxEntries : DEFAULT_SETTINGS_CACHE.maxEntries;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || ttlMs > 24 * 60 * 60 * 1000 || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 512) throw invalid();
  return {ttlMs,maxEntries};
}

/** 地址禁止携带凭据、查询参数和片段，仅本机调试地址允许使用明文协议。 */
function relayUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || !value || value !== value.trim() || controlCharacters.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'wss:' || url.protocol === 'ws:' && ['localhost','127.0.0.1'].includes(url.hostname))) throw invalid();
  return url.href;
}

/** 每个允许字段分别校验；既有配置可缺省名称，用户新保存的名称须为有效别名。 */
function fields(values, {allowMissing = false} = {}) {
  if (!isRecord(values) || Object.keys(values).some(key => !CONFIG_KEYS.has(key))) throw invalid();
  if (!allowMissing && !Object.keys(values).length) throw invalid();
  const next = {};
  if (Object.hasOwn(values,'label')) {
    if (typeof values.label !== 'string' || !values.label.trim() || values.label.trim().length > 80 || controlCharacters.test(values.label)) throw invalid();
    next.label = values.label.trim();
  }
  if (Object.hasOwn(values,'relayUrl')) next.relayUrl = relayUrl(values.relayUrl);
  if (Object.hasOwn(values,'multiInstance')) {
    if (typeof values.multiInstance !== 'boolean') throw invalid();
    next.multiInstance = values.multiInstance;
  }
  if (Object.hasOwn(values,'newConversationSettingsCache')) {
    if (values.newConversationSettingsCache === undefined) throw invalid();
    next.newConversationSettingsCache = validateSettingsCache(values.newConversationSettingsCache);
  }
  return next;
}

/** 打开前后核对普通文件身份，拒绝符号链接和超限正文，不将系统异常透传界面。 */
function load(file) {
  let descriptor;
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw invalid();
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CONFIG_BYTES) throw invalid();
    descriptor = fs.openSync(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_CONFIG_BYTES) throw invalid();
    const body = fs.readFileSync(descriptor);
    if (body.length > MAX_CONFIG_BYTES) throw invalid();
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw changed();
    let config;
    try { config = JSON.parse(body.toString('utf8').replace(/^\uFEFF/,'')); } catch { throw invalid(); }
    if (!isRecord(config)) throw invalid();
    return {body,config,revision:digest(body)};
  } catch (error) {
    if (error?.code?.startsWith('MANAGEMENT_CONFIG_')) throw error;
    throw unavailable();
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** 只返回允许编辑的投影和令牌是否已配置，保留其他设置在守护内部。 */
function projection({config,revision}) {
  const permitted = {};
  for (const key of CONFIG_KEYS) if (Object.hasOwn(config,key)) permitted[key] = config[key];
  // 空名称沿用系统电脑名；读取旧配置时允许展示这一缺省状态。
  const emptyLabel = permitted.label === '';
  if (emptyLabel) delete permitted.label;
  const value = fields(permitted,{allowMissing:true});
  return {revision,values:{label:value.label ?? '',relayUrl:value.relayUrl ?? '',multiInstance:value.multiInstance ?? true,newConversationSettingsCache:value.newConversationSettingsCache ?? {...DEFAULT_SETTINGS_CACHE}},tokenConfigured:typeof config.token === 'string' && config.token.length > 0};
}

/** 读取当前文件修订，界面保存时必须携带该修订，避免旧窗口覆盖较新配置。 */
export function readManagedConfig(file) { return projection(load(file)); }

/** 在写入敏感正文前落实文件权限；临时文件与备份均只由当前用户管理。 */
function writePrivate(file,body) {
  let descriptor;
  try {
    createPrivateFile(file);
    descriptor = fs.openSync(file,'r+');
    fs.writeFileSync(descriptor,body);
    fs.fsyncSync(descriptor);
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** 仅回收能证明原持有进程已退出且文件身份未变的旧锁，不凭超时抢占仍在保存的进程。 */
function staleSaveLock(file) {
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 || process.platform !== 'win32' && before.uid !== process.getuid()) return false;
    const body = fs.readFileSync(file),owner = JSON.parse(body.toString('utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(owner.nonce)) return false;
    try { process.kill(owner.pid,0); return false; } catch (error) { if (error.code !== 'ESRCH') return false; }
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || !fs.readFileSync(file).equals(body)) return false;
    fs.unlinkSync(file); return true;
  } catch { return false; }
}

/** 保存锁记录当前进程身份；异常退出后的下一次保存可安全回收失效记录。 */
function acquireSaveLock(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const descriptor = fs.openSync(file,'wx',0o600);
      try { fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,nonce:randomUUID()})); }
      catch (error) { fs.closeSync(descriptor); try { fs.unlinkSync(file); } catch {} throw error; }
      return descriptor;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt > 0 || !staleSaveLock(file)) throw changed();
    }
  }
  throw changed();
}

/** 同目录排他保存并保留私有备份，只合并允许字段；令牌和其他原值保持原样。 */
export function saveManagedConfig(file,options = {}) {
  if (!isRecord(options) || Object.keys(options).some(key => !['expectedRevision','values'].includes(key))) throw invalid();
  const {expectedRevision,values} = options;
  if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) throw invalid();
  const edits = fields(values);
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw invalid();
  const lock = file + '.management.lock', temporary = file + '.' + randomUUID() + '.tmp';
  let lockDescriptor, temporaryCreated = false;
  try {
    lockDescriptor = acquireSaveLock(lock);
    const current = load(file);
    if (current.revision !== expectedRevision) throw changed();
    if (Object.hasOwn(values,'newConversationSettingsCache')) edits.newConversationSettingsCache = validateSettingsCache({...validateSettingsCache(current.config.newConversationSettingsCache),...values.newConversationSettingsCache});
    const config = {...current.config,...edits};
    const body = Buffer.from(JSON.stringify(config,null,2) + '\n');
    if (body.length > MAX_CONFIG_BYTES) throw invalid();
    const result = projection({config,revision:digest(body)});
    const backup = file + '.' + Date.now() + '.' + randomUUID() + '.backup.json';
    writePrivate(backup,current.body);
    temporaryCreated = true; writePrivate(temporary,body);
    if (load(file).revision !== expectedRevision) throw changed();
    fs.renameSync(temporary,file); temporaryCreated = false;
    return result;
  } catch (error) {
    if (error?.code?.startsWith('MANAGEMENT_CONFIG_')) throw error;
    throw unavailable();
  } finally {
    if (temporaryCreated) try { fs.unlinkSync(temporary); } catch { /* 保存失败时仅清理本次创建的临时文件。 */ }
    if (lockDescriptor !== undefined) {
      try { fs.closeSync(lockDescriptor); } catch { /* 不以清理失败覆盖已确定的保存结果。 */ }
      try { fs.unlinkSync(lock); } catch { /* 外部进程已清理锁时不触碰其他路径。 */ }
    }
  }
}
