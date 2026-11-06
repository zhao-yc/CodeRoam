import { randomUUID } from 'node:crypto';
import { BridgeError, validatePluginIds, validateThreadMentionIds } from '../../packages/protocol/contracts.mjs';
import { validateImages } from '../../packages/protocol/images.mjs';
import { pluginPrompt } from './plugins.mjs';
import { threadMentionPrompt } from './thread-mentions.mjs';
import { validateMessageChoices } from '../../packages/protocol/contracts.mjs';
import { validateSettings } from './model-settings.mjs';

const WATCHER = 'message-queue';

/** 优先复用原桌面队列；旧服务账本仍保留待处理消息，手机退出不影响已确认入队内容。 */
export class MessageQueue {
  constructor({ journal, adapter, exclusive, changed, blocked = () => false, dispatch = null }) {
    this.db = journal.db; this.adapter = adapter; this.exclusive = exclusive; this.changed = changed; this.blocked = blocked;
    this.dispatch = dispatch;
    this.closed = false; this.pumping = false;
    this.db.exec(`CREATE TABLE IF NOT EXISTS message_queue (
      position INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      thread_id TEXT NOT NULL, device_id TEXT NOT NULL, command_id TEXT NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
      previous_turn TEXT NOT NULL DEFAULT '', UNIQUE(device_id, command_id)
    )`);
    this.adapter.nativeQueue?.setJournal?.(journal);
    // 崩溃前已开始发送的消息必须人工核对，绝不能当作待发送消息重放。
    this.db.prepare("UPDATE message_queue SET state='unknown', error='发送结果需要核对，请先查看聊天；此消息不会自动重发' WHERE state='sending'").run();
    this.timer = setInterval(() => this.pump(), 1000); this.timer.unref();
  }

  rows(threadId) { return this.db.prepare('SELECT * FROM message_queue WHERE thread_id=? ORDER BY position').all(threadId); }

  /** 快照只公开展示信息和附件数量，不回传设备身份、图片正文或本地路径。 */
  decorate(snapshot) {
    const queuedMessages = this.rows(snapshot.threadId).map(row => {
      const payload = JSON.parse(row.payload);
      return { id: row.id, text: payload.text, imageCount: payload.images.length, attachmentCount: payload.attachments.length, state: row.state, error: row.error, ...(this.adapter.nativeQueue?.used.has(snapshot.threadId) ? {source:row.id.startsWith('desktop-')?'desktop':'legacy'} : {}), ...(payload.plugins?.length ? { plugins: payload.plugins.map(({id,displayName}) => ({id,displayName})) } : {}), ...(payload.threadMentions?.length ? { threadMentions: payload.threadMentions.map(({id,title}) => ({id,title})) } : {}) };
    });
    return { ...snapshot, supportsMessageQueue: true, supportsQueueEditing: true, queuedMessages: [...snapshot.queuedMessages ?? [], ...queuedMessages] };
  }

  async snapshot(threadId) {
    return this.adapter.watch(threadId, WATCHER, { fresh: true, history: false });
  }

