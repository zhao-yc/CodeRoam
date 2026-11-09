import fs from 'node:fs';
import path from 'node:path';

const invalidWorker = () => Object.assign(new Error('所选文件不是有效的守护托管配置，请选择现有服务的 worker.json'), {code: 'MANAGER_CONFIG_INVALID'});

/** 只接受用户通过原生选择器或启动参数指定的托管文件，不接受渲染页面传入路径。 */
export function validateWorkerFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw Object.assign(new Error('请选择现有守护进程的 worker.json'), {code: 'MANAGER_CONFIG_INVALID'});
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw invalidWorker();
    const worker = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!['entry', 'bridgeConfig', 'runDirectory', 'logDirectory', 'statusFile', 'projectRoot'].every(key => typeof worker[key] === 'string' && path.isAbsolute(worker[key]))) throw invalidWorker();
    return path.resolve(file);
  } catch { throw invalidWorker(); }
}

/** 仅本地打包首页的顶层窗口可以调用预加载白名单。 */
export function trustedSender(event, window, rendererUrl) {
  return !!window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url.split('#')[0] === rendererUrl;
}

/** 偏好只保存托管路径；配对令牌和管理接口凭据始终不进入渲染页面。 */
export function createManagerController({preferencesPath, initialWorker = '', defaultWorker = () => '', beforeChoose = async () => {}, version, platform, chooseFile, connect}) {
  let workerConfigPath = '';
  // 首次通过启动参数关联的现有服务也要记住，后续双击客户端即可恢复连接。
  const remember = selected => {
    fs.mkdirSync(path.dirname(preferencesPath), {recursive: true, mode: 0o700});
    const temporary = preferencesPath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({workerConfigPath: selected}), {mode: 0o600});
    fs.renameSync(temporary, preferencesPath);
  };
  try {
    const saved = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
    workerConfigPath = validateWorkerFile(saved.workerConfigPath);
  } catch { /* 首次启动或原路径不存在时，由用户重新选择。 */ }
  const candidate = initialWorker || (!workerConfigPath && defaultWorker());
  if (candidate) {
    const selected = validateWorkerFile(candidate);
    if (selected !== workerConfigPath) remember(selected);
    workerConfigPath = selected;
  }
  const context = () => ({configured: workerConfigPath.length > 0, workerConfigPath, version, platform});
  return {
    context,
    async chooseWorker() {
      const selected = await chooseFile();
      if (!selected) return context();
      const next = validateWorkerFile(selected);
      if (next === workerConfigPath) return context();
      await beforeChoose(next, workerConfigPath);
      remember(next); workerConfigPath = next;
      return context();
    },
    async request(method, params = {}) {
      if (!workerConfigPath) throw Object.assign(new Error('请先选择现有服务的 worker.json'), {code: 'MANAGER_CONFIG_INVALID'});
      const client = await connect(workerConfigPath);
      return await client.request(method, params);
    },
  };
}
