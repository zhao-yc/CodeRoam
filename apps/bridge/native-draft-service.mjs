import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { BridgeError, UPLOAD_METHODS, requireString, requestFingerprint, validDraftRevision, validateAttachmentScope, validateDraftRequest } from '../../packages/protocol/contracts.mjs';
import { validateImages } from '../../packages/protocol/images.mjs';

const unavailable = () => new BridgeError('DRAFT_UNAVAILABLE', '暂时无法核对原生草稿，请在电脑端确认后重新读取');
const isUnknown = error => error?.outcomeUnknown === true || !error?.code || /超时|连接已关闭|not-connected|timeout/i.test(error.message ?? '');

/** 身份只取原生草稿与窗口定位字段，忽略回读时会变化的快照、修订和焦点信息。 */
function bindingIdentity(binding, projectId) {
  if (!binding || typeof binding.clientDraftId !== 'string') return null;
  const identity = { projectId, clientDraftId: binding.clientDraftId };
  for (const [key, value] of Object.entries({ pid: binding.pid ?? binding.port?.pid, port: binding.port?.port, url: binding.url, windowId: binding.windowId, generation: binding.generation, instanceId: binding.instanceId, cwd: binding.cwd })) {
    if (typeof value === 'string' || Number.isSafeInteger(value)) identity[key] = value;
  }
  if (identity.pid === undefined && identity.url === undefined && identity.windowId === undefined) return null;
  return requestFingerprint('native-draft-binding', identity);
}

/** 只投影手机需要的模型和权限字段，原生窗口、客户端草稿编号和工作目录始终留在服务内。 */
function publicSnapshot(entry, native) {
  const strings = values => values.every(value => typeof value === 'string');
  if (!native || !validDraftRevision(native.revision) || !['ready', 'detached', 'promoted'].includes(native.status) || typeof native.hasDesktopText !== 'boolean' ||
      !native.settings || !strings(['model', 'effort', 'serviceTier', 'mode'].map(key => native.settings[key])) || !['default', 'plan'].includes(native.settings.mode) ||
      !Array.isArray(native.models) || !native.permissions || typeof native.permissions.mode !== 'string' || !validDraftRevision(native.permissions.revision) || !Array.isArray(native.permissions.options)) throw unavailable();
  const models = native.models.map(model => {
    if (!model || !strings([model.id, model.label, model.defaultEffort]) || !Array.isArray(model.efforts) || !strings(model.efforts) || !Array.isArray(model.speeds) || typeof model.supportsImages !== 'boolean') throw unavailable();
    return {
      id: model.id, label: model.label, defaultEffort: model.defaultEffort, efforts: [...model.efforts], supportsImages: model.supportsImages,
      speeds: model.speeds.map(speed => {
        if (!speed || !strings([speed.id, speed.label]) || (speed.description !== undefined && typeof speed.description !== 'string')) throw unavailable();
        return { id: speed.id, label: speed.label, ...(speed.description === undefined ? {} : { description: speed.description }) };
      }),
    };
  });
  const permissions = {
    mode: native.permissions.mode, revision: native.permissions.revision,
    options: native.permissions.options.map(option => {
      if (!option || !strings([option.id, option.label]) || typeof option.enabled !== 'boolean' || ['description', 'disabledReason'].some(key => option[key] !== undefined && typeof option[key] !== 'string')) throw unavailable();
      return { id: option.id, label: option.label, enabled: option.enabled,
        ...(option.description === undefined ? {} : { description: option.description }),
        ...(option.disabledReason === undefined ? {} : { disabledReason: option.disabledReason }) };
    }),
    ...(typeof native.permissions.reviewer === 'string' ? { reviewer: native.permissions.reviewer } : {}),
  };
  if (native.threadId !== undefined) requireString(native.threadId, '聊天编号', 200);
  return {
    draftId: entry.draftId, projectId: entry.projectId, revision: native.revision, status: native.status,
    settings: Object.fromEntries(['model', 'effort', 'serviceTier', 'mode'].map(key => [key, native.settings[key]])),
    models, permissions, ...(native.threadId === undefined ? {} : { threadId: native.threadId }), hasDesktopText: native.hasDesktopText,
  };
}

