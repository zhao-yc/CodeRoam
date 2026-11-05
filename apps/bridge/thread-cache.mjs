import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { BridgeError, MAX_CONVERSATION_CACHE_THREADS } from '../../packages/protocol/contracts.mjs';
import { conversationContentRevision, conversationProjection, existingConversationSnapshot } from './conversation-prefetch.mjs';
import { conversationUpdate } from './updates.mjs';
import { ConversationCacheStore } from './conversation-cache-store.mjs';
import { RECENT_CONVERSATION_OPTIONS, CONVERSATION_PAGE_SIZE, CONVERSATION_PAGE_BYTES } from './conversation-page.mjs';

export const CACHE_WATCHER = Symbol('缓存只读跟随');
export const CACHE_THREAD_LIMIT = MAX_CONVERSATION_CACHE_THREADS;
const MAX_SUBSCRIPTIONS = 128;

/** 每个桌面实例独立保留有限的展示正文，订阅身份和实时权限只在内存中存在。 */
export class ThreadCacheFeed {
  constructor({ adapter, db, send, blocked, removed = () => {}, listRows }) {
    this.adapter = adapter;
    this.db = db;
    this.send = send;
    this.blocked = blocked;
    this.removed = removed;
    this.listRows = listRows;
    this.subscriptions = new Map();
    this.targets = new Set();
    this.recent = new Set();
    this.verified = new Set();
    this.liveVersions = new Map();
    this.saved = new Map();
    this.reading = new Map();
    this.nextProbe = new Map();
    this.probes = new Set();
    this.closed = false;
    this.mode = 'legacy';this.activity = new Set();this.lifecycle = new Map();this.maintenanceGeneration=0;
    this.cacheStore = new ConversationCacheStore({
      db, blocked, visible: ids => this.adapter.index?.visibleThreadIds?.(ids) ?? null,
      onMissing: id => this.forget(id, { storeCleared: true }),
    });
  }

  /** 新协议只跟随实际活动，轻维护释放内部正文状态而不碰真实详情订阅。 */
  setMode(mode) {
    if(!['legacy','online','grace','light'].includes(mode)||mode===this.mode)return;
    // 降频前保存最后一份展示窗口；轻维护中不按短周期重试正文写入。
    if(mode==='light')this.cacheStore.flush();
    this.cacheStore.setPaused(mode==='light');
    if(mode==='light')this.cacheStore.trimClean();
    this.mode=mode;
    this.maintenanceGeneration++;
    if(mode==='light') {
      clearTimeout(this.timer);this.timer=null;this.dirty=false;
      this.sourceView?.close?.();
      for(const id of this.targets)this.stopFollowing(id);
      this.saved.clear();this.reading.clear();this.liveVersions.clear();
    }
    if(this.interval){clearInterval(this.interval);this.interval=null;this.start();}
    else this.start();
  }
  /** 不完整活动查询只增加候选；失败和缺席不能证明先前任务已经结束。 */
  setActivityInventory(inventory) {
    if(!inventory||!Array.isArray(inventory.threadIds))return;
    if(inventory.complete)this.activity=new Set(inventory.threadIds);
    else for(const id of inventory.threadIds)this.activity.add(id);
  }
  /** 终态先保存再释放内部跟随，静态副本不继续持有完整桌面 state。 */
  settled(snapshot) {
    if(this.closed||this.blocked(snapshot.threadId))return;
    this.remember(snapshot.threadId);
    try {
      if(this.liveEntry(snapshot.threadId))this.save(snapshot);
      this.cacheStore.flush([snapshot.threadId]);
    } catch { /* 展示缓存失败不能阻断任务终态和内部订阅释放。 */ }
    finally {
      this.activity.delete(snapshot.threadId);this.liveVersions.delete(snapshot.threadId);
      this.stopFollowing(snapshot.threadId);
    }
  }

  /** 文件通知及时触发，低频元数据核对补偿漏报和在其他目录追加的日志。 */
  start() {
    if (this.interval || this.closed || !this.db || !this.adapter.index?.historyCacheSource || !this.adapter.index?.list) return;
    const file = this.adapter.index.filePath;
    if (file && !this.watcher) {
      try {
        const name = path.basename(file);
        this.watcher = fs.watch(path.dirname(file), { persistent: false }, (_event, filename) => {
          if (filename == null || [name, name + '-wal', 'session_index.jsonl'].includes(String(filename))) this.schedule();
        });
        this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
      } catch { /* 索引尚未创建时由低频核对恢复。 */ }
    }
    this.interval = setInterval(() => this.schedule(0), this.mode==='light'?15000:2000);
    this.interval.unref();
    if(this.mode!=='light')this.schedule(0);
  }