  /** 入队与普通写操作共用会话锁、请求账本；仅确认保存后通知手机清空原草稿。 */
  async operate(params, commandId, deviceId) {
    const { threadId, queueAction } = params;
    if (this.blocked(threadId)) throw new BridgeError('DELETE_IN_PROGRESS', '该聊天正在删除，不能操作排队消息');
    if (queueAction === 'enqueue') {
      const pluginIds = validatePluginIds(params.pluginIds);
      const threadMentionIds = validateThreadMentionIds(params.threadMentionIds);
      const images = validateImages(params.images), text = params.text ?? '', attachments = params.attachments ?? [];
      if (typeof text !== 'string' || text.length > 32000 || (!text.trim() && !images.length && !attachments.length)) throw new BridgeError('BAD_PARAMS', '请输入消息或选择附件');
      if (this.rows(threadId).length >= 20) throw new BridgeError('QUEUE_FULL', '最多排队20条消息，请先处理已有消息');
      const snapshot = await this.snapshot(threadId);
      if (snapshot.readOnly) throw new BridgeError('HISTORY_READ_ONLY', '请先连接原桌面聊天再排队');
      const choices = params.choices === undefined ? {} : validateMessageChoices(params.choices);
      // 原生权限选择必须由原生完整流程处理；显式权限选项沿用已验证的旧队列，不提前改变当前任务。
      if (!snapshot.supportsNativeMessageQueue && this.adapter.nativeQueue?.used.has(threadId)) throw new BridgeError('NATIVE_QUEUE_UNAVAILABLE','电脑队列连接中断，消息未转入其他队列，请同步后重试');
      // 排队偏好只约束忙时跟进；以电脑最新事实判断，空闲且无待发消息时直接开始一轮。
      const hasBacklog = this.rows(threadId).some(row => row.state !== 'editing') || (snapshot.queuedMessages?.length ?? 0) > 0;
      const waitingForInput = snapshot.approvals?.length || snapshot.pendingPlan || snapshot.questionGroups?.some(group => group.state === 'pending' && group.kind === 'native');
      if (!hasBacklog && snapshot.status === 'idle' && !snapshot.activeTurnId && !waitingForInput) {
        try {
          const result = await this.adapter.operate('turn.send', { threadId, text, images, attachments, ...(params.choices ? { choices: structuredClone(params.choices) } : {}), ...(pluginIds.length ? { pluginIds } : {}), ...(threadMentionIds.length ? { threadMentionIds } : {}) }, commandId, deviceId);
          this.release(threadId);
          return { ...result, queued: false };
        } catch (error) {
          // 仅明确的轮次竞争可安全回队；超时或结果未知不能再次保存正文造成重复投递。
          if (error.code !== 'TURN_ACTIVE' || error.outcomeUnknown) { this.release(threadId); throw error; }
        }
      }
      const needsSettings = ['model', 'effort', 'serviceTier', 'mode'].some(key => choices[key] !== undefined);
      if (snapshot.supportsNativeMessageQueue && choices.permissionMode === undefined && (!needsSettings || this.adapter.nativeQueue.supportsSubmissionOptions !== false)) {
        try { return await this.enqueueNative(params, commandId, deviceId, snapshot, choices); }
        finally { this.release(threadId); }
      }
      let selection, mentions;
      try {
        selection = pluginIds.length ? await this.adapter.selectPlugins(threadId, WATCHER, pluginIds) : null;
        mentions = threadMentionIds.length ? await this.adapter.threadMentions?.select(threadMentionIds,threadId,WATCHER) : null;
        if(threadMentionIds.length&&!mentions)throw new BridgeError('THREAD_MENTIONS_UNAVAILABLE','请更新电脑连接服务后引用聊天');
        selection?.check();
        mentions?.check();
      } catch (error) { this.release(threadId); throw error; }
      const plugins = selection?.plugins.map(({id,displayName}) => ({id,displayName}));
      const id = randomUUID();
      this.db.prepare("INSERT INTO message_queue(id,thread_id,device_id,command_id,payload,state) VALUES (?,?,?,?,?,'queued')").run(id, threadId, deviceId, commandId, JSON.stringify({ threadId, text, images, attachments, ...(params.choices ? { choices: structuredClone(params.choices) } : {}), ...(plugins?.length ? {pluginIds: plugins.map(plugin => plugin.id), plugins} : {}), ...(mentions?.mentions.length ? {threadMentionIds,threadMentions:mentions.mentions} : {}) }));
      this.changed(threadId);
      return { ok: true, queued: true, queueId: id };
    }
    const row = this.rows(threadId).find(item => item.id === params.queueId);
    if (!row && params.queueId?.startsWith('desktop-') && this.adapter.nativeQueue) {
      const result = await this.adapter.nativeQueue.operate(queueAction, params, commandId, deviceId);
      if (result.edited) {
        // 原生撤回结果落入私有账本后才回传手机；回执丢失或手机退出仍可继续恢复草稿。
        this.db.prepare("INSERT INTO message_queue(id,thread_id,device_id,command_id,payload,state) VALUES (?,?,?,?,?,'editing') ON CONFLICT(id) DO UPDATE SET state='editing',payload=excluded.payload").run(params.queueId, threadId, deviceId, commandId, JSON.stringify({threadId,...result.draft}));
        this.changed(threadId);
      }
      return {...result,queueId:params.queueId};
    }
    if (!row) throw new BridgeError('QUEUE_CHANGED', '这条排队消息已处理，请重新同步');
    if (row.device_id !== deviceId) throw new BridgeError('QUEUE_FORBIDDEN', '只能处理本设备发送的排队消息');
    if (queueAction === 'edit') return this.withdrawForEdit(row);
    if (queueAction === 'cancel') {
      this.db.prepare('DELETE FROM message_queue WHERE id=?').run(row.id); this.changed(threadId); this.release(threadId);
      return { ok: true, canceled: true };
    }
    if (queueAction !== 'steer' || row.state !== 'queued') throw new BridgeError('QUEUE_CHANGED', '这条消息已开始发送或需要核对，不能重复追加');
    const snapshot = await this.snapshot(threadId);
    if (!snapshot.activeTurnId || snapshot.activeTurnId !== params.expectedTurnId) throw new BridgeError('STALE_TURN', '当前任务已经变化，消息仍保留在队列中');
    return this.deliver(row, 'turn.steer', snapshot.activeTurnId);
  }

