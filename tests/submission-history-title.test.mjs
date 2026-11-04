import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

// 直接运行页面展示函数，确认标题来自历史快照而非额外网络查询。
const page = fs.readFileSync('apps/mobile/pages/task-history/index.uvue', 'utf8');
const source = page.slice(page.indexOf('function chatTitle('), page.indexOf('function stageDetail('));
const context = vm.createContext({});
vm.runInContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nglobalThis.subject = chatTitle;', context);
test('历史页直接显示记录中的标题，兼容缺少字段的旧服务', () => {
  assert.equal(context.subject('甲', { kind: 'command', threadTitle: '入库时的名称', title: '发送消息' }), '入库时的名称');
  assert.equal(context.subject('乙', { kind: 'command', threadTitle: '乙的名称' }), '乙的名称');
  assert.equal(context.subject('甲', { kind: 'command' }), '历史记录未保存标题');
  assert.equal(context.subject('甲', { kind: 'newConversation', title: '新聊天' }), '新聊天');
  assert.ok(!page.includes('readComputerMenu'));
});
