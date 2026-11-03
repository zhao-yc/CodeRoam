import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

/** 执行真实工作区脚本，桥接、组件装卸和页面导航由用例控制。 */
export function workspaceFixture(options = {}) {
  const calls=[],watchers=[],unmounts=[],ticks=[];
  const props={initialTarget:null,active:true,windowWidth:1366,windowHeight:900,detailRoute:false,...options.props};
  const connection={hostId:'host',cacheNamespace:'pair',connected:true,computers:[{id:'host',online:true},{id:'other',online:true}],...options.connection};
  let cached=options.cached??false;
  const ref=value=>({value}),context={props,connection,ref,computed:read=>({get value(){return read();}}),defineProps:()=>props,withDefaults:(value,defaults)=>({...defaults,...value}),defineExpose(){},watch:(read,callback,settings)=>{watchers.push({read,callback});if(settings?.immediate)callback(read());},onMounted(){},onUnmounted:fn=>unmounts.push(fn),nextTick:fn=>{if(options.manualTicks)return new Promise(resolve=>ticks.push(()=>{fn?.();resolve();}));fn?.();return Promise.resolve();},getCurrentPages:()=>[{},{}],encodeURIComponent,readConversationCache:(...args)=>{calls.push(['cache',...args]);return cached?{}:null;},bindWorkspaceNoticeNavigation:fn=>{context.notice=fn;return()=>{context.notice=null;};},uni:{showToast:value=>calls.push(['toast',value.title]),hideKeyboard:()=>calls.push(['keyboard']),navigateTo:value=>{calls.push(['navigate',value.url]);value.success?.();},navigateBack:()=>calls.push(['back'])},bridge:{selectComputer:hostId=>{calls.push(['select',hostId]);connection.hostId=hostId;},openThread:threadId=>{calls.push(['open',threadId]);connection.activeThreadId=threadId;return Promise.resolve({});},watch:threadId=>{calls.push(['watch',threadId]);connection.activeThreadId=threadId;},cancelOpen:threadId=>calls.push(['cancel',threadId])}};
  context.withDefaults = value => value;
  const scope=vm.createContext(context);
  const layout=fs.readFileSync('apps/mobile/services/workspace-layout.uts','utf8').replace(/\bexport /g,'');
  const component=fs.readFileSync('apps/mobile/components/chat-workspace/chat-workspace.uvue','utf8').match(/<script setup lang="uts">([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm,'');
  vm.runInContext(stripTypeScriptTypes(layout+'\n'+component,{mode:'transform'})+';globalThis.api={selected,selectedKey,mode,wide,detailWidth,detailMounted,creating,newReady,listPane,detailPane,selectConversation,openThread,openNewConversation,closeNewConversation,onConversationCreated,closeConversation,onConversationRemoved,syncNoticeNavigation,handleBack};',scope);
  const api=scope.api;
  api.listPane.value={rememberOpened:key=>calls.push(['recent',key]),showArchiveSuccessNotice:()=>calls.push(['archive-notice']),showDeleteSuccessNotice:()=>calls.push(['delete-notice']),handleBack:()=>false};
  return {...api,calls,props:scope.props,connection,watchers,context,target:(id='thread',host='host')=>({hostId:host,threadId:id,title:'合成聊天',projectName:'项目',cacheNamespace:'pair'}),setCached:value=>{cached=value;},flush:async()=>{ticks.splice(0).forEach(fn=>fn());await Promise.resolve();},unmount:()=>unmounts.forEach(fn=>fn())};
}
