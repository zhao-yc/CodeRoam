import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

const page=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');
const helpers=stripTypeScriptTypes(fs.readFileSync('apps/mobile/services/composer-layout.uts','utf8').replace(/\bexport /g,''),{mode:'transform'});

/** 执行实际页面的布局、测量和焦点方法，使用可控布局帧复现迟到回调。 */
function fixture(){
  const ref=value=>({value}),frames=[],timers=new Map(),watches=[],unloads=[];let timerId=0;
  const c={computed:fn=>({get value(){return fn();}}),inputFocused:ref(false),draft:ref(''),visiblePrediction:ref(''),draftImages:ref([]),draftFiles:ref([]),composerMenu:ref(''),permissionMenuOpen:ref(false),imageBusy:ref(false),draftHeight:ref(64),predictionHeight:ref(24),predictionFocus:ref(false),pageHostId:ref('host'),pageThreadId:ref('thread'),composerBlurTimer:0,composerMeasureRevision:0,pageAlive:true,following:ref(false),measuredHeight:72,geometry:[],uni:{getElementById:()=>({getBoundingClientRect:()=>({height:c.measuredHeight})})},nextTick:fn=>frames.push(fn),watch:(read,run)=>watches.push({read,run}),onResize:fn=>{c.resize=fn;},onUnload:fn=>unloads.push(fn),updateMenuHeight:()=>c.geometry.push('菜单'),scrollLatest:()=>c.geometry.push('最新消息'),updateTimelinePosition:()=>c.geometry.push('消息位置'),dismissGoal(){},setTimeout:fn=>{timers.set(++timerId,fn);return timerId;},clearTimeout:id=>timers.delete(id)};
  Object.assign(c,{composerAnimationTimer:0,composerAnimationRevision:0});
  Object.assign(c,{pluginOpen:ref(false),draftPlugins:ref([]),mentionOpen:ref(false),draftMentions:ref([])});
  const layout=page.slice(page.indexOf('// 占位预测使用独立测量值'),page.indexOf('// 键盘由输入区处理'));
  const blur=page.slice(page.indexOf('function onDraftBlur()'),page.indexOf('function updateMenuHeight()'));
  const focus=page.match(/function onComposerFocus\(\) \{[^\n]*\}/)[0];
  vm.runInNewContext(stripTypeScriptTypes(helpers+layout+blur+focus+';globalThis.ui={composerExpanded,composerHeight,composerStageHeight,settleComposerAnimation,onDraftBlur,onComposerFocus,onPermissionVisibility,onDraftLineChange,measureComposerPrediction,updateComposerGeometry};',{mode:'transform'}), componentScope(c));
  return {c,ui:c.ui,watches,unloads,timers,flush(){while(frames.length)frames.shift()();},blur(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}}};
}

test('空白默认单行，聚焦恢复编辑面板，空白失焦延后收起，重新聚焦取消收起',()=>{
  const f=fixture();assert.equal(f.ui.composerExpanded.value,false);assert.equal(f.ui.composerHeight.value,24);
  f.ui.onComposerFocus();assert.equal(f.ui.composerExpanded.value,true);assert.equal(f.ui.composerHeight.value,64);
  f.ui.onDraftBlur();assert.equal(f.ui.composerExpanded.value,true);f.blur();assert.equal(f.ui.composerExpanded.value,false);
  f.ui.onComposerFocus();f.ui.onDraftBlur();f.ui.onComposerFocus();f.blur();assert.equal(f.ui.composerExpanded.value,true);
});

test('草稿、预测、附件、工具菜单、权限菜单和选择附件期间，失焦仍保持展开',()=>{
  for(const [key,value] of [['draft','草稿'],['visiblePrediction','预测'],['draftImages',[{}]],['draftFiles',[{}]],['draftPlugins',[{id:'sample@example',displayName:'示例插件'}]],['pluginOpen',true],['draftMentions',[{id:'synthetic',title:'合成聊天'}]],['mentionOpen',true],['composerMenu','add'],['permissionMenuOpen',true],['imageBusy',true]]){
    const f=fixture();f.ui.onComposerFocus();f.c[key].value=value;f.ui.onDraftBlur();f.blur();assert.equal(f.ui.composerExpanded.value,true,key);
    f.c[key].value=Array.isArray(value)?[]:typeof value==='boolean'?false:'';assert.equal(f.ui.composerExpanded.value,false,key);
  }
});

