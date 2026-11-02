import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { IpcClient } from '../../packages/protocol/ipc-client.mjs';
import { BridgeError } from '../../packages/protocol/contracts.mjs';

const execute = promisify(execFile);

/** Mac 的 IPC 按配置目录隔离；只接受该私有通道发现的所有者，写请求仍定向发送。 */
export class MacInstanceIpcClient extends IpcClient {
  /** 连接地址只能来自本机发现器，不能使用手机或全局桥接配置替换。 */
  constructor({ instance, verify, ...options }) { super({ ...options, socketPath: instance.ipcSocketPath }); this.instance = instance; this.verify = verify; this.allowedClients = new Set(); }
  /** 未就绪或已退出的实例不接受任何新操作。 */
  assertCurrent() { if (!this.instance.alive || !this.instance.ready) throw new BridgeError('INSTANCE_NOT_READY', '所选 Mac 实例连接尚未就绪，请稍后核对原操作', this.instance.wasReady === true); }
  /** 归属查询前后都核对独占目录，期间发生进程变化时不接纳旧客户端。 */
  async findOwner(threadId, hostId = 'local', timeoutMs = this.timeoutMs) {
    this.assertCurrent(); await this.verify();
    const result = await super.request('thread-owner-discovery', { hostId, conversationId: threadId }, 1, { timeoutMs });
    await this.verify(); this.assertCurrent();
    if (result.resultType !== 'success') return null;
    if (!/^[0-9a-f-]{36}$/i.test(result.handledByClientId ?? '')) throw new BridgeError('INSTANCE_CHANGED', 'Mac 实例返回的会话归属无效');
    this.allowedClients.add(result.handledByClientId);
    return { ...result.result, clientId: result.handledByClientId, hostId };
  }
  /** 独立 IPC 不查询其他配置目录；冷会话交给所选进程正常导航后再核对。 */
  async ownedElsewhere() { this.assertCurrent(); return false; }
  /** 初始化之外的请求必须定向发送，回应后再次复核，不能把迟到响应当成当前结果。 */
  async request(method, params, version, options = {}) {
    if (method !== 'initialize') {
      this.assertCurrent(); await this.verify(); this.assertCurrent();
      if (!options.targetClientId || !this.allowedClients.has(options.targetClientId)) throw new BridgeError('INSTANCE_CHANGED', '会话所属 Mac 实例已变化，请重新连接');
    }
    const result = await super.request(method, params, version, options);
    if (method !== 'initialize') { await this.verify(); this.assertCurrent(); }
    if (method !== 'initialize' && result.resultType === 'success' && result.handledByClientId !== options.targetClientId) throw new BridgeError('INSTANCE_CHANGED', 'Mac 桌面响应归属已变化，已停止操作');
    return result;
  }
  /** 只向已核验的原所有者同步订阅，禁止向整条 IPC 广播。 */
  broadcast(method, params, version, targets) { this.assertCurrent(); if (!targets?.length || targets.some(id => !this.allowedClients.has(id))) throw new BridgeError('INSTANCE_CHANGED', '会话所属 Mac 实例已变化，已停止操作'); return super.broadcast(method, params, version, targets); }
  /** 未核验来源和已经断开的客户端不能恢复实时快照。 */
  handleMessage(message) {
    if (message.type === 'broadcast' && message.method === 'client-status-changed' && message.params?.status === 'disconnected') this.allowedClients.delete(message.params.clientId);
    if (message.type === 'broadcast' && !this.allowedClients.has(message.sourceClientId)) return;
    super.handleMessage(message);
  }
  /** 连接断开即撤销全部客户端身份，重连后重新发现原所有者。 */
  handleClose() { this.allowedClients.clear(); this.instance.ready = false; super.handleClose(); }
}

/** AppleEvent 只带 PID 和已校验的聊天编号；最终是否加载成功仍由会话快照确认。 */
export async function navigateMacInstance(instance, threadId, { verify, isCurrent = () => true, launch = execute } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) throw new BridgeError('BAD_THREAD_ID', '会话编号无效');
  if (!isCurrent()) throw new BridgeError('SUBSCRIPTION_CANCELED', '旧的实例导航已取消');
  await verify();
  if (!isCurrent()) throw new BridgeError('SUBSCRIPTION_CANCELED', '旧的实例导航已取消');
  try { await launch('/usr/bin/osascript', ['-l', 'JavaScript', fileURLToPath(new URL('./macos-navigation.js', import.meta.url)), String(instance.pid), threadId], { timeout: 8000, maxBuffer: 4096 }); }
  catch { throw new BridgeError('DESKTOP_LOAD_FAILED', '无法打开所选 Mac 实例的会话，请在该实例检查后重试'); }
  await verify();
  if (!isCurrent()) throw new BridgeError('SUBSCRIPTION_CANCELED', '会话已切换，已忽略旧的实例导航');
}
