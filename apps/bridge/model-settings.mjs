import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from '../../packages/protocol/contracts.mjs';

const MAX_CACHE_AGE = 24 * 60 * 60 * 1000;

/** 桌面常速的 default、null 与缺省值统一为手机使用的空字符串。 */
export function normalizeServiceTier(serviceTier) {
  return serviceTier == null || serviceTier === 'default' ? '' : serviceTier;
}

/** 只读桌面生成的模型目录，只向手机返回选择器需要的公开能力字段。 */
export class ModelCatalog {
  constructor({ codexHome = path.join(os.homedir(), '.codex'), now = Date.now } = {}) {
    this.filePath = path.join(codexHome, 'models_cache.json'); this.now = now;
  }

  read(provider = 'openai') {
    if (provider !== 'openai') throw new BridgeError('CATALOG_UNAVAILABLE', '当前模型提供方暂不支持手机选择，请在电脑端设置');
    let cache;
    try {
      if (fs.statSync(this.filePath).size > 4 * 1024 * 1024) throw new Error();
      cache = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch { throw new BridgeError('CATALOG_UNAVAILABLE', '暂时无法读取模型目录，请在电脑端刷新模型后重试'); }
    const age = this.now() - Date.parse(cache.fetched_at);
    if (!Number.isFinite(age) || age < -300000 || age > MAX_CACHE_AGE || !Array.isArray(cache.models)) {
      throw new BridgeError('CATALOG_EXPIRED', '模型目录已过期，请在电脑端刷新模型后重试');
    }
    const models = cache.models.filter(model => model.visibility === 'list' && typeof model.slug === 'string').map(model => ({
      id: model.slug, label: String(model.display_name ?? model.slug),
      defaultEffort: String(model.default_reasoning_level ?? ''),
      efforts: (model.supported_reasoning_levels ?? []).filter(option => typeof option.effort === 'string').map(option => option.effort),
      speeds: [{ id: '', label: '常速', description: '' }, ...(model.service_tiers ?? []).filter(tier => typeof tier.id === 'string' && tier.id !== 'default').map(tier => ({
        id: tier.id, label: tier.id === 'priority' ? '快速' : tier.id === 'ultrafast' ? '极速' : String(tier.name ?? tier.id),
        description: tier.id === 'priority' ? '更快响应，用量消耗更高' : '',
      }))],
      supportsImages: model.input_modalities?.includes('image') !== false,
    }));
    if (!models.length) throw new BridgeError('CATALOG_UNAVAILABLE', '模型目录尚未准备好，请在电脑端刷新后重试');
    return models;
  }
}

/** 从桌面最新会话设置读取下一轮配置，不把历史轮次猜成当前设置。 */
export function executionSettings(state) {
  const latest = state.latestThreadSettings ?? {};
  // 与桌面输入框使用同一协作模式，旧版本缺少实时字段时才回退保存设置。
  const collaboration = state.latestCollaborationMode ?? latest.collaborationMode;
  const model = collaboration?.settings?.model ?? latest.model ?? state.latestModel;
  if (typeof model !== 'string' || !model) return null;
  return {
    model,
    effort: String(collaboration?.settings?.reasoning_effort ?? latest.effort ?? state.latestReasoningEffort ?? ''),
    serviceTier: normalizeServiceTier(latest.serviceTier),
    mode: collaboration?.mode === 'plan' ? 'plan' : 'default',
  };
}

/** 只允许四项执行设置，保留桌面协作模式中的其他设置与全部权限。 */
export function validateSettings(changes, current, models, collaboration) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length ||
      Object.keys(changes).some(key => !['model', 'effort', 'serviceTier', 'mode'].includes(key))) {
    throw new BridgeError('BAD_SETTINGS', '仅支持修改模型、推理强度、速度和计划模式');
  }
  if (Object.values(changes).some(value => typeof value !== 'string')) throw new BridgeError('BAD_SETTINGS', '执行设置必须使用有效的选项');
  const selected = { ...current, ...changes };
  // 兼容修复前已加载的草稿；常速别名转换后仍按真实模型目录校验。
  selected.serviceTier = normalizeServiceTier(selected.serviceTier);
  const model = models.find(model => model.id === selected.model);
  if (!model) throw new BridgeError('MODEL_UNAVAILABLE', '此模型当前不可用，请刷新模型列表');
  if (changes.model !== undefined && changes.model !== current.model) {
    if (changes.effort === undefined && !model.efforts.includes(selected.effort)) selected.effort = model.defaultEffort;
    if (changes.serviceTier === undefined && !model.speeds.some(speed => speed.id === selected.serviceTier)) selected.serviceTier = '';
  }
  if (!model.efforts.includes(selected.effort)) throw new BridgeError('EFFORT_UNAVAILABLE', '此模型不支持所选推理强度');
  if (!model.speeds.some(speed => speed.id === selected.serviceTier)) throw new BridgeError('SPEED_UNAVAILABLE', '此模型不支持所选速度');
  if (!['plan', 'default'].includes(selected.mode)) throw new BridgeError('BAD_SETTINGS', '不支持此执行模式');
  const threadSettings = {
    model: selected.model, effort: selected.effort, serviceTier: selected.serviceTier || null,
    collaborationMode: {
      mode: selected.mode,
      settings: { ...collaboration?.settings, model: selected.model, reasoning_effort: selected.effort, developer_instructions: null },
    },
  };
  return { selected, threadSettings };
}
