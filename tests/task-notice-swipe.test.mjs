import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

/** 执行实际通知组件的手势方法，验证滑动与轻点的边界及迟到事件。 */
function fixture(){
 const calls=[],watchers=[],clock={now:1000},props={active:true,headerId:'header',hostId:'host',threadId:'thread'},view={current:{key:'notice-one',kind:'question'},phase:'visible'};
 const context=vm.createContext({ref:value=>({value}),computed:get=>({get value(){return get();}}),defineProps:()=>props,withDefaults:(value,defaults)=>({...defaults,...value}),onMounted:fn=>fn(),nextTick:fn=>fn(),watch:(_read,changed)=>watchers.push(changed),Date:{now:()=>clock.now},taskNotifications:view,taskNoticeTitle:()=>'',uni:{getElementById:()=>({getBoundingClientRect:()=>({bottom:48,height:70})})},openTaskNotice:notice=>calls.push(['open',notice.key]),dismissTaskNotice:key=>{if(view.current?.key!==key||view.phase!=='visible')return false;calls.push(['dismiss',key]);view.phase='swipe';return true;}});
 const source=fs.readFileSync('apps/mobile/components/task-notice/task-notice.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
 vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.f={beginTouch,moveTouch,finishTouch,cancelTouch,openNotice,dragOffset,noticeTransform,noticeOpacity};',context);
 return {...context.f,calls,clock,props,view,watchers};
}
const touch=(x,y,identifier=1)=>({clientX:x,clientY:y,identifier});
const begin=(f,x=100,y=150)=>f.beginTouch({touches:[touch(x,y)]});
const move=(f,x,y)=>f.moveTouch({touches:[touch(x,y)]});
const end=(f,x=100,y=150)=>f.finishTouch({changedTouches:[touch(x,y)]});

test('上滑跟手并提前关闭，只触发关闭，不误触打开会话',()=>{
 const f=fixture();begin(f);move(f,102,100);assert.equal(f.dragOffset.value,-50);assert.ok(f.noticeOpacity.value<1);end(f,102,100);f.openNotice();
 assert.deepEqual(f.calls,[['dismiss','notice-one']]);assert.equal(f.view.phase,'swipe');assert.equal(f.noticeTransform.value,'translateY(-138px)');
});

test('普通轻点及小幅抖动继续打开，未达阈值的移动回弹且不关闭',()=>{
 const tap=fixture();begin(tap);move(tap,102,148);end(tap,102,148);tap.openNotice();assert.deepEqual(tap.calls,[['open','notice-one']]);
 const short=fixture();begin(short);move(short,100,130);end(short,100,130);short.openNotice();assert.equal(short.dragOffset.value,0);assert.deepEqual(short.calls,[]);assert.equal(short.view.phase,'visible');
});

test('横滑、下滑、明显斜滑和多指手势不会关闭或打开',()=>{
 for(const [x,y] of [[160,150],[100,200],[150,100]]){const f=fixture();begin(f);move(f,x,y);end(f,x,y);f.openNotice();assert.deepEqual(f.calls,[]);}
 const multi=fixture();begin(multi);multi.moveTouch({touches:[touch(100,100),touch(120,110,2)]});end(multi,100,100);multi.openNotice();assert.deepEqual(multi.calls,[]);
});

test('系统取消及手势期间换条不会划走或点开新通知，新的一次轻点仍有效',()=>{
 const cancelled=fixture();begin(cancelled);move(cancelled,100,100);cancelled.cancelTouch();end(cancelled,100,100);cancelled.openNotice();assert.deepEqual(cancelled.calls,[]);
 const changed=fixture();begin(changed);move(changed,100,100);changed.view.current={key:'notice-two',kind:'approval'};changed.watchers.forEach(changed=>changed());end(changed,100,100);changed.openNotice();assert.deepEqual(changed.calls,[]);
 changed.clock.now+=351;begin(changed);end(changed);changed.openNotice();assert.deepEqual(changed.calls,[['open','notice-two']]);
});
