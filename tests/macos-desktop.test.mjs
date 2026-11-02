import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultIpcSocketPath } from '../packages/protocol/ipc-client.mjs';
import { desktopCodexPath } from '../apps/bridge/thread-creation.mjs';
import { openDesktopThread } from '../apps/bridge/desktop-launcher.mjs';
import { acquireRuntimeLock } from '../apps/bridge/runtime-lock.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const id = '00000000-0000-4000-8000-000000000001';

test('平台默认 IPC 保留 Windows 管道并尊重 Mac 私有用户目录', () => {
  assert.equal(defaultIpcSocketPath({ platform: 'win32' }), '\\\\.\\pipe\\codex-ipc');
  assert.equal(defaultIpcSocketPath({ platform: 'darwin', codexHome: '/private/example/codex' }), '/private/example/codex/ipc/ipc.sock');
});

test('Mac 只通过固定桌面标识打开经过校验的会话，不调用受限原生管理接口', async () => {
  const calls = [], launch = async (...args) => calls.push(args);
  await openDesktopThread(id, { platform: 'darwin', launch, nativeApi: { navigate: () => assert.fail('不应调用原生管理接口') } });
  assert.deepEqual(calls[0].slice(0, 2), ['/usr/bin/open', ['-b', 'com.openai.codex', `codex://threads/${id}`]]);
  for (const invalid of ['bad', `${id}?prompt=run`, `${id}/other`]) {
    await assert.rejects(openDesktopThread(invalid, { platform: 'darwin', launch }), error => error.code === 'BAD_THREAD_ID');
  }
  assert.equal(calls.length, 1);
});

test('Mac 导航过期不启动进程，系统启动失败不透传路径或伪报成功', async () => {
  await assert.rejects(openDesktopThread(id, { platform: 'darwin', isCurrent: () => false, launch: () => assert.fail() }), error => error.code === 'SUBSCRIPTION_CANCELED');
  await assert.rejects(openDesktopThread(id, { platform: 'darwin', launch: () => { throw new Error('/private/example'); } }), error => error.code === 'DESKTOP_LOAD_FAILED' && !error.message.includes('/private'));
});

test('Mac CLI 同时识别整合版和独立桌面的随附程序，缺少程序时明确失败', () => {
  for (const installed of [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ]) {
    const options = { platform: 'darwin', env: {}, exists: file => file === installed, stat: () => ({ isFile: () => true }) };
    assert.equal(desktopCodexPath(undefined, options), installed);
  }
  assert.throws(() => desktopCodexPath(undefined, { platform: 'darwin', env: {}, exists: () => false }), error => error.code === 'CREATION_UNSUPPORTED');
});

test('Mac 长路径仍可排他，异常退出后仅回收失效套接字', { skip: process.platform !== 'darwin', timeout: 5000 }, async t => {
  const identity = '/private/example/' + 'long-project/'.repeat(20) + randomUUID();
  const module = new URL('../apps/bridge/runtime-lock.mjs', import.meta.url).href;
  const code = `import {acquireRuntimeLock} from ${JSON.stringify(module)};await acquireRuntimeLock(${JSON.stringify(identity)});console.log('就绪');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  let release;
  t.after(() => { child.kill(); release?.(); });
  await once(child.stdout, 'data');
  await assert.rejects(acquireRuntimeLock(identity), error => error.code === 'BRIDGE_ALREADY_RUNNING');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  release = await acquireRuntimeLock(identity);
  await assert.rejects(acquireRuntimeLock(identity), error => error.code === 'BRIDGE_ALREADY_RUNNING');
});