/** 以设备和项目管理原生草稿；所有桌面动作只交给控制器，不读取旧配置或模型缓存。 */
export class NativeDraftService extends EventEmitter {
  constructor({ controller, projects, attachments, now = Date.now }) {
    super();
    this.controller = controller;
    this.projects = projects;
    this.attachments = attachments;
    this.now = now;
    this.sessions = new Map();
    this.current = new Map();
    this.locks = new Map();
    this.unknownOpens = new Map();
    this.commands = new Map();
    this.closed = false;
    this.timer = null;
  }

  /** 关闭后拒绝新请求，也禁止迟到的原生响应重新建立会话或订阅。 */
  assertOpen() {
    if (this.closed) throw new BridgeError('DRAFT_SERVICE_CLOSED', '原生草稿服务已关闭');
  }

  /** 项目锁覆盖回读、修订核验、附件落盘和原生写入，避免两台手机在同一项目交错提交。 */
  async locked(projectId, operation) {
    this.assertOpen();
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    this.locks.set(projectId, gate);
    await previous;
    try { this.assertOpen(); return await operation(); }
    finally { release(); if (this.locks.get(projectId) === gate) this.locks.delete(projectId); }
  }

  /** UUID 仅是公开索引，必须同时匹配设备；未知和越权请求使用相同提示。 */
  session(draftId, deviceId) {
    this.assertOpen();
    requireString(deviceId, '设备编号', 200);
    const entry = this.sessions.get(draftId);
    if (!entry || entry.deviceId !== deviceId) throw new BridgeError('DRAFT_NOT_FOUND', '草稿不存在或不属于当前设备，请重新打开新聊天');
    return entry;
  }

  /** 只在修订号或状态变化时发布；返回副本，避免消费者篡改服务里的并发基线。 */
  accept(entry, native, notify = true) {
    this.assertOpen();
    const snapshot = publicSnapshot(entry, native), previous = entry.snapshot;
    // 已确认创建的聊天不可被迟到的 ready 响应变回可发送的草稿。
    if (previous?.status === 'promoted' && snapshot.status !== 'promoted') return structuredClone(previous);
    entry.snapshot = snapshot;
    entry.observedAt = this.now();
    if (notify && entry.watching && previous && (previous.revision !== snapshot.revision || previous.status !== snapshot.status)) {
      this.emit('changed', { deviceId: entry.deviceId, snapshot: structuredClone(snapshot) });
    }
    return structuredClone(snapshot);
  }

  /** 每次写入都重新核对实际原生状态；未知写入不能靠换请求编号或恢复订阅重放。 */
  writable(entry, expectedRevision) {
    if (entry.snapshot.status === 'detached') throw new BridgeError('DRAFT_DETACHED', '原生草稿已离开当前桌面，请重新打开新聊天');
    if (entry.snapshot.status === 'promoted') throw new BridgeError('DRAFT_PROMOTED', '电脑端已发送此草稿，请打开已创建的聊天');
    if (entry.uncertain) throw new BridgeError('OUTCOME_UNKNOWN', '草稿操作结果尚未确认，请先核对电脑端，不要重新发送', true);
    if (expectedRevision !== undefined && entry.snapshot.revision !== expectedRevision) throw new BridgeError('DRAFT_CHANGED', '电脑端草稿已经变化，请重新读取后操作');
  }

