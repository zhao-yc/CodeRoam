import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsarReader } from '../../packages/protocol/asar-reader.mjs';
import { BridgeError } from '../../packages/protocol/contracts.mjs';

const archiveCache = new Map();
const maxCachedArchives = 4;
const oldSharedHash = 'f4b8ddb204fe43881fe4a625c09938e96aca597585583af1d86fc611c79d2e47';
const identifier = '[A-Za-z_$][\\w$]*';
const unsupported = () => new BridgeError('INSTANCE_NOT_READY', '当前桌面实例的协调接口暂不兼容，请更新电脑连接服务');

/** 仅接受安装包首页直接声明的本地模块，拒绝远端、跳目录和编码后的地址。 */
function entryModules(reader) {
  const html = reader.text('webview/index.html');
  if (html.length > 256 * 1024) throw unsupported();
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi)];
  if (!scripts.length || scripts.length > 16) throw unsupported();
  const names = scripts.map(([, , value]) => {
    const match = value.match(/^(?:\/|\.\/)?assets\/([A-Za-z0-9][A-Za-z0-9._-]{0,150}\.js)$/);
    if (!match) throw unsupported();
    const name = 'webview/assets/' + match[1];
    if (!reader.files.has(name)) throw unsupported();
    return name;
  });
  return [...new Set(names)];
}

/** 新版服务声明是纯 getter/setter 模块；只解析源码，不执行模块工厂或创建宿主。 */
function servicesFactory(source, filename) {
  const normalized = source.replace(/^\/\*[\s\S]*?\*\/\s*/, '').replace(/\/\/# sourceMappingURL=[^\r\n]*\s*$/, '').replace(/\s/g, '');
  const declaration = normalized.match(/^exportconst__rspack_esm_id=(\d+);exportconst__rspack_esm_ids=\[\1\];exportconst__webpack_modules__=\{([A-Za-z0-9_$]{1,80})\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{(.+)\}\};?$/);
  if (!declaration || path.posix.basename(filename).split('.')[0] !== declaration[1]) return null;
  const [, , moduleId, , exportsName, runtimeName, body] = declaration;
  const shape = new RegExp('^let(?<host>' + identifier + '),(?<services>' + identifier + ');function(?<setHost>' + identifier + ')\\((?<hostArg>' + identifier + ')\\)\\{\\k<host>=\\k<hostArg>\\}function(?<setServices>' + identifier + ')\\((?<servicesArg>' + identifier + ')\\)\\{\\k<services>=\\k<servicesArg>\\}(?<runtime>' + identifier + ')\\.r\\((?<exports>' + identifier + ')\\),\\k<runtime>\\.d\\(\\k<exports>,\\{appHost:\\(\\)=>\\k<host>,appServices:\\(\\)=>\\k<services>,setAppHost:\\(\\)=>\\k<setHost>,setAppServices:\\(\\)=>\\k<setServices>\\}\\)$');
  const match = body.match(shape);
  return match?.groups?.runtime === runtimeName && match.groups.exports === exportsName ? moduleId : null;
}

/** 旧 ESM 布局仅接受已审核的完整包，避免首次导入未知模块触发顶层初始化。 */
function legacyModules(reader) {
  const names = [...reader.files.keys()].filter(name => /^webview\/assets\/app-shared-[a-f0-9]+\.js$/.test(name));
  if (names.length !== 1) throw unsupported();
  const source = reader.text(names[0]);
  const exports = [...source.matchAll(/export\s*\{([^}]*)\}/g)].map(match => '{' + match[1] + '}').join(',');
  if (createHash('sha256').update(source).digest('hex') === oldSharedHash && /\bas\s+Vct\b/.test(exports)) {
    return { kind: 'esm', shared: path.posix.basename(names[0]), services: 'Vct' };
  }
  throw unsupported();
}

/** 从受信安装包提取只读绑定元数据；运行时只能读取已初始化的模块缓存。 */
export function parseInstanceBindingModules(reader) {
  try {
    const entries = entryModules(reader);
    const runtimes = entries.filter(name => /export\s*\{[^}]*\bas\s+__webpack_require__\s*(?=[,}])/.test(reader.text(name)));
    if (!runtimes.length) return Object.freeze(legacyModules(reader));
    if (runtimes.length !== 1) throw unsupported();
    const candidates = [...reader.files].filter(([name, metadata]) => /^webview\/assets\/async\/\d{1,10}\.[a-f0-9]{6,64}\.js$/.test(name) && Number.isSafeInteger(metadata.size) && metadata.size > 0 && metadata.size <= 4096);
    if (candidates.length > 8192 || candidates.reduce((bytes, [, metadata]) => bytes + metadata.size, 0) > 8 * 1024 * 1024) throw unsupported();
    const services = new Set();
    for (const [name] of candidates) {
      const moduleId = servicesFactory(reader.text(name), name);
      if (moduleId) services.add(moduleId);
    }
    if (services.size !== 1) throw unsupported();
    return Object.freeze({ kind: 'webpack', entry: path.posix.basename(runtimes[0]), servicesModule: [...services][0] });
  } catch { throw unsupported(); }
}

/** 发现器核验进程身份后，这里再次核对可执行文件和资源的规范安装路径。 */
function archiveForExecutable(executable) {
  const windows = process.platform === 'win32' && /[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/](?:ChatGPT|Codex)\.exe$/i.test(executable ?? '');
  const mac = process.platform === 'darwin' && /\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/.test(executable ?? '');
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || (!windows && !mac)) throw unsupported();
  const canonical = fs.realpathSync.native(executable);
  const samePath = (a, b) => windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!samePath(canonical, path.normalize(executable))) throw unsupported();
  const expected = windows ? path.join(path.dirname(canonical), 'resources', 'app.asar') : path.resolve(path.dirname(canonical), '../Resources/app.asar');
  const archive = fs.realpathSync.native(expected);
  if (!samePath(archive, expected)) throw unsupported();
  return archive;
}

/** 安装包更新会使旧元数据失效，最多缓存四份安装文件身份。 */
export function instanceBindingModules(executable) {
  let reader;
  try {
    const archive = archiveForExecutable(executable);
    const identity = () => {
      const stat = fs.statSync(archive, { bigint: true });
      if (!stat.isFile()) throw unsupported();
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    };
    const before = identity();
    const cached = archiveCache.get(archive);
    if (cached?.identity === before) return cached.modules;
    reader = new AsarReader(archive);
    const modules = parseInstanceBindingModules(reader);
    if (before !== identity()) throw unsupported();
    archiveCache.delete(archive);
    archiveCache.set(archive, { identity: before, modules });
    if (archiveCache.size > maxCachedArchives) archiveCache.delete(archiveCache.keys().next().value);
    return modules;
  } catch { throw unsupported(); }
  finally { reader?.close(); }
}
