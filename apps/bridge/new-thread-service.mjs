import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { ThreadCreationClient } from './thread-creation.mjs';
import { normalizeServiceTier } from './model-settings.mjs';

const SETTINGS_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const SETTINGS_CACHE_LIMIT = 64;

/** 只读取所选电脑已保存的项目；客户端不能提交任意目录。 */
export class NewThreadService {
  constructor({ codexHome = path.join(os.homedir(), '.codex'), codexCliPath, creation = new ThreadCreationClient({ codexHome, codexCliPath }), catalog, now = Date.now } = {}) {
    this.codexHome = codexHome; this.creation = creation; this.catalog = catalog; this.now = now;
    this.settingsCache = new Map();
  }
  projects() {
    let state;
    try {
      const file = path.join(this.codexHome, '.codex-global-state.json');
      if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error();
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { throw new BridgeError('PROJECTS_UNAVAILABLE', '暂时无法读取电脑端项目，请先在 Codex 桌面添加项目'); }
    const records = state['local-projects'];
    const projects = Object.values(records && typeof records === 'object' ? records : {}).filter(project => typeof project?.id === 'string' && Array.isArray(project.rootPaths)).flatMap(project => {
      const cwd = project.rootPaths[0];
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return [];
      try { if (!fs.statSync(cwd).isDirectory()) return []; } catch { return []; }
      return [{ id: project.id, label: String(project.name || path.basename(cwd)), cwd }];
    });
    const selected = state['selected-project'];
    return { projects, selectedProjectId: selected?.type === 'local' ? selected.projectId ?? selected.id ?? '' : '', supportsThreadCreation: true };
  }
  project(id) {
    const project = this.projects().projects.find(project => project.id === id);
    if (!project) throw new BridgeError('PROJECT_NOT_FOUND', '项目已不存在，请重新选择电脑端项目');
    return project;
  }
  /** 常见配置层只比较文件状态；其他托管配置由有效期兜底，不读取或保留原始配置正文。 */
  settingsSignature(cwd) {
    const files = new Set([path.join(this.codexHome, 'config.toml'), path.join(this.codexHome, 'managed_config.toml'), this.catalog?.filePath ?? path.join(this.codexHome, 'models_cache.json')]);
    for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
      files.add(path.join(directory, '.codex', 'config.toml'));
      if (directory === path.dirname(directory)) break;
    }
    return JSON.stringify([...files].map(file => {
      try {
        const stat = fs.statSync(file, { bigint: true });
        return [file, [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')];
      } catch (error) { return [file, error.code]; }
    }));
  }
  /** 每个实例按项目和目录缓存只读投影；同一版本的并发读取共用辅助进程。 */
  async settingsConfig(projectId, cwd) {
    const signature = this.settingsSignature(cwd), now = this.now(), creation = this.creation;
    for (const [id, entry] of this.settingsCache) {
      if (!entry.pending && (now < entry.loadedAt || now - entry.loadedAt >= SETTINGS_CACHE_TTL_MS)) this.settingsCache.delete(id);
    }
    const cached = this.settingsCache.get(projectId);
    if (cached && cached.cwd === cwd && cached.signature === signature && cached.creation === creation && cached.resolveCli === creation.resolveCli && cached.codexHome === creation.codexHome && cached.codexCliPath === creation.codexCliPath) {
      this.settingsCache.delete(projectId); this.settingsCache.set(projectId, cached);
      return cached.pending ?? cached.value;
    }
    const entry = { cwd, signature, creation, resolveCli: creation.resolveCli, codexHome: creation.codexHome, codexCliPath: creation.codexCliPath, pending: null, loadedAt: 0, value: null };
    entry.pending = Promise.resolve().then(() => creation.readConfig(cwd)).then(response => {
      const config = response?.config ?? {}, defaults = response?.defaultModel;
      // 内存中只保存工具栏需要的字段，不缓存配置中的令牌、权限或其他正文。
      entry.value = {
        model: config.model ?? defaults?.model ?? defaults?.id ?? '', provider: config.model_provider ?? 'openai',
        effort: config.model_reasoning_effort ?? defaults?.defaultReasoningEffort ?? null, serviceTier: normalizeServiceTier(config.service_tier),
      };
      entry.loadedAt = this.now(); entry.pending = null;
      // 读取期间文件变动或新请求替换条目时，旧回执不能覆盖较新的缓存。
      if (this.settingsCache.get(projectId) === entry && this.settingsSignature(cwd) !== signature) this.settingsCache.delete(projectId);
      return entry.value;
    }, error => {
      if (this.settingsCache.get(projectId) === entry) this.settingsCache.delete(projectId);
      throw error;
    });
    this.settingsCache.set(projectId, entry);
    while (this.settingsCache.size > SETTINGS_CACHE_LIMIT) this.settingsCache.delete(this.settingsCache.keys().next().value);
    return entry.pending;
  }
  /** 项目资格和模型目录每次重新校验，缓存仅省去重复启动配置读取进程。 */
  async settings(projectId) {
    const project = this.project(projectId);
    const config = await this.settingsConfig(projectId, project.cwd);
    try {
      const models = this.catalog?.read(config.provider) ?? [];
      const model = models.find(model => model.id === config.model);
      const effort = String(config.effort ?? model?.defaultEffort ?? '');
      return { settings: { model: config.model, effort, serviceTier: config.serviceTier, mode: 'default' }, models };
    } catch (error) {
      if (this.settingsCache.get(projectId)?.value === config) this.settingsCache.delete(projectId);
      throw error;
    }
  }
  /** 创建结果由调用方先记入自有账本，后续加载或发送失败也可继续同一编号。 */
  create(projectId, title = '新聊天', onCreated) { return this.creation.create(this.project(projectId).cwd, title, onCreated); }
}
