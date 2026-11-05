import path from 'node:path';
import { NativeDesktop } from './native-desktop.mjs';
import { DesktopAdapter } from './desktop-adapter.mjs';
import { BridgeAgent } from './agent.mjs';
import { StateReader } from './state-reader.mjs';
import { ModelCatalog } from './model-settings.mjs';
import { AttachmentStore } from './attachment-store.mjs';
import { Journal } from './journal.mjs';
import { DesktopGoalController } from './desktop-goals.mjs';
import { DesktopArchiveController } from './desktop-archive.mjs';
import { ComposerPredictionReader } from './composer-prediction.mjs';
import { DesktopFileReportReader } from './file-reports.mjs';
import { InstanceIpcClient, bindInstanceClients } from './instance-binding.mjs';
import { BridgeError, READ_METHODS } from '../../packages/protocol/contracts.mjs';
import { MacInstanceIpcClient, navigateMacInstance } from './macos-instance-client.mjs';
import { withDesktopUi } from './desktop-ui-coordinator.mjs';
import { readInstanceActivity } from './instance-activity.mjs';
import { NewThreadService } from './new-thread-service.mjs';
import { NativeDraftController } from './native-draft-controller.mjs';
import { ThreadCreationClient, instanceCodexPath } from './thread-creation.mjs';

/** 固定到本次已核验进程和随机管道；管道丢失后不能选择另一个桌面代替。 */
class InstanceNativeDesktop extends NativeDesktop {
  constructor(instance, client, options) { super(options); this.instance = instance; this.boundClient = client; this.processId = instance.pid; }
  async resolveEndpoint() {
    this.boundClient.assertCurrent();
    return { path: this.instance.nativePipe, pid: this.instance.pid };
  }
  async call(...args) { this.boundClient.assertCurrent(); return super.call(...args); }
  async connect() { try { return await super.connect(); } catch { throw new BridgeError('INSTANCE_NOT_READY', '所选实例的原生连接尚未就绪，请在电脑检查该实例后重试'); } }
  /** 冷会话在原桌面加载后立即补核后台身份，避免等到下次周期发现才可跟随。 */
  async navigate(...args) {
    // 导航和随后的已读更新使用同一条已固定的工具管道，开始导航前复核一次即可。
    if (this.instance.directIpc) await this.instance.verify();
    await super.navigate(...args);
    await this.instance.refreshOwners?.();
  }
}

/** 原生帮助程序只接收连接服务生成的实例约束，手机不能指定 PID 或管道。 */
class InstanceArchiveController extends DesktopArchiveController {
  constructor(instance, client) { super({ platform: instance.platform }); this.instance = instance; this.client = client; }
  /** 实例身份与配置目录取自电脑发现器，覆盖调用参数，避免跨实例释放其他会话的写入者。 */
  archive(params, verify) {
    this.client.assertCurrent();
    return super.archive({ ...params, processId: this.instance.pid, processStartedAt: this.instance.startedAt, nativePipe: this.instance.nativePipe, codexHome: this.instance.codexHome }, async () => { this.client.assertCurrent(); await verify(); });
  }
}
class InstanceGoalController extends DesktopGoalController {
  constructor(instance, client, options) { super(options); this.instance = instance; this.client = client; }
  perform(params, verify) { this.client.assertCurrent(); return super.perform({ ...params, processId: this.instance.pid, nativePipe: this.instance.nativePipe }, async () => { this.client.assertCurrent(); await verify(); }); }
}

