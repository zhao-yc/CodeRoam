import test from 'node:test';
import assert from 'node:assert/strict';
import {createWindowsStartupControl} from '../apps/bridge/management-startup.mjs';

function fixture() {
  const root = 'C:/example/project';
  const supervisor = root + '/supervisor/service-supervisor.mjs';
  const workerConfigPath = root + '/worker.json';
  const runtime = {platform: 'win32', ppid: 100, execPath: 'C:/example/node.exe'};
  const host = {
    UserSid: 'synthetic-user-sid',
    WorkerConfig: 'c:\\EXAMPLE\\project\\worker.json',
    SupervisorPath: supervisor,
    NodePath: runtime.execPath,
    ProjectRoot: root,
  };
  const registration = {
    name: 'CodexMobileBridge', processId: 100, mode: 'Auto',
    image: '"C:\\ProgramData\\Example\\CodexMobileBridge.exe"',
    programData: 'C:/ProgramData', userSid: host.UserSid,
  };
  const scripts = [];
  const change = {
    run(script) {
      registration.mode = script.includes("'start=', 'auto'") ? 'Auto' : 'Manual';
      return '0';
    },
  };
  const control = createWindowsStartupControl({workerConfigPath, projectRoot: root}, {
    runtime, supervisor,
    readHost: file => {
      assert.equal(file, 'C:\\ProgramData\\Example\\service.json');
      return host;
    },
    execute: async (script, timeout) => {
      if (script.includes('Get-CimInstance')) return JSON.stringify(registration);
      scripts.push({script, timeout});
      return change.run(script);
    },
  });
  return {control, registration, host, scripts, change};
}

test('只有实际服务宿主和绑定托管配置都匹配时才公开开机启动状态', async () => {
  const {control, registration, host, scripts} = fixture();
  assert.equal(await control.read(), true);
  registration.processId++;
  assert.equal(await control.read(), undefined);
  await assert.rejects(control.set(false), {code: 'MANAGEMENT_STARTUP_UNAVAILABLE'});
  registration.processId--;
  host.WorkerConfig = 'C:/example/other/worker.json';
  assert.equal(await control.read(), undefined);
  await assert.rejects(control.set(false), {code: 'MANAGEMENT_STARTUP_UNAVAILABLE'});
  assert.equal(scripts.length, 0);
  assert.equal(createWindowsStartupControl({workerConfigPath: 'C:/example/worker.json'}, {runtime: {platform: 'darwin'}}), null);
});

test('启动开关只发出固定的 Windows 服务配置命令并核对 SCM 写入结果', async () => {
  const {control, scripts} = fixture();
  await assert.rejects(control.set('false'), {code: 'MANAGEMENT_REQUEST_INVALID'});
  assert.deepEqual(await control.set(true), {startupEnabled: true});
  assert.equal(scripts.length, 0);
  assert.deepEqual(await control.set(false), {startupEnabled: false});
  assert.equal(await control.read(), false);
  assert.match(scripts[0].script, /\(\[Environment\]::SystemDirectory\) 'sc\.exe'/);
  assert.match(scripts[0].script, /-Verb RunAs/);
  assert.match(scripts[0].script, /@\('config', 'CodexMobileBridge', 'start=', 'demand'\)/);
  assert.equal(scripts[0].timeout, 0);
  assert.deepEqual(await control.set(true), {startupEnabled: true});
  assert.match(scripts[1].script, /@\('config', 'CodexMobileBridge', 'start=', 'auto'\)/);
});

test('等待 Windows 确认时仍可读取状态且拒绝第二次写入，取消后可以重试', async () => {
  const {control, change} = fixture();
  const original = change.run;
  let settle;
  let promptOpened;
  const prompt = new Promise(resolve => { promptOpened = resolve; });
  change.run = () => new Promise(resolve => { settle = resolve; promptOpened(); });
  const write = control.set(false);
  await prompt;
  assert.equal(await control.read(), true);
  await assert.rejects(control.set(false), {code: 'MANAGEMENT_BUSY'});
  settle('canceled');
  await assert.rejects(write, {code: 'MANAGEMENT_STARTUP_CANCELED'});
  assert.equal(await control.read(), true);
  change.run = () => '0';
  await assert.rejects(control.set(false), {code: 'MANAGEMENT_STARTUP_FAILED'});
  change.run = original;
  assert.deepEqual(await control.set(false), {startupEnabled: false});
});
