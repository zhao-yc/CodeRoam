import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AttachmentStore } from '../apps/bridge/attachment-store.mjs';

/** 合成附件只在仓库缓存内创建，清理前保留明确的绝对目录边界。 */
function fixture(t) {
  const cache = path.resolve('.cache'); fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'task-attachments-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = Date.now();
  const store = new AttachmentStore({ root, now: () => time });
  const id = randomUUID(), scope = 'task:' + randomUUID(), data = Buffer.from('任务附件合成内容');
  store.begin('phone', scope, { uploadId: id, name: '合成说明.txt', size: data.length });
  store.chunk('phone', scope, { uploadId: id, index: 0, data: data.toString('base64') });
  store.finish('phone', scope, { uploadId: id });
  return { root, store, id, scope, data, advance: () => { time += 48 * 60 * 60 * 1000; } };
}

test('已入队任务附件跨过普通有效期仍可绑定到新聊天，其他设备不能读取', t => {
  const f = fixture(t);
  f.store.retainScope = (device, scope) => device === 'phone' && scope === f.scope;
  f.advance(); f.store.cleanup();
  assert.throws(() => f.store.metadata('other', f.scope, f.id), error => error.code === 'UPLOAD_NOT_FOUND');
  f.store.bindScope('phone', f.scope, 'new-thread', [f.id]);
  const target = f.store.metadata('phone', 'new-thread', f.id);
  assert.deepEqual(f.store.readData(target.directory, target.metadata), f.data);
  assert.equal(target.metadata.threadId, 'new-thread');
  assert.equal(f.store.metadata('phone', f.scope, f.id).metadata.complete, true);
});

test('任务接管期间拒绝撤销附件，释放引用后按原有效期清理', t => {
  const f = fixture(t); f.store.retainScope = () => true; f.advance();
  assert.throws(() => f.store.abort('phone', f.scope, { uploadId: f.id }), error => error.code === 'UPLOAD_IN_USE');
  f.store.retainScope = () => false;
  assert.throws(() => f.store.metadata('phone', f.scope, f.id), error => error.code === 'UPLOAD_EXPIRED');
  f.store.cleanup();
  assert.throws(() => f.store.metadata('phone', f.scope, f.id), error => error.code === 'UPLOAD_NOT_FOUND');
});

test('原生草稿附件绑定幂等，已损坏目标不能被原任务覆盖', t => {
  const f = fixture(t), target = 'draft:' + randomUUID();
  f.store.bindScope('phone', f.scope, target, [f.id]);
  f.store.bindScope('phone', f.scope, target, [f.id]);
  const { directory } = f.store.metadata('phone', target, f.id);
  fs.writeFileSync(path.join(directory, 'data'), '已经变化');
  assert.throws(() => f.store.bindScope('phone', f.scope, target, [f.id]), error => error.code === 'ATTACHMENT_CONFLICT');
  assert.equal(fs.readFileSync(path.join(directory, 'data'), 'utf8'), '已经变化');
});

test('损坏及未完成的上传不能绑定到新聊天', t => {
  const f = fixture(t);
  const id = randomUUID();
  f.store.begin('phone', f.scope, { uploadId: id, name: '未完成.txt', size: 20 });
  assert.throws(() => f.store.bindScope('phone', f.scope, 'thread', [id]), error => error.code === 'UPLOAD_INCOMPLETE');
  const { directory } = f.store.metadata('phone', f.scope, f.id);
  fs.writeFileSync(path.join(directory, 'data'), '损坏');
  assert.throws(() => f.store.bindScope('phone', f.scope, 'thread', [f.id]), error => error.code === 'UPLOAD_CORRUPT');
});
