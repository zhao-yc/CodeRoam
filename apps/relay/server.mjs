import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_MESSAGE_BYTES, WRITE_METHODS, validateRequest, validateDraftId, validDraftRevision, matchesToken, errorPayload, BridgeError } from '../../packages/protocol/contracts.mjs';
import { HostProfiles } from './host-profiles.mjs';
import { HostInstances } from './host-instances.mjs';

/** 只中转已配对设备的白名单请求；模型凭据始终留在电脑端。 */
export function createRelay({ identities, requestTimeoutMs = 15000, heartbeatMs = 15000, allowedOrigins = [], profiles = new HostProfiles(), instances = new HostInstances() }) {
  if (!Array.isArray(identities) || identities.length === 0) throw new Error('中转服务缺少设备鉴权配置');
  const hosts = new Map();
  const mobiles = new Set();
  const pending = new Map();
  const tickets = new Map();
  const authenticate = request => {
    const bearer=/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.authorization??'')?.[1];
    return bearer?identities.find(entry=>matchesToken(bearer,entry.tokenSha256)):null;
  };
  const server = http.createServer((request, response) => {
    const origin=request.headers.origin;
    if(origin&&!allowedOrigins.includes(origin)){response.writeHead(403).end();return;}
    if(origin){response.setHeader('Access-Control-Allow-Origin',origin);response.setHeader('Vary','Origin');}
    if(request.url==='/session'&&request.method==='OPTIONS'){response.writeHead(204,{'Access-Control-Allow-Methods':'POST','Access-Control-Allow-Headers':'Authorization,Content-Type'}).end();return;}
    if(request.url==='/session'&&request.method==='POST'){
      const identity=authenticate(request);
      if(!identity||identity.role!=='mobile'){response.writeHead(401).end();return;}
      for(const [key,value]of tickets)if(value.expiresAt<Date.now())tickets.delete(key);
      if(tickets.size>=1024){response.writeHead(429).end();return;}
      const ticket=randomBytes(32).toString('base64url');tickets.set(ticket,{identity,expiresAt:Date.now()+30000});
      response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({ticket}));return;
    }
    if (request.url !== '/healthz') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ status: 'ok', protocolVersion: 1 }));
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false });
  const send = (socket, message) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 4 * MAX_MESSAGE_BYTES) { socket.close(1013, '接收速度不足，请重新同步'); return false; }
    socket.send(JSON.stringify(message));
    return true;
  };
  const fail = (socket, requestId, error) => send(socket, { v: 1, type: 'response', requestId, error: errorPayload(error) });
  const hostOnline = id => {
    const row = instances.row(id), parent = row?.parentId ?? id;
    return hosts.has(id) && (!instances.managed.has(parent) || row?.online === true);
  };
  const hostList = identity => instances.ids(identity.hostIds).map(hostId => {
    const row = instances.row(hostId);
    return { ...profiles.computer(hostId, hostOnline(hostId)), ...(row ? { parentHostId: row.parentId, instanceGeneration: row.generation ?? '', ...(!hostOnline(hostId) && row.reason ? { unavailableReason: row.reason } : {}) } : {}) };
  });
  const notifyHosts = () => { for (const mobile of mobiles) send(mobile, { v: 1, type: 'hosts', hosts: hostList(mobile.identity) }); };
  const complete = transportId => {
    const entry = pending.get(transportId);
    if (!entry) return null;
    clearTimeout(entry.timer);
    pending.delete(transportId);
    return entry;
  };

  const draftKey = (hostId, draftId) => JSON.stringify([hostId, draftId]);
  const draftRead = method => method === 'thread.draft.open' || method === 'thread.draft.read';
  const generationOf = hostId => instances.managed.has(instances.row(hostId)?.parentId ?? hostId) ? instances.row(hostId)?.generation : undefined;
  /** 草稿事件必须匹配实际注册连接及实例代次，不能借父电脑连接伪造其他电脑的来源。 */
  const draftSource = (socket, hostId, generation) => hosts.get(hostId) === socket && hostOnline(hostId) &&
    (instances.managed.has(socket.identity.hostId) ? instances.owns(socket.identity.hostId, hostId, generation) : hostId === socket.identity.hostId && generation === undefined);
  const draftSnapshot = snapshot => {
    try {
      validateDraftId(snapshot?.draftId);
      return typeof snapshot.projectId === 'string' && snapshot.projectId.length > 0 && snapshot.projectId.length <= 200 && validDraftRevision(snapshot.revision) && ['ready', 'detached', 'promoted'].includes(snapshot.status);
    } catch { return false; }
  };
  const draftViewer = (deviceId, key, watch) => [...mobiles].some(mobile => mobile.identity.id === deviceId && mobile.draftWatches.get(key)?.host === watch.host && mobile.draftWatches.get(key)?.generation === watch.generation);
  /** 只释放仍属原连接、原代次的观察，不把旧草稿退订发送到新实例，更不删除电脑草稿。 */
  const releaseDraft = (deviceId, watch) => {
    if (draftViewer(deviceId, draftKey(watch.hostId, watch.draftId), watch) || !draftSource(watch.host, watch.hostId, watch.generation)) return;
    send(watch.host, { v: 1, type: 'request', requestId: randomUUID(), transportId: randomUUID(), deviceId, hostId: watch.hostId, ...(watch.generation ? { generation: watch.generation } : {}), method: 'thread.draft.unwatch', params: { draftId: watch.draftId } });
  };
  /** 换代与重连均撤销草稿订阅；仅相同 generation 的新连接也不能继承旧连接的订阅。 */
  const invalidateDrafts = predicate => {
    for (const mobile of mobiles) {
      for (const [key, watch] of mobile.draftWatches) if (predicate(watch)) mobile.draftWatches.delete(key);
      for (const [key, watch] of mobile.draftReleases) if (predicate(watch)) mobile.draftReleases.delete(key);
    }
  };

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    let identity=authenticate(request);
    let ticketAuthenticated=false;
    const ticket=(request.headers['sec-websocket-protocol']??'').split(',').map(value=>value.trim()).find(value=>value.startsWith('ticket.'))?.slice(7);
    if(!identity&&ticket){const entry=tickets.get(ticket);tickets.delete(ticket);if(entry&&entry.expiresAt>=Date.now()){identity=entry.identity;ticketAuthenticated=true;}}
    const origin = request.headers.origin;
    // uni-app x Android SDK 默认携带这个来源，仅在手机的一次性票据验证通过后兼容。
    // HTTP 票据接口和其他网页来源继续使用原白名单，来源本身不代表设备身份。
    const nativeTicketOrigin=origin==='http://localhost'&&ticketAuthenticated&&identity?.role==='mobile';
    if (url.pathname !== '/ws' || url.search || !identity || (origin && !allowedOrigins.includes(origin)&&!nativeTicketOrigin)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(request, socket, head, client => {
      client.identity = identity;
      client.alive = true;
      client.watches = new Set();
      client.listWatches = new Set();
      client.draftWatches = new Map();
      client.draftReleases = new Map();
      client.draftSequence = 0;
      client.on('pong', () => { client.alive = true; });
      sockets.emit('connection', client);
    });
  });

  sockets.on('connection', socket => {
    const identity = socket.identity;
    if (identity.role === 'host') {
      const previous = hosts.get(identity.hostId);
      if (previous) invalidateDrafts(watch => watch.host === previous);
      if (previous) for (const [id, connection] of hosts) if (connection === previous) hosts.delete(id);
      instances.disconnect(identity.hostId);
      hosts.set(identity.hostId, socket);
      previous?.close(4001, '电脑连接已更新');
      send(socket, { v: 1, type: 'welcome', role: 'host', hostId: identity.hostId, capabilities: { hostInstances: true } });
      notifyHosts();
    } else if (identity.role === 'mobile') {
      mobiles.add(socket);
      send(socket, { v: 1, type: 'welcome', role: 'mobile', deviceId: identity.id, hosts: hostList(identity), capabilities: { hostProfiles: true, hostInstances: true } });
    } else { socket.close(1008, '设备角色不受支持'); return; }
    socket.on('error', () => {});
    socket.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { socket.close(1007, '消息不是有效 JSON'); return; }
      if (identity.role === 'host') {
        if (hosts.get(identity.hostId) !== socket) return;
        if (message.type === 'host.ready') {
          try { profiles.observe(identity.hostId, message); notifyHosts(); }
          catch { socket.close(1011, '连接信息暂时无法保存'); }
          return;
        }
        if (message.type === 'host.instances') {
          try {
            if (Array.isArray(message.instances) && message.instances.some(row => identities.some(other => other.role === 'host' && other.hostId !== identity.hostId && other.hostId === row?.id))) throw new BridgeError('BAD_INSTANCES', '实例编号与其他电脑冲突');
            const rows = instances.update(identity.hostId, message.instances);
            for (const row of rows) {
              if (row.id !== identity.hostId) { if (row.online) hosts.set(row.id, socket); else if (hosts.get(row.id) === socket) hosts.delete(row.id); }
              if (row.generation) profiles.observe(row.id, { label: row.label, hostname: profiles.get(identity.hostId).hostname, connectionType: 'codex-desktop' });
            }
            // 同一连接中的一个实例换代，只结束该实例的在途请求；写请求保持结果待核对。
            for (const [id, entry] of pending) if (entry.host === socket && (!hostOnline(entry.hostId) || entry.generation && instances.row(entry.hostId)?.generation !== entry.generation)) {
              complete(id); fail(entry.mobile, entry.requestId, new BridgeError(WRITE_METHODS.has(entry.method) ? 'OUTCOME_UNKNOWN' : 'INSTANCE_CHANGED', '实例连接已变化，请先核对原操作', WRITE_METHODS.has(entry.method)));
            }
            invalidateDrafts(watch => watch.host === socket && !draftSource(socket, watch.hostId, watch.generation));
            notifyHosts();
          } catch { socket.close(1008, '实例清单或归属无效'); }
          return;
        }
        if (message.type === 'response') {
          const entry = pending.get(message.transportId);
          if (!entry || entry.host !== socket) return;
          if (entry.generation && (message.hostId !== entry.hostId || message.generation !== entry.generation || !instances.owns(identity.hostId, entry.hostId, entry.generation))) return;
          if (entry.method.startsWith('thread.draft.') && !draftSource(socket, entry.hostId, entry.generation)) return;
          complete(message.transportId);
          if (!message.error && draftRead(entry.method) && (!draftSnapshot(message.result) || (entry.method === 'thread.draft.read' ? message.result.draftId !== entry.draftId : message.result.projectId !== entry.projectId))) {
            fail(entry.mobile, entry.requestId, new BridgeError('BAD_DRAFT_RESPONSE', '电脑返回的草稿与原请求不匹配，请重新核对')); return;
          }
          if (entry.method.startsWith('thread.draft.') && !instances.authorized(entry.mobile.identity.hostIds, entry.hostId)) {
            if (!message.error && draftRead(entry.method)) releaseDraft(entry.mobile.identity.id, { host: socket, hostId: entry.hostId, generation: entry.generation, draftId: message.result.draftId });
            fail(entry.mobile, entry.requestId, new BridgeError('HOST_FORBIDDEN', '这台电脑已不在当前手机的授权范围内')); return;
          }
          if (message.error && entry.method === 'threads.watch') entry.mobile.listWatches.delete(entry.hostId);
          if (message.error && entry.method === 'thread.watch') entry.mobile.watches.delete(`${entry.hostId}:${entry.threadId}`);
          if (!message.error && draftRead(entry.method) && draftSnapshot(message.result)) {
            const snapshot = message.result, key = draftKey(entry.hostId, snapshot.draftId);
            const matches = entry.method === 'thread.draft.read' ? snapshot.draftId === entry.draftId : snapshot.projectId === entry.projectId;
            if (matches) {
              const watch = { host: socket, hostId: entry.hostId, generation: entry.generation, draftId: snapshot.draftId, projectId: snapshot.projectId, sequence: entry.draftSequence };
              const released = entry.mobile.draftReleases.get(key);
              if (mobiles.has(entry.mobile) && entry.mobile.readyState === WebSocket.OPEN && instances.authorized(entry.mobile.identity.hostIds, entry.hostId) && !(released?.host === socket && released.generation === entry.generation && released.sequence > entry.draftSequence)) {
                const existing = entry.mobile.draftWatches.get(key);
                if (!existing || existing.sequence < watch.sequence) entry.mobile.draftWatches.set(key, watch);
              } else releaseDraft(entry.mobile.identity.id, watch);
            }
          }
          if (!message.error && entry.method === 'thread.draft.unwatch' && message.result?.ok === true) {
            const key = draftKey(entry.hostId, entry.draftId), current = entry.mobile.draftWatches.get(key);
            if (!current || current.sequence <= entry.draftSequence) entry.mobile.draftWatches.delete(key);
            entry.mobile.draftReleases.set(key, { host: socket, hostId: entry.hostId, generation: entry.generation, sequence: entry.draftSequence });
          }
          send(entry.mobile, { v: 1, type: 'response', requestId: entry.requestId, result: message.result, error: message.error });
        } else if (message.type === 'thread.draft.changed') {
          if (message.v !== 1 || typeof message.deviceId !== 'string' || !draftSnapshot(message.snapshot)) return;
          const hostId = message.hostId ?? identity.hostId;
          if (!draftSource(socket, hostId, message.generation)) return;
          const key = draftKey(hostId, message.snapshot.draftId);
          for (const mobile of mobiles) {
            const watch = mobile.draftWatches.get(key);
            if (mobile.identity.id === message.deviceId && instances.authorized(mobile.identity.hostIds, hostId) && watch?.host === socket && watch.generation === message.generation && watch.projectId === message.snapshot.projectId) {
              send(mobile, { v: 1, type: 'thread.draft.changed', deviceId: message.deviceId, hostId, ...(message.generation ? { generation: message.generation } : {}), snapshot: message.snapshot });
            }
          }
        } else if (message.type === 'threads.event' && Array.isArray(message.threads)) {
          const hostId = instances.managed.has(identity.hostId) ? message.hostId : identity.hostId;
          if (instances.managed.has(identity.hostId) && !instances.owns(identity.hostId, hostId, message.generation)) return;
          for (const mobile of mobiles) if (instances.authorized(mobile.identity.hostIds, hostId) && mobile.listWatches.has(hostId)) send(mobile, { ...message, hostId });
        } else if (message.type === 'event' && typeof message.threadId === 'string') {
          const hostId = instances.managed.has(identity.hostId) ? message.hostId : identity.hostId;
          if (instances.managed.has(identity.hostId) && !instances.owns(identity.hostId, hostId, message.generation)) return;
          for (const mobile of mobiles) if (instances.authorized(mobile.identity.hostIds, hostId) && mobile.watches.has(`${hostId}:${message.threadId}`)) send(mobile, { ...message, hostId });
        }
        return;
      }
      try {
        validateRequest(message);
        if (message.method === 'ping') { send(socket, { v: 1, type: 'response', requestId: message.requestId, result: { now: Date.now() } }); return; }
        if (!instances.authorized(identity.hostIds, message.hostId)) throw new BridgeError('HOST_FORBIDDEN', '这台电脑不在当前手机的授权范围内');
        // 外观设置只在中转处理，允许电脑离线，不进入桌面指令和会话操作账本。
        if (message.method === 'host.profile.update') {
          profiles.update(message.hostId, message.params);
          notifyHosts();
          send(socket, { v: 1, type: 'response', requestId: message.requestId, result: { computer: profiles.computer(message.hostId, hostOnline(message.hostId)) } });
          return;
        }
        const host = hosts.get(message.hostId);
        if (!host || !hostOnline(message.hostId)) throw new BridgeError('HOST_OFFLINE', instances.row(message.hostId)?.reason || '电脑或实例尚未连接，请确认已启动连接服务');
        if (pending.size >= 1024 || [...pending.values()].filter(entry => entry.mobile === socket).length >= 16) throw new BridgeError('BUSY', '待处理请求过多，请稍后重试');
        const transportId = randomUUID();
        const generation = generationOf(message.hostId);
        const draftSequence = message.method.startsWith('thread.draft.') ? ++socket.draftSequence : undefined;
        // 同配对多标签页仅释放当前观看者，最后一个观看者才通知电脑停止轮询。
        if (message.method === 'thread.draft.unwatch') {
          const key = draftKey(message.hostId, message.params.draftId), watch = { host, hostId: message.hostId, generation, draftId: message.params.draftId };
          const shared = [...mobiles].some(other => other !== socket && other.identity.id === identity.id && other.draftWatches.get(key)?.host === host && other.draftWatches.get(key)?.generation === generation);
          if (shared) {
            socket.draftWatches.delete(key); socket.draftReleases.set(key, { ...watch, sequence: draftSequence });
            send(socket, { v: 1, type: 'response', requestId: message.requestId, result: { ok: true } }); return;
          }
        }
        const key = `${message.hostId}:${message.params.threadId}`;
        if (message.method === 'threads.watch') socket.listWatches.add(message.hostId);
        if (message.method === 'threads.unwatch') socket.listWatches.delete(message.hostId);
        if (message.method === 'thread.watch') socket.watches.add(key);
        if (message.method === 'thread.unwatch') socket.watches.delete(key);
        // 同一配对可同时打开多个标签页。显式退出与断线一样，只有最后一个观看者才释放电脑订阅。
        const sharedWatch=message.method==='thread.unwatch'&&[...mobiles].some(other=>other!==socket&&other.identity.id===identity.id&&other.watches.has(key));
        const sharedList=message.method==='threads.unwatch'&&[...mobiles].some(other=>other!==socket&&other.identity.id===identity.id&&other.listWatches.has(message.hostId));
        if(sharedWatch||sharedList){send(socket,{v:1,type:'response',requestId:message.requestId,result:{ok:true}});return;}
        const timer = setTimeout(() => {
          const entry = complete(transportId);
          if (entry) fail(socket, message.requestId, new BridgeError(WRITE_METHODS.has(message.method) ? 'OUTCOME_UNKNOWN' : 'REQUEST_TIMEOUT', WRITE_METHODS.has(message.method) ? '请求已发出，执行结果需要核对，请勿重复发送' : '电脑响应超时', WRITE_METHODS.has(message.method)));
        }, message.method === 'thread.delete' ? Math.max(60000, requestTimeoutMs) : message.method === 'thread.goal.update' ? Math.max(30000, requestTimeoutMs) : requestTimeoutMs);
        pending.set(transportId, { host, hostId: message.hostId, generation, mobile: socket, requestId: message.requestId, method: message.method, threadId: message.params.threadId, draftId: message.params.draftId, projectId: message.params.projectId, draftSequence, timer });
        send(host, { ...message, deviceId: identity.id, transportId, ...(generation ? { generation } : {}) });
      } catch (error) { fail(socket, message.requestId, error); }
    });
    socket.on('close', () => {
      mobiles.delete(socket);
      if (identity.role === 'mobile') for (const watch of socket.draftWatches.values()) releaseDraft(identity.id, watch);
      // 释放已离线手机的只读订阅；同一身份的其他在线连接仍在观看时保留。
      if(identity.role==='mobile')for(const key of socket.watches){
        if([...mobiles].some(other=>other.identity.id===identity.id&&other.watches.has(key)))continue;
        const split=key.indexOf(':'),hostId=key.slice(0,split),threadId=key.slice(split+1),host=hosts.get(hostId);
        if(host)send(host,{v:1,type:'request',requestId:randomUUID(),transportId:randomUUID(),deviceId:identity.id,hostId,generation:instances.row(hostId)?.generation,method:'thread.unwatch',params:{threadId}});
      }
      if(identity.role==='mobile')for(const hostId of socket.listWatches){
        if([...mobiles].some(other=>other.identity.id===identity.id&&other.listWatches.has(hostId)))continue;
        const host=hosts.get(hostId);
        if(host)send(host,{v:1,type:'request',requestId:randomUUID(),transportId:randomUUID(),deviceId:identity.id,hostId,generation:instances.row(hostId)?.generation,method:'threads.unwatch',params:{}});
      }
      if (identity.role === 'host' && hosts.get(identity.hostId) === socket) { invalidateDrafts(watch => watch.host === socket); for (const [id, connection] of hosts) if (connection === socket) hosts.delete(id); instances.disconnect(identity.hostId); notifyHosts(); }
      for (const [id, entry] of pending) if (entry.host === socket || entry.mobile === socket) {
        // 打开回执可能晚于手机断线，保留 transport 到原超时，以便拿到编号后只转发 unwatch。
        if (entry.mobile === socket && entry.host !== socket && draftRead(entry.method)) {
          if (entry.draftId) releaseDraft(identity.id, { host: entry.host, hostId: entry.hostId, generation: entry.generation, draftId: entry.draftId });
          continue;
        }
        complete(id);
        if (entry.mobile !== socket) fail(entry.mobile, entry.requestId, new BridgeError(WRITE_METHODS.has(entry.method) ? 'OUTCOME_UNKNOWN' : 'HOST_OFFLINE', '电脑连接已断开，请先核对会话状态', WRITE_METHODS.has(entry.method)));
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!socket.alive) { socket.terminate(); continue; }
      socket.alive = false;
      socket.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    server,
    listen: (port = 0, host = '127.0.0.1') => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); }); }),
    async close() { clearInterval(heartbeat); for (const entry of pending.values()) clearTimeout(entry.timer); pending.clear(); for (const socket of sockets.clients) socket.terminate(); await new Promise(resolve => sockets.close(resolve)); if (server.listening) await new Promise(resolve => server.close(resolve)); },
  };
}