  /** 成功仅确认登记。初始快照和之后的更新都走同一条设备专属事件流。 */
  watch(deviceId, { subscriptionId, threads, verify = [] }) {
    if (!this.db || !this.adapter.index?.historyCacheSource) throw new BridgeError('METHOD_NOT_ALLOWED', '此连接服务暂不支持后台聊天缓存');
    const key = JSON.stringify([deviceId, subscriptionId]);
    if (!this.subscriptions.has(key) && this.subscriptions.size >= MAX_SUBSCRIPTIONS) throw new BridgeError('TOO_MANY_CACHE_SUBSCRIPTIONS', '后台聊天订阅过多，请关闭不用的页面');
    this.subscriptions.delete(key);
    const versions = new Map(threads.map(row => [row.threadId, row.revision]));
    const verifyOnly = new Set(verify.filter(id => !versions.has(id)));
    this.subscriptions.set(key, { deviceId, subscriptionId, versions, verify: verifyOnly });
    this.start();
    this.schedule(0);
    return { ok: true };
  }

  /** 退订只取消这一条传输，守护进程继续更新本机最近聊天。 */
  unwatch(deviceId, { subscriptionId }) {
    this.subscriptions.delete(JSON.stringify([deviceId, subscriptionId]));
    this.schedule();
    return { ok: true };
  }

  /** 中转换线时废弃旧设备订阅，但保留已同步的本机快照。 */
  clearSubscriptions() {
    this.subscriptions.clear();
    this.schedule();
  }