  /** 所有文件及引用都在电脑端解析，调用原生逐条追加接口，绝不回写整份队列。 */
  async enqueueNative(params, commandId, deviceId, snapshot, choices) {
    const {threadId}=params, entry=this.adapter.subscribed(threadId,deviceId), owner={...entry.owner};
    const selection=params.pluginIds?.length?await this.adapter.selectPlugins(threadId,deviceId,params.pluginIds):null;
    const mentions=params.threadMentionIds?.length?await this.adapter.threadMentions?.select(params.threadMentionIds,threadId,deviceId):null;
    if(params.threadMentionIds?.length&&!mentions)throw new BridgeError('THREAD_MENTIONS_UNAVAILABLE','当前电脑暂不支持聊天引用');
    const prompt=threadMentionPrompt(pluginPrompt(params.text??'',selection?.plugins??[]),mentions);
    const cwd=entry.state.cwd??entry.state.environments?.[0]?.cwd;
    const images=validateImages(params.images);
    let submissionOptions;
    const changes=Object.fromEntries(['model','effort','serviceTier','mode'].filter(key=>choices[key]!==undefined).map(key=>[key,choices[key]]));
    if(Object.keys(changes).length) {
      const current=await this.adapter.readSettings(threadId,deviceId);
      const {threadSettings,selected}=validateSettings(changes,current.settings,current.models,entry.state.latestCollaborationMode);
      if(images.length&&current.models.find(model=>model.id===selected.model)?.supportsImages===false)throw new BridgeError('IMAGES_UNSUPPORTED','当前模型不支持图片，请切换模型');
      submissionOptions={executionHostId:owner.hostId,collaborationMode:threadSettings.collaborationMode,serviceTier:threadSettings.serviceTier??null};
    }
    selection?.check();mentions?.check();
    const files=this.adapter.attachments.materialize(deviceId,threadId,params.attachments,cwd,images.length);
    const message={id:commandId,text:prompt,cwd,createdAt:Date.now(),context:{prompt:prompt+(mentions?.contextText??''),addedFiles:[],fileAttachments:files.map(file=>({label:file.label,path:file.path,fsPath:file.path})),imageAttachments:images.map((src,index)=>({id:commandId+':image:'+index,src})),ideContext:null,workspaceRoots:[cwd],...(mentions?.references?.length&&mentions.mode!=='savedContext'?{threadReferences:mentions.references}:{})},...(selection?.plugins.length?{pluginInputs:selection.plugins.map(plugin=>({type:'mention',name:plugin.name,path:'plugin://'+plugin.id}))}:{}),...(submissionOptions?{submissionOptions}:{})};
    selection?.check();mentions?.check();
    const current=this.adapter.subscribed(threadId,deviceId);
    if(current!==entry||current.owner.clientId!==owner.clientId||current.owner.hostId!==owner.hostId)throw new BridgeError('OWNER_UNAVAILABLE','电脑聊天归属已变化，请重新同步');
    const result=await this.adapter.nativeQueue.operate('enqueue',params,commandId,deviceId,message);
    this.changed(threadId);return result;
  }

  /** 先停止自动投递，再回传完整草稿；手机确认恢复前保留可再次读取的撤回记录。 */
  withdrawForEdit(row) {
    if (!['queued', 'editing'].includes(row.state)) throw new BridgeError('QUEUE_CHANGED', '这条消息已开始发送或需要核对，不能撤回编辑');
    const payload = JSON.parse(row.payload);
    const attachments = payload.attachments.map(id => {
      const { metadata } = this.adapter.attachments.metadata(row.device_id, row.thread_id, id);
      if (!metadata.complete) throw new BridgeError('UPLOAD_INCOMPLETE', '原附件尚未就绪，消息仍保留，请先核对附件');
      return { id, name: metadata.name, size: metadata.size };
    });
    // 只返回原上传编号和显示信息，不允许手机获得服务器文件路径。
    const draft = { text: payload.text, images: payload.images, attachments, ...(payload.choices ? { choices: payload.choices } : {}), ...(payload.plugins?.length ? { plugins: payload.plugins.map(({ id, displayName }) => ({ id, displayName })) } : {}), ...(payload.threadMentions?.length ? { threadMentions: payload.threadMentions.map(({ id, title }) => ({ id, title })) } : {}) };
    this.db.prepare("UPDATE message_queue SET state='editing',error='' WHERE id=?").run(row.id);
    this.changed(row.thread_id);
    return { ok: true, edited: true, queueId: row.id, draft };
  }

