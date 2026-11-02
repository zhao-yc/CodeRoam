import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8');
const compile = source => stripTypeScriptTypes(source.replace(/\bexport /g, ''), { mode: 'transform' });

/** 执行真实监听模块，模拟浏览器事件以检查范围、默认行为和临时资源释放。 */
function pasteFixture(accept = async () => {}) {
  const listeners = new Set(), created = [], revoked = [], notices = [], received = [];
  class Textarea { disabled = false; matches = true; closest() { return this.matches ? this : null; } }
  const source = read('apps/mobile/services/image-paste.uts').replace(/\/\/ #ifndef WEB[\s\S]*?\/\/ #endif/g, '');
  const context = vm.createContext({ HTMLTextAreaElement: Textarea, document: {
    addEventListener: (name, callback) => { assert.equal(name, 'paste'); listeners.add(callback); },
    removeEventListener: (name, callback) => { assert.equal(name, 'paste'); listeners.delete(callback); }
  }, URL: { createObjectURL: file => { created.push(file); return 'blob:' + created.length; }, revokeObjectURL: url => revoked.push(url) },
  uni: { showToast: options => notices.push(options.title) } });
  vm.runInContext(compile(source) + '\nglobalThis.bind = bindImagePaste;', context);
  const unbind = context.bind('.draft', async paths => { received.push([...paths]); await accept(paths); });
  return { listeners, created, revoked, notices, received, unbind, Textarea,
    async paste(files, target = new Textarea(), prevented = false) {
      const event = { target, defaultPrevented: prevented, clipboardData: files == null ? null : { files }, preventDefault() { this.defaultPrevented = true; } };
      await Promise.all([...listeners].map(callback => callback(event)));
      return event;
    }
  };
}

test('粘贴图片进入附件处理，忽略同批非图片，完成后释放全部临时地址', async () => {
  let release;
  const f = pasteFixture(() => new Promise(resolve => { release = resolve; }));
  const pending = f.paste([{ type: 'image/png' }, { type: 'text/plain' }, { type: 'image/webp' }]);
  assert.deepEqual(f.received, [['blob:1', 'blob:2']]);
  assert.deepEqual(f.revoked, []);
  release();
  assert.equal((await pending).defaultPrevented, true);
  assert.deepEqual(f.revoked, ['blob:1', 'blob:2']);
});

test('文字或HTML不被拦截，其他输入框、禁用输入框与已处理事件不读取图片', async () => {
  const f = pasteFixture(), outside = new f.Textarea(), disabled = new f.Textarea();
  outside.matches = false; disabled.disabled = true;
  for (const files of [[], [{ type: 'text/html' }], null]) assert.equal((await f.paste(files)).defaultPrevented, false);
  for (const target of [outside, disabled, {}]) await f.paste([{ type: 'image/png' }], target);
  await f.paste([{ type: 'image/png' }], new f.Textarea(), true);
  assert.equal(f.created.length, 0);
  f.unbind();
  assert.equal(f.listeners.size, 0);
  await f.paste([{ type: 'image/png' }]);
  assert.equal(f.received.length, 0);
});

test('处理失败仍释放临时地址，原生平台不注册浏览器监听', async () => {
  const f = pasteFixture(async () => { throw new Error('模拟解码失败'); });
  await f.paste([{ type: 'image/png' }]);
  assert.deepEqual(f.revoked, ['blob:1']);
  assert.equal(f.notices.length, 1);
  const native = read('apps/mobile/services/image-paste.uts').replace(/\/\/ #ifdef WEB[\s\S]*?\/\/ #endif/g, '');
  const context = vm.createContext({});
  vm.runInContext(compile(native) + '\nglobalThis.unbind = bindImagePaste(".draft", async () => {}); unbind();', context);
});

/** 提取页面实际处理方法，验证异步解码与切换会话之间的隔离。 */
function conversationFixture() {
  const source = read('apps/mobile/pages/conversation/index.uvue');
  const method = source.slice(source.indexOf('async function pasteImages('), source.indexOf('// 文档级委托只匹配'));
  const stores = new Map(), notices = [], pending = [];
  const context = { pageVisible: { value: true }, canWrite: { value: true }, imageBusy: { value: false }, modelSupportsImages: { value: true },
    pageHostId: { value: 'pc-a' }, pageThreadId: { value: 'thread-a' }, connection: { snapshot: { supportsImages: true } }, MAX_COMPOSER_IMAGES: 3,
    readDraftImages: (host, thread) => stores.get(host + ':' + thread) ?? [], readDraftFiles: () => context.files,
    saveDraftImages: (host, thread, images) => stores.set(host + ':' + thread, images), files: [],
    prepareImage: path => new Promise((resolve, reject) => pending.push({ path, resolve, reject })),
    isCurrentPage: () => true, notify: message => notices.push(message) };
  vm.createContext(context); vm.runInContext(compile(method) + '\nglobalThis.paste = pasteImages;', context);
  return { context, stores, notices, pending };
}

test('已有会话合并附件容量，阻止并发粘贴，并把迟到结果写回原会话', async () => {
  const f = conversationFixture(), c = f.context;
  c.files = [{ id: 'file' }]; f.stores.set('pc-a:thread-a', [{ id: 'old', src: 'old' }]);
  const first = c.paste(['one', 'two']);
  assert.equal(f.pending.length, 1); assert.equal(c.imageBusy.value, true);
  await c.paste(['concurrent']); assert.equal(f.pending.length, 1);
  c.pageHostId.value = 'pc-b'; c.pageThreadId.value = 'thread-b';
  f.pending[0].resolve('data:image/jpeg;base64,合成图片'); await first;
  assert.equal(f.stores.get('pc-a:thread-a').length, 2); assert.equal(f.stores.has('pc-b:thread-b'), false);
  assert.equal(c.imageBusy.value, false); assert.equal(f.notices.length, 1);
});

test('只读、隐藏、模型不支持、服务不支持及附件已满时不处理图片', async () => {
  for (const block of [f => { f.context.canWrite.value = false; }, f => { f.context.pageVisible.value = false; },
    f => { f.context.modelSupportsImages.value = false; }, f => { f.context.connection.snapshot.supportsImages = false; },
    f => { f.context.files = [{}, {}, {}]; }]) {
    const f = conversationFixture(); block(f); await f.context.paste(['image']); assert.equal(f.pending.length, 0);
  }
});

test('解码失败保留已有附件并解除忙碌状态', async () => {
  const f = conversationFixture(); f.stores.set('pc-a:thread-a', [{ id: 'old' }]);
  const pending = f.context.paste(['bad']); f.pending[0].reject(new Error('合成坏图片')); await pending;
  assert.equal(f.stores.get('pc-a:thread-a')[0].id, 'old'); assert.equal(f.context.imageBusy.value, false);
  assert.deepEqual(f.notices, ['合成坏图片']);
});

test('新对话粘贴捕获原草稿，沿用图片处理并遵守图片与文件合计上限', async () => {
  const source = read('apps/mobile/components/new-conversation/new-conversation.uvue');
  const method = source.slice(source.indexOf('async function pasteImages('), source.indexOf('async function acceptFiles('));
  const original = { images: [], files: [{}, {}] }, accepted = [], notices = [];
  const c = { props: { expanded: true }, alive: true, busy: { value: false }, imageBusy: { value: false }, modelSupportsImages: { value: true }, draft: { value: original },
    remaining: () => 3 - c.draft.value.images.length - c.draft.value.files.length,
    acceptImages: async (target, paths) => { accepted.push({ target, paths: [...paths] }); }, notify: message => notices.push(message) };
  vm.createContext(c); vm.runInContext(compile(method) + '\nglobalThis.paste = pasteImages;', c);
  await c.paste(['one', 'two']); assert.equal(accepted[0].target, original); assert.deepEqual(accepted[0].paths, ['one']);
  c.props.expanded = false; await c.paste(['collapsed']); assert.equal(accepted.length, 1); c.props.expanded = true;
  c.busy.value = true; await c.paste(['blocked']); assert.equal(accepted.length, 1); assert.equal(notices.length, 1);
});
