import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { BridgeError, errorPayload } from '../packages/protocol/contracts.mjs';
import { NativeServerQueueClient } from '../apps/bridge/native-server-queue-client.mjs';
import { ThreadCreationClient } from '../apps/bridge/thread-creation.mjs';

const cwd = path.resolve('synthetic-project');
const input = [{ type: 'text', text: '合成排队消息', text_elements: [] }];
const row = (index = 1, changes = {}) => ({ id: 'queue-' + index, clientUserMessageId: 'command-' + index, input: structuredClone(input), ...changes });
const page = (data = [], nextCursor = null) => ({ data, nextCursor });

function fixture(handle = () => page()) {
  const calls = [], runs = [];
  const creation = {
    async run(directory, action, options) {
      runs.push({ directory, options });
      return action(async (method, params) => {
        calls.push({ method, params });
        if (method === 'thread/loaded/list') return page();
        return handle(method, params);
      });
    },
  };
  return { client: new NativeServerQueueClient({ creation }), creation, calls, runs };
}

function assertSafe(error, code, unknown = false) {
  assert.ok(error instanceof BridgeError);
  assert.equal(error.code, code);
  assert.equal(error.outcomeUnknown, unknown);
  assert.equal(error.cause, undefined);
  assert.equal(JSON.stringify(errorPayload(error)).includes('/private/example'), false);
  assert.equal(error.message.includes('内部诊断'), false);
  return true;
}

test('分页完整返回内部原始记录，保留长文本、附件、插件及未知附加字段', async () => {
  const complex = row(1, {
    input: [
      { type: 'text', text: '合成'.repeat(12000), text_elements: [{ byteRange: { start: 0, end: 6 }, placeholder: '合成标记' }] },
      { type: 'localImage', path: '/private/example/image.png', detail: 'original' },
      { type: 'image', fileId: 'synthetic-file', detail: null },
      { type: 'audio', url: 'https://example.com/audio' },
      { type: 'localAudio', path: '/private/example/audio.wav' },
      { type: 'skill', name: '合成插件', path: '/private/example/skill' },
      { type: 'mention', name: '合成引用', path: 'plugin://example' },
    ],
    context: { privatePath: '/private/example/context', metadata: ['完整保留'] },
  });
  const second = row(2);
  const f = fixture((_method, params) => params.cursor === undefined ? page([complex], 'cursor-two') : page([second]));
  const rows = await f.client.list('thread', cwd);
  assert.deepEqual(rows, [complex, second]);
  assert.equal(rows[0], complex);
  assert.deepEqual(f.calls, [
    { method: 'thread/loaded/list', params: { limit: 1 } },
    { method: 'thread/queue/list', params: { threadId: 'thread', limit: 200 } },
    { method: 'thread/queue/list', params: { threadId: 'thread', limit: 199, cursor: 'cursor-two' } },
    { method: 'thread/loaded/list', params: { limit: 1 } },
  ]);
  assert.deepEqual(f.runs, [{ directory: cwd, options: { experimentalApi: true } }]);
});

test('允许空队列与恰好200条记录，超过200条或仍有下一页则拒绝，不能截断', async () => {
  assert.deepEqual(await fixture().client.list('thread', cwd), []);
  const rows = Array.from({ length: 200 }, (_, index) => row(index));
  assert.deepEqual(await fixture(() => page(rows)).client.list('thread', cwd), rows);
  for (const response of [page([...rows, row(201)]), page(rows, 'more')]) {
    await assert.rejects(fixture(() => response).client.list('thread', cwd), error => assertSafe(error, 'NATIVE_QUEUE_UNAVAILABLE'));
  }
});

test('拒绝循环游标、非法游标、重复记录及持续空分页，失败后仍回查加载状态', async () => {
  for (const response of [page([], 'loop'), page([], 42), page([], ''), page([row(), row()])]) {
    const f = fixture(() => response);
    await assert.rejects(f.client.list('thread', cwd), error =>
      assertSafe(error, response.data.length ? 'NATIVE_QUEUE_CHANGED' : 'NATIVE_QUEUE_UNAVAILABLE'));
    assert.equal(f.calls.at(-1).method, 'thread/loaded/list');
    assert.ok(f.calls.length <= 4);
  }
  let count = 0;
  const f = fixture(() => page([], 'empty-' + count++));
  await assert.rejects(f.client.list('thread', cwd), { code: 'NATIVE_QUEUE_UNAVAILABLE' });
  assert.ok(count <= 201);
  const duplicate = fixture((_method, params) => params.cursor ? page([row(2, { clientUserMessageId: 'command-1' })]) : page([row()], 'second'));
  await assert.rejects(duplicate.client.list('thread', cwd), { code: 'NATIVE_QUEUE_CHANGED' });
});

