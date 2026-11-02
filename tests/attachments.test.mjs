import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AttachmentStore } from '../apps/bridge/attachment-store.mjs';
import { FILE_CHUNK_BYTES, MAX_FILE_BYTES, validateAttachmentInfo } from '../packages/protocol/attachments.mjs';
import { validateRequest, WRITE_METHODS, UPLOAD_METHODS } from '../packages/protocol/contracts.mjs';

function fixture(t) {
  // Mac 的 /var 是系统符号链接；夹具使用真实路径，仍保留上传目录的防链接校验。
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-attachments-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  return { root, cwd, store: new AttachmentStore({ root: path.join(root, 'temporary') }), id: randomUUID() };
}
function upload(f, data, name = '验收文本.txt') {
  const info = { uploadId: f.id, name, size: data.length }; f.store.begin('phone', 'thread', info);
  for (let offset = 0, index = 0; offset < data.length; offset += FILE_CHUNK_BYTES, index++) f.store.chunk('phone', 'thread', { uploadId: f.id, index, data: data.subarray(offset, offset + FILE_CHUNK_BYTES).toString('base64') });
  return f.store.finish('phone', 'thread', info);
}

test('多分片文档可恢复与去重，完成后才落入原工作目录，重试不覆盖已有文件', t => {
  const f = fixture(t), data = Buffer.from('用于测试的中文文件\n'.repeat(30000));
  f.store.begin('phone', 'thread', { uploadId: f.id, name: '说明.txt', size: data.length });
  const chunk = { uploadId: f.id, index: 0, data: data.subarray(0, FILE_CHUNK_BYTES).toString('base64') };
  assert.equal(f.store.chunk('phone', 'thread', chunk).received, FILE_CHUNK_BYTES); assert.equal(f.store.chunk('phone', 'thread', chunk).received, FILE_CHUNK_BYTES);
  assert.throws(() => f.store.materialize('phone', 'thread', [f.id], f.cwd), error => error.code === 'UPLOAD_INCOMPLETE');
  // 进程重启复用同一存储，开始请求返回已确认进度。
  f.store = new AttachmentStore({ root: path.join(f.root, 'temporary') }); assert.equal(f.store.begin('phone', 'thread', { uploadId: f.id, name: '说明.txt', size: data.length }).nextChunk, 1);
  for (let offset = FILE_CHUNK_BYTES, index = 1; offset < data.length; offset += FILE_CHUNK_BYTES, index++) f.store.chunk('phone', 'thread', { uploadId: f.id, index, data: data.subarray(offset, offset + FILE_CHUNK_BYTES).toString('base64') });
  f.store.finish('phone', 'thread', { uploadId: f.id }); const files = f.store.materialize('phone', 'thread', [f.id], f.cwd);
  assert.ok(files[0].path.startsWith(path.join(f.cwd, '.codex-remote-attachments'))); assert.deepEqual(fs.readFileSync(files[0].path), data);
  assert.equal(f.store.materialize('phone', 'thread', [f.id], f.cwd)[0].path, files[0].path);
  fs.writeFileSync(files[0].path, '文件已被其他任务修改'); assert.throws(() => f.store.materialize('phone', 'thread', [f.id], f.cwd), error => error.code === 'ATTACHMENT_CONFLICT');
});

test('附件拒绝跨手机和会话访问、伪路径、超限、乱序与重复分片冲突', t => {
  const f = fixture(t); upload(f, Buffer.from('测试内容'));
  for (const [phone, thread] of [['other', 'thread'], ['phone', 'other']]) assert.throws(() => f.store.materialize(phone, thread, [f.id], f.cwd));
  assert.throws(() => f.store.begin('phone', 'thread', { uploadId: '../escape', name: 'x.txt', size: 1 }));
  for (const name of ['../x.txt', 'x.exe', 'CON.txt', 'photo.zip', 'x.txt:stream', 'x.txt\n']) assert.throws(() => validateAttachmentInfo(name, 1));
  assert.throws(() => validateAttachmentInfo('x.txt', MAX_FILE_BYTES + 1)); assert.throws(() => validateAttachmentInfo('x.txt', 0));
  assert.throws(() => f.store.materialize('phone', 'thread', [f.id, f.id], f.cwd)); assert.throws(() => f.store.materialize('phone', 'thread', [f.id], f.cwd, 3));
  assert.throws(() => f.store.chunk('phone', 'thread', { uploadId: f.id, index: 0, data: Buffer.from('不同内容').toString('base64') }), error => error.code === 'CHUNK_CONFLICT');
  const next = { ...f, id: randomUUID() }; f.store.begin('phone', 'thread', { uploadId: next.id, name: 'next.txt', size: 100 });
  assert.throws(() => f.store.chunk('phone', 'thread', { uploadId: next.id, index: 1, data: 'YQ==' })); assert.throws(() => f.store.finish('phone', 'thread', { uploadId: next.id }));
});

test('伪装文档、二进制文本和损坏文件不能完成上传', t => {
  const f = fixture(t);
  for (const [name, bytes] of [['x.pdf', Buffer.from('假的PDF')], ['x.docx', Buffer.from('假的Word')], ['x.xls', Buffer.from('假的Excel')], ['x.txt', Buffer.from([0, 1, 2])], ['x.txt', Buffer.from('MZ伪装程序')]]) {
    assert.throws(() => upload({ ...f, id: randomUUID() }, bytes, name), error => error.code === 'BAD_FILE_TYPE');
  }
  upload(f, Buffer.from('原始内容')); const directory = f.store.metadata('phone', 'thread', f.id).directory;
  fs.writeFileSync(path.join(directory, 'data'), '被修改的内容'); assert.throws(() => f.store.materialize('phone', 'thread', [f.id], f.cwd), error => error.code === 'UPLOAD_CORRUPT');
});

test('取消和过期只清理临时文件，已发送的会话附件继续保留', t => {
  const f = fixture(t); upload(f, Buffer.from('%PDF-1.4\n测试PDF'), '报告.pdf');
  const [file] = f.store.materialize('phone', 'thread', [f.id], f.cwd); f.store.abort('phone', 'thread', { uploadId: f.id }); assert.ok(fs.existsSync(file.path));
  assert.deepEqual(f.store.abort('phone', 'thread', { uploadId: f.id }), { ok: true });
  const expired = { ...f, id: randomUUID() }; upload(expired, Buffer.from('过期附件'));
  const directory = f.store.metadata('phone', 'thread', expired.id).directory;
  const old = new Date(Date.now() - 25 * 3600000); fs.utimesSync(directory, old, old); f.store.cleanup(); assert.ok(!fs.existsSync(directory)); assert.ok(fs.existsSync(file.path));
});

test('上传分片使用专用白名单，不进入写操作账本，仍必须提供会话编号', () => {
  for (const method of UPLOAD_METHODS) {
    assert.equal(WRITE_METHODS.has(method), false);
    assert.doesNotThrow(() => validateRequest({ v: 1, type: 'request', requestId: randomUUID(), method, params: { threadId: 'thread' } }));
    assert.throws(() => validateRequest({ v: 1, type: 'request', requestId: randomUUID(), method, params: {} }));
  }
});
