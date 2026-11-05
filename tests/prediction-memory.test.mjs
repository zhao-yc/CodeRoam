import test from 'node:test';
import assert from 'node:assert/strict';
import { V8PredictionCache } from '../apps/bridge/v8-prediction-cache.mjs';
import { DesktopPredictionMemory, PredictionMemoryTransport } from '../apps/bridge/prediction-memory.mjs';

/** 合成压缩指针堆覆盖真实字段布局；不读取本机进程或保存真实会话内容。 */
function fixture({ text = '中文原文  \n下一行', sourceTurnId = 'turn-1', outOfObject = false } = {}) {
  const base = 0x100000000n, heap = Buffer.alloc(1024 * 1024), strings = new Map();
  let used = 0x10000;
  const allocate = size => { const offset = used; used += (size + 7) & ~7; return base + BigInt(offset); };
  const offsetOf = address => Number(address - base);
  const write = (address, value) => heap.writeUInt32LE(value >>> 0, offsetOf(address));
  const tag = address => Number(address - base) + 1;
  const meta = allocate(40), empty = allocate(16);
  write(meta, tag(meta));
  heap[offsetOf(meta) + 4] = 10;
  heap.writeUInt16LE(0x91, offsetOf(meta) + 8);
  const map = (type, size, fields = []) => {
    const address = allocate(40), descriptors = fields.length ? allocate(16 + fields.length * 12) : empty;
    write(address, tag(meta)); heap[offsetOf(address) + 4] = size; heap[offsetOf(address) + 5] = 3;
    heap.writeUInt16LE(type, offsetOf(address) + 8);
    write(address + 12n, fields.length << 10); write(address + 24n, tag(descriptors));
    if (fields.length) {
      write(descriptors, tag(meta));
      heap.writeUInt16LE(fields.length, offsetOf(descriptors) + 4);
      heap.writeUInt16LE(fields.length, offsetOf(descriptors) + 6);
      fields.forEach((field, index) => {
        write(descriptors + BigInt(16 + index * 12), tag(field.key));
        write(descriptors + BigInt(20 + index * 12), field.details * 2);
      });
    }
    return address;
  };
  const oneByte = map(8, 3), twoByte = map(0, 3), symbolMap = map(0x80, 4);
  const string = value => {
    if (strings.has(value)) return strings.get(value);
    const ascii = /^[\x00-\x7f]*$/.test(value), bytes = Buffer.from(value, ascii ? 'latin1' : 'utf16le');
    const address = allocate(12 + bytes.length);
    write(address, tag(ascii ? oneByte : twoByte)); write(address + 8n, value.length);
    bytes.copy(heap, offsetOf(address) + 12); strings.set(value, address); return address;
  };
  const symbol = name => { const address = allocate(16); write(address, tag(symbolMap)); write(address + 12n, tag(string(name))); return address; };
  const object = (values, inline = Object.keys(values).length) => {
    const entries = Object.entries(values);
    const fields = entries.map(([name], index) => ({
      key: name.startsWith('@') ? symbol(name.slice(1)) : string(name),
      details: 0xc2 + ((index < inline ? 3 + index : 2 + index - inline) * 0x80000) + (index < inline ? 0x40000000 : 0),
    }));
    const shape = map(0x421, 3 + inline, fields), address = allocate((3 + inline) * 4);
    write(address, tag(shape));
    let properties;
    if (inline < entries.length) {
      properties = allocate(8 + (entries.length - inline) * 4);
      write(properties, tag(meta)); write(properties + 4n, (entries.length - inline) * 2);
      write(address + 4n, tag(properties));
    }
    entries.forEach(([, value], index) => write(index < inline ? address + BigInt((3 + index) * 4) : properties + BigInt((2 + index - inline) * 4), tag(value)));
    return address;
  };
  const array = values => {
    const elements = allocate(8 + values.length * 4);
    write(elements, tag(meta)); write(elements + 4n, values.length);
    values.forEach((value, index) => write(elements + BigInt(8 + index * 4), tag(string(value))));
    const address = allocate(16); write(address, tag(map(0x420, 4))); write(address + 8n, tag(elements)); write(address + 12n, values.length * 2); return address;
  };
  const jsMapShape = map(0x40c, 4);
  const jsMap = entries => {
    const table = allocate(28 + entries.length * 12), address = allocate(16);
    write(table, tag(meta)); write(table + 4n, 5 + entries.length * 3);
    write(table + 8n, entries.length * 2); write(table + 16n, 4);
    entries.forEach(([key, value], index) => { write(table + BigInt(28 + index * 12), tag(string(key))); write(table + BigInt(32 + index * 12), tag(value)); });
    write(address, tag(jsMapShape)); write(address + 12n, tag(table)); return { address, table };
  };
  const data = object({ text: string(text), sourceTurnId: string(sourceTurnId) }, outOfObject ? 1 : 2);
  const state = object({ data, status: string('success'), fetchStatus: string('idle') });
  const query = object({ queryKey: array(['local', 'thread-1', 'turn-1']), state });
  const queryIndex = jsMap([[JSON.stringify(['local', 'thread-1', 'turn-1']), query]]);
  const queryCache = object({ '@queries': queryIndex.address });
  const client = object({ '@queryCache': queryCache });
  const moderation = jsMap([]), service = object({ controller: state });
  const controller = object({ queries: client, service, moderationMetadataBySourceTurn: moderation.address });
  write(service + 12n, tag(controller));
  const host = object({ cumberbatchController: controller });
  const reads = new Map();
  const memory = {
    closed: false,
    hook: null,
    async findKeys(names) { return { keys: names.filter(name => strings.has(name)).map(name => ({ address: '0x' + strings.get(name).toString(16), name })), truncated: false }; },
    async references(targets) {
      const values = new Set(targets.map(item => item.value)), matches = [];
      for (let index = 0; index < used; index += 4) {
        const value = heap.readUInt32LE(index);
        if (values.has(value)) matches.push({ address: '0x' + (base + BigInt(index)).toString(16), value, cage: '0x' + base.toString(16) });
      }
      return { matches, truncated: false };
    },
    async read(value, length) {
      const address = BigInt(value), count = (reads.get(value) ?? 0) + 1;
      reads.set(value, count); memory.hook?.(address, count);
      return Buffer.from(heap.subarray(offsetOf(address), offsetOf(address) + length));
    },
    close() { this.closed = true; },
  };
  return { memory, data, state, host, client, controller, queryIndex, write, tag, base, text };
}