test('非法队列行与输入结构明确失败，原始数据或路径不进入错误', async () => {
  for (const invalid of [
    null, [], {}, row(1, { id: '' }), row(1, { clientUserMessageId: null }),
    row(1, { input: null }), row(1, { input: [] }), row(1, { input: [null] }),
    row(1, { input: [{ type: 'text', text: 7 }] }),
    row(1, { input: [{ type: 'text', text: '合成', text_elements: [{ byteRange: { start: 3, end: 0 } }] }] }),
    row(1, { input: [{ type: 'image' }] }),
    row(1, { input: [{ type: 'localImage', path: '/private/example', detail: 'invalid' }] }),
    row(1, { input: [{ type: 'skill', path: '/private/example' }] }),
    row(1, { input: [{ type: 'turn/start', text: '/private/example 内部诊断' }] }),
  ]) {
    await assert.rejects(fixture(() => page([invalid])).client.list('thread', cwd),
      error => assertSafe(error, 'NATIVE_QUEUE_UNAVAILABLE'));
  }
  await assert.rejects(fixture(() => ({ rows: [] })).client.list('thread', cwd), { code: 'NATIVE_QUEUE_UNAVAILABLE' });
});

test('入队先分页精确查重，即使20条已满也返回原记录，不以原生id或正文误判', async () => {
  const rows = Array.from({ length: 20 }, (_, index) => row(index));
  const f = fixture((_method, params) => params.cursor ? page(rows.slice(10)) : page(rows.slice(0, 10), 'remaining'));
  assert.equal(await f.client.enqueue('thread', input, 'command-19', cwd), rows[19]);
  assert.equal(f.calls.some(call => call.method === 'thread/queue/add'), false);

  const added = row(2, { clientUserMessageId: 'target' });
  const g = fixture(method => method === 'thread/queue/list'
    ? page([row(1, { id: 'target', clientUserMessageId: 'target-other' })])
    : { queuedSubmission: added });
  assert.equal(await g.client.enqueue('thread', input, 'target', cwd), added);
  assert.equal(g.calls.filter(call => call.method === 'thread/queue/add').length, 1);
});

test('重复命令直接返回原row，新命令遇到20条上限明确拒绝', async () => {
  const original = row(1, { input: [{ type: 'text', text: '原始合成内容' }] });
  const changed = fixture(() => page([original]));
  assert.equal(await changed.client.enqueue('thread', input, 'command-1', cwd), original);
  const full = fixture(() => page(Array.from({ length: 20 }, (_, index) => row(index))));
  await assert.rejects(full.client.enqueue('thread', input, 'new-command', cwd), { code: 'NATIVE_QUEUE_FULL', outcomeUnknown: false });
  assert.equal([...changed.calls, ...full.calls].some(call => call.method === 'thread/queue/add'), false);
});

test('入队只发送准备好的UserInput及命令编号，删除返回原生deleted布尔值', async () => {
  const added = row(1);
  const f = fixture(method => method === 'thread/queue/list' ? page() : { queuedSubmission: added });
  assert.equal(await f.client.enqueue('thread', input, 'command-1', cwd), added);
  assert.deepEqual(f.calls[2], { method: 'thread/queue/add', params: { threadId: 'thread', input, clientUserMessageId: 'command-1' } });
  for (const deleted of [true, false]) {
    const g = fixture(() => ({ deleted }));
    assert.equal(await g.client.remove('thread', 'queue-1', cwd), deleted);
    assert.deepEqual(g.calls, [
      { method: 'thread/loaded/list', params: { limit: 1 } },
      { method: 'thread/queue/delete', params: { threadId: 'thread', queuedSubmissionId: 'queue-1' } },
      { method: 'thread/loaded/list', params: { limit: 1 } },
    ]);
  }
});

