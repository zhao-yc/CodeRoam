import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, errorPayload } from '../packages/protocol/contracts.mjs';
import { readStoredMessageQueue } from '../apps/bridge/native-stored-message-queue.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
const native = (changes = {}) => ({ id: 'synthetic-message', text: '合成队列消息', ...changes });
const state = rows => ({ 'queued-follow-ups': { thread: rows } });

function fixture(t, value) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'native-stored-queue-'));
  const file = path.join(home, '.codex-global-state.json');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (value !== undefined) fs.writeFileSync(file, JSON.stringify(value));
  return { home, file, read: (threadId = 'thread') => readStoredMessageQueue(home, threadId) };
}

function safe(error) {
  assert.ok(error instanceof BridgeError);
  assert.deepEqual(errorPayload(error), {
    code: 'NATIVE_QUEUE_UNAVAILABLE',
    message: '电脑原生队列暂时无法读取，请重新同步后重试',
    outcomeUnknown: false,
  });
  assert.equal(error.cause, undefined);
  assert.equal(error.message.includes('/private/example'), false);
  return true;
}

test('文件不存在、存储键缺失与目标聊天缺失时返回空数组，不创建原文件', t => {
  const f = fixture(t);
  assert.deepEqual(f.read(), []);
  assert.equal(fs.existsSync(f.file), false);
  fs.writeFileSync(f.file, '{}');
  assert.deepEqual(f.read(), []);
  fs.writeFileSync(f.file, JSON.stringify({ 'queued-follow-ups': {} }));
  assert.deepEqual(f.read('constructor'), []);
  assert.deepEqual(f.read('__proto__'), []);
  assert.deepEqual(f.read('../another-file'), []);
});

test('完整返回特殊设置、复杂输入及长正文原始行，文件内容与修改时间保持一致', t => {
  const rows = [native({
    text: '合成'.repeat(20000),
    context: { model: 'synthetic-model', approvalPolicy: 'on-request', path: '/private/example/context' },
    input: [{ type: 'localImage', path: '/private/example/image.png' }, { type: 'mention', path: 'plugin://example' }],
    privateRaw: { retained: true },
  })];
  const f = fixture(t, state(rows));
  const before = fs.readFileSync(f.file), info = fs.statSync(f.file, { bigint: true });
  assert.deepEqual(f.read(), rows);
  assert.deepEqual(fs.readFileSync(f.file), before);
  const after = fs.statSync(f.file, { bigint: true });
  assert.equal(after.mtimeNs, info.mtimeNs);
  assert.equal(after.ctimeNs, info.ctimeNs);
  assert.equal(after.ino, info.ino);
});

test('拒绝损坏JSON、非plain根对象及非法线程映射，错误提示统一脱敏', t => {
  const f = fixture(t);
  for (const value of [null, [], 'private', 4,
    { 'queued-follow-ups': null }, { 'queued-follow-ups': [] }, { 'queued-follow-ups': 'private' },
    { 'queued-follow-ups': { thread: null } }, { 'queued-follow-ups': { thread: {} } },
    { 'queued-follow-ups': { thread: 'private' } },
  ]) {
    fs.writeFileSync(f.file, JSON.stringify(value));
    assert.throws(() => f.read(), safe);
  }
  fs.writeFileSync(f.file, '{"内部诊断 /private/example":');
  assert.throws(() => f.read(), safe);
});

test('拒绝非法原生行及超长编号，保留允许的完整200字编号和空正文', t => {
  const f = fixture(t);
  for (const row of [null, [], {}, native({ id: null }), native({ id: 3 }),
    native({ id: 'a'.repeat(201) }), native({ text: null }), native({ text: 3 })]) {
    fs.writeFileSync(f.file, JSON.stringify(state([row])));
    assert.throws(() => f.read(), safe);
  }
  const allowed = native({ id: 'a'.repeat(200), text: '' });
  fs.writeFileSync(f.file, JSON.stringify(state([allowed])));
  assert.deepEqual(f.read(), [allowed]);
});

test('200条完整返回，201条拒绝且不截断', t => {
  const rows = Array.from({ length: 200 }, (_, index) => native({ id: 'message-' + index }));
  const f = fixture(t, state(rows));
  assert.deepEqual(f.read(), rows);
  fs.writeFileSync(f.file, JSON.stringify(state([...rows, native()])));
  assert.throws(() => f.read(), safe);
});

test('stat发现超过32MiB时拒绝，在打开和读取前终止', t => {
  const f = fixture(t, {});
  fs.truncateSync(f.file, MAX_BYTES + 1);
  const open = t.mock.method(fs, 'openSync', () => { throw Error('不应打开超限文件'); });
  assert.throws(() => f.read(), safe);
  assert.equal(open.mock.callCount(), 0);
});

test('恰好32MiB的有效JSON允许读取，按字节而非字符计数', t => {
  const rows = [native()];
  const f = fixture(t);
  const bytes = Buffer.alloc(MAX_BYTES, 0x20);
  Buffer.from(JSON.stringify(state(rows))).copy(bytes);
  fs.writeFileSync(f.file, bytes);
  assert.deepEqual(f.read(), rows);
  assert.equal(fs.statSync(f.file).size, MAX_BYTES);
});