/** 一个实例一份上下文，默认实例沿用原账本，其余实例独立保存附件和去重状态。 */
export class InstanceRuntime {
  constructor({ instance, config, dataPath, send, bind = bindInstanceClients, diagnostics = null }) {
    this.instance = instance; this.bind = bind; this.closed = false; this.bindings = null;
    this.isMac = instance.platform === 'darwin';
    this.client = this.isMac ? new MacInstanceIpcClient({ instance, verify: () => instance.verify() }) : new InstanceIpcClient({ instance, socketPath: config.ipcSocketPath });
    this.native = new InstanceNativeDesktop(instance, this.client, { stateDirectory: instance.codexHome });
    this.adapter = new DesktopAdapter({ client: this.client, native: this.native, index: new StateReader(instance.codexHome), modelCatalog: new ModelCatalog({ codexHome: instance.codexHome }), attachments: new AttachmentStore({ root: path.join(dataPath, 'attachments') }), goalController: new InstanceGoalController(instance, this.client, { diagnosticPath: path.join(dataPath, 'goal-ui-diagnostics.jsonl') }), activateThread: this.isMac ? (id, options) => withDesktopUi(() => navigateMacInstance(instance, id, { ...options, verify: () => instance.verify() })) : undefined });
    const activate = this.adapter.activateThread;
    this.adapter.readActivityInventory = async options => {
      const current=await readInstanceActivity(instance);
      if(current.complete)return current;
      const saved=await DesktopAdapter.prototype.readActivityInventory.call(this.adapter,options);
      return {complete:false,threadIds:[...new Set([...current.threadIds,...saved.threadIds])]};
    };
    this.adapter.activateThread = async (id, options) => {
      const own = await this.adapter.discoverOwner(id, 400);
      if (!own && await this.client.ownedElsewhere(id)) throw new BridgeError('THREAD_OWNED_BY_OTHER_INSTANCE', '此聊天正在另一个实例中打开，请切换到对应设备');
      return activate(id, options);
    };
    // 目录查询和创建共用原实例的 CODEX_HOME 与已核验桌面随附 CLI。
    const desktopIdentity = { platform: instance.platform, executable: instance.executable };
    const newThreads = new NewThreadService({ codexHome: instance.codexHome, catalog: this.adapter.modelCatalog, settingsCache: config.newConversationSettingsCache, creation: new ThreadCreationClient({ codexHome: instance.codexHome, resolveCli: () => instanceCodexPath(desktopIdentity) }) });
    // 删除与草稿、文件汇总共用同一个已绑定实例，桌面升级不依赖旧版本的全局端口发现。
    this.agent = new BridgeAgent({ config: { ...config, codexHome: instance.codexHome }, newThreads, adapter: this.adapter, journal: new Journal(path.join(dataPath, 'journal.sqlite')), archiveController: new InstanceArchiveController(instance, this.client), diagnostics });
    this.agent.nativeDrafts.controller.close();
    this.agent.nativeDrafts.controller=new NativeDraftController({adapter:this.adapter,instance,discover:async()=>instance.alive&&instance.port?[{pid:instance.pid,port:instance.port,executable:instance.executable}]:[]});
    this.agent.predictions.close();
    this.agent.predictions = new ComposerPredictionReader({ discover: async () => instance.alive && instance.port ? [{ pid: instance.pid, port: instance.port }] : [] });
    this.agent.fileReports.close();
    this.agent.fileReports = new DesktopFileReportReader({ discover: async () => instance.alive && instance.port ? [{ pid: instance.pid, port: instance.port, executable:instance.executable }] : [] });
    this.agent.send = message => instance.alive && instance.ready && send({ ...message, hostId: instance.id, generation: instance.generation });
    this.client.on('disconnected', () => { instance.ready = false; this.agent.threadCache.clearSubscriptions(); });
  }
  /** Windows 单实例复用系统核验的独占 IPC，多实例继续核对页面来源。 */
  async ready() {
    if (this.closed || !this.instance.alive) return false;
    this.client.refreshRouterClients?.();
    if (this.instance.ready && (this.isMac || this.instance.directIpc || this.client.allowedClients.size)) { this.warmProjectCapabilities(); return true; }
    if (!this.bindings) this.bindings = (async () => {
      if (this.isMac) await this.instance.verify();
      try { await this.client.connect(); }
      catch (error) { this.client.close(); throw error; }
      let ids;
      if (this.isMac || this.instance.directIpc) ids = new Set();
      else if (this.instance.routerManaged) {
        this.client.refreshRouterClients();
        ids = this.client.allowedClients;
        if (!ids.size) {
          this.client.close();
          throw new BridgeError('INSTANCE_NOT_READY', '正在等待所选桌面连接本机管道');
        }
      } else ids = await this.bind(this.client, this.instance);
      if (this.closed || !this.instance.alive) return false;
      this.client.allowedClients = ids; this.instance.ready = true; this.instance.wasReady = true;
      this.warmProjectCapabilities();
      this.agent.threadCache.start();
      this.agent.threadListFeed.start();
      await this.agent.predictions.start(); return true;
    })().finally(() => { this.bindings = null; });
    return this.bindings;
  }
  /** 已核验实例上线后后台准备项目能力，不阻塞上线或提前创建桌面草稿。 */
  warmProjectCapabilities() {
    if (this.isMac) this.agent.nativeDrafts.controller.capabilities({ reuse: true }).catch(() => {});
  }
  async request(message) {
    if (message.generation !== this.instance.generation || !this.instance.alive ||
        (message.expectedGeneration !== undefined && message.expectedGeneration !== this.instance.generation)) {
      throw new BridgeError('INSTANCE_CHANGED', '实例已重启，请重新连接后核对原操作');
    }
    // 任务查询与订阅仅访问实例账本，复用绑定校验；提交和控制仍实时复核进程及管道身份。
    const readOnlyTask = ['tasks.list', 'tasks.watch', 'tasks.unwatch'].includes(message.method);
    if (!readOnlyTask && (this.isMac && message.method !== 'projects.list' || this.instance.directIpc && !READ_METHODS.has(message.method))) await this.instance.verify();
    this.client.assertCurrent();
    const response = await this.agent.handleRequest(message);
    if (message.method === 'projects.list' || readOnlyTask) this.client.assertCurrent();
    return response;
  }
  /** 先断开传输，停止时不再向已撤销身份的客户端发送退订，也不会遗留账本和连接。 */
  async close() { this.closed = true; this.instance.alive = false; this.instance.ready = false; this.client.close(); await this.agent.close(); }
}
