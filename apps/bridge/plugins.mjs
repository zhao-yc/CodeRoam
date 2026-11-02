import path from 'node:path';
import { BridgeError, validatePluginIds } from '../../packages/protocol/contracts.mjs';

const unavailable = () => new BridgeError('PLUGINS_UNAVAILABLE', '暂时无法读取插件，请确认电脑连接后重新读取');
const changed = () => new BridgeError('PLUGINS_CHANGED', '聊天目录或电脑实例已变化，请重新读取插件后发送');
const cwdOf = entry => entry.state?.cwd ?? entry.state?.environments?.[0]?.cwd;

/** 查询开始时保留实例身份原值，不能把同一对象被原地改写后的值当作原身份。 */
function instanceContext(adapter, creation) {
  const client = adapter.client, instance = client?.instance;
  const keys = ['id','generation','pid','startedAt','codexHome','executable','nativePipe','port','platform','userData'];
  const identity = keys.map(key => instance?.[key]);
  return () => {
    if (adapter.stopped || adapter.client !== client || client?.instance !== instance || keys.some((key, i) => instance?.[key] !== identity[i]) || (instance && creation?.codexHome !== instance.codexHome)) throw changed();
    try { client?.assertCurrent?.(); } catch { throw changed(); }
  };
}

/** 即使项目尚无聊天订阅，也必须在目录查询前后核对绑定实例和配置目录。 */
export function pluginInstanceVerifier(adapter, creation) {
  const check = instanceContext(adapter, creation), instance = adapter.client?.instance;
  return async () => {
    check();
    if (instance?.platform === 'darwin') {
      try { await instance.verify(); } catch { throw changed(); }
      check();
    }
  };
}

/** 复用所选实例的创建短连接；原始市场、来源路径和诊断永不离开连接服务。 */
export class PluginCatalog {
  constructor({ creation, verify = () => {} } = {}) { this.creation = creation; this.verify = verify; }

  async read(cwd) {
    const creation = this.creation, home = creation?.codexHome, cli = creation?.codexCliPath, resolver = creation?.resolveCli;
    const checkCreation = () => {
      if (this.creation !== creation || creation.codexHome !== home || creation.codexCliPath !== cli || creation.resolveCli !== resolver) throw changed();
    };
    try {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !creation?.run) throw unavailable();
      await this.verify();
      checkCreation();
      const response = await creation.run(cwd, request => request('plugin/installed', { cwds: [cwd] }));
      await this.verify();
      checkCreation();
      if (!Array.isArray(response?.marketplaces) || response.marketplaces.some(market => !Array.isArray(market?.plugins))) throw unavailable();
      const plugins = new Map();
      for (const plugin of response.marketplaces.flatMap(market => market.plugins)) {
        if (plugin?.installed !== true || plugin.enabled !== true || (plugin.availability !== undefined && plugin.availability !== 'AVAILABLE') || plugin.disabledReason) continue;
        try { validatePluginIds([plugin.id]); } catch { continue; }
        if (typeof plugin.name !== 'string' || !plugin.name.trim() || plugin.name.length > 200 || /[\u0000-\u001f\u007f]/.test(plugin.name)) continue;
        if (plugins.has(plugin.id)) continue;
        const label = plugin.interface?.displayName;
        const displayName = typeof label === 'string' && label.trim() ? label.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : plugin.name;
        const description = typeof plugin.interface?.shortDescription === 'string' ? plugin.interface.shortDescription.slice(0, 2000) : '';
        plugins.set(plugin.id, { id: plugin.id, name: plugin.name, displayName, description });
      }
      return { plugins: [...plugins.values()], supportsPluginSelection: true };
    } catch (error) {
      if (error?.code === 'PLUGINS_CHANGED') throw changed();
      // 创建接口沿用原有错误码；只在插件边界转换，且不附带原始 cause。
      throw unavailable();
    }
  }
}

/** 捕获订阅、所有者、目录及实例代次，异步结果返回和真正发送前都需重新核对。 */
export function pluginContext(adapter, threadId, deviceId) {
  const entry = adapter.subscribed(threadId, deviceId), owner = entry.owner, cwd = cwdOf(entry), client = adapter.client;
  const ownerId = owner.clientId, hostId = owner.hostId, catalog = adapter.pluginCatalog, creation = catalog?.creation;
  const home = creation?.codexHome, cli = creation?.codexCliPath, resolver = creation?.resolveCli;
  const checkInstance = instanceContext(adapter, creation);
  const check = () => {
    const current = adapter.subscribed(threadId, deviceId);
    if (current !== entry || current.owner !== owner || owner.clientId !== ownerId || owner.hostId !== hostId || cwdOf(current) !== cwd || adapter.pluginCatalog !== catalog || catalog?.creation !== creation || creation?.codexHome !== home || creation?.codexCliPath !== cli || creation?.resolveCli !== resolver || (client?.allowedClients && !client.allowedClients.has(ownerId))) throw changed();
    checkInstance();
  };
  check();
  return { cwd, check };
}

/** 只读取已经订阅的原会话，读取期间退订或变更上下文则丢弃结果。 */
export async function readThreadPlugins(adapter, threadId, deviceId) {
  const context = pluginContext(adapter, threadId, deviceId);
  let result;
  try { result = await adapter.pluginCatalog?.read(context.cwd); }
  finally { context.check(); }
  if (!result) throw unavailable();
  return result;
}

/** 新建聊天只接受电脑项目编号；查询结束后再核对项目目录与创建客户端。 */
export async function readProjectPlugins(service, catalog, projectId, adapter) {
  const cwd = service.project(projectId).cwd, creation = service.creation, checkInstance = instanceContext(adapter, creation);
  checkInstance();
  const result = await catalog.read(cwd);
  checkInstance();
  if (service.creation !== creation || adapter.pluginCatalog !== catalog || catalog.creation !== creation || service.project(projectId).cwd !== cwd) throw changed();
  return result;
}

/** 每次发送或入队都读取最新目录，返回的名称只来自电脑端已核对记录。 */
export async function selectThreadPlugins(adapter, threadId, deviceId, ids) {
  const selected = validatePluginIds(ids), context = pluginContext(adapter, threadId, deviceId);
  if (!selected.length) return { plugins: [], check: context.check };
  const result = await readThreadPlugins(adapter, threadId, deviceId);
  context.check();
  const plugins = selected.map(id => {
    const plugin = result.plugins.find(plugin => plugin.id === id);
    if (!plugin) throw new BridgeError('PLUGIN_UNAVAILABLE', '所选插件已不可用，请重新选择插件后发送');
    return plugin;
  });
  return { plugins, check: context.check };
}

/** 提示正文与可恢复消息使用同一份插件标记；标签转义防止破坏 Markdown 链接。 */
export function pluginPrompt(text, plugins) {
  if (!plugins.length) return text;
  const mentions = plugins.map(plugin => `[@${plugin.displayName.replace(/[\\[\]]/g, '\\$&')}](plugin://${plugin.id})`).join(' ');
  return text + (text ? '\n\n' : '') + mentions;
}