  /** 每次显式打开都走原生按钮；只有返回相同原生身份时才复用公开 token。 */
  async open(params, deviceId, commandId, checkpoint = () => {}) {
    validateDraftRequest('thread.draft.open', params);
    requireString(deviceId, '设备编号', 200);
    return this.locked(params.projectId, async () => {
      const key = JSON.stringify([deviceId, params.projectId]);
      if (this.unknownOpens.has(key)) throw new BridgeError('OUTCOME_UNKNOWN', '上次原生新聊天结果尚未确认，当前无法安全再次打开，请先核对电脑端', true);
      if (await this.controller.capabilities() !== true) throw new BridgeError('DRAFT_UNSUPPORTED', '当前电脑暂不支持原生新聊天，请升级后重试');
      this.assertOpen();
      const project = await this.projects.project(params.projectId);
      if (!project || project.id !== params.projectId) throw new BridgeError('PROJECT_NOT_FOUND', '项目已不存在，请重新选择电脑端项目');
      const command = { method: 'thread.draft.open', fingerprint: requestFingerprint('thread.draft.open', params), deviceId, commandId, key, project: { ...project } };
      this.commands.set(JSON.stringify([deviceId, commandId]), command);
      this.unknownOpens.set(key, command);
      let entry, returned = false;
      try {
        const opened = await this.controller.open(project, commandId);
        returned = true;
        this.assertOpen();
        if (!opened || opened.binding == null) throw unavailable();
        const identity = bindingIdentity(opened.binding, project.id);
        entry = identity ? [...this.sessions.values()].find(value => value.deviceId === deviceId && value.projectId === project.id && value.bindingIdentity === identity) : undefined;
        const existed = !!entry;
        entry ??= { draftId: randomUUID(), projectId: project.id, project: { ...project }, deviceId, watching: true, watchEpoch: 0 };
        Object.assign(entry, { binding: opened.binding, bindingIdentity: identity });
        command.entry = entry;
        const snapshot = this.accept(entry, opened.snapshot, existed);
        this.sessions.set(entry.draftId, entry);
        this.current.set(key, entry.draftId);
        entry.watching = true;
        this.syncTimer();
        await checkpoint({ draftId: entry.draftId, snapshot: structuredClone(snapshot) });
        this.unknownOpens.delete(key);
        command.confirmed = true;
        return snapshot;
      } catch (error) {
        // 控制器可能在按钮已执行后的 settle 阶段失败，不能把普通读取错误当作未打开的证据。
        const refused = !returned && ['DRAFT_WINDOW_AMBIGUOUS', 'DRAFT_UNSUPPORTED'].includes(error.code) && error.outcomeUnknown !== true;
        if (refused && !this.closed) this.unknownOpens.delete(key);
        if (this.closed) throw new BridgeError('DRAFT_SERVICE_CLOSED', '原生草稿服务已关闭', true);
        return this.writeFailed(entry, error, !refused);
      }
    });
  }

  /** 显式读取恢复订阅；读取期间到达的 unwatch 优先，迟到响应不会撤销它。 */
  async read(params, deviceId) {
    validateDraftRequest('thread.draft.read', params);
    const entry = this.session(params.draftId, deviceId), epoch = entry.watchEpoch;
    return this.locked(entry.projectId, async () => {
      const snapshot = this.accept(entry, await this.controller.read(entry.binding));
      if (epoch === entry.watchEpoch) entry.watching = true;
      this.syncTimer();
      return snapshot;
    });
  }

  /** 控制器写入返回后仍须保留公开检查点，后续失败时外层账本可核对结果。 */
  async update(params, deviceId, commandId, checkpoint = () => {}) {
    validateDraftRequest('thread.draft.update', params);
    const entry = this.session(params.draftId, deviceId);
    return this.locked(entry.projectId, async () => {
      this.accept(entry, await this.controller.read(entry.binding));
      this.writable(entry, params.expectedRevision);
      const command = { method: 'thread.draft.update', fingerprint: requestFingerprint('thread.draft.update', params), deviceId, commandId, entry, changes: structuredClone(params.changes), beforeRevision: entry.snapshot.revision };
      this.commands.set(JSON.stringify([deviceId, commandId]), command);
      let returned = false;
      try {
        const native = await this.controller.update(entry.binding, structuredClone(params.changes), { expectedRevision: params.expectedRevision, confirmedFullAccess: params.confirmedFullAccess, commandId });
        returned = true;
        const snapshot = this.accept(entry, native);
        command.confirmedSnapshot = structuredClone(snapshot);
        await checkpoint({ draftId: entry.draftId, snapshot: structuredClone(snapshot) });
        return snapshot;
      } catch (error) { return this.writeFailed(entry, error, returned); }
    });
  }

  /** 原生接收后发生的异常一律视为未知；确定被拒绝的业务错误才允许用户刷新后重试。 */
  writeFailed(entry, error, returned = false) {
    if (this.closed || returned || isUnknown(error)) {
      if (entry) entry.uncertain = true;
      throw new BridgeError('OUTCOME_UNKNOWN', '连接中断或原生回执未确认，请先核对电脑端，不要重新发送', true);
    }
    throw error;
  }

