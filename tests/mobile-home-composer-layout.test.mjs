import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const component=fs.readFileSync('apps/mobile/components/new-conversation/new-conversation.uvue','utf8');

/** 执行组件真实的可见性和过渡回调，布局帧、计时器均由用例控制。 */
function fixture(){
  const ref=value=>({value}),frames=[],timers=new Map(),unmounts=[],calls=[];let timerId=0;
  const native={draftId:'same-native-draft',watching:false};
  const c={props:{expanded:false},connection:{hostId:'example-computer'},projectId:ref('example-project'),native:ref(native),computed:read=>({get value(){return read();}}),draftHeight:ref(64),draft:ref({text:'保留的手机草稿',images:[],files:[],plugins:[],threadMentions:[],threadMentionRevision:0}),currentWindowHeight:ref(844),keyboardInset:ref(0),focused:ref(false),contentTarget:ref(''),error:ref('旧错误'),settingsError:ref('旧设置错误'),projectsLoading:ref(false),settingsLoading:ref(false),editorRevision:0,editorLayoutTimer:0,projectRequest:0,settingsRequest:0,alive:true,baseWindowHeight:844,uni:{getWindowInfo:()=>({windowHeight:844})},nextTick:fn=>frames.push(fn),setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),onUnmounted:fn=>unmounts.push(fn),watch:(read,run,options)=>{if(options?.immediate)run(read());},beginNewConversation:()=>calls.push('新流程'),loadProjects:()=>{calls.push('读取项目');native.watching=true;},closeNativeDraft:(hostId,projectId)=>{assert.equal(hostId,'example-computer');assert.equal(projectId,'example-project');calls.push('取消原生订阅');native.watching=false;},closeMenus:()=>calls.push('关闭菜单'),emit:event=>calls.push(event)};
  c.nativeOpenRequested=false;
  const dimensions=component.split(/\r?\n/).filter(line=>/^const (editorContentHeight|visibleInputHeight|visibleContentHeight|editorStageHeight) =/.test(line)).join('\n');
  // 通过实际函数定位生命周期，中文说明修改不会改变需要执行的范围。
  const lifecycle=component.slice(component.indexOf('function syncEditorVisibility('),component.indexOf('let unbindImagePaste'));
  const methods=['showDraftInput','onLineChange','onKeyboardChange','expandEditor'].map(name=>component.split(/\r?\n/).find(line=>line.startsWith('function '+name+'('))).join('\n');
  vm.runInNewContext(stripTypeScriptTypes(dimensions+'\n'+methods+'\n'+lifecycle+';globalThis.ui={syncEditorVisibility,settleEditorLayout,visibleInputHeight,visibleContentHeight,editorStageHeight,onLineChange,onKeyboardChange,expandEditor};',{mode:'transform'}),c);
  return {c,calls,timers,ui:c.ui,flush(){while(frames.length)frames.shift()();},expand(value){c.props.expanded=value;c.ui.syncEditorVisibility(value);},unmount(){unmounts.forEach(fn=>fn());}};
}

test('列表默认保留单行高度，点击只请求展开，展开后才读取项目和聚焦',()=>{
  const f=fixture();assert.equal(f.ui.editorStageHeight.value,44);assert.equal(f.ui.visibleInputHeight.value,24);assert.equal(f.calls.includes('读取项目'),false);
  f.ui.expandEditor();assert.equal(f.calls.at(-1),'expand');assert.equal(f.calls.includes('新流程'),false);
  f.expand(true);assert.equal(f.ui.editorStageHeight.value,122);assert.equal(f.ui.visibleInputHeight.value,64);assert.deepEqual(f.calls.slice(-2),['新流程','读取项目']);
  assert.equal(f.c.focused.value,false);f.flush();assert.equal(f.c.focused.value,true);
});

test('多行和附件扩展数值高度，过渡完成后滚到实际输入位置',()=>{
  const f=fixture();f.expand(true);f.flush();f.ui.onLineChange({detail:{height:360}});assert.equal(f.c.draftHeight.value,144);
  f.c.draft.value.images=[{}];assert.equal(f.ui.visibleContentHeight.value,214);assert.equal(f.ui.editorStageHeight.value,272);
  f.ui.settleEditorLayout();assert.equal(f.timers.size,1);const timer=[...f.timers.values()][0];assert.equal(timer.ms,220);f.c.contentTarget.value='';timer.fn();f.flush();assert.equal(f.c.contentTarget.value,'new-draft-input');
});

test('收起、快速重开及卸载阻止旧聚焦和旧动画回写，保留同一电脑草稿只恢复订阅',()=>{
  const f=fixture();f.expand(true);const old=[...f.timers.values()][0].fn;f.c.keyboardInset.value=260;f.expand(false);f.flush();old();f.flush();
  assert.equal(f.c.focused.value,false);assert.equal(f.c.keyboardInset.value,0);assert.equal(f.timers.size,0);assert.equal(f.c.contentTarget.value,'');
  assert.equal(f.c.native.value.watching,false);assert.equal(f.c.native.value.draftId,'same-native-draft');assert.equal(f.c.draft.value.text,'保留的手机草稿');
  f.ui.onLineChange({detail:{height:24}});assert.equal(f.c.draftHeight.value,64);
  f.expand(true);f.flush();assert.equal(f.c.focused.value,true);assert.equal(f.calls.filter(call=>call==='新流程').length,2);
  assert.equal(f.c.native.value.watching,true);assert.equal(f.c.native.value.draftId,'same-native-draft');
  const latest=[...f.timers.values()][0].fn;f.unmount();f.c.contentTarget.value='';latest();f.flush();assert.equal(f.timers.size,0);assert.equal(f.c.contentTarget.value,'');
  assert.equal(f.c.native.value.watching,false);
});

test('收起状态的常驻组件不发起项目或模型读取',()=>{
  const settings=component.slice(component.indexOf('function loadSettings('),component.indexOf('// 项目来自电脑'));
  const projects=component.slice(component.indexOf('function loadProjects()'),component.indexOf('function chooseComputer('));
  const c={props:{expanded:false}};
  vm.runInNewContext(stripTypeScriptTypes(settings+projects+';loadSettings();loadProjects();',{mode:'transform'}),c);
});

test('收起后的迟到键盘高度不再抬高列表入口',()=>{
  const f=fixture();f.expand(true);f.ui.onKeyboardChange({detail:{height:260}});assert.equal(f.c.keyboardInset.value,260);
  f.expand(false);f.ui.onKeyboardChange({detail:{height:260}});assert.equal(f.c.keyboardInset.value,0);assert.equal(f.ui.editorStageHeight.value,44);
});