test('新增回执允许原生协议补齐或省略输入默认字段，完整返回原row', async () => {
  const original = row(1, { input: [{ type: 'text', text: '合成排队消息' }] });
  const f = fixture(method => method === 'thread/queue/list' ? page() : { queuedSubmission: original });
  assert.equal(await f.client.enqueue('thread', input, 'command-1', cwd), original);
});
test('非法编号、目录、输入及执行设置对象在连接前被拒绝', async () => {
  const f = fixture();
  for (const operation of [
    () => f.client.list('', cwd),
    () => f.client.list('thread', 'relative/project'),
    () => f.client.enqueue('thread', { input, approvalPolicy: 'never', model: 'example' }, 'command', cwd),
    () => f.client.enqueue('thread', [], 'command', cwd),
    () => f.client.enqueue('thread', input, '', cwd),
    () => f.client.remove('thread', '', cwd),
  ]) await assert.rejects(operation(), error => assertSafe(error, 'NATIVE_QUEUE_UNAVAILABLE'));
  assert.equal(f.runs.length, 0);
});

test('固定白名单拒绝未知方法、加载线程、轮次执行、队列update及审批覆盖', async () => {
  const f = fixture();
  for (const method of ['thread/start', 'thread/resume', 'turn/start', 'turn/steer', 'thread/queue/update', 'config/read', 'unknown', 'toString']) {
    await assert.rejects(f.client.run(cwd, request => request(method, {})), { code: 'NATIVE_QUEUE_UNAVAILABLE' });
  }
  for (const method of ['thread/queue/add', 'thread/queue/delete', 'thread/queue/list']) {
    await assert.rejects(f.client.run(cwd, request => request(method, { threadId: 'thread', approvalPolicy: 'never' })), { code: 'NATIVE_QUEUE_UNAVAILABLE' });
  }
  assert.equal(f.calls.every(call => call.method === 'thread/loaded/list'), true);
});

test('action前已有加载聊天时拒绝，action后加载异常在读操作中明确失败', async () => {
  for (const loaded of [page(['other-thread']), {}, page([], 'unexpected-cursor')]) {
    const f = fixture();
    let called = false;
    f.creation.run = async (_cwd, action) => action(async method => {
      assert.equal(method, 'thread/loaded/list');
      return loaded;
    });
    await assert.rejects(f.client.run(cwd, async () => { called = true; }), { code: 'NATIVE_QUEUE_UNAVAILABLE', outcomeUnknown: false });
    assert.equal(called, false);
  }
  const f = fixture();
  let checks = 0;
  f.creation.run = async (_cwd, action) => action(async method =>
    method === 'thread/loaded/list' ? page(checks++ ? ['unexpected-thread'] : []) : page());
  await assert.rejects(f.client.list('thread', cwd), { code: 'NATIVE_QUEUE_UNAVAILABLE', outcomeUnknown: false });
  assert.equal(checks, 2);
});

test('写入成功后出现加载聊天、检查断线或非法回执均为结果未知', async () => {
  for (const operation of ['enqueue', 'remove']) {
    for (const failure of ['loaded', 'disconnect', 'malformed']) {
      let checks = 0, writes = 0;
      const creation = {
        run: async (_cwd, action) => action(async method => {
          if (method === 'thread/loaded/list') {
            if (++checks === 2 && failure === 'disconnect') throw Error('/private/example 内部诊断');
            return page(checks === 2 && failure === 'loaded' ? ['unexpected-thread'] : []);
          }
          if (method === 'thread/queue/list') return page();
          writes++;
          if (failure === 'malformed') return operation === 'enqueue' ? { queuedSubmission: row(2) } : { deleted: 'yes' };
          return operation === 'enqueue' ? { queuedSubmission: row() } : { deleted: true };
        }),
      };
      const client = new NativeServerQueueClient({ creation });
      await assert.rejects(operation === 'enqueue'
        ? client.enqueue('thread', input, 'command-1', cwd)
        : client.remove('thread', 'queue-1', cwd), error => assertSafe(error, 'OUTCOME_UNKNOWN', true));
      assert.equal(writes, 1);
      assert.equal(checks, 2);
    }
  }
});

test('RPC明确拒绝读取原cause的固定代码映射，错误原文永不透出', async () => {
  for (const code of ['NATIVE_QUEUE_FULL', 'NATIVE_QUEUE_CHANGED', -32601, -32602]) {
    const f = fixture(method => {
      if (method === 'thread/queue/list') return page();
      throw Object.assign(Error('/private/example 内部诊断'), {
        code: 'CREATION_REJECTED', cause: { code, message: '/private/example 内部诊断' },
      });
    });
    await assert.rejects(f.client.enqueue('thread', input, 'command-1', cwd),
      error => assertSafe(error, typeof code === 'string' ? code : 'NATIVE_QUEUE_UNAVAILABLE'));
    assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
  }
  const f = fixture(() => { throw Error('/private/example 内部诊断'); });
  await assert.rejects(f.client.list('thread', cwd), error => assertSafe(error, 'NATIVE_QUEUE_UNAVAILABLE'));
});

