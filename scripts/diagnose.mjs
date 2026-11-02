import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { IpcClient } from '../packages/protocol/ipc-client.mjs';
import { AsarReader } from './asar-reader.mjs';

/** 只读诊断真实 IPC 的握手、广播和会话所有者发现。 */
async function main() {
  const { values } = parseArgs({ options: {
    thread: { type: 'string', default: process.env.CODEX_THREAD_ID ?? '' },
    socket: { type: 'string', default: '\\\\.\\pipe\\codex-ipc' },
    asar: { type: 'string' },
    hosts: { type: 'string', default: 'local,durable' },
    'observe-ms': { type: 'string', default: '500' },
    watch: { type: 'boolean', default: false },
  } });
  if (values.asar) {
    const reader = new AsarReader(values.asar);
    try {
      const pkg = JSON.parse(reader.text('package.json'));
      const matches = [...reader.files.keys()].filter(name => name.startsWith('.vite/build/') && name.endsWith('.js')).flatMap(name => {
        const source = reader.text(name);
        return ['thread-owner-discovery', 'thread-stream-state-changed', 'thread-follower-start-turn', 'CODEX_CLI_PATH'].filter(term => source.includes(term)).map(term => ({ file: name, term, offset: source.indexOf(term) }));
      });
      console.log(JSON.stringify({ kind: '安装包', version: pkg.version, fileCount: reader.files.size, matches }));
    } finally { reader.close(); }
  }
  const client = new IpcClient({ socketPath: values.socket });
  const broadcasts = new Map();
  client.on('broadcast', message => broadcasts.set(message.method, (broadcasts.get(message.method) ?? 0) + 1));
  client.on('broadcast', message => {
    if (message.method !== 'thread-stream-state-changed') return;
    const change = message.params?.change ?? {};
    const snapshot = change.conversationState ?? {};
    const history = snapshot.turnHistory ?? {};
    const firstTurn = snapshot.turns?.[0] ?? Object.values(history.history?.entitiesByKey ?? {})[0] ?? {};
    console.log(JSON.stringify({ kind: '会话输出', type: change.type, changeKeys: Object.keys(change), snapshotKeys: Object.keys(snapshot), turnCount: snapshot.turns?.length, historyKeys: Object.keys(history), canonicalKeys: Object.keys(history.history ?? {}), firstTurnKeys: Object.keys(firstTurn), firstItemKeys: Object.keys(firstTurn.items?.[0] ?? {}), requestKeys: Object.keys(snapshot.requests?.[0] ?? {}), revision: change.revision, patchCount: change.patches?.length }));
  });
  const start = performance.now();
  try {
    await client.connect();
    console.log(JSON.stringify({ kind: '握手', status: '成功', durationMs: Math.round(performance.now() - start) }));
    if (values.thread) for (const hostId of values.hosts.split(',')) {
      const owner = await client.findOwner(values.thread, hostId);
      console.log(JSON.stringify({ kind: '所有者查询', hostId, owner }));
      if (owner && values.watch) client.broadcast('thread-stream-following-changed', { hostId, conversationId: values.thread, following: true }, 1, [owner.clientId]);
    }
    await new Promise(resolve => setTimeout(resolve, Number(values['observe-ms'])));
    console.log(JSON.stringify({ kind: '广播计数', methods: Object.fromEntries(broadcasts) }));
  } finally {
    if (values.watch && values.thread) {
      for (const hostId of values.hosts.split(',')) {
        if (client.socket?.writable) client.broadcast('thread-stream-following-changed', { hostId, conversationId: values.thread, following: false }, 1);
      }
    }
    client.close();
  }
}

main().catch(error => { console.error(JSON.stringify({ status: '失败', code: error.code ?? 'DIAGNOSTIC_FAILED', message: error.message })); process.exitCode = 1; });
