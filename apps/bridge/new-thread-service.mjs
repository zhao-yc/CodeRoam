import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { ThreadCreationClient } from './thread-creation.mjs';
import { normalizeServiceTier } from './model-settings.mjs';

/** 只读取所选电脑已保存的项目；客户端不能提交任意目录。 */
export class NewThreadService {
  constructor({ codexHome = path.join(os.homedir(), '.codex'), codexCliPath, creation = new ThreadCreationClient({ codexHome, codexCliPath }), catalog } = {}) {
    this.codexHome = codexHome; this.creation = creation; this.catalog = catalog;
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
  /** 默认设置来自项目实际配置；只返回输入工具栏需要的四项字段。 */
  async settings(projectId) {
    const project = this.project(projectId);
    const response = await this.creation.readConfig(project.cwd);
    const config = response?.config ?? {};
    const models = this.catalog?.read(config.model_provider ?? 'openai') ?? [];
    const modelId = config.model ?? response.defaultModel?.model ?? response.defaultModel?.id ?? '';
    const model = models.find(model => model.id === modelId);
    const effort = String(config.model_reasoning_effort ?? response.defaultModel?.defaultReasoningEffort ?? model?.defaultEffort ?? '');
    return { settings: { model: modelId, effort, serviceTier: normalizeServiceTier(config.service_tier), mode: 'default' }, models };
  }
  /** 创建结果由调用方先记入自有账本，后续加载或发送失败也可继续同一编号。 */
  create(projectId, title = '新对话', onCreated) { return this.creation.create(this.project(projectId).cwd, title, onCreated); }
}
