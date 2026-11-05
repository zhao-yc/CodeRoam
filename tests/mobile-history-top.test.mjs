import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
const message=id=>({id,role:'assistant',text:id,turnId:'turn',status:'completed'});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
/** 执行真实页面脚本，单独控制布局、手势和历史回执。 */
function fixture(){
 const requests=[],unloads=[],geometry={short:true,anchored:false},connection={snapshot:{threadId:'thread',title:'会话',cwd:'',status:'active',activeTurnId:'turn',messages:[message('current')],turns:[],approvals:[],questionGroups:[],updatedAt:1,supportsHistoryPages:true},connected:true,hostId:'pc',activeThreadId:'thread',computers:[]};
 const context=componentContext({hideTaskNoticeThread:()=>{},setTimeout,clearTimeout,connection,bridge:{cancelOpen(){},request(method,params){return new Promise((resolve,reject)=>requests.push({method,params,resolve,reject}));}},ref:value=>({value}),computed:get=>({get value(){return get();}}),watch:()=>{},onLoad:()=>{},onUnload:fn=>unloads.push(fn),onShow:()=>{},onHide:()=>{},onBackPress:()=>{},onResize:()=>{},readDraft:()=>'',reportTimeline:snapshot=>snapshot.messages.map(item=>({...item,executions:[],label:''})),nextTick:fn=>fn(),uni:{getWindowInfo:()=>({windowWidth:390}),getElementById(id){if(id==='conversation-timeline')return {getBoundingClientRect:()=>({top:0,bottom:300,height:300})};if(id==='timeline-bottom')return {getBoundingClientRect:()=>({bottom:geometry.short?200:1000})};if(geometry.anchored&&id==='message-current')return {getBoundingClientRect:()=>({top:(context.subject.historyPage.value?.messages.length??1)*100,bottom:500})};return null;}}});
 const helpers=fs.readFileSync('apps/mobile/services/history.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,'');
 const page=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
 // 加载实际展示依赖，保留历史布局和异步回执的完整验收路径。
 for (const module of ['executions','turn-failure','annotations','message-attachments','message-presentations']) vm.runInContext(stripTypeScriptTypes(fs.readFileSync('apps/mobile/services/'+module+'.uts','utf8').replace(/^import .*\r?\n/gm,'').replace(/\bexport /g,''),{mode:'transform'}),context);
 vm.runInContext(stripTypeScriptTypes(helpers+'\n'+page,{mode:'transform'})+';globalThis.subject={loadOlder,onHistoryTop,beginTimelineTouch,historyPage,loadingHistory,historyError,historyScrollTop,displayConversation,pageHostId,pageThreadId,pageVisible,following,scrollTarget,setScroll:(top)=>{lastScrollTop=top;}};',context);
 const p=context.subject;p.pageHostId.value='pc';p.pageThreadId.value='thread';p.pageVisible.value=true;
 return {p,requests,connection,geometry,unloads};
}

test('短页面不自动预取，只有手动加载才请求一页',async()=>{
 const f=fixture();assert.equal(f.requests.length,0);f.p.loadOlder();f.p.loadOlder();assert.equal(f.requests.length,1);
 f.requests[0].resolve({messages:[],turns:[],cursor:'',hasMore:false});await settle();
 assert.equal(f.p.historyPage.value.hasMore,false);assert.equal(f.p.loadingHistory.value,false);
 f.p.loadOlder();assert.equal(f.requests.length,1);
});

test('长会话初次布局不预取，失败后同一手势不重试，新的触顶手势才重试',async()=>{
 const f=fixture();f.geometry.short=false;assert.equal(f.requests.length,0);
 f.p.beginTimelineTouch();f.p.onHistoryTop();f.p.onHistoryTop();assert.equal(f.requests.length,1);
 f.requests[0].reject(new Error('模拟超时'));await settle();f.p.onHistoryTop();assert.equal(f.requests.length,1);
 f.p.beginTimelineTouch();f.p.onHistoryTop();assert.equal(f.requests.length,2);
 f.requests[1].resolve({messages:[],turns:[],cursor:'',hasMore:false});await settle();assert.equal(f.p.historyError.value,'');
});

test('中间空页继续推进游标，保留请求期间到达的实时消息和运行状态',async()=>{
 const f=fixture();f.p.loadOlder();f.requests[0].resolve({messages:[],turns:[],cursor:'next',hasMore:true});await settle();assert.equal(f.requests.length,2);assert.equal(f.requests[1].params.before,'next');
 f.connection.snapshot.messages.push(message('live'));
 f.requests[1].resolve({messages:[message('old')],turns:[],cursor:'',hasMore:false});await settle();
 assert.deepEqual(Array.from(f.p.displayConversation.value.messages,item=>item.id),['old','current','live']);assert.equal(f.p.displayConversation.value.status,'active');assert.equal(f.connection.snapshot.messages[0].id,'current');
});

test('游标无进展和连续空页均有限停止，不能误判已显示全部对话',async()=>{
 const f=fixture();f.p.loadOlder();f.requests[0].resolve({messages:[],turns:[],cursor:'same',hasMore:true});await settle();f.requests[1].resolve({messages:[],turns:[],cursor:'same',hasMore:true});await settle();assert.equal(f.requests.length,2);assert.equal(f.p.loadingHistory.value,false);assert.equal(f.p.historyPage.value.hasMore,true);assert.notEqual(f.p.historyError.value,'');
 const g=fixture();g.p.loadOlder();for(let i=0;i<32;i++){g.requests[i].resolve({messages:[],turns:[],cursor:'cursor-'+i,hasMore:true});await settle();}assert.equal(g.requests.length,32);assert.equal(g.p.loadingHistory.value,false);assert.equal(g.p.historyPage.value.hasMore,true);
});

test('连续十页折叠过程只需一次加载，直到更早的问答出现且全部过程仍可展开',async()=>{
 const f=fixture();
 f.connection.snapshot.status='idle';f.connection.snapshot.activeTurnId='';
 f.connection.snapshot.turns=[{turnId:'turn',status:'completed'}];
 f.connection.snapshot.messages=[{...message('current'),kind:'agentMessage',phase:'final_answer'}];
 f.p.loadOlder();
 for(let index=0;index<10;index++){
  assert.equal(f.requests.length,index+1);
  f.requests[index].resolve({messages:[{...message('command-'+index),role:'tool',kind:'commandExecution'}],turns:[],cursor:'page-'+index,hasMore:true});
  await settle();
 }
 assert.equal(f.requests.length,11);
 f.requests[10].resolve({messages:[{...message('earlier-question'),role:'user'}],turns:[],cursor:'earlier',hasMore:true});await settle();
 assert.equal(f.requests.length,11);assert.equal(f.p.loadingHistory.value,false);
 assert.equal(f.p.displayConversation.value.messages[0].id,'earlier-question');
 assert.equal(f.p.displayConversation.value.messages.filter(item=>item.role==='tool').length,10);
});

test('加载失败仍保留按钮，点击可继续使用原游标重试',async()=>{
 const f=fixture();f.p.loadOlder();f.requests[0].reject(new Error('合成读取失败'));await settle();
 const template=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8').split('<script setup')[0];
 assert.match(template,/button v-else-if="historyError.length > 0"[^>]*@click="loadOlder\(\)"/);
 f.p.loadOlder();assert.equal(f.requests.length,2);assert.equal(f.p.historyError.value,'');
 f.requests[1].resolve({messages:[message('old')],turns:[],cursor:'',hasMore:false});await settle();
 assert.equal(f.p.displayConversation.value.messages[0].id,'old');
});

test('前插历史保持可见消息的像素位置，离页后的回执不再改变历史',async()=>{
 const f=fixture();f.geometry.anchored=true;f.p.loadOlder();f.requests[0].resolve({messages:[message('old')],turns:[],cursor:'next',hasMore:true});await settle();assert.equal(f.p.historyScrollTop.value,100);assert.equal(f.p.following.value,false);
 f.p.loadOlder();f.unloads.forEach(fn=>fn());f.requests[1].resolve({messages:[message('stale')],turns:[],cursor:'',hasMore:false});await settle();assert.equal(f.p.displayConversation.value.messages.some(item=>item.id==='stale'),false);
});

test('相邻页高度相同时，用户重新上滑后仍能再次恢复同一偏移',async()=>{
 const f=fixture();f.geometry.anchored=true;let property=0,actualScroll=0;
 Object.defineProperty(f.p.historyScrollTop,'value',{get:()=>property,set:value=>{if(value!==property){property=value;actualScroll=value;}}});
 f.p.loadOlder();f.requests[0].resolve({messages:[message('old')],turns:[],cursor:'page2',hasMore:true});await settle();assert.equal(actualScroll,100);
 actualScroll=0;f.p.setScroll(0);f.p.loadOlder();f.requests[1].resolve({messages:[message('older')],turns:[],cursor:'',hasMore:false});await settle();assert.equal(actualScroll,100);
});