  /** 附件只在就绪状态、修订核验和电脑正文占用检查之后落盘；手机不能提交工作目录或文件路径。 */
  async send(params, deviceId, commandId, checkpoint = () => {}) {
    validateDraftRequest('thread.draft.send', params);
    const images = validateImages(params.images), entry = this.session(params.draftId, deviceId);
    return this.locked(entry.projectId, async () => {
      this.accept(entry, await this.controller.read(entry.binding));
      this.writable(entry, params.expectedRevision);
      if (entry.snapshot.hasDesktopText) throw new BridgeError('DRAFT_HAS_DESKTOP_TEXT', '电脑端草稿已有正文，请先在电脑端处理后再发送');
      const files = this.attachments.materialize(deviceId, 'draft:' + entry.draftId, params.attachments, entry.project.cwd, images.length);
      const command = { method: 'thread.draft.send', fingerprint: requestFingerprint('thread.draft.send', params), deviceId, commandId, entry };
      this.commands.set(JSON.stringify([deviceId, commandId]), command);
      let returned = false, created = false, creationCheckpoint;
      // onCreated 同步固化状态并立即调用检查点；控制器无需等待异步账本也不能触发第二次发送。
      const onCreated = result => {
        this.assertOpen();
        const threadId = typeof result === 'string' ? result : result?.threadId;
        requireString(threadId, '聊天编号', 200);
        if (entry.snapshot.status === 'promoted' && entry.snapshot.threadId !== threadId) throw unavailable();
        created = true;
        command.threadId = threadId;
        const snapshot = this.accept(entry, { ...entry.snapshot, status: 'promoted', threadId });
        creationCheckpoint = Promise.resolve(checkpoint({ draftId: entry.draftId, threadId, snapshot }));
        // 某些原生实现不 await 回调，先接住拒绝，仍在 send 收口时传播检查点错误。
        creationCheckpoint.catch(() => {});
        return creationCheckpoint;
      };
      try {
        // input 的 attachments 是由 AttachmentStore 核验过的文件描述，禁止透传手机附件编号或任意路径。
        const result = await this.controller.send(entry.binding, { text: params.text, images, attachments: files }, { expectedRevision: params.expectedRevision, commandId, onCreated });
        returned = true;
        this.assertOpen();
        requireString(result?.threadId, '聊天编号', 200);
        if (created && entry.snapshot.threadId !== result.threadId) throw unavailable();
        await creationCheckpoint;
        const snapshot = this.accept(entry, { ...(result.snapshot ?? entry.snapshot), status: 'promoted', threadId: result.threadId });
        const response = { draftId: entry.draftId, threadId: result.threadId, snapshot };
        await checkpoint(structuredClone(response));
        return response;
      } catch (error) { return this.writeFailed(entry, error, returned || created); }
    });
  }

  /** command.status 仅回读原绑定并核对原指纹；没有创建回执的 promoted 不能归因于手机发送。 */
  async commandStatus(journal, deviceId, commandId) {
    const original = journal.status(deviceId, commandId);
    if (original.state !== 'unknown' || this.closed) return original;
    const command = this.commands.get(JSON.stringify([deviceId, commandId]));
    const fingerprint = journal.unknownFingerprint?.(deviceId, commandId);
    if (!command || command.fingerprint !== fingerprint) return original;
    const projectId = command.entry?.projectId ?? command.project?.id;
    if (!projectId) return original;
    try {
      return await this.locked(projectId, async () => {
        let entry = command.entry;
        if (!entry && command.method === 'thread.draft.open' && typeof this.controller.recoverOpen === 'function') {
          // 控制器只查原 renderer 命令 guard，不触发按钮；无原命令绑定时必须保持未知。
          const recovered = await this.controller.recoverOpen({ ...command.project }, commandId);
          this.assertOpen();
          if (!recovered || recovered.binding == null) return original;
          const identity = bindingIdentity(recovered.binding, projectId);
          entry = identity ? [...this.sessions.values()].find(value => value.deviceId === deviceId && value.projectId === projectId && value.bindingIdentity === identity) : undefined;
          entry ??= { draftId: randomUUID(), projectId, project: { ...command.project }, deviceId, watching: false, watchEpoch: 0 };
          Object.assign(entry, { binding: recovered.binding, bindingIdentity: identity });
          this.accept(entry, recovered.snapshot, false);
          command.entry = entry;
        }
        if (!entry) return original;
        const snapshot = this.accept(entry, await this.controller.read(entry.binding));
        let result;
        if (command.method === 'thread.draft.open') result = snapshot;
        if (command.method === 'thread.draft.update' && (command.confirmedSnapshot || snapshot.status === 'ready' && snapshot.revision !== command.beforeRevision && Object.entries(command.changes).every(([key, value]) => (key === 'permissionMode' ? snapshot.permissions.mode : snapshot.settings[key]) === value))) result = snapshot;
        if (command.method === 'thread.draft.send' && command.threadId && snapshot.status === 'promoted' && snapshot.threadId === command.threadId) result = { draftId: entry.draftId, threadId: command.threadId, snapshot };
        if (!result) return original;
        // 只收口自有 Journal 的原未知记录，条件更新不能覆盖并发处理或其他设备的命令。
        if (!journal.db?.prepare) return original;
        const payload = { result, resolution: { source: 'native-draft-state', confirmedAt: this.now(), previousError: original.error ?? null } };
        const updated = journal.db.prepare("UPDATE commands SET state='done',payload=? WHERE device_id=? AND command_id=? AND fingerprint=? AND state='unknown'").run(JSON.stringify(payload), deviceId, commandId, fingerprint);
        if (updated.changes !== 1) return journal.status(deviceId, commandId);
        entry.uncertain = false;
        this.sessions.set(entry.draftId, entry);
        if (command.method === 'thread.draft.open' && this.unknownOpens.get(command.key) === command) { this.unknownOpens.delete(command.key); this.current.set(command.key, entry.draftId); }
        return journal.status(deviceId, commandId);
      });
    } catch { return original; }
  }

