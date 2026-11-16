import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

test('历史快照不能直接写入，原会话实时同步后恢复操作',()=>{
  const source=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8').match(/^const (?:readOnly|canWrite|subscriptionReady|goalHostOnline|liveConversation) = .+$/gm).join('\n');
  const snapshot={threadId:'thread',readOnly:true};
  const context=componentContext({cacheOnly:false,connection:{connected:true,snapshot,hostId:'pc',activeThreadId:'thread',subscribedHostId:'pc',subscribedThreadId:'thread',computers:[{id:'pc',online:true}],pendingCommandId:''},busy:{value:false},checking:{value:false},activating:{value:false},pageHostId:{value:'pc'},pageThreadId:{value:'thread'},computed:fn=>({get value(){return fn();}})});
  vm.runInContext(stripTypeScriptTypes(source)+'; globalThis.writable=canWrite;',context);
  assert.equal(context.writable.value,false);snapshot.readOnly=false;assert.equal(context.writable.value,true);context.activating.value=true;assert.equal(context.writable.value,false);
});

/** 原生button不支持布局子组件；Web能显示不代表Android会创建对应节点。 */
test('手机端原生button只包含文字，不嵌套图标或布局组件',()=>{
  const invalid=[];
  function inspect(directory){
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())inspect(file);
      else if(file.endsWith('.uvue')){
        const source=fs.readFileSync(file,'utf8').split('<script')[0];
        // 属性表达式里的比较符号不视为标签结束，兼容UTS和CRLF。
        const buttons=source.matchAll(/<button\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/button>/g);
        for(const button of buttons){
          if(/<[a-z][\w-]*\b/i.test(button[2]))invalid.push(file+':'+(source.slice(0,button.index).split('\n').length));
          if(/class="action-hitbox"/.test(button[1])){
            assert.match(button[1],/\baria-label=/,file+' 的图标点击层必须有可读名称');
            assert.match(button[1],/@click=/,file+' 的点击层必须保留操作');
          }
        }
      }
    }
  }
  inspect('apps/mobile/pages');inspect('apps/mobile/components');
  assert.deepEqual(invalid,[],'原生button不接受嵌套组件：'+invalid.join('、'));
});

/** 使用页面真实入口，确认禁用态不会发送、停止或关闭菜单。 */
test('停止动作等待实时状态，已经更换的轮次不会停止',()=>{
  const source=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');
  const method=source.slice(source.indexOf('function stopFromMenu('),source.indexOf('// 原生返回'));
  const calls=[], pending=[];
  const context={activeTurnId:{value:'turn'},closeActions:()=>calls.push('关闭菜单'),stop:()=>calls.push('停止'),runLiveAction:action=>pending.push(action)};
  vm.runInNewContext(method+'\nstopFromMenu();',componentScope(context));
  assert.deepEqual(calls,['关闭菜单']);
  context.activeTurnId.value='other';
  pending.shift()();
  assert.deepEqual(calls,['关闭菜单']);
  vm.runInNewContext(method+'\nstopFromMenu();',componentScope(context));
  pending.shift()();
  assert.deepEqual(calls,['关闭菜单','关闭菜单','停止']);
});
