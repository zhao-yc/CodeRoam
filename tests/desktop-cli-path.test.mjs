import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { desktopCodexPath } from '../apps/bridge/thread-creation.mjs';

const paths = path.win32;
const localData = 'C:\\Users\\example\\AppData\\Local';
const cacheRoot = paths.join(localData, 'OpenAI', 'Codex', 'bin');
const windowsApps = 'C:\\Program Files\\WindowsApps';
const oldHash = '1111111111111111', newHash = '2222222222222222';
const cli = hash => paths.join(cacheRoot, hash, 'codex.exe');
const info = modified => ({ isFile: () => true, mtimeMs: modified });

/** 模拟独立用户服务无法枚举安装目录，使用真实定位方法检查桌面缓存回退。 */
function fixture({ folders = [oldHash, newHash], files = new Map([[cli(oldHash), info(1)], [cli(newHash), info(2)]]) } = {}) {
  const reads = [];
  return { reads, options: {
    platform: 'win32', env: { LOCALAPPDATA: localData, ProgramFiles: 'C:\\Program Files' },
    exists: file => files.has(file),
    stat: file => { if (!files.has(file)) throw Object.assign(new Error('文件已清理'), { code: 'ENOENT' }); return files.get(file); },
    directories: directory => { reads.push(directory); if (directory === cacheRoot) return folders; throw Object.assign(new Error('安装目录禁止枚举'), { code: 'EPERM' }); },
  } };
}

test('独立服务无需枚举 WindowsApps，选择最近完整的桌面 CLI 缓存', () => {
  const f = fixture();
  assert.equal(desktopCodexPath(undefined, f.options), cli(newHash));
  assert.deepEqual(f.reads, [cacheRoot]);
});

test('本机显式路径和环境变量优先，手机不能借此传入相对程序', () => {
  const configured = 'D:\\本机程序\\codex.exe', environment = 'D:\\环境程序\\codex.exe';
  const f = fixture({ files: new Map([[configured, info(1)], [environment, info(1)]]) });
  f.options.env.CODEX_CLI_PATH = environment;
  assert.equal(desktopCodexPath(configured, f.options), configured);
  assert.equal(desktopCodexPath('./codex.exe', f.options), environment);
  assert.deepEqual(f.reads, []);
});

test('忽略正在解包、路径跳转、非文件及已清理版本，不因单项失效中断查找', () => {
  const f = fixture({ folders: ['.staging-2222222222222222-temp', '..', 'codex.exe', '3333333333333333', newHash, oldHash], files: new Map([[cli(newHash), { isFile: () => false, mtimeMs: 999 }], [cli(oldHash), info(1)]]) });
  assert.equal(desktopCodexPath(undefined, f.options), cli(oldHash));
});

test('缓存查询失败或没有可执行文件时，仍可使用原桌面安装位置并按版本排序', () => {
  for (const denied of [false, true]) {
    const f = fixture({ folders: [], files: new Map() });
    const latest = 'OpenAI.Codex_26.10.0.0_x64__publisher';
    const installed = paths.join(windowsApps, latest, 'app', 'resources', 'codex.exe');
    f.options.directories = directory => {
      if (directory === cacheRoot) { if (denied) throw new Error('缓存不可读'); return []; }
      assert.equal(directory, windowsApps);
      return ['OpenAI.Codex_26.9.0.0_x64__publisher', latest];
    };
    f.options.exists = candidate => candidate === installed;
    assert.equal(desktopCodexPath(undefined, f.options), installed);
  }
});

test('缺少 LOCALAPPDATA 时使用原用户目录，缓存失效仍返回明确能力错误', () => {
  const f = fixture();
  delete f.options.env.LOCALAPPDATA;
  f.options.env.USERPROFILE = 'C:\\Users\\example';
  assert.equal(desktopCodexPath(undefined, f.options), cli(newHash));
  const empty = fixture({ folders: [], files: new Map() });
  assert.throws(() => desktopCodexPath(undefined, empty.options), error => error.code === 'CREATION_UNSUPPORTED' && /可访问/.test(error.message));
});