  /** 上传路由仅接收已鉴权的草稿作用域；聊天上传仍由原聊天订阅适配器鉴权。 */
  async transfer(method, params, deviceId) {
    if (!UPLOAD_METHODS.has(method)) throw new BridgeError('METHOD_NOT_ALLOWED', '此操作不在允许的附件接口列表中');
    const scope = validateAttachmentScope(params);
    if (!scope.draftId) throw new BridgeError('BAD_PARAMS', '聊天附件请通过聊天订阅服务上传');
    const entry = this.session(scope.draftId, deviceId);
    return this.locked(entry.projectId, async () => {
      if (method !== 'attachment.abort') {
        this.accept(entry, await this.controller.read(entry.binding));
        this.writable(entry);
      }
      const { draftId, ...input } = params;
      return this.attachments[method.slice('attachment.'.length)](deviceId, 'draft:' + draftId, input);
    });
  }

  /** 取消订阅只停止观察，保留 UUID 与原生草稿；之后显式 read 可以恢复。 */
  unwatch(params, deviceId) {
    validateDraftRequest('thread.draft.unwatch', params);
    const entry = this.session(params.draftId, deviceId);
    entry.watching = false;
    entry.watchEpoch++;
    this.syncTimer();
    return { ok: true };
  }

  /** 每秒仅轮询已订阅草稿；慢读取不会累积队列，失败不伪造缓存状态或自动重放写入。 */
  syncTimer() {
    const watched = !this.closed && [...this.sessions.values()].some(entry => entry.watching);
    if (!watched && this.timer) { clearInterval(this.timer); this.timer = null; }
    if (watched && !this.timer) {
      this.timer = setInterval(() => {
        for (const entry of this.sessions.values()) {
          if (!entry.watching || entry.polling) continue;
          entry.polling = true;
          const epoch = entry.watchEpoch;
          this.locked(entry.projectId, async () => {
            if (!entry.watching || entry.watchEpoch !== epoch) return;
            const native = await this.controller.read(entry.binding);
            if (!this.closed && entry.watching && entry.watchEpoch === epoch) this.accept(entry, native);
          }).catch(() => {}).finally(() => { entry.polling = false; });
        }
      }, 1000);
      this.timer.unref?.();
    }
  }

  /** 先撤销所有观察再关闭原生连接，避免关闭期间的迟到读取或回调重新发送事件。 */
  close() {
    if (this.closed) return this.closing;
    this.closed = true;
    for (const entry of this.sessions.values()) { entry.watching = false; entry.watchEpoch++; }
    this.syncTimer();
    this.closing = Promise.resolve().then(() => this.controller.close());
    return this.closing;
  }
}
