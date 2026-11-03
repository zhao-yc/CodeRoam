import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

/** 执行真实阅读补偿链，模拟 resize 回调前浏览器已经重新排版的情况。 */
function fixture() {
  const source=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8'),ticks=[],rects=new Map([['message-a',{top:-20,bottom:80}],['message-b',{top:100,bottom:400}]]),calls=[];
  const context={ref:value=>({value}),readingFloor:{value:0},following:{value:false},hasUnseenBelow:{value:false},historyScrollTop:{value:0},timeline:{value:[{id:'a'},{id:'b'}]},entryAnchor:entry=>'message-'+entry.id,historyGesture:0,touchingTimeline:false,cacheInitialPositioning:false,lastScrollTop:200,layoutUntil:0,nextTick:fn=>ticks.push(fn),isCurrentPage:()=>true,scrollLatest:()=>calls.push('latest'),updateTimelinePosition(){},paneResizeCallbacks:[()=>calls.push('resize')],uni:{getElementById:id=>{if(id==='conversation-timeline')return {scrollTop:200,getBoundingClientRect:()=>({top:0,bottom:500,height:500})};if(id==='timeline-message-end')return {getBoundingClientRect:()=>({top:700,bottom:700})};return rects.has(id)?{getBoundingClientRect:()=>rects.get(id)}:null;}}};
  context.atTimelineBottom={value:false};context.timelineUserScrolling=false;
  const reading=source.slice(source.indexOf('type ReadingAnchor ='),source.indexOf('// 历史只补充正文'));
  const resize=source.match(/^function resizeConversationPane\(\) \{[\s\S]*?^\}/m)[0];
  vm.runInNewContext(stripTypeScriptTypes(reading+'\n'+resize,{mode:'transform'})+';globalThis.api={rememberReadingPosition,resizeConversationPane};',context);
  return {...context.api,context,rects,calls,flush:()=>{let limit=30;while(ticks.length){assert.ok(--limit>0);ticks.shift()();}}};
}
test('旋转前的锚点不会被已经重排的 DOM 覆盖，尺寸变化后仍显示同一段内容',()=>{
  const f=fixture();f.rememberReadingPosition();f.rects.set('message-a',{top:80,bottom:180});f.rects.set('message-b',{top:200,bottom:500});
  f.resizeConversationPane();f.flush();assert.equal(f.context.historyScrollTop.value,300);assert.equal(f.context.following.value,false);assert.deepEqual(f.calls,['resize']);
});
test('跟随最新时继续定位底部，缓存首屏定位期间不抢占原定位',()=>{
  const following=fixture();following.context.following.value=true;following.resizeConversationPane();following.flush();assert.ok(following.calls.includes('latest'));
  const initial=fixture();initial.context.cacheInitialPositioning=true;initial.resizeConversationPane();initial.flush();assert.equal(initial.context.historyScrollTop.value,0);assert.deepEqual(initial.calls,['resize']);
});