  /** 发送前先落盘占位；断线或超时保留未知状态，明确失败也暂停队列供用户处理。 */
  async deliver(row, method, previousTurn, background = false) {
    this.db.prepare("UPDATE message_queue SET state='sending', previous_turn=? WHERE id=?").run(previousTurn, row.id); this.changed(row.thread_id);
    try {
      // 展示名称只供队列快照使用；投递重新解析编号和最新名称，不信任持久化的标记。
      const { plugins, threadMentions, ...params } = JSON.parse(row.payload);
      // 自动投递同样先进入实例提交队列；手动追加已经由当前提交任务持有执行槽。
      const input = { ...params, expectedTurnId: previousTurn };
      const result = background && this.dispatch ? await this.dispatch(method, input, row.id, row.device_id) : await this.adapter.operate(method, input, row.id, row.device_id);
      if (method === 'turn.steer') this.db.prepare('DELETE FROM message_queue WHERE id=?').run(row.id);
      else this.db.prepare("UPDATE message_queue SET state='dispatched' WHERE id=?").run(row.id);
      this.changed(row.thread_id); this.release(row.thread_id); return result;
    } catch (error) {
      const unknown = error.outcomeUnknown || /timeout|超时|连接已关闭|not-connected/i.test(error.message);
      // 空闲快照之后桌面先开始了另一任务时安全回队，绝不改为追加。
      const state = error.code === 'TURN_ACTIVE' || error.code === 'STALE_TURN' ? 'queued' : unknown ? 'unknown' : 'failed';
      const pluginFailure = ['PLUGIN_UNAVAILABLE','PLUGINS_UNAVAILABLE','PLUGINS_CHANGED'].includes(error.code);
      const mentionFailure = String(error.code).startsWith('THREAD_MENTION');
      this.db.prepare('UPDATE message_queue SET state=?,error=? WHERE id=?').run(state, state === 'queued' ? '' : unknown ? '发送结果需要核对，请先查看聊天；此消息不会自动重发' : pluginFailure ? '所选插件已不可用或目录已变化，队列已暂停；请取消此消息并重新选择插件发送' : mentionFailure ? '所引用聊天已不可用，队列已暂停；请撤回编辑并重新选择聊天' : '发送失败，请核对聊天和附件后取消此消息并重新发送', row.id);
      this.changed(row.thread_id); throw error;
    }
  }

  /** 刷新原桌面事实后按先进先出发送；切页、重连和进程恢复都不依赖手机页面。 */
  async drain(threadId) {
    if (this.closed || this.blocked(threadId)) return;
    const rows = this.rows(threadId).filter(row => row.state !== 'editing'); if (!rows.length) return;
    const snapshot = await this.snapshot(threadId); if (this.closed) return;
    const head = rows[0];
    if (head.state === 'dispatched') {
      const latestTurn = snapshot.turns?.at(-1)?.turnId ?? snapshot.activeTurnId;
      // 收到成功回执还不够，必须观察到新轮次，防止桌面状态尚未广播时连发。
      if (latestTurn && latestTurn !== head.previous_turn) {
        this.db.prepare('DELETE FROM message_queue WHERE id=?').run(head.id); this.changed(threadId); this.release(threadId);
      }
      return;
    }
    if (head.state !== 'queued' || snapshot.status !== 'idle' || snapshot.activeTurnId || snapshot.readOnly || snapshot.approvals?.length || snapshot.pendingPlan || snapshot.questionGroups?.some(group => group.state === 'pending' && group.kind === 'native')) return;
    await this.deliver(head, 'turn.send', snapshot.turns?.at(-1)?.turnId ?? '', true);
  }

  async pump() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    try {
      const threads = this.db.prepare('SELECT DISTINCT thread_id FROM message_queue').all();
      // 新执行器在实际写入时取得统一锁，不能在等待入队结果期间占住同一会话锁。
      await Promise.allSettled(threads.map(row => this.dispatch ? this.drain(row.thread_id) : this.exclusive(row.thread_id, () => this.drain(row.thread_id))));
    } finally { this.pumping = false; }
  }

  release(threadId) { if (!this.rows(threadId).length) this.adapter.unwatch(threadId, WATCHER); }

  /** 归档或永久删除成功后撤销对应排队消息，避免以后重新唤醒会话。 */
  forget(threadIds) {
    for (const id of threadIds) { this.db.prepare('DELETE FROM message_queue WHERE thread_id=?').run(id); this.release(id); }
  }

  close() { this.closed = true; clearInterval(this.timer); }
}
