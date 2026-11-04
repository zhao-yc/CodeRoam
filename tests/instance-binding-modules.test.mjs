import test from 'node:test';
import assert from 'node:assert/strict';
import { instanceBindingModules, parseInstanceBindingModules } from '../apps/bridge/instance-binding-modules.mjs';

/** 使用合成安装包，只描述模块语义，不复制官方桌面资源。 */
function reader(files) {
  const contents = new Map(Object.entries(files));
  return {
    files: new Map([...contents].map(([name, source]) => [name, { size: Buffer.byteLength(source) }])),
    text(name) { if (!contents.has(name)) throw Error('合成资源不存在'); return contents.get(name); },
  };
}

function serviceChunk(chunk, moduleId = 'ServicesA') {
  return `export const __rspack_esm_id=${chunk};export const __rspack_esm_ids=[${chunk}];export const __webpack_modules__={${moduleId}(module,exports,runtime){let host,services;function setHost(value){host=value}function setServices(value){services=value}runtime.r(exports),runtime.d(exports,{appHost:()=>host,appServices:()=>services,setAppHost:()=>setHost,setAppServices:()=>setServices})}};`;
}

function webpackFiles(entry = '100.abcdef12.js', moduleId = 'ServicesA') {
  return {
    'webview/index.html': `<script type="module" src="/assets/${entry}"></script>`,
    ['webview/assets/' + entry]: 'var request=()=>{};request.c={};export{request as __webpack_require__};',
    'webview/assets/async/200.abcdef34.js': serviceChunk(200, moduleId),
  };
}

const unsupported = error => error.code === 'INSTANCE_NOT_READY' && !error.message.includes('synthetic');

test('新版按首页运行时导出和纯服务模块定位，构建哈希与模块编号可以变化', () => {
  for (const [entry, id] of [['100.abcdef12.js', 'ServicesA'], ['101.1234abcd.js', 'Other_$2']]) {
    assert.deepEqual(parseInstanceBindingModules(reader(webpackFiles(entry, id))), { kind: 'webpack', entry, servicesModule: id });
  }
});

test('多个小型 chunk 声明同一服务模块时去重，仍拒绝不同服务模块的歧义', () => {
  const files = webpackFiles();
  files['webview/assets/async/201.abcdef35.js'] = serviceChunk(201);
  assert.equal(parseInstanceBindingModules(reader(files)).servicesModule, 'ServicesA');
  files['webview/assets/async/202.abcdef36.js'] = serviceChunk(202, 'OtherServices');
  assert.throws(() => parseInstanceBindingModules(reader(files)), unsupported);
});

test('运行时不唯一、服务声明缺失或混入宿主构造时拒绝适配', () => {
  const ambiguous = webpackFiles();
  ambiguous['webview/index.html'] += '<script type="module" src="/assets/101.abcdef13.js"></script>';
  ambiguous['webview/assets/101.abcdef13.js'] = 'export{another as __webpack_require__};';
  assert.throws(() => parseInstanceBindingModules(reader(ambiguous)), unsupported);
  const missing = webpackFiles();
  delete missing['webview/assets/async/200.abcdef34.js'];
  assert.throws(() => parseInstanceBindingModules(reader(missing)), unsupported);
  const constructed = webpackFiles();
  constructed['webview/assets/async/200.abcdef34.js'] = serviceChunk(200).replace('let host,services;', 'let host,services;new DesktopHost();');
  assert.throws(() => parseInstanceBindingModules(reader(constructed)), unsupported);
});

test('首页脚本拒绝远端、目录穿越、编码路径和查询参数', () => {
  for (const url of ['https://example.com/runtime.js', '/assets/../runtime.js', '/assets/%2e%2e.js', '/assets/100.abcdef12.js?synthetic=1', '/assets/nested/runtime.js']) {
    const files = webpackFiles();
    files['webview/index.html'] = `<script type="module" src="${url}"></script>`;
    assert.throws(() => parseInstanceBindingModules(reader(files)), unsupported);
  }
});

test('服务工厂编号和文件编号必须一致，模块键不能携带路径或表达式', () => {
  for (const value of [serviceChunk(201), serviceChunk(200, '../services'), serviceChunk(200, 'services()')]) {
    const files = webpackFiles();
    files['webview/assets/async/200.abcdef34.js'] = value;
    assert.throws(() => parseInstanceBindingModules(reader(files)), unsupported);
  }
});

test('未审核的旧 ESM 即使包含相似服务对象也拒绝导入', () => {
  const files = {
    'webview/index.html': '<script type="module" src="/assets/app-initial-abcdef.js"></script>',
    'webview/assets/app-initial-abcdef.js': 'import "./app-shared-abcdef.js";',
    'webview/assets/app-shared-abcdef.js': 'const state={clientCoordination:coordination,appServerManagers:managers};export{state as RenamedServices};',
  };
  assert.throws(() => parseInstanceBindingModules(reader(files)), unsupported);
  files['webview/assets/app-shared-abcdef.js'] += 'new DesktopHost();';
  // 相似导出不能证明模块已经加载，也不能掩盖顶层初始化。
  assert.throws(() => parseInstanceBindingModules(reader(files)), unsupported);
});

test('解析失败使用固定中文错误，非标准或相对安装路径不能读取资源', () => {
  assert.throws(() => parseInstanceBindingModules(reader({})), unsupported);
  for (const executable of ['synthetic.exe', '/synthetic/Codex.exe', 'https://example.com/Codex.exe', null]) {
    assert.throws(() => instanceBindingModules(executable), unsupported);
  }
});