function transportFixture(respond, timeoutMs = 20, normal = false) {
  const calls = [], launches = [];
  const launch = (executable, args, options) => {
    launches.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', 0);
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        for (const line of chunk.toString().trim().split('\n')) {
          const message = JSON.parse(line);
          calls.push(message);
          if (!message.id) continue;
          const result = message.method === 'initialize' ? {} : respond(message, child);
          if (result !== undefined) child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
        }
        done();
      },
    });
    child.stdin.on('finish', () => child.emit('exit', 0));
    return child;
  };
  const options = { launch, resolveCli: () => 'synthetic-cli', codexHome: path.resolve('synthetic-home'), timeoutMs };
  const client = normal ? new NativeServerQueueClient(options) : new NativeServerQueueClient({ creation: new ThreadCreationClient(options) });
  return { client, calls, launches, options };
}

test('正常构造透传codexHome及resolveCli，短连接开启实验API且始终不加载或执行聊天', async () => {
  const f = transportFixture(() => page(), 20, true);
  await f.client.list('thread', cwd);
  assert.deepEqual(f.calls.map(call => call.method), ['initialize', 'initialized', 'thread/loaded/list', 'thread/queue/list', 'thread/loaded/list']);
  assert.deepEqual(f.calls[0].params.capabilities, { experimentalApi: true });
  assert.equal(f.launches[0].executable, 'synthetic-cli');
  assert.equal(f.launches[0].options.env.CODEX_HOME, f.options.codexHome);
  assert.equal(f.launches[0].options.cwd, cwd);
  assert.deepEqual(f.launches[0].args, ['app-server', '--listen', 'stdio://']);
  assert.equal(f.launches[0].options.shell, false);
});

test('真实短连接的add与delete超时或断线保持结果未知，每次仅写一次', async () => {
  for (const method of ['thread/queue/add', 'thread/queue/delete']) {
    for (const failure of ['timeout', 'disconnect']) {
      const f = transportFixture((message, child) => {
        if (message.method === method) {
          if (failure === 'disconnect') queueMicrotask(() => child.emit('exit', 1));
          return undefined;
        }
        return page();
      });
      await assert.rejects(method === 'thread/queue/add'
        ? f.client.enqueue('thread', input, 'command-1', cwd)
        : f.client.remove('thread', 'queue-1', cwd), error => assertSafe(error, 'OUTCOME_UNKNOWN', true));
      assert.equal(f.calls.filter(call => call.method === method).length, 1);
      assert.equal(f.launches.length, 1);
      assert.equal(f.calls.some(call => /^(thread\/(?:start|resume)|turn\/)/.test(call.method)), false);
    }
  }
});

test('写前读取超时明确失败，写后回查超时与未知写入异常保持结果未知', async () => {
  const read = transportFixture(message => message.method === 'thread/loaded/list' ? page() : undefined);
  await assert.rejects(read.client.enqueue('thread', input, 'command-1', cwd), error => assertSafe(error, 'NATIVE_QUEUE_UNAVAILABLE'));
  assert.equal(read.calls.some(call => call.method === 'thread/queue/add'), false);

  let checks = 0;
  const postcheck = transportFixture(message => {
    if (message.method === 'thread/loaded/list') return ++checks === 1 ? page() : undefined;
    if (message.method === 'thread/queue/list') return page();
    return { queuedSubmission: row() };
  });
  await assert.rejects(postcheck.client.enqueue('thread', input, 'command-1', cwd), error => assertSafe(error, 'OUTCOME_UNKNOWN', true));

  for (const error of [
    Error('/private/example 内部诊断'),
    Object.assign(Error('/private/example 内部诊断'), { code: 'CREATION_REJECTED', outcomeUnknown: true, cause: { code: 'NATIVE_QUEUE_FULL' } }),
  ]) {
    const f = fixture(method => {
      if (method === 'thread/queue/list') return page();
      throw error;
    });
    await assert.rejects(f.client.enqueue('thread', input, 'command-1', cwd), failure => assertSafe(failure, 'OUTCOME_UNKNOWN', true));
    assert.equal(f.calls.filter(call => call.method === 'thread/queue/add').length, 1);
  }
});
