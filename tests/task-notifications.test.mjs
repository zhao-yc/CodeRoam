import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {taskNotificationState} from '../apps/bridge/task-notifications.mjs';
import {normalizeConversation} from '../apps/bridge/conversation.mjs';
import {conversationUpdate,applyConversationUpdate} from '../apps/bridge/updates.mjs';

/** 执行真实 UTS 状态机，用明确时刻验证跨页共用的通知队列。 */
function fixture(){const source=fs.readFileSync('apps/mobile/services/task-notification-state.uts','utf8').replace(/^import .*\r?\n/gm,'').replaceAll('export ','');const context=vm.createContext({});vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.Center=TaskNotificationCenter;',context);return new context.Center();}
const plain=value=>JSON.parse(JSON.stringify(value));
const action=(kind='question',id='q1',turnId='turn')=>({kind,id,turnId});
const row=(status='inProgress',pending=[],id='thread',turn='turn')=>({id,title:'合成测试会话',notificationState:{latestTurnId:turn,latestTurnStatus:status,pending}});

test('结构化结果独立于正文窗口，异常为失败，停止不变为成功，列表不含私密内容',()=>{
 const questions=[{id:'q',turnId:'t',state:'pending',questions:[{answer:'不应广播'}]}],approvals=[{id:'a',turnId:'t',detail:'不应广播'}];
 assert.deepEqual(taskNotificationState([{turnId:'t',status:'completed',error:{message:'不应广播'}}],questions,approvals,{id:'p',turnId:'t',text:'不应广播'}),{latestTurnId:'t',latestTurnStatus:'failed',pending:[action('question','q','t'),action('approval','a','t'),action('plan','p','t')]});
 assert.equal(taskNotificationState([{turnId:'t',status:'interrupted'}],[],[],null).latestTurnStatus,'interrupted');
 const snapshot=normalizeConversation({id:'thread',turns:[{turnId:'empty',status:'failed',items:[]}]});assert.equal(snapshot.notificationState.latestTurnStatus,'failed');assert.deepEqual(snapshot.turns,[{turnId:'empty',status:'failed',errorMessage:'任务执行失败，未提供具体原因'}]);assert.deepEqual(snapshot.latestTurn,{turnId:'empty',status:'failed'});
 const initial=normalizeConversation({id:'thread',turns:[{turnId:'t',status:'inProgress',items:[{id:'msg',type:'agentMessage',text:'合成正文'.repeat(1000)}]}]});
 const final=normalizeConversation({id:'thread',turns:[{turnId:'t',status:'completed',items:[{id:'msg',type:'agentMessage',text:'合成正文'.repeat(1000)}]}]});
 const event=conversationUpdate({snapshot:initial,seq:1},final);const rebuilt=applyConversationUpdate({snapshot:initial,epoch:'epoch',seq:1},{...event,epoch:'epoch',seq:2});assert.deepEqual(rebuilt.snapshot.notificationState,final.notificationState);
});

test('首次仅补待交互，成功失败只在基线后的明确终态提醒，停止和断线不误报',()=>{
 const c=fixture();c.observe('host','g',[row('completed'),row('failed',[],'old')],0);assert.equal(c.current,null);
 c.observe('host','g',[row('inProgress'),row('failed',[],'old')],1);c.observe('host','g',[row('completed'),row('failed',[],'old')],2);assert.equal(c.current.kind,'completed');
 c.reset();c.observe('host','g',[row('inProgress')],0);c.observe('host','g',[row('interrupted')],1);assert.equal(c.current,null);c.observe('host','g',[row('failed')],2);assert.equal(c.current.kind,'failed');
 c.reset();c.observe('host','g',[row('completed',[action()])],3);assert.equal(c.current.kind,'question');assert.equal(c.queue.length,0);
 c.reset();c.observe('host','g',[row('unknown',[],'thread','')],0);c.observe('host','g',[row('completed')],1);assert.equal(c.current,null,'历史或未知快照首次补齐不能冒充新完成');
});

test('进入动画后完整展示五秒，再淡出并依次展示；重复推送不重置跨页倒计时',()=>{
 const c=fixture();c.observe('host','g',[row('inProgress',[action(),action('approval','a')])],0);assert.equal(c.phase,'enter');c.tick(16);assert.equal(c.phase,'visible');assert.equal(c.deadline,5216);
 c.observe('host','g',[row('inProgress',[action(),action('approval','a')])],1000);assert.equal(c.deadline,5216);assert.equal(c.queue.length,1);
 c.tick(5215);assert.equal(c.phase,'visible');c.tick(5216);assert.equal(c.phase,'leave');c.tick(5416);assert.equal(c.current.kind,'approval');assert.equal(c.phase,'enter');
});

test('上滑提前离场后继续队列，不改待办，不因重复关闭而延长动画',()=>{
 const c=fixture();c.observe('host','g',[row('inProgress',[action(),action('approval','a')])],0);c.tick(16);const key=c.current.key;
 assert.equal(c.swipeDismiss(key,1000),true);assert.equal(c.phase,'swipe');assert.equal(c.deadline,1200);assert.equal(c.queue.length,1);
 assert.equal(c.swipeDismiss(key,1050),false);assert.equal(c.deadline,1200);c.tick(1199);assert.equal(c.current.key,key);c.tick(1200);assert.equal(c.current.kind,'approval');
 assert.equal(c.hosts[0].threads[0].notificationState.pending.length,2);c.tick(1216);assert.equal(c.swipeDismiss(key,1217),false);assert.equal(c.current.kind,'approval');
});

test('异步问题在运行中提醒，同数量新事项仍提醒，排队事项失效即剔除',()=>{
 const c=fixture();c.observe('host','g',[row('inProgress',[action(),action('plan','p')])],0);assert.equal(c.current.kind,'question');
 c.observe('host','g',[row('inProgress',[action('question','q2')])],20);assert.equal(c.queue.length,1);assert.equal(c.queue[0].targetId,'q2');c.dismiss(21);assert.equal(c.current.targetId,'q2');
 c.observe('host','g',[row('completed',[action('plan','p2')])],22);assert.deepEqual(plain(c.queue.map(item=>item.kind)),['plan']);
});

test('不同电脑同号会话独立，撤回和换代清理旧通知，恢复仅补仍待交互',()=>{
 const c=fixture();c.observe('one','g',[row('completed',[action()])],0);c.observe('two','g',[row('completed',[action()])],1);assert.equal(c.queue.length,1);
 c.retainHosts([JSON.stringify(['two','g'])]);c.tick(2);assert.equal(c.current.hostId,'two');c.retainHosts([JSON.stringify(['two','g2'])]);assert.equal(c.current,null);
 c.reset();c.observe('two','g2',[row('completed',[action('approval','a')]),row('failed',[],'old')],3);assert.equal(c.current.kind,'approval');assert.equal(c.queue.length,0);
});

test('当前聊天的五类通知均略过，离开不补发，后续新事项仍提醒',()=>{
 for(const kind of ['question','approval','plan','completed','failed']){
  const c=fixture();c.setVisibleThread('one','thread',0);c.observe('one','g',[row()],1);
  const terminal=kind==='completed'||kind==='failed',updated=row(terminal?kind:'inProgress',terminal?[]:[action(kind)]);
  c.observe('one','g',[updated],2);assert.equal(c.current,null,kind);assert.equal(c.queue.length,0);
  c.setVisibleThread('','',3);c.observe('one','g',[updated],4);assert.equal(c.current,null,'离开后不能补发 '+kind);
  c.observe('one','g',[row('inProgress')],5);
  c.observe('one','g',[row(terminal?kind:'inProgress',terminal?[]:[action(kind,'new','next')],'thread','next')],6);
  assert.equal(c.current.kind,kind,'离开后新事项应提醒');
 }
});

test('进入聊天立即清除已显示和排队的本聊天通知，其他聊天和电脑保留',()=>{
 const c=fixture();c.observe('one','g',[row('inProgress',[action(),action('approval','a')]),row('inProgress',[action('plan','p')],'other')],0);
 c.observe('two','g',[row('inProgress',[action()])],1);assert.equal(c.queue.length,3);
 c.setVisibleThread('one','thread',2);assert.equal(c.current.threadId,'other');assert.equal(c.queue.length,1);assert.equal(c.queue[0].hostId,'two');
 c.dismiss(3);assert.equal(c.current.hostId,'two');c.dismiss(4);assert.equal(c.current,null);
 c.setVisibleThread('','',5);c.observe('one','g',[row('inProgress',[action(),action('approval','a')])],6);assert.equal(c.current,null);
 c.setVisibleThread('one','thread',7);c.reset();c.observe('one','new',[row('inProgress',[action()])],8);assert.equal(c.current,null,'重连后前台页面仍然抑制提醒');
 c.observe('two','g',[row('inProgress',[action()])],9);assert.equal(c.current.hostId,'two','其他电脑的同号聊天仍提醒');
});

/** 模拟框架导航与连接生命周期，确认点击只读打开一次，订阅不依赖首页。 */
function serviceFixture(){
 const watchers=[],ticks=[],calls=[];
 const connection={configurationRevision:1,configured:true,connected:true,hostId:'one',computers:[{id:'one',online:true,label:'示例电脑',instanceGeneration:'g'}]};
 const threadList={computers:[{hostId:'one',instanceGeneration:'g',online:true,subscribed:true,threads:[row('inProgress',[action()])]}]};
 const context=vm.createContext({TaskNotificationCenter:fixture().constructor,reactive:value=>value,connection,threadList,watch:(_read,changed,options)=>{watchers.push(changed);if(options?.immediate)changed();},nextTick:fn=>ticks.push(fn),setTimeout:()=>1,clearTimeout(){},Date,JSON,getCurrentPages:()=>[{route:'pages/connection/index'}],syncThreadComputers:()=>calls.push('sync'),refreshComputerThreads:()=>calls.push('subscribe'),disconnectThreadLists:()=>calls.push('disconnect'),bridge:{selectComputer:id=>calls.push(['computer',id]),openThread:id=>{calls.push(['open',id]);return Promise.resolve({});}},uni:{showToast:options=>calls.push(['toast',options.title]),navigateTo:options=>calls.push(['navigate',options]),redirectTo:options=>calls.push(['replace',options])}});
 const source=fs.readFileSync('apps/mobile/services/task-notifications.uts','utf8').replace(/^import .*\r?\n/gm,'').replaceAll('export ','');vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'})+';globalThis.f={startTaskNotifications,resetTaskNotifications,openTaskNotice,pendingTaskNotice,taskNotifications,showTaskNoticeThread,hideTaskNoticeThread};',context);
 return {...context.f,connection,threadList,calls,watchers,ticks};
}

test('应用初始化即全局订阅，重入只初始化一次；点击跨页后才打开目标，不发送任务',()=>{
 const f=serviceFixture();f.startTaskNotifications();f.startTaskNotifications();assert.equal(f.watchers.length,2);assert.ok(f.calls.includes('subscribe'));const notice=f.taskNotifications.current;assert.equal(notice.kind,'question');
 f.openTaskNotice(notice);const navigation=f.calls.find(call=>call[0]==='navigate')[1];assert.match(navigation.url,/noticeKey=/);assert.equal(f.pendingTaskNotice(notice.key).hostId,'one');assert.equal(f.calls.some(call=>call[0]==='open'),false);
 navigation.success();assert.equal(f.calls.some(call=>call[0]==='open'),false);f.ticks.shift()();assert.deepEqual(f.calls.filter(call=>Array.isArray(call)&&call[0]==='open'),[['open','thread']]);assert.equal(f.taskNotifications.focus.targetId,'q1');
});

test('当前会话点击只定位；离线、换代或旧导航回调不切换电脑',()=>{
 const f=serviceFixture();f.startTaskNotifications();const notice=f.taskNotifications.current;f.openTaskNotice(notice,'one','thread');assert.equal(f.taskNotifications.focusRevision,1);assert.equal(f.calls.some(call=>Array.isArray(call)&&call[0]==='navigate'),false);
 f.openTaskNotice(notice);const navigation=f.calls.find(call=>call[0]==='navigate')[1];navigation.success();f.resetTaskNotifications();f.ticks.shift()();assert.equal(f.calls.some(call=>call[0]==='open'),false);
 f.connection.computers[0].instanceGeneration='new';f.openTaskNotice(notice);assert.ok(f.calls.some(call=>call[0]==='toast'));assert.equal(f.calls.some(call=>call[0]==='computer'),false);
});

test('页面可见登记清理通知，旧页面卸载不误清新窗口，返回列表后恢复提醒',()=>{
 const f=serviceFixture();f.startTaskNotifications();assert.equal(f.taskNotifications.current.kind,'question');
 const old=f.showTaskNoticeThread('one','thread');assert.equal(f.taskNotifications.current,null);
 const current=f.showTaskNoticeThread('one','thread');f.hideTaskNoticeThread(old);
 f.threadList.computers[0].threads=[row('inProgress',[action('approval','new')])];f.watchers[1]();assert.equal(f.taskNotifications.current,null,'旧页面清理不能撤销新页面登记');
 f.resetTaskNotifications();f.watchers[1]();assert.equal(f.taskNotifications.current,null,'重连后仍识别当前窗口');
 f.hideTaskNoticeThread(current);f.watchers[1]();assert.equal(f.taskNotifications.current,null,'离开后不补发已有事项');
 f.threadList.computers[0].threads=[row('inProgress',[action('plan','new-plan')])];f.watchers[1]();assert.equal(f.taskNotifications.current.kind,'plan','列表保留连接订阅时也应正常提醒');
});
