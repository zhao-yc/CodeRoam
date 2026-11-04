import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = ['submission-task-state', 'submission-task-presentation'].map(name => fs.readFileSync('apps/mobile/services/' + name + '.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '')).join('\n');
const context = vm.createContext({ reactive: value => value });
vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.subject={submissionCardMeta,submissionCardError,submissionNeedsPauseNotice,legacyDeletionVisible,submissionHistoryOrder};', context);
const subject = context.subject;

test('跨实例合并历史按实际完成时间倒序，早提交的重试成功记录也能排在最前', () => {
  const tasks = [{ id: 'later-submitted', position: 80, createdAt: 900, completedAt: 1000 }, { id: 'retried', position: 6, createdAt: 100, completedAt: 3000 }, { id: 'other-instance', position: 2, createdAt: 800, completedAt: 2000 }];
  assert.deepEqual(tasks.sort(subject.submissionHistoryOrder).map(task => task.id), ['retried', 'other-instance', 'later-submitted']);
});

test('完成时间相同按编号倒序，缺少完成时间的待核对记录排在后面', () => {
  const tasks = [{ position: 99, completedAt: 0 }, { position: 100, completedAt: null }, { position: 2, completedAt: 1000 }, { position: 3, completedAt: 1000 }];
  assert.deepEqual(tasks.sort(subject.submissionHistoryOrder).map(task => task.position), [3, 2, 100, 99]);
});

test('支持提交队列的实例不再出现旧删除卡，旧服务保留原异常和核对入口', () => {
  for (const state of ['running', 'failed', 'unknown']) {
    for (const visible of [false, true]) assert.equal(subject.legacyDeletionVisible(state, visible, true), false);
  }
  assert.equal(subject.legacyDeletionVisible('running', true, false), false);
  assert.equal(subject.legacyDeletionVisible('running', false, false), true);
  assert.equal(subject.legacyDeletionVisible('failed', true, false), true);
  assert.equal(subject.legacyDeletionVisible('unknown', true, false), true);
});

test('暂停源卡片只给一条短状态，不重复通用失败阶段，也不修改错误原文', () => {
  const task = { state: 'failed', position: 12, stage: '执行失败，实例队列已暂停', error: '删除失败，需要核对原聊天。\n完整的第二行原因仍保留。' };
  const original = JSON.stringify(task);
  assert.equal(subject.submissionCardMeta(task, true), '失败 · 队列已暂停');
  assert.equal(subject.submissionCardMeta(task, false), '#12');
  assert.equal(subject.submissionCardError(task), '删除失败，需要核对原聊天。 完整的第二行原因仍保留。');
  assert.equal(JSON.stringify(task), original);
  assert.equal(subject.submissionCardMeta({ ...task, state: 'unknown' }, true), '待核对 · 队列已暂停');
});

test('仅运行任务把真实阶段合并到元信息，完成和等待任务不占额外说明行', () => {
  assert.equal(subject.submissionCardMeta({ state: 'running', position: 7, stage: '正在创建聊天' }, false), '#7 · 正在创建聊天');
  assert.equal(subject.submissionCardMeta({ state: 'running', position: 7, stage: '执行中' }, false), '#7');
  assert.equal(subject.submissionCardMeta({ state: 'queued', position: 8, stage: '等待执行' }, false), '#8');
  assert.equal(subject.submissionCardMeta({ state: 'succeeded', position: 6, stage: '执行完成' }, false), '#6');
  assert.equal(subject.submissionCardMeta({ state: 'unknown', localOnly: true, position: 0, stage: '' }, false), '入队待核对');
});

test('暂停源卡在当前三项内时不再给横幅，折叠隐藏或其他设备阻塞时保留恢复入口', () => {
  assert.equal(subject.submissionNeedsPauseNotice(true, 'failed-1', ['queued-1', 'failed-1', 'queued-2']), false);
  assert.equal(subject.submissionNeedsPauseNotice(true, 'failed-1', ['queued-1', 'queued-2', 'queued-3']), true);
  assert.equal(subject.submissionNeedsPauseNotice(true, '', ['queued-1']), true);
  assert.equal(subject.submissionNeedsPauseNotice(false, 'failed-1', []), false);
});