test('拒绝目录和符号链接，不跟随链接读取目标', t => {
  const f = fixture(t);
  fs.mkdirSync(f.file);
  assert.throws(() => f.read(), safe);
  fs.rmdirSync(f.file);
  const target = path.join(f.home, 'synthetic-state.json');
  fs.writeFileSync(target, JSON.stringify(state([native()])));
  try {
    fs.symlinkSync(target, f.file, 'file');
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('当前 Windows 用户无创建文件符号链接权限');
      return;
    }
    throw error;
  }
  const open = t.mock.method(fs, 'openSync', () => { throw Error('不应打开链接'); });
  assert.throws(() => f.read(), safe);
  assert.equal(open.mock.callCount(), 0);
});

test('即使链接目标为普通文件也必须在打开前拒绝，独立于系统创建链接权限', t => {
  const f = fixture(t, state([native()]));
  const info = fs.lstatSync(f.file, { bigint: true });
  t.mock.method(fs, 'lstatSync', () => ({
    ...info, isFile: () => true, isSymbolicLink: () => true,
  }));
  const open = t.mock.method(fs, 'openSync', () => { throw Error('不应跟随链接打开文件'); });
  assert.throws(() => f.read(), safe);
  assert.equal(open.mock.callCount(), 0);
});
test('分次短读可完整恢复JSON，固定以只读句柄打开已知文件', t => {
  const rows = [native()], f = fixture(t, state(rows));
  const originalRead = fs.readSync, originalOpen = fs.openSync;
  const open = t.mock.method(fs, 'openSync', (...args) => originalOpen(...args));
  t.mock.method(fs, 'readSync', (fd, bytes, offset, length, position) =>
    originalRead(fd, bytes, offset, Math.min(length, 7), position));
  assert.deepEqual(f.read(), rows);
  assert.deepEqual(open.mock.calls.map(call => call.arguments), [[f.file, 'r']]);
});

test('打开后句柄身份与先前路径不同时拒绝并关闭句柄', t => {
  const f = fixture(t, state([native()]));
  const originalStat = fs.fstatSync, originalClose = fs.closeSync;
  // 模拟替换后的不同 inode，避免 Windows 文件共享检查在取得句柄前提前拒绝。
  t.mock.method(fs, 'fstatSync', (...args) => {
    const result = originalStat(...args);
    result.ino += 1n;
    return result;
  });
  const close = t.mock.method(fs, 'closeSync', fd => originalClose(fd));
  assert.throws(() => f.read(), safe);
  assert.equal(close.mock.callCount(), 1);
});

test('读取期间增长、缩短或同大小重写时拒绝', t => {
  const f = fixture(t, state([native()]));
  const originalRead = fs.readSync;
  for (const change of ['grow', 'shrink', 'rewrite']) {
    fs.writeFileSync(f.file, JSON.stringify(state([native()])));
    let changed = false;
    const read = t.mock.method(fs, 'readSync', (...args) => {
      const count = originalRead(...args);
      if (!changed) {
        changed = true;
        if (change === 'grow') fs.appendFileSync(f.file, ' ');
        if (change === 'shrink') fs.truncateSync(f.file, 1);
        if (change === 'rewrite') {
          fs.writeFileSync(f.file, JSON.stringify(state([native({ text: '变更队列消息' })])));
          const later = new Date(Date.now() + 1000);
          fs.utimesSync(f.file, later, later);
        }
      }
      return count;
    });
    assert.throws(() => f.read(), safe);
    read.mock.restore();
  }
});

test('读取期间路径被替换时拒绝，句柄中的旧内容不作为当前队列', t => {
  const f = fixture(t, state([native()]));
  const originalRead = fs.readSync;
  let changed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = originalRead(...args);
    if (!changed) {
      changed = true;
      fs.renameSync(f.file, path.join(f.home, 'synthetic-old.json'));
      fs.writeFileSync(f.file, JSON.stringify(state([])));
    }
    return count;
  });
  assert.throws(() => f.read(), safe);
});

test('读取或关闭异常均脱敏，读取失败也关闭句柄，后续ENOENT不能伪装成空队列', t => {
  const f = fixture(t, state([native()]));
  const originalClose = fs.closeSync;
  const close = t.mock.method(fs, 'closeSync', fd => originalClose(fd));
  const read = t.mock.method(fs, 'readSync', () => {
    throw Object.assign(Error('/private/example 内部诊断'), { code: 'ENOENT' });
  });
  assert.throws(() => f.read(), safe);
  assert.equal(close.mock.callCount(), 1);
  read.mock.restore();
  close.mock.restore();
  t.mock.method(fs, 'closeSync', fd => {
    originalClose(fd);
    throw Error('/private/example 关闭异常');
  });
  assert.throws(() => f.read(), safe);
});

test('非法配置目录和线程参数安全拒绝', t => {
  const f = fixture(t, state([]));
  for (const home of [null, 3, '', 'relative/home']) assert.throws(() => readStoredMessageQueue(home, 'thread'), safe);
  for (const threadId of [null, 3, '', 't'.repeat(201)]) assert.throws(() => readStoredMessageQueue(f.home, threadId), safe);
});
