import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createManagerController, trustedSender, validateWorkerFile} from '../apps/desktop-manager/electron/manager-controller.mjs';

/** 创建管理端自己的隔离偏好与合成托管文件，不连接正在使用的服务。 */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manager-shell-'));
  const file = path.join(root, 'worker.json'), preferencesPath = path.join(root, 'manager.json');
  fs.writeFileSync(file, JSON.stringify(Object.fromEntries(['entry','bridgeConfig','runDirectory','logDirectory','statusFile','projectRoot'].map(key => [key, path.join(root, key)]))));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.equal(path.basename(root).startsWith('codex-manager-shell-'), true);
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {root, file, preferencesPath};
}

test('管理界面仅接受自己的首页顶层 IPC，拒绝外部窗口和子框架', () => {
  const frame = {url: 'file:///manager/index.html'}, contents = {mainFrame: frame}, window = {webContents: contents};
  assert.equal(trustedSender({sender: contents, senderFrame: frame}, window, frame.url), true);
  assert.equal(trustedSender({sender: {}, senderFrame: frame}, window, frame.url), false);
  assert.equal(trustedSender({sender: contents, senderFrame: {...frame}}, window, frame.url), false);
  frame.url = 'https://example.com/index.html';
  assert.equal(trustedSender({sender: contents, senderFrame: frame}, window, 'file:///manager/index.html'), false);
  assert.equal(trustedSender({}, null, ''), false);
});

test('未关联服务时不启动桥接，取消选择不改变关联状态', async t => {
  const f = fixture(t); let connections = 0;
  const controller = createManagerController({...f, version: '0.1.0', platform: 'win32', chooseFile: async () => '', connect: () => { connections++; }});
  assert.equal(controller.context().configured, false);
  await assert.rejects(controller.request('status'), /先选择/);
  assert.equal((await controller.chooseWorker()).configured, false);
  assert.equal(connections, 0); assert.equal(fs.existsSync(f.preferencesPath), false);
});

test('原生选择关联仅保存托管路径，后续操作复用同一现有服务', async t => {
  const f = fixture(t), calls = [];
  const controller = createManagerController({...f, version: '0.1.0', platform: 'win32', chooseFile: async () => f.file, connect: file => ({request: async (method, params) => { calls.push({file, method, params}); return {running: true}; }})});
  assert.equal((await controller.chooseWorker()).configured, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.preferencesPath)), {workerConfigPath: f.file});
  assert.deepEqual(await controller.request('status'), {running: true});
  assert.deepEqual(calls, [{file: f.file, method: 'status', params: {}}]);
  const restored = createManagerController({...f, version: '0.1.0', platform: 'win32', chooseFile: async () => '', connect: () => {}});
  assert.equal(restored.context().workerConfigPath, f.file);
});

test('失效偏好回到选择入口，非托管 JSON 和相对路径不能被关联', async t => {
  const f = fixture(t);
  fs.writeFileSync(f.preferencesPath, JSON.stringify({workerConfigPath: path.join(f.root, 'missing.json')}));
  const controller = createManagerController({...f, version: '0.1.0', platform: 'win32', chooseFile: async () => f.preferencesPath, connect: () => {}});
  assert.equal(controller.context().configured, false);
  await assert.rejects(controller.chooseWorker(), /不是有效/);
  assert.throws(() => validateWorkerFile('worker.json'), /请选择/);
  fs.writeFileSync(f.file, '合成私有正文不可出现在错误提示');
  assert.throws(() => validateWorkerFile(f.file), error => error.code === 'MANAGER_CONFIG_INVALID' && !error.message.includes('合成私有正文'));
});
