import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

/** 执行真正的点击入口，检查同步打开、完整地址和失败复制。 */
test('网页链接同步新开标签，隔离opener，不改当前路由；失败后由用户决定复制',()=>{
  const source=fs.readFileSync('apps/mobile/services/external-link.uts','utf8').replace(/^import .*\r?\n/gm,'').replaceAll('export ','');
  const calls=[],tab={opener:'parent',location:{href:''}};
  const context=componentContext({safeWebUrl:value=>/^https?:\/\//.test(value)?value:'',window:{open:(...args)=>{calls.push(args);return tab;}},uni:{showToast:value=>calls.push(value),showModal:value=>calls.push(value),setClipboardData:value=>calls.push(value)}});
  vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+'\nglobalThis.subject=openMessageLink;',context);
  const url='https://example.com/?v=example&name=%E4%B8%AD%E6%96%87#正文';
  context.subject(url);assert.equal(tab.location.href,url);assert.equal(tab.opener,null);assert.deepEqual(Array.from(calls[0]),['about:blank','_blank']);
  context.subject('javascript:alert(1)');assert.equal(calls.at(-1).title,'此链接不支持打开');
  context.window.open=()=>null;context.subject(url);const dialog=calls.at(-1);assert.equal(dialog.confirmText,'复制链接');
  const count=calls.length;dialog.success({confirm:false});assert.equal(calls.length,count);
  dialog.success({confirm:true});assert.equal(calls.at(-1).data,url);
});

/** 流式重排直接执行会话页方法，确认锚点、跟随和新手势优先级。 */
test('Markdown重排保持历史阅读锚点，跟随时到底，新手势取消旧位置恢复',()=>{
  const page=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');
  const reading=page.slice(page.indexOf('function entryAnchor('),page.indexOf('let cacheWriteTimer ='));
  const methods=reading+page.slice(page.indexOf('function beginTimelineTouch()'),page.indexOf('// 历史只补充正文'));
  let top=120;const ticks=[],scrolls=[];
  const context=componentContext({cacheInitialPositioning:false,following:{value:false},readingFloor:{value:0},hasUnseenBelow:{value:false},atTimelineBottom:{value:false},touchingTimeline:false,loadingHistory:{value:false},historyGesture:1,lastScrollTop:240,historyScrollTop:{value:240},layoutUntil:0,visibleTimeline:{value:[{id:'a'}]},isCurrentPage:()=>true,uni:{getElementById:id=>({getBoundingClientRect:()=>id==='conversation-timeline'?{top:100,bottom:700,height:600}:{top,bottom:top+50}})},nextTick:callback=>ticks.push(callback),scrollLatest:()=>scrolls.push('latest'),pauseFollowing:()=>{context.following.value=false;}});
  vm.runInContext(stripTypeScriptTypes(methods,{mode:'transform'})+'\nglobalThis.subject={beforeMarkdownLayout,afterMarkdownLayout,markdownReading};',context);
  const flush=()=>{while(ticks.length)ticks.shift()();},f=context.subject;
  f.beforeMarkdownLayout();top=190;f.afterMarkdownLayout();flush();assert.equal(context.historyScrollTop.value,310);
  context.historyScrollTop.value=310;f.beforeMarkdownLayout();top=240;context.historyGesture++;f.afterMarkdownLayout();flush();assert.equal(context.historyScrollTop.value,310);
  context.following.value=true;f.afterMarkdownLayout();flush();assert.equal(scrolls.length,1);
  f.markdownReading(true);assert.equal(context.following.value,false);assert.equal(context.touchingTimeline,true);f.markdownReading(false);assert.equal(context.touchingTimeline,false);
});

test('代码复制使用原始代码，图片预览不改变消息源文本',()=>{
  const source=fs.readFileSync('apps/mobile/components/markdown-body/markdown-body.uvue','utf8');
  const method=source.match(/function copyCode\(code: string\) \{[^\n]+/)[0];const copied=[];
  const context=componentContext({uni:{setClipboardData:options=>copied.push(options.data)}});
  vm.runInContext(stripTypeScriptTypes(method)+';globalThis.copy=copyCode;',context);
  const code='const url = "https://example.com";\n  // 保留空格和换行\n';context.copy(code);assert.equal(copied[0],code);
  const page=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');assert.match(page,/entry.role == 'assistant' && entry.text.trim\(\).length > 0/);
});
