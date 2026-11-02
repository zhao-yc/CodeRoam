import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const uts=name=>fs.readFileSync('apps/mobile/services/'+name+'.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
const message=(id,text=id)=>({id,text,role:'assistant',turnId:'turn',phase:'commentary',status:'inProgress'});
/** 使用真实页面的布局链，控制 DOM 更新时机，覆盖手势与异步回调的竞态。 */
function fixture(){
 const ticks=[],watches=[],unloads=[],rects=new Map([['message-a',{top:-20,bottom:80}],['message-b',{top:100,bottom:600}]]);
 const state={bottom:600},connection={hostId:'pc',activeThreadId:'thread',connected:true,snapshot:{threadId:'thread',messages:[message('a'),message('b')],turns:[],approvals:[],questionGroups:[],activeTurnId:'turn'}};
 const c=vm.createContext({setTimeout,clearTimeout,connection,bridge:{cancelOpen(){}},ref:value=>({value}),computed:get=>({get value(){return get();}}),watch:(source,callback)=>watches.push({source,callback}),nextTick:fn=>ticks.push(fn),onLoad(){},onShow(){},onHide(){},onResize(){},onBackPress(){},onUnload:fn=>unloads.push(fn),readDraft:()=>'',uni:{getWindowInfo:()=>({windowWidth:390}),getElementById:id=>{const rect=id==='conversation-timeline'?{top:0,bottom:500,height:500}:id==='timeline-bottom'||id==='timeline-message-end'?{top:state.bottom,bottom:state.bottom}:rects.get(id);return rect?{getBoundingClientRect:()=>rect}:null;}}});
 for(const name of ['history','turn-failure','annotations','message-attachments','message-presentations','executions'])vm.runInContext(stripTypeScriptTypes(uts(name),{mode:'transform'}),c);
 const source=fs.readFileSync('apps/mobile/pages/conversation/index.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
 vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.p={pageHostId,pageThreadId,pageVisible,following,hasUnseenBelow,atTimelineBottom,readingFloor,historyScrollTop,scrollTarget,displayConversation,expandedReportIds,beforeMarkdownLayout,afterMarkdownLayout,beginTimelineTouch,endTimelineTouch,onTimelineScroll,updateTimelinePosition,resumeFollowing,rememberReadingPosition};',c);
 const p=c.p;p.pageHostId.value='pc';p.pageThreadId.value='thread';p.pageVisible.value=true;p.following.value=false;
 const flush=()=>{let limit=100;while(ticks.length){if(--limit===0)throw Error('布局链未收敛');ticks.shift()();}};
 const update=fn=>{const old=JSON.parse(JSON.stringify(p.displayConversation.value));fn();watches.find(w=>w.source===p.displayConversation).callback(p.displayConversation.value,old);};
 return {p,rects,state,connection,flush,ticks,unloads,update};
}

test('完全相同的快照与骨架消失不滚动、不产生未读，仍保留原滚动范围',()=>{
 const f=fixture();f.p.onTimelineScroll({detail:{scrollTop:300,scrollHeight:900}});f.update(()=>{});f.flush();
 assert.equal(f.p.historyScrollTop.value,0);assert.equal(f.p.hasUnseenBelow.value,false);assert.equal(f.p.following.value,false);assert.equal(f.p.readingFloor.value,800);
 f.p.beforeMarkdownLayout();f.state.bottom=550;f.p.afterMarkdownLayout();f.flush();assert.equal(f.p.historyScrollTop.value,0);assert.equal(f.p.hasUnseenBelow.value,false);
});

test('下方追加与流式增长显示原有箭头；手动到底只清提示，箭头显式恢复跟随',()=>{
 const f=fixture();f.p.beforeMarkdownLayout();f.state.bottom=800;f.p.afterMarkdownLayout();f.flush();assert.equal(f.p.hasUnseenBelow.value,true);assert.equal(f.p.historyScrollTop.value,0);
 f.p.beginTimelineTouch();f.state.bottom=500;f.p.endTimelineTouch();assert.equal(f.p.hasUnseenBelow.value,false);assert.equal(f.p.following.value,false);
 f.p.updateTimelinePosition();f.p.resumeFollowing();assert.equal(f.p.following.value,false);f.p.resumeFollowing(true);f.flush();assert.equal(f.p.following.value,true);assert.equal(f.p.scrollTarget.value,'timeline-bottom');assert.equal(f.p.readingFloor.value,0);
});

test('历史前插和图片重排保持首条可见消息；锚点消失时使用后续候选',()=>{
 const f=fixture();f.p.beforeMarkdownLayout();f.rects.set('message-a',{top:80,bottom:180});f.rects.set('message-b',{top:200,bottom:700});f.state.bottom=700;f.p.afterMarkdownLayout();f.flush();assert.equal(f.p.historyScrollTop.value,100);assert.equal(f.p.hasUnseenBelow.value,false);
 const g=fixture();g.p.beforeMarkdownLayout();g.rects.delete('message-a');g.rects.set('message-b',{top:170,bottom:670});g.p.afterMarkdownLayout();g.flush();assert.equal(g.p.historyScrollTop.value,70);
 const h=fixture();h.p.onTimelineScroll({detail:{scrollTop:200,scrollHeight:900}});h.p.beforeMarkdownLayout();h.rects.clear();h.p.afterMarkdownLayout();h.flush();assert.equal(h.p.readingFloor.value,700);assert.equal(h.p.historyScrollTop.value,0);
});

test('新手势、离页及较新的布局回调取消旧补偿，不抢占用户的滚动',()=>{
 const f=fixture();f.p.beforeMarkdownLayout();f.rects.set('message-a',{top:80,bottom:180});f.p.afterMarkdownLayout();f.p.beginTimelineTouch();f.flush();assert.equal(f.p.historyScrollTop.value,0);assert.equal(f.p.readingFloor.value,0);
 const g=fixture();g.p.beforeMarkdownLayout();g.rects.set('message-a',{top:80,bottom:180});g.p.afterMarkdownLayout();g.connection.activeThreadId='other';g.flush();assert.equal(g.p.historyScrollTop.value,0);
 const h=fixture();h.p.beforeMarkdownLayout();h.p.afterMarkdownLayout();h.rects.set('message-a',{top:30,bottom:130});h.p.afterMarkdownLayout();h.flush();assert.equal(h.p.historyScrollTop.value,50);
});

test('缓存中已显示的过程在实时轮次完成后保持展开，已有手动收起选择不被覆盖',()=>{
 const f=fixture();f.connection.snapshot.messages=[message('a'),{...message('final'),phase:'final_answer'}];
 f.update(()=>{f.connection.snapshot={...f.connection.snapshot,activeTurnId:'',turns:[{turnId:'turn',status:'completed'}]};});f.flush();assert.deepEqual(Array.from(f.p.expandedReportIds.value),['process:turn:final']);
 f.p.expandedReportIds.value=[];f.update(()=>{f.connection.snapshot={...f.connection.snapshot,updatedAt:2};});f.flush();assert.deepEqual(Array.from(f.p.expandedReportIds.value),[]);
});
