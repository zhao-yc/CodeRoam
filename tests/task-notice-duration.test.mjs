import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const key='codex-mobile-notice-duration-ms';
const source=file=>fs.readFileSync(file,'utf8').replace(/^import .*\r?\n/gm,'').replaceAll('export ','');

/** 实际通知服务配合可控时钟，验证本地存储、计时器及永不自动关闭。 */
function fixture(saved,readFails=false){
 const store=new Map(saved===undefined?[]:[[key,saved]]),timers=new Map(),clock={now:0,id:0},options={writeFails:false},calls=[];
 const centerContext=vm.createContext({});vm.runInContext(stripTypeScriptTypes(source('apps/mobile/services/task-notification-state.uts'),{mode:'transform'})+';globalThis.Center=TaskNotificationCenter;',centerContext);
 const connection={configurationRevision:1,configured:true,connected:true,hostId:'host',computers:[{id:'host',online:true,label:'合成电脑',instanceGeneration:'g'}]},pending=[{kind:'question',id:'q',turnId:'turn'}];
 const threadList={computers:[{hostId:'host',instanceGeneration:'g',online:true,subscribed:true,threads:[{id:'thread',title:'合成通知',notificationState:{latestTurnId:'turn',latestTurnStatus:'inProgress',pending}}]}]},watchers=[];
 const context=vm.createContext({TaskNotificationCenter:centerContext.Center,reactive:value=>value,connection,threadList,watch:(_read,changed,config)=>{watchers.push(changed);if(config?.immediate)changed();},nextTick:fn=>fn(),Date:{now:()=>clock.now},setTimeout:(fn,delay)=>{const id=++clock.id;timers.set(id,{fn,at:clock.now+delay});return id;},clearTimeout:id=>timers.delete(id),syncThreadComputers(){},refreshComputerThreads(){},disconnectThreadLists(){},bridge:{},uni:{getStorageSync:()=>{if(readFails)throw Error('模拟读取失败');return store.get(key);},setStorageSync:(name,value)=>{if(options.writeFails)throw Error('模拟保存失败');store.set(name,value);calls.push(['saved',name,value]);}}});
 vm.runInContext(stripTypeScriptTypes(source('apps/mobile/services/task-notifications.uts'),{mode:'transform'})+';globalThis.f={startTaskNotifications,resetTaskNotifications,setTaskNoticeDuration,taskNoticeDurationLabel,dismissTaskNotice,taskNotifications};',context);context.f.startTaskNotifications();
 const advance=to=>{for(;;){const next=[...timers].filter(([,timer])=>timer.at<=to).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;timers.delete(next[0]);clock.now=next[1].at;next[1].fn();}clock.now=to;};
 return {...context.f,advance,store,timers,options,calls,threadList,push:()=>watchers[1]()};
}

test('默认五秒，恢复十秒和不自动关闭；损坏或不可读偏好回落默认',()=>{
 for(const [saved,expected] of [[undefined,5000],[10000,10000],[0,0],['10000',5000],[12,5000],[null,5000]]){const f=fixture(saved);assert.equal(f.taskNotifications.durationMs,expected);}
 assert.equal(fixture(10000,true).taskNotifications.durationMs,5000);
 const ten=fixture(10000);ten.advance(10215);assert.equal(ten.taskNotifications.phase,'visible');ten.advance(10216);assert.equal(ten.taskNotifications.phase,'leave');ten.advance(10416);assert.equal(ten.taskNotifications.current,null);
});

test('不自动关闭时没有倒计时，新事件不会让当前卡片消失，仍可上滑继续队列',()=>{
 const f=fixture(0);f.advance(20000);const current=f.taskNotifications.current;assert.equal(f.taskNotifications.phase,'visible');assert.equal(f.timers.size,0);
 const row=f.threadList.computers[0].threads[0];f.threadList.computers[0].threads=[{...row,notificationState:{...row.notificationState,pending:[...row.notificationState.pending,{kind:'approval',id:'a',turnId:'turn'}]}}];f.push();f.advance(100000);assert.equal(f.taskNotifications.current.key,current.key);assert.equal(f.timers.size,0);
 assert.equal(f.dismissTaskNotice(current.key),true);f.advance(100216);assert.equal(f.taskNotifications.current.kind,'approval');assert.equal(f.taskNotifications.phase,'visible');assert.equal(f.timers.size,0);
});

test('修改时长立即重新计时，同选项不延长；重启及清除连接仍保留偏好',()=>{
 const f=fixture(0);f.advance(20000);f.setTaskNoticeDuration(10000);f.advance(25000);f.setTaskNoticeDuration(10000);f.advance(29999);assert.equal(f.taskNotifications.phase,'visible');f.advance(30000);assert.equal(f.taskNotifications.phase,'leave');
 assert.equal(f.store.get(key),10000);assert.equal(fixture(f.store.get(key)).taskNotifications.durationMs,10000);f.resetTaskNotifications();assert.equal(f.taskNotifications.durationMs,10000);
 const five=fixture(10000);five.advance(2000);five.setTaskNoticeDuration(5000);five.advance(6999);assert.equal(five.taskNotifications.phase,'visible');five.advance(7000);assert.equal(five.taskNotifications.phase,'leave');
});

test('保存失败及无效值不覆盖当前选择或计时，选不自动关闭可取消现有计时器',()=>{
 const f=fixture();f.advance(216);f.options.writeFails=true;assert.throws(()=>f.setTaskNoticeDuration(10000),/无法保存通知时长/);assert.equal(f.taskNotifications.durationMs,5000);assert.equal(f.timers.size,1);assert.throws(()=>f.setTaskNoticeDuration(6000),/选项无效/);
 f.options.writeFails=false;f.setTaskNoticeDuration(0);assert.equal(f.timers.size,0);f.advance(100000);assert.equal(f.taskNotifications.phase,'visible');assert.equal(f.store.get(key),0);
});

test('设置页三项选择正确保存，取消不改变偏好',()=>{
 const f=fixture(),sheets=[],toasts=[];
 const context=vm.createContext({...f,computed:get=>({get value(){return get();}}),ref:value=>({value}),connection:{computers:[]},bridge:{},useManualReconnect:()=>()=>{},onLoad(){},onShow(){},onHide(){},onUnload(){},uni:{hideKeyboard(){},showActionSheet:options=>sheets.push(options),showToast:options=>toasts.push(options.title)}});
 const page=fs.readFileSync('apps/mobile/pages/connection/index.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');vm.runInContext(stripTypeScriptTypes(page,{mode:'transform'})+';globalThis.choose=chooseNoticeDuration;',context);
 for(const [index,value] of [[1,10000],[2,0],[0,5000]]){context.choose();const sheet=sheets.at(-1);assert.deepEqual(Array.from(sheet.itemList),['5 秒','10 秒','不自动关闭']);sheet.success({tapIndex:index});assert.equal(f.store.get(key),value);assert.ok(toasts.at(-1).includes(f.taskNoticeDurationLabel(value)));}
 context.choose();sheets.at(-1).fail({errMsg:'取消'});assert.equal(f.store.get(key),5000);
});