  schedule(delay = 250) {
    if (this.closed || !this.db || !this.adapter.index?.historyCacheSource) return;
    if(this.mode==='light'&&delay>0){this.dirty=true;return;}
    if (this.running) { this.dirty = true; return; }
    if (this.timer && delay > 0) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh().catch(() => {});
    }, delay);
    this.timer.unref();
  }

  /** 最近打开的聊天与移动端关注目标优先，所有设备共用同一个二十条窗口。 */
  remember(threadId) {
    this.recent.delete(threadId);
    this.recent.add(threadId);
    if (this.recent.size > CACHE_THREAD_LIMIT) this.recent.delete(this.recent.values().next().value);
  }

  row(threadId) {
    return this.cacheStore.row(threadId);
  }

  /** 只接受同一实例和会话的两份可验证展示基线。 */
  baseline(threadId, revision) {
    return this.cacheStore.baseline(threadId, revision);
  }

  /** 打开详情先核验索引和 IPC 身份，已有持久窗口只在来源版本相同时直接使用。 */
  async preview(threadId) {
    if (this.closed || this.blocked(threadId) || !this.adapter.index?.historyCacheSource) return undefined;
    const source = this.adapter.index.historyCacheSource(threadId);
    let snapshot;
    if (this.liveEntry(threadId)) snapshot = existingConversationSnapshot(this.adapter, threadId);
    else {
      const row = this.row(threadId);
      if (source && row?.saved_source === source) {
        try {
          const saved = JSON.parse(row.snapshot);
          if (saved?.threadId === threadId && Array.isArray(saved.messages) && Array.isArray(saved.turns) && saved.messages.length <= CONVERSATION_PAGE_SIZE && (saved.messages.length <= 1 || Buffer.byteLength(JSON.stringify(saved.messages)) <= CONVERSATION_PAGE_BYTES)) snapshot = saved;
        } catch { /* 损坏的展示副本按原历史来源重新读取。 */ }
      }
      snapshot ??= await this.readSaved(threadId, source);
    }
    if (this.closed || this.blocked(threadId)) return undefined;
    // 等待历史期间可能已删除或加载到桌面，返回前再核验并优先采用当前所有者。
    this.adapter.index.historyCacheSource(threadId);
    if (this.liveEntry(threadId)) snapshot = existingConversationSnapshot(this.adapter, threadId);
    if (snapshot?.threadId !== threadId) return undefined;
    const projection = conversationProjection(snapshot);
    return {
      snapshot: { ...projection, readOnly: true, status: 'unknown', activeTurnId: '', approvals: [], questionGroups: [], updatedAt: 0 },
      contentRevision: conversationContentRevision(projection),
    };
  }

  /** 最新两版展示立即进入内存和推送，普通落盘由固定合并窗口负责。 */
  save(source, savedSource) {
    if (this.closed || !this.db || this.blocked(source.threadId)) return;
    const record = this.cacheStore.stage(source, savedSource);
    if (!record) return;
    const latest = source.latestTurn?.status ?? source.turns?.at(-1)?.status;
    // 终态即使仍被前台详情查看，也必须保存最终窗口；轻维护只在已确认历史终态时走到此处。
    try { this.deliver(record.snapshot, record.revision, record.baseRevision, record.baseSnapshot); }
    finally {
      if (this.mode==='light'||!source.activeTurnId&&source.status!=='active'&&['completed','failed','interrupted','reviewStopped'].includes(latest))this.cacheStore.flush([source.threadId]);
    }
  }

  /** 只有指定设备和订阅才收到其关注会话的最新展示正文。 */
  deliver(snapshot, revision, baseRevision, baseSnapshot) {
    const deltas = new Map();
    for (const { deviceId, subscriptionId, versions } of this.subscriptions.values()) {
      const previous = versions.get(snapshot.threadId);
      if (previous === undefined || previous === revision) continue;
      if (!deltas.has(previous)) {
        let update;
        try {
          const baseline = previous===baseRevision&&baseSnapshot ? (typeof baseSnapshot==='string'?JSON.parse(baseSnapshot):baseSnapshot) : this.baseline(snapshot.threadId,previous);
          if (baseline) update=conversationUpdate({snapshot:baseline},snapshot);
        } catch { /* 基线不可用仍发送当前完整展示，不能让数据库故障阻断实时推送。 */ }
        deltas.set(previous,update??null);
      }
      const update = deltas.get(previous);
      const body = update?.kind === 'delta' ? { baseRevision: previous, update: update.update } : { snapshot };
      if (this.send({ v: 1, type: 'thread.cache.event', deviceId, subscriptionId, threadId: snapshot.threadId, revision, ...body }) !== false) versions.set(snapshot.threadId, revision);
    }
  }

  deliverStored(threadId, revision) {
    if (![...this.subscriptions.values()].some(({ versions }) => versions.has(threadId) && versions.get(threadId) !== revision)) return;
    const row = this.row(threadId);
    if (!row) return;
    this.deliver(JSON.parse(row.snapshot), row.revision, row.previous_revision, row.previous_snapshot);
  }

  /** 归档、删除及索引确认不存在时，移除两版正文和正在使用的内部跟随。 */
  forget(threadId, {storeCleared=false}={}) {
    if(!storeCleared)this.cacheStore.forget(threadId);
    this.saved.delete(threadId);
    this.reading.delete(threadId);
    this.verified.delete(threadId);
    this.liveVersions.delete(threadId);
    this.recent.delete(threadId);
    this.targets.delete(threadId);
    this.nextProbe.delete(threadId);
    this.stopFollowing(threadId);
    this.removed(threadId);
    for (const { deviceId, subscriptionId, versions, verify } of this.subscriptions.values()) {
      if (!versions.has(threadId) && !verify.has(threadId)) continue;
      if (this.send({ v: 1, type: 'thread.cache.event', deviceId, subscriptionId, threadId, revision: '', removed: true }) !== false) {
        versions.delete(threadId);
        verify.delete(threadId);
      }
    }
  }

  /** 只用成功的索引查询确认移除，待核对的手机缓存不占后台正文跟随额度。 */
  checkMembership() {
    const ids = new Set(this.db.prepare('SELECT thread_id FROM conversation_cache').all().map(row => row.thread_id));
    // 合并窗口内的新副本尚未落盘，也必须参加归档和删除核对。
    for (const id of this.cacheStore.records.keys()) ids.add(id);
    // 正在查看的详情即使超出最近窗口，也需要收到明确的归档或删除结果。
    for (const [id, entry] of this.adapter.conversations ?? []) {
      if ([...entry.watchers ?? []].some(watcher => watcher !== 'list-status' && watcher !== CACHE_WATCHER)) ids.add(id);
    }
    for (const { versions, verify } of this.subscriptions.values()) {
      for (const id of versions.keys()) ids.add(id);
      for (const id of verify) ids.add(id);
    }
    if (!ids.size) return;
    let visible;
    try { visible = this.adapter.index.visibleThreadIds([...ids]); }
    catch { return; }
    for (const id of ids) if (!visible.has(id)) this.forget(id);
  }

  /** 只从桌面适配器已确认所有者的实时数据提取展示缓存。 */
  captureLive(snapshot) {
    const id = snapshot.threadId;
    if (this.closed || this.mode==='light' || !this.db || snapshot.readOnly || this.blocked(id) || (!this.targets.has(id) && !this.recent.has(id))) return;
    const entry = this.liveEntry(id);
    if (!entry || (!this.verified.has(id) && !this.adapter.index?.containsThread?.(id))) return;
    this.save(snapshot);
    if (this.targets.has(id)) this.liveVersions.set(id, { entry, state: entry.state, revision: entry.revision });
  }

  liveEntry(id) {
    const entry = this.adapter.conversations?.get(id);
    if (!entry?.owner || !entry.state) return undefined;
    const client = this.adapter.client;
    try { client?.assertCurrent?.(); } catch { return undefined; }
    if (client?.allowedClients instanceof Set && !client.allowedClients.has(entry.owner.clientId)) return undefined;
    return entry;
  }

  /** 历史未变时复用内存回执，同一会话的前台读取和后台刷新共享一次解析。 */
  readSaved(threadId, source = this.adapter.index.historyCacheSource(threadId)) {
    const previous = this.saved.get(threadId);
    if (source && previous?.source === source) return previous.snapshot;
    const pending = this.reading.get(threadId);
    if (pending) return pending;
    const reading = Promise.resolve().then(async () => {
      let snapshot;
      for (let attempt = 0; attempt < 2; attempt++) {
        snapshot = await this.adapter.index.readHistory(threadId, RECENT_CONVERSATION_OPTIONS);
        if (snapshot?.threadId !== threadId) throw new BridgeError('HISTORY_ID_MISMATCH', '保存的聊天历史编号不一致');
        const current = this.adapter.index.historyCacheSource(threadId);
        if (this.closed || this.blocked(threadId) || this.reading.get(threadId) !== reading) throw new BridgeError('SUBSCRIPTION_CANCELED', '已取消旧的聊天历史读取');
        if (source !== current) { source = current; continue; }
        if (source && (this.targets.has(threadId) || this.recent.has(threadId))) {
          this.saved.delete(threadId);
          this.saved.set(threadId, { source, snapshot });
          if (this.saved.size > CACHE_THREAD_LIMIT) this.saved.delete(this.saved.keys().next().value);
          // 持久化是加速路径，磁盘写入失败仍可返回原始只读历史。
          try { if (!this.liveEntry(threadId)) this.save(snapshot, source); } catch { /* 下次索引核对再尝试。 */ }
        }
        return snapshot;
      }
      // 连续追加的文件可显示最后一次完整读取，等稳定后再写缓存。
      return snapshot;
    }).finally(() => { if (this.reading.get(threadId) === reading) this.reading.delete(threadId); });
    this.reading.set(threadId, reading);
    return reading;
  }

  /** 少量并行探测可跟随的原桌面，已加载时共用现有 IPC 状态。 */
  follow(threadId) {
    const entry = this.liveEntry(threadId);
    if(this.mode==='light'||this.mode!=='legacy'&&!this.activity.has(threadId)&&entry?.state?.threadRuntimeStatus?.type!=='active')return;
    if (entry) {
      entry.watchers.add(CACHE_WATCHER);
      return;
    }
    // 列表或详情已经在取得同一快照时，让其现有请求完成，避免重复发现所有者。
    if(this.adapter.conversations?.has(threadId))return;
    if (!this.adapter.watch || this.probes.size >= 2 || this.probes.has(threadId) || (this.nextProbe.get(threadId) ?? 0) > Date.now()) return;
    this.probes.add(threadId);
    const generation=this.maintenanceGeneration;
    this.nextProbe.set(threadId, Date.now() + 10000);
    this.adapter.watch(threadId, CACHE_WATCHER, { history: false, ownerTimeoutMs: 350, snapshotTimeoutMs: 1000,isCurrent:()=>!this.closed&&generation===this.maintenanceGeneration&&this.mode!=='light'&&this.targets.has(threadId)&&!this.blocked(threadId) })
      .then(snapshot => this.captureLive(snapshot)).catch(() => {}).finally(() => {
        this.probes.delete(threadId);
        if (this.closed || generation!==this.maintenanceGeneration || this.mode==='light' || !this.targets.has(threadId) || this.blocked(threadId)) this.stopFollowing(threadId);
      });
  }

  stopFollowing(id) {
    if (this.adapter.conversations?.get(id)?.watchers.has(CACHE_WATCHER)) this.adapter.unwatch(id, CACHE_WATCHER);
  }

  /** 逐条让出事件循环，缓存预热不连续占用正在打开的详情请求。 */
  async refresh() {
    if (this.closed || !this.db || this.running) return;
    this.running = true;
    try {
      this.checkMembership();
      const requested = [...this.subscriptions.values()].reverse().flatMap(({ versions }) => [...versions.keys()]);
      // 列表已预热时复用其最近排序；成员和来源仍在本轮另行新鲜核验。
      const latest = (this.listRows?.() ?? this.adapter.index.list({ limit: CACHE_THREAD_LIMIT })).slice(0, CACHE_THREAD_LIMIT).map(row => row.id);
      const desired = new Set([...new Set([...requested, ...[...this.recent].reverse(), ...latest])].slice(0, CACHE_THREAD_LIMIT));
      for (const id of this.targets) {
        if (desired.has(id)) continue;
        this.verified.delete(id);
        this.liveVersions.delete(id);
        this.saved.delete(id);
        this.nextProbe.delete(id);
        this.stopFollowing(id);
      }
      this.targets = desired;
      this.activity=new Set([...this.activity].filter(id=>desired.has(id)));
      for(const id of this.lifecycle.keys())if(!desired.has(id))this.lifecycle.delete(id);
      // 后台本轮共用一次只读索引批次，避免二十个目标各自打开原生 SQLite。
      const sourceView = this.adapter.index.historySourceView?.([...desired]);
      this.sourceView = sourceView;
      for (const id of desired) {
        await nextTick();
        if (this.closed) return;
        if (this.blocked(id)) continue;
        try {
          // 每轮都核对是否已归档或删除，即使 IPC 仍保留先前的所有者。
          const source = sourceView ? sourceView.source(id) : this.adapter.index.historyCacheSource(id);
          this.verified.add(id);
          const entry = this.mode==='light'?undefined:this.liveEntry(id);
          this.follow(id);
          const row = this.cacheStore.metadata(id);
          if (entry) {
            const previous = this.liveVersions.get(id);
            if (row && previous?.entry === entry && previous.state === entry.state && previous.revision === entry.revision) this.deliverStored(id, row.revision);
            else this.captureLive(this.adapter.snapshot(entry.state));
            continue;
          }
          if (source && row?.saved_source === source) this.deliverStored(id, row.revision);
          else if (source && this.saved.get(id)?.source === source) this.save(this.saved.get(id).snapshot, source);
          else if (source) {
            if(this.mode!=='legacy'&&this.adapter.index.historyActivity) {
              let activity=this.lifecycle.get(id);
              if(activity?.source!==source){activity={source,...(sourceView ? sourceView.activity(id) : this.adapter.index.historyActivity(id))};this.lifecycle.set(id,activity);}
              // 轻维护仅在明确终态时读取正文，输出中的文件变化只保留来源标记。
              if(activity.status==='active'||this.mode==='light'&&!['completed','interrupted','failed'].includes(activity.status))continue;
            }else if(this.mode==='light')continue;
            await this.readSaved(id, source);
          }
        } catch (error) {
          if (error.code === 'THREAD_NOT_FOUND') this.forget(id);
        }
      }
    } finally {
      this.sourceView?.close?.();this.sourceView = undefined;
      this.running = false;
      if (this.dirty) { this.dirty = false; this.schedule(); }
    }
  }

  close() {
    this.cacheStore.close();
    this.closed = true;
    this.sourceView?.close?.();this.sourceView = undefined;
    clearTimeout(this.timer);
    clearInterval(this.interval);
    this.watcher?.close();
    this.subscriptions.clear();
    for (const id of this.targets) this.stopFollowing(id);
    this.targets.clear();
    this.saved.clear();
    this.reading.clear();
    this.liveVersions.clear();
    this.lifecycle.clear();this.activity.clear();
  }
}