test('预测从主宿主根沿查询索引读取，保留中文空格和换行', async () => {
  const source = fixture(), cache = new V8PredictionCache(source.memory);
  assert.deepEqual(await cache.read('local', 'thread-1', 'turn-1'), { threadId: 'thread-1', sourceTurnId: 'turn-1', text: source.text });
});

test('对象外字段与私有 Symbol 缓存索引使用实际字段偏移', async () => {
  const source = fixture({ outOfObject: true });
  assert.equal((await new V8PredictionCache(source.memory).read('local', 'thread-1', 'turn-1')).text, source.text);
});

test('错误主机、聊天和轮次不接纳其他查询的预测', async () => {
  for (const args of [['other', 'thread-1', 'turn-1'], ['local', 'other', 'turn-1'], ['local', 'thread-1', 'other']]) {
    assert.equal(await new V8PredictionCache(fixture().memory).read(...args), null);
  }
  assert.equal(await new V8PredictionCache(fixture({ sourceTurnId: 'old-turn' }).memory).read('local', 'thread-1', 'turn-1'), null);
});

test('独立回读期间清空查询缓存会丢弃原预测', async () => {
  const source = fixture();
  const page = source.host & ~4095n;
  source.memory.hook = (address, count) => { if (address === page && count === 2) source.write(source.queryIndex.table + 8n, 0); };
  assert.equal(await new V8PredictionCache(source.memory).read('local', 'thread-1', 'turn-1'), null);
});

test('二次回读重新核对控制器上的查询客户端，不读取旧索引', async () => {
  const source = fixture(), page = source.host & ~4095n;
  source.memory.hook = (address, count) => { if (address === page && count === 2) source.write(source.controller + 12n, source.tag(source.state)); };
  assert.equal(await new V8PredictionCache(source.memory).read('local', 'thread-1', 'turn-1'), null);
});

test('普通启动和无页面端口的多实例使用相同只读缓存路径', async () => {
  for (const mode of [{ directIpc: true }, { routerManaged: true }]) {
    const source = fixture(), opened = [];
    const reader = new DesktopPredictionMemory({ platform: 'win32', open: identity => { opened.push(identity); return source.memory; } });
    // 使用实际 Windows 发现器的记录形态，省略 platform 字段。
    const instance = { ...mode, port: null, alive: true, ready: true, pid: 10, startedAt: 20, generation: 'one' };
    const result = await reader.read({ client: { instance, assertCurrent() {} } }, 'local', 'thread-1', 'turn-1');
    assert.equal(result.available, true); assert.equal(result.prediction.text, source.text);
    assert.deepEqual(opened, [{ pid: 10, startedAt: 20 }]);
    reader.close(); assert.equal(source.memory.closed, true);
  }
});

test('实例代次变化后丢弃在途只读结果', async () => {
  const source = fixture(), instance = { platform: 'win32', alive: true, ready: true, pid: 10, startedAt: 20, generation: 'one' };
  const reader = new DesktopPredictionMemory({ platform: 'win32', open: () => source.memory });
  source.memory.hook = () => { instance.generation = 'two'; };
  assert.equal((await reader.read({ client: { instance, assertCurrent() {} } }, 'local', 'thread-1', 'turn-1')).available, false);
  reader.close();
});

test('旧单实例入口在原生 PID 或连接变化后丢弃结果', async () => {
  for (const change of [native => { native.processId++; }, native => { native.socket = {}; }]) {
    const source = fixture(), native = { platform: 'win32', processId: 10, socket: {}, async connect() {} };
    const reader = new DesktopPredictionMemory({ platform: 'win32', open: () => source.memory });
    let changed = false;
    source.memory.hook = () => { if (!changed) { change(native); changed = true; } };
    assert.equal((await reader.read({ native }, 'local', 'thread-1', 'turn-1')).available, false);
    reader.close();
  }
});

test('传输接收满额合法引用，并逐行处理同批多条回复', () => {
  const received = [], transport = Object.create(PredictionMemoryTransport.prototype);
  transport.buffer = ''; transport.closed = false; transport.pending = new Map();
  for (const id of [1, 2]) transport.pending.set(id, { timer: null, resolve: value => received.push(value), reject: assert.fail });
  const result = { matches: Array.from({ length: 2048 }, () => ({ address: '0x123456789abc', cage: '0x123400000000', value: 123456789 })), truncated: false };
  transport.receive(JSON.stringify({ id: 1, result }) + '\n' + JSON.stringify({ id: 2, result }) + '\n');
  assert.equal(transport.closed, false); assert.equal(received.length, 2); assert.equal(received[0].matches.length, 2048);
});
