import path from 'node:path';
import { AsarReader } from '../../packages/protocol/asar-reader.mjs';
import { BridgeError } from '../../packages/protocol/contracts.mjs';

const unavailable = () => new BridgeError('THREAD_MENTION_UNSUPPORTED', '当前桌面版本暂不支持聊天引用，请更新电脑连接服务');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 按语义定位已安装桌面的导出，不依赖构建时产生的压缩名称。 */
export function parseThreadMentionModules(reader) {
  const find = pattern => {
    const names = [...reader.files.keys()].filter(name => pattern.test(name));
    if (names.length !== 1) throw unavailable();
    return names[0];
  };
  const exported = (source, name) => {
    if (!name) throw unavailable();
    const value = source.slice(source.lastIndexOf('export{')).match(new RegExp('(?<=[{,])' + escape(name) + ' as ([\\w$]+)(?=[,}])'))?.[1];
    if (!value) throw unavailable();
    return value;
  };
  const initialName = find(/^webview\/assets\/app-initial-[a-f0-9]+\.js$/);
  const primaryName = find(/^webview\/assets\/app-primary-[a-f0-9]+\.js$/);
  const capabilityName = find(/^webview\/assets\/thread-reference-capability-[a-f0-9]+\.js$/);
  const initial = reader.text(initialName), primary = reader.text(primaryName), capability = reader.text(capabilityName);
  const formatter = initial.match(/function ([\w$]+)\(\{prompt:[^)]{0,2200}threadReferences:[^)]*\)\{/g);
  if (formatter?.length !== 1 || !initial.includes('## Referenced chats with Codex:') || !initial.includes('MUST call `read_thread`')) throw unavailable();
  const formatterName = formatter[0].match(/^function ([\w$]+)/)[1];
  // 原生开关读取创建线程时按真实 dynamicTools/config 写入的能力记录，缺省必须为 false。
  const key = initial.match(/function ([\w$]+)\([\w$]+\)\{return`thread-reference-capability:\$\{[\w$]+\}`\}/)?.[1];
  const gate = capability.match(/function ([\w$]+)\(([\w$]+)\)\{return ([\w$]+)\(([\w$]+)\(\2\),!1\)\}/);
  if (!key || !gate) throw unavailable();
  const imports = capability.match(/import\{([^}]+)\}from["']\.\/(app-initial-[a-f0-9]+\.js)["']/);
  const imported = local => imports?.[1].split(',').map(item => item.trim().split(/ as /)).find(parts => parts[1] === local)?.[0];
  if (imports?.[2] !== path.posix.basename(initialName) || imported(gate[4]) !== exported(initial, key)) throw unavailable();
  const readStored = imported(gate[3]);
  const storedLocal = readStored && initial.slice(initial.lastIndexOf('export{')).match(new RegExp('(?<=[{,])([\\w$]+) as ' + escape(readStored) + '(?=[,}])'))?.[1];
  if (!storedLocal || !new RegExp('function ' + escape(storedLocal) + '\\([\\w$]+,[\\w$]+\\)\\{return typeof window').test(initial)) throw unavailable();
  // 仅导出主机归属元数据的 atom；不调用会读取/恢复聊天的原生 resolver。
  const manager = initial.match(/([\w$]+)=[\w$]+\([\w$]+,\([\w$]+,\{get:([\w$]+)\}\)=>\2\(\2\([\w$]+,[\w$]+\)\)\?\.managerHostId\?\?null\)/)?.[1];
  const metadata = initial.match(/let ([\w$]+)=[\w$]+\.get\(([\w$]+),\{hostId:[\w$]+,threadId:[\w$]+\}\);if\(\1!=null\)return [\w$]+=[\w$]+,\{managerHostId:[\w$]+,conversationHostId:\1.hostId\?\?null\}/)?.[2];
  const submitMarker = primary.indexOf('clearDraftAttachments:');
  const registration = primary.slice(Math.max(0, submitMarker - 1200), submitMarker).match(/([\w$]+)\([\w$]+,\{submit:/)?.[1];
  const registrationStart = registration ? primary.indexOf('function ' + registration + '(') : -1;
  const submitAtom = registrationStart < 0 ? null : primary.slice(registrationStart, registrationStart + 1000).match(/\.set\(([\w$]+),[\w$]+\)/)?.[1];
  if (!manager || !metadata || !submitAtom) throw unavailable();
  return {
    initial: path.posix.basename(initialName), primary: path.posix.basename(primaryName), capability: path.posix.basename(capabilityName),
    formatter: exported(initial, formatterName), readCapability: exported(capability, gate[1]),
    managerHostAtom: exported(initial, manager), conversationAtom: exported(initial, metadata), submitAtom: exported(primary, submitAtom),
  };
}

/** 安装路径只接受现有发现器已核验的桌面程序，错误不携带私有路径。 */
export function threadMentionModules(executable) {
  let reader;
  try {
    if (typeof executable !== 'string') throw unavailable();
    const windows = /[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/](?:ChatGPT|Codex)\.exe$/i.test(executable);
    const mac = /\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/.test(executable);
    if (!windows && !mac) throw unavailable();
    const archive = windows ? path.join(path.dirname(executable), 'resources/app.asar') : path.resolve(path.dirname(executable), '../Resources/app.asar');
    reader = new AsarReader(archive);
    return parseThreadMentionModules(reader);
  } catch { throw unavailable(); }
  finally { reader?.close(); }
}
