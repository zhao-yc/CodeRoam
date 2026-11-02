import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { MAX_MESSAGE_BYTES, WRITE_METHODS, validateRequest, matchesToken, errorPayload, BridgeError } from '../../packages/protocol/contracts.mjs';
import { HostProfiles } from './host-profiles.mjs';

/** 只中转已配对设备的白名单请求；模型凭据始终留在电脑端。 */
export function createRelay({ identities, requestTimeoutMs = 15000, heartbeatMs = 15000, allowedOrigins = [], profiles = new HostProfiles() }) {
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
  const hostList = identity => identity.hostIds.map(hostId => profiles.computer(hostId, hosts.has(hostId)));
  const notifyHosts = () => { for (const mobile of mobiles) send(mobile, { v: 1, type: 'hosts', hosts: hostList(mobile.identity) }); };
  const complete = transportId => {
    const entry = pending.get(transportId);
    if (!entry) return null;
    clearTimeout(entry.timer);
    pending.delete(transportId);
    return entry;
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
      client.on('pong', () => { client.alive = true; });
      sockets.emit('connection', client);
    });
  });

  sockets.on('connection', socket => {
    const identity = socket.identity;
    if (identity.role === 'host') {
      const previous = hosts.get(identity.hostId);
      hosts.set(identity.hostId, socket);
      previous?.close(4001, '电脑连接已更新');
      send(socket, { v: 1, type: 'welcome', role: 'host', hostId: identity.hostId });
      notifyHosts();
    } else if (identity.role === 'mobile') {
      mobiles.add(socket);
      send(socket, { v: 1, type: 'welcome', role: 'mobile', deviceId: identity.id, hosts: hostList(identity), capabilities: { hostProfiles: true } });
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
        if (message.type === 'response') {
          const entry = pending.get(message.transportId);
          if (!entry || entry.host !== socket) return;
          complete(message.transportId);
          if (message.error && entry.method === 'threads.watch') entry.mobile.listWatches.delete(entry.hostId);
          if (message.error && entry.method === 'thread.watch') entry.mobile.watches.delete(`${entry.hostId}:${entry.threadId}`);
          send(entry.mobile, { v: 1, type: 'response', requestId: entry.requestId, result: message.result, error: message.error });
        } else if (message.type === 'threads.event' && Array.isArray(message.threads)) {
          for (const mobile of mobiles) if (mobile.identity.hostIds.includes(identity.hostId) && mobile.listWatches.has(identity.hostId)) send(mobile, { ...message, hostId: identity.hostId });
        } else if (message.type === 'event' && typeof message.threadId === 'string') {
          for (const mobile of mobiles) if (mobile.identity.hostIds.includes(identity.hostId) && mobile.watches.has(`${identity.hostId}:${message.threadId}`)) send(mobile, { ...message, hostId: identity.hostId });
        }
        return;
      }
      try {
        validateRequest(message);
        if (message.method === 'ping') { send(socket, { v: 1, type: 'response', requestId: message.requestId, result: { now: Date.now() } }); return; }
        if (!identity.hostIds.includes(message.hostId)) throw new BridgeError('HOST_FORBIDDEN', '这台电脑不在当前手机的授权范围内');
        // 外观设置只在中转处理，允许电脑离线，不进入桌面指令和会话操作账本。
        if (message.method === 'host.profile.update') {
          profiles.update(message.hostId, message.params);
          notifyHosts();
          send(socket, { v: 1, type: 'response', requestId: message.requestId, result: { computer: profiles.computer(message.hostId, hosts.has(message.hostId)) } });
          return;
        }
        const host = hosts.get(message.hostId);
        if (!host) throw new BridgeError('HOST_OFFLINE', '电脑尚未连接，请确认电脑在线并已启动连接服务');
        if (pending.size >= 1024 || [...pending.values()].filter(entry => entry.mobile === socket).length >= 16) throw new BridgeError('BUSY', '待处理请求过多，请稍后重试');
        const transportId = randomUUID();
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
        pending.set(transportId, { host, hostId: message.hostId, mobile: socket, requestId: message.requestId, method: message.method, threadId: message.params.threadId, timer });
        send(host, { ...message, deviceId: identity.id, transportId });
      } catch (error) { fail(socket, message.requestId, error); }
    });
    socket.on('close', () => {
      mobiles.delete(socket);
      // 释放已离线手机的只读订阅；同一身份的其他在线连接仍在观看时保留。
      if(identity.role==='mobile')for(const key of socket.watches){
        if([...mobiles].some(other=>other.identity.id===identity.id&&other.watches.has(key)))continue;
        const split=key.indexOf(':'),hostId=key.slice(0,split),threadId=key.slice(split+1),host=hosts.get(hostId);
        if(host)send(host,{v:1,type:'request',requestId:randomUUID(),transportId:randomUUID(),deviceId:identity.id,hostId,method:'thread.unwatch',params:{threadId}});
      }
      if(identity.role==='mobile')for(const hostId of socket.listWatches){
        if([...mobiles].some(other=>other.identity.id===identity.id&&other.listWatches.has(hostId)))continue;
        const host=hosts.get(hostId);
        if(host)send(host,{v:1,type:'request',requestId:randomUUID(),transportId:randomUUID(),deviceId:identity.id,hostId,method:'threads.unwatch',params:{}});
      }
      if (identity.role === 'host' && hosts.get(identity.hostId) === socket) { hosts.delete(identity.hostId); notifyHosts(); }
      for (const [id, entry] of pending) if (entry.host === socket || entry.mobile === socket) {
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
