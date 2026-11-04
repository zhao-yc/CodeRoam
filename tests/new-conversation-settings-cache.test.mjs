import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NewThreadService } from '../apps/bridge/new-thread-service.mjs';
import { ModelCatalog } from '../apps/bridge/model-settings.mjs';

const DAY = 24 * 60 * 60 * 1000;
const SETTINGS_TTL = 2 * 60 * 60 * 1000;

/** 用可控回执精确安排配置读取与文件变化，避免依赖定时等待。 */
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

/** 每例使用真实项目与模型文件，只有昂贵的辅助进程由可控读取器替代。 */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-settings-cache-'));
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace'), cwd = path.join(workspace, 'project');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  let revision = 0;
  const f = { root, home, workspace, cwd, time: Date.UTC(2026, 0, 1), reads: [], catalogReads: 0, response: { config: { model: 'model-a', model_reasoning_effort: 'high', service_tier: 'default' } } };
  f.write = (file, body) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 增加合成注释长度，确保快速连续写入也能观察到文件状态变化。
    fs.writeFileSync(file, body + '\n# ' + 'x'.repeat(++revision) + '\n');
  };
  f.saveProjects = (projects = [{ id: 'project', cwd }]) => {
    fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({
      'local-projects': Object.fromEntries(projects.map(project => [project.id, { id: project.id, name: project.id, rootPaths: [project.cwd] }])),
      'selected-project': { type: 'local', projectId: projects[0]?.id ?? '' },
    }));
  };
  f.writeModels = ({ effort = 'high', fetchedAt = f.time, label = '合成模型 A' } = {}) => {
    fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ fetched_at: new Date(fetchedAt).toISOString(), revision: 'x'.repeat(++revision), models: ['model-a', 'model-b'].map(id => ({
      slug: id, display_name: id === 'model-a' ? label : '合成模型 B', visibility: 'list', default_reasoning_level: effort,
      supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }], input_modalities: ['text', 'image'],
    })) }));
  };
  f.handler = async () => structuredClone(f.response);
  f.creation = { codexHome: home, async readConfig(directory) { f.reads.push(directory); return f.handler(directory); } };
  f.catalog = new ModelCatalog({ codexHome: home, now: () => f.time });
  const readCatalog = f.catalog.read.bind(f.catalog);
  f.catalog.read = provider => { f.catalogReads++; return readCatalog(provider); };
  f.service = new NewThreadService({ codexHome: home, creation: f.creation, catalog: f.catalog, now: () => f.time });
  f.saveProjects(); f.writeModels();
  t.after(() => {
    // 只删除本例明确创建的临时目录，不触碰共享工程与其他测试的数据。
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.equal(path.basename(root).startsWith('codex-settings-cache-'), true);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return f;
}

test('并发及重复读取复用一次配置请求，每个调用仍检查真实模型目录', async t => {
  const f = fixture(t), started = deferred(), finish = deferred();
  f.handler = async () => { started.resolve(); await finish.promise; return structuredClone(f.response); };
  const first = f.service.settings('project'), second = f.service.settings('project');
  await started.promise;
  assert.equal(f.reads.length, 1);
  finish.resolve();
  const results = await Promise.all([first, second, f.service.settings('project')]);
  assert.deepEqual(results.map(result => result.settings), Array.from({ length: 3 }, () => ({ model: 'model-a', effort: 'high', serviceTier: '', mode: 'default' })));
  assert.equal(f.reads.length, 1); assert.equal(f.catalogReads, 3);
});

test('两小时有效期到边界重新读取，时钟回退不能延长旧缓存寿命', async t => {
  const f = fixture(t), start = f.time;
  await f.service.settings('project');
  f.time = start + 30000; await f.service.settings('project');
  assert.equal(f.reads.length, 1);
  f.time = start + SETTINGS_TTL - 1; await f.service.settings('project');
  assert.equal(f.reads.length, 1);
  f.time = start + SETTINGS_TTL; await f.service.settings('project');
  assert.equal(f.reads.length, 2);
  f.time = start + SETTINGS_TTL - 1; await f.service.settings('project');
  assert.equal(f.reads.length, 3);
});

for (const [name, location] of [
  ['用户配置', f => path.join(f.home, 'config.toml')],
  ['用户托管配置', f => path.join(f.home, 'managed_config.toml')],
  ['项目配置', f => path.join(f.cwd, '.codex', 'config.toml')],
  ['祖先目录配置', f => path.join(f.workspace, '.codex', 'config.toml')],
]) {
  test(`${name}创建、修改与删除都在有效期内使配置缓存失效`, async t => {
    const f = fixture(t), file = location(f);
    await f.service.settings('project');
    f.write(file, 'model = "model-b"');
    f.response.config.model = 'model-b';
    assert.equal((await f.service.settings('project')).settings.model, 'model-b');
    f.write(file, 'model = "model-a"');
    f.response.config.model = 'model-a';
    assert.equal((await f.service.settings('project')).settings.model, 'model-a');
    fs.unlinkSync(file);
    await f.service.settings('project');
    assert.equal(f.reads.length, 4);
    await f.service.settings('project'); assert.equal(f.reads.length, 4);
  });
}

test('模型缓存文件变化后重新读配置并使用新目录的默认强度与名称', async t => {
  const f = fixture(t);
  f.response.config.model_reasoning_effort = null;
  assert.equal((await f.service.settings('project')).settings.effort, 'high');
  f.writeModels({ effort: 'medium', label: '更新后的合成模型' });
  const result = await f.service.settings('project');
  assert.equal(result.settings.effort, 'medium'); assert.equal(result.models[0].label, '更新后的合成模型');
  await f.service.settings('project');
  assert.equal(f.reads.length, 2); assert.equal(f.catalogReads, 3);
});

test('项目编号相同但保存目录变更时不复用原目录配置', async t => {
  const f = fixture(t), next = path.join(f.workspace, 'next-project');
  fs.mkdirSync(next);
  f.handler = async directory => ({ config: { model: directory === f.cwd ? 'model-a' : 'model-b' } });
  assert.equal((await f.service.settings('project')).settings.model, 'model-a');
  f.saveProjects([{ id: 'project', cwd: next }]);
  assert.equal((await f.service.settings('project')).settings.model, 'model-b');
  await f.service.settings('project');
  assert.deepEqual(f.reads, [f.cwd, next]);
});

test('不同项目与服务实例独立读取，重建实例不继承旧内存缓存', async t => {
  const f = fixture(t);
  f.saveProjects([{ id: 'project', cwd: f.cwd }, { id: 'other', cwd: f.cwd }]);
  await f.service.settings('project'); await f.service.settings('other');
  const next = new NewThreadService({ codexHome: f.home, creation: f.creation, catalog: f.catalog, now: () => f.time });
  await next.settings('project');
  await f.service.settings('project'); await next.settings('project');
  assert.equal(f.reads.length, 3);
});

test('配置读取失败不缓存，下一次请求可以重试', async t => {
  const f = fixture(t);
  f.handler = async () => { throw new Error('合成配置读取失败'); };
  await assert.rejects(f.service.settings('project'), /合成配置读取失败/);
  assert.equal(f.service.settingsCache.size, 0);
  f.handler = async () => structuredClone(f.response);
  assert.equal((await f.service.settings('project')).settings.model, 'model-a');
  await f.service.settings('project'); assert.equal(f.reads.length, 2);
});

test('过期配置重读失败时直接报错，不回退之前成功的旧配置', async t => {
  const f = fixture(t);
  await f.service.settings('project'); f.time += SETTINGS_TTL;
  f.handler = async () => { throw new Error('合成重读失败'); };
  await assert.rejects(f.service.settings('project'), /合成重读失败/);
  assert.equal(f.service.settingsCache.size, 0);
  f.handler = async () => ({ config: { model: 'model-b' } });
  assert.equal((await f.service.settings('project')).settings.model, 'model-b');
  assert.equal(f.reads.length, 3);
});

test('缓存有效期内仍执行模型目录过期校验，目录错误会清掉对应配置', async t => {
  const f = fixture(t);
  f.writeModels({ fetchedAt: f.time - DAY + 10000 });
  await f.service.settings('project');
  f.time += 10001;
  await assert.rejects(f.service.settings('project'), { code: 'CATALOG_EXPIRED' });
  assert.equal(f.reads.length, 1); assert.equal(f.catalogReads, 2); assert.equal(f.service.settingsCache.size, 0);
  f.writeModels();
  await f.service.settings('project'); assert.equal(f.reads.length, 2);
});

test('已保存项目移除或项目目录删除后仍拒绝缓存命中', async t => {
  const f = fixture(t);
  await f.service.settings('project');
  f.saveProjects([]);
  await assert.rejects(f.service.settings('project'), { code: 'PROJECT_NOT_FOUND' });
  f.saveProjects();
  fs.rmdirSync(f.cwd);
  await assert.rejects(f.service.settings('project'), { code: 'PROJECT_NOT_FOUND' });
  assert.equal(f.reads.length, 1); assert.equal(f.catalogReads, 1);
});

test('配置读取途中发生文件变化时，原回执可完成但不能进入缓存', async t => {
  const f = fixture(t), started = deferred(), finish = deferred();
  f.handler = async () => { started.resolve(); await finish.promise; return { config: { model: 'model-a' } }; };
  const first = f.service.settings('project');
  await started.promise;
  f.write(path.join(f.home, 'config.toml'), 'model = "model-b"');
  f.handler = async () => ({ config: { model: 'model-b' } });
  finish.resolve();
  assert.equal((await first).settings.model, 'model-a'); assert.equal(f.service.settingsCache.size, 0);
  assert.equal((await f.service.settings('project')).settings.model, 'model-b');
  assert.equal(f.reads.length, 2);
});

test('新签名请求不等待旧在途请求，迟到旧成功不能替换新缓存', async t => {
  const f = fixture(t), started = deferred(), finish = deferred();
  f.handler = async () => { started.resolve(); return finish.promise; };
  const first = f.service.settings('project');
  await started.promise;
  f.write(path.join(f.home, 'config.toml'), 'model = "model-b"');
  f.handler = async () => ({ config: { model: 'model-b' } });
  assert.equal((await f.service.settings('project')).settings.model, 'model-b');
  finish.resolve({ config: { model: 'model-a' } });
  assert.equal((await first).settings.model, 'model-a');
  assert.equal((await f.service.settings('project')).settings.model, 'model-b');
  assert.equal(f.reads.length, 2);
});

test('迟到旧配置失败不能删除新签名已成功的缓存', async t => {
  const f = fixture(t), started = deferred(), finish = deferred();
  f.handler = async () => { started.resolve(); return finish.promise; };
  const first = f.service.settings('project'), rejected = assert.rejects(first, /合成旧请求失败/);
  await started.promise;
  f.write(path.join(f.home, 'config.toml'), 'model = "model-b"');
  f.handler = async () => ({ config: { model: 'model-b' } });
  assert.equal((await f.service.settings('project')).settings.model, 'model-b');
  finish.reject(new Error('合成旧请求失败')); await rejected;
  assert.equal((await f.service.settings('project')).settings.model, 'model-b');
  assert.equal(f.reads.length, 2);
});

test('旧回执的模型目录错误不能删除较新成功请求的配置缓存', async t => {
  const f = fixture(t), started = deferred(), finish = deferred();
  f.handler = async () => { started.resolve(); return finish.promise; };
  const first = f.service.settings('project'), rejected = assert.rejects(first, { code: 'CATALOG_UNAVAILABLE' });
  await started.promise;
  f.write(path.join(f.home, 'config.toml'), 'model = "model-b"');
  f.handler = async () => ({ config: { model: 'model-b' } });
  assert.equal((await f.service.settings('project')).settings.model, 'model-b');
  finish.resolve({ config: { model: 'model-a', model_provider: 'unsupported-example' } }); await rejected;
  assert.equal((await f.service.settings('project')).settings.model, 'model-b');
  assert.equal(f.reads.length, 2);
});

test('调用者修改工具栏结果与模型数组不能污染下一次读取', async t => {
  const f = fixture(t), first = await f.service.settings('project');
  first.settings.model = 'changed-by-caller'; first.settings.effort = 'changed-by-caller';
  first.models[0].defaultEffort = 'changed-by-caller'; first.models.length = 0;
  const next = await f.service.settings('project');
  assert.equal(next.settings.model, 'model-a'); assert.equal(next.settings.effort, 'high');
  assert.equal(next.models.length, 2); assert.equal(next.models[0].defaultEffort, 'high');
  assert.equal(f.reads.length, 1);
});

test('内存只保存必要配置投影，不保留配置正文和额外默认模型字段', async t => {
  const f = fixture(t);
  f.response = { config: { model: null, model_provider: 'openai', service_tier: 'priority', api_key: 'synthetic-sensitive-placeholder', approvals_reviewer: 'example-reviewer', nested: { unrelated: 'synthetic-unrelated-config' } }, defaultModel: { id: 'model-b', defaultReasoningEffort: 'medium', unrelated: 'synthetic-default-detail' } };
  const result = await f.service.settings('project');
  assert.deepEqual(result.settings, { model: 'model-b', effort: 'medium', serviceTier: 'priority', mode: 'default' });
  const cached = f.service.settingsCache.get('project');
  assert.deepEqual(cached.value, { model: 'model-b', provider: 'openai', effort: 'medium', serviceTier: 'priority' });
  const serialized = JSON.stringify([...f.service.settingsCache.values()]);
  for (const marker of ['synthetic-sensitive-placeholder', 'example-reviewer', 'synthetic-unrelated-config', 'synthetic-default-detail']) assert.equal(serialized.includes(marker), false);
});

test('配置缓存最多保留六十四个项目，近期命中保留且最旧项目需要重读', async t => {
  const f = fixture(t), projects = Array.from({ length: 65 }, (_, index) => ({ id: 'project-' + index, cwd: f.cwd }));
  f.saveProjects(projects);
  for (let index = 0; index < 64; index++) await f.service.settings(projects[index].id);
  await f.service.settings('project-0'); await f.service.settings('project-64');
  assert.equal(f.reads.length, 65); assert.equal(f.service.settingsCache.size, 64);
  assert.equal(f.service.settingsCache.has('project-0'), true); assert.equal(f.service.settingsCache.has('project-1'), false);
  await f.service.settings('project-0'); assert.equal(f.reads.length, 65);
  await f.service.settings('project-1'); assert.equal(f.reads.length, 66); assert.equal(f.service.settingsCache.size, 64);
});
