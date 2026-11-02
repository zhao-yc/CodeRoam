import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

/** 直接执行实际 UTS 草稿模块，每个用例使用独立应用内存，避免跨用例状态串联。 */
function composerFixture(){
  const context=vm.createContext({reactive:value=>value});
  let source=fs.readFileSync(new URL('../apps/mobile/services/composer.uts',import.meta.url),'utf8')
    .replace(/^import .* from 'vue'\r?\n/m,'').replace(/\bexport /g,'');
  source=stripTypeScriptTypes(source,{mode:'transform'});
  vm.runInContext(source+'\nglobalThis.subject={readDraft,saveDraft,readDraftImages,saveDraftImages,rememberSubmission,settleSubmission};',context);
  return context.subject;
}

test('图片草稿跨会话隔离，失败或结果未知时保留，成功只清除本次图片',()=>{
  const f=composerFixture(),image=id=>({id,src:'data:image/jpeg;base64,模拟图片'});
  f.saveDraftImages('pc','thread',[image('sent')]);f.saveDraftImages('other','thread',[image('other')]);
  f.rememberSubmission('pc','thread','failed','');f.settleSubmission('pc','failed',false);assert.equal(f.readDraftImages('pc','thread')[0].id,'sent');
  f.rememberSubmission('pc','thread','unknown','');assert.equal(f.readDraftImages('pc','thread').length,1);
  f.saveDraftImages('pc','thread',[image('sent'),image('new')]);f.settleSubmission('pc','unknown',true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.readDraftImages('pc','thread').map(item=>item.id))),['new']);assert.equal(f.readDraftImages('other','thread')[0].id,'other');
});

test('草稿按电脑和会话隔离，删除当前草稿不影响其他输入',()=>{
  const f=composerFixture();
  f.saveDraft('pc-a','thread-1','第一台电脑的会话一');
  f.saveDraft('pc-a','thread-2','第一台电脑的会话二');
  f.saveDraft('pc-b','thread-1','第二台电脑的同名会话');
  assert.equal(f.readDraft('pc-a','thread-1'),'第一台电脑的会话一');
  assert.equal(f.readDraft('pc-a','thread-2'),'第一台电脑的会话二');
  assert.equal(f.readDraft('pc-b','thread-1'),'第二台电脑的同名会话');
  assert.equal(f.readDraft('pc-b','thread-2'),'');
  f.saveDraft('pc-a','thread-1','');
  assert.equal(f.readDraft('pc-a','thread-1'),'');
  assert.equal(f.readDraft('pc-a','thread-2'),'第一台电脑的会话二');
  assert.equal(f.readDraft('pc-b','thread-1'),'第二台电脑的同名会话');
});

test('离开会话再返回时恢复最新草稿，反复编辑不会读到旧值',()=>{
  const f=composerFixture();
  assert.equal(f.readDraft('pc','thread-a'),'');
  f.saveDraft('pc','thread-a','尚未完成的指令');
  f.saveDraft('pc','thread-b','另一会话的内容');
  assert.equal(f.readDraft('pc','thread-a'),'尚未完成的指令');
  f.saveDraft('pc','thread-a','补充后的完整指令');
  assert.equal(f.readDraft('pc','thread-a'),'补充后的完整指令');
  assert.equal(f.readDraft('pc','thread-b'),'另一会话的内容');
});

test('成功回执只清除对应提交的草稿，允许提交时去掉首尾空白',()=>{
  const f=composerFixture();
  f.saveDraft('pc-a','thread-a','  原提交指令\n');
  f.saveDraft('pc-a','thread-b','同台电脑的其他草稿');
  f.saveDraft('pc-b','thread-a','其他电脑的草稿');
  f.rememberSubmission('pc-a','thread-a','command-a','原提交指令');
  f.settleSubmission('pc-a','command-a',true);
  assert.equal(f.readDraft('pc-a','thread-a'),'');
  assert.equal(f.readDraft('pc-a','thread-b'),'同台电脑的其他草稿');
  assert.equal(f.readDraft('pc-b','thread-a'),'其他电脑的草稿');
});

test('发送后继续编辑时，原提交的成功回执不清除新文字',()=>{
  const f=composerFixture();
  f.saveDraft('pc','thread','原提交指令');
  f.rememberSubmission('pc','thread','command','原提交指令');
  f.saveDraft('pc','thread','发送后补写的下一条指令');
  f.settleSubmission('pc','command',true);
  assert.equal(f.readDraft('pc','thread'),'发送后补写的下一条指令');
});

test('发送后删除并重新输入同一句时，旧成功回执不清除重新输入的草稿',()=>{
  const f=composerFixture();
  f.saveDraft('pc','thread','同一句指令');
  f.rememberSubmission('pc','thread','old-command','同一句指令');
  f.saveDraft('pc','thread','');
  f.saveDraft('pc','thread','同一句指令');
  f.settleSubmission('pc','old-command',true);
  assert.equal(f.readDraft('pc','thread'),'同一句指令');
  // 新输入仍可正常提交并在属于它自己的回执到达后清空。
  f.rememberSubmission('pc','thread','new-command','同一句指令');
  f.settleSubmission('pc','new-command',true);
  assert.equal(f.readDraft('pc','thread'),'');
});

test('发送后仅修改首尾空白时，旧成功回执仍保留新的草稿版本',()=>{
  const f=composerFixture();
  f.saveDraft('pc','thread','原提交指令');
  f.rememberSubmission('pc','thread','command','原提交指令');
  f.saveDraft('pc','thread','  原提交指令\n');
  f.settleSubmission('pc','command',true);
  assert.equal(f.readDraft('pc','thread'),'  原提交指令\n');
});

test('失败回执保留草稿，重复到达的旧成功回执不再清除',()=>{
  const f=composerFixture();
  f.saveDraft('pc','thread','需要重试的指令');
  f.rememberSubmission('pc','thread','command','需要重试的指令');
  f.settleSubmission('pc','command',false);
  assert.equal(f.readDraft('pc','thread'),'需要重试的指令');
  f.settleSubmission('pc','command',true);
  assert.equal(f.readDraft('pc','thread'),'需要重试的指令');
});

test('发送结果未知时持续保留草稿，之后核对成功才清除原输入',()=>{
  const f=composerFixture();
  f.saveDraft('pc','thread','等待核对的指令');
  f.rememberSubmission('pc','thread','pending-command','等待核对的指令');
  // 未知结果不结算提交，页面返回后仍可恢复输入；账本确认成功时复用成功结算。
  assert.equal(f.readDraft('pc','thread'),'等待核对的指令');
  f.settleSubmission('pc','pending-command',true);
  assert.equal(f.readDraft('pc','thread'),'');
});

test('不同命令编号和不同电脑的回执均不会误清草稿',()=>{
  const f=composerFixture();
  f.saveDraft('pc-a','thread','待确认指令');
  f.rememberSubmission('pc-a','thread','expected-command','待确认指令');
  f.settleSubmission('pc-a','other-command',true);
  f.settleSubmission('pc-b','expected-command',true);
  assert.equal(f.readDraft('pc-a','thread'),'待确认指令');
  f.settleSubmission('pc-a','expected-command',true);
  assert.equal(f.readDraft('pc-a','thread'),'');
});