test('预测按真实排版高度取整并限制六行，编辑态保持原有高度范围',()=>{
  const f=fixture();f.c.visiblePrediction.value='预测';
  for(const [height,expected] of [[24,24],[48,48],[48.25,72],[144,144],[360,144]]){f.c.measuredHeight=height;f.ui.measureComposerPrediction();f.flush();assert.equal(f.ui.composerHeight.value,expected);}
  f.c.visiblePrediction.value='';f.c.draft.value='已有草稿';
  for(const [height,expected] of [[24,64],[96,96],[400,144]]){f.ui.onDraftLineChange({detail:{height}});assert.equal(f.ui.composerHeight.value,expected);}
});

test('预测测量在布局帧后读取，过期、切换及页面卸载后的旧测量均不写回',()=>{
  const f=fixture();f.c.visiblePrediction.value='第一条';f.ui.measureComposerPrediction();f.c.visiblePrediction.value='第二条';f.ui.measureComposerPrediction();f.c.measuredHeight=96;f.flush();assert.equal(f.c.predictionHeight.value,96);
  f.ui.measureComposerPrediction();f.c.visiblePrediction.value='';f.ui.measureComposerPrediction();f.flush();assert.equal(f.c.predictionHeight.value,24);
  f.c.visiblePrediction.value='另一会话';f.ui.measureComposerPrediction();f.c.pageAlive=false;f.unloads.forEach(fn=>fn());f.flush();assert.equal(f.c.predictionHeight.value,24);
});

test('宽度变化重测预测，空输入行高不覆盖预测，布局更新尊重历史阅读位置',()=>{
  const f=fixture();f.c.visiblePrediction.value='需要随宽度换行的预测';f.c.measuredHeight=120;f.c.resize();f.flush();assert.equal(f.ui.composerHeight.value,120);
  f.ui.onDraftLineChange({detail:{height:24}});f.flush();assert.equal(f.ui.composerHeight.value,120);assert.equal(f.c.geometry.includes('最新消息'),false);
  f.c.composerMenu.value='add';f.c.following.value=true;f.ui.updateComposerGeometry();f.flush();assert.ok(f.c.geometry.includes('菜单'));assert.ok(f.c.geometry.includes('最新消息'));
});

test('清空草稿与切换会话复位编辑高度及焦点，不把预测写入 textarea 正文',()=>{
  const f=fixture();f.c.draftHeight.value=144;f.watches.find(watch=>watch.read()==='').run('');assert.equal(f.c.draftHeight.value,64);
  f.c.inputFocused.value=true;f.c.predictionFocus.value=true;f.c.permissionMenuOpen.value=true;f.c.draftHeight.value=144;
  f.watches.find(watch=>watch.read()==='host:thread').run();assert.equal(f.c.inputFocused.value,false);assert.equal(f.c.predictionFocus.value,false);assert.equal(f.c.permissionMenuOpen.value,false);assert.equal(f.c.draftHeight.value,64);
  assert.equal((page.match(/<textarea\b[^>]*class="draft"/g)??[]).length,1);assert.match(page,/:value="draft"/);
});

test('展开及增行使用明确高度，动画完成后补测菜单与历史阅读位置',()=>{
  const f=fixture();assert.equal(f.ui.composerStageHeight.value,44);
  f.ui.onComposerFocus();assert.equal(f.ui.composerStageHeight.value,122);
  f.c.draft.value='多行草稿';f.ui.onDraftLineChange({detail:{height:120}});assert.equal(f.ui.composerStageHeight.value,178);f.flush();f.c.geometry.length=0;
  f.c.composerMenu.value='settings';f.ui.settleComposerAnimation();assert.equal(f.c.geometry.length,0);
  f.blur();f.flush();assert.deepEqual(f.c.geometry,['菜单','消息位置']);
});

test('快速反向切换只保留最后一次完成回调，会话切换与卸载取消旧回调',()=>{
  const f=fixture();f.ui.settleComposerAnimation();const old=[...f.timers.values()][0];
  f.ui.onComposerFocus();f.ui.settleComposerAnimation();assert.equal(f.timers.size,1);old();f.flush();assert.equal(f.c.geometry.length,0);
  f.blur();f.flush();assert.deepEqual(f.c.geometry,['消息位置']);f.c.geometry.length=0;
  for(const reset of [()=>f.watches.find(w=>w.read()==='host:thread').run(),()=>f.unloads.forEach(fn=>fn())]){
    f.ui.settleComposerAnimation();const callback=[...f.timers.values()][0];reset();assert.equal(f.timers.size,0);f.flush();f.c.geometry.length=0;callback();f.flush();assert.equal(f.c.geometry.length,0);
  }
});
