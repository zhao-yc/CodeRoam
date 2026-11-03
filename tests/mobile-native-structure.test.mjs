import {componentContext, componentScope} from './helpers/component-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';

test('历史浏览实际计算发送禁用态，原会话实时同步后恢复操作',()=>{
  const source=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8').split(/\r?\n/).filter(line=>line.startsWith('const readOnly =')||line.startsWith('const canWrite =')).join('\n');
  const snapshot={threadId:'thread',readOnly:true};
  const context=componentContext({connection:{connected:true,snapshot,hostId:'pc',activeThreadId:'thread',pendingCommandId:''},busy:{value:false},checking:{value:false},activating:{value:false},pageHostId:{value:'pc'},pageThreadId:{value:'thread'},computed:fn=>({get value(){return fn();}})});
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
test('主操作和菜单停止在禁用态无副作用，启用后保留发送与停止',()=>{
  const source=fs.readFileSync('apps/mobile/components/chat-detail/chat-detail.uvue','utf8');
  const methods=['primaryAction','stopFromMenu'].map(name=>source.split(/\r?\n/).find(line=>line.startsWith('function '+name+'('))).join('\n');
  const calls=[];
  const context={canWrite:{value:false},imageBusy:{value:false},filesReady:{value:true},draftFiles:{value:[]},draftMentions:{value:[]},draftImages:{value:[]},draft:{value:'继续'},activeTurnId:{value:'turn'},send:()=>calls.push('发送'),stop:()=>calls.push('停止'),closeActions:()=>calls.push('关闭菜单')};
  vm.runInNewContext(methods+'\nprimaryAction(); stopFromMenu();', componentScope(context));assert.deepEqual(calls,[]);
  context.canWrite.value=true;vm.runInNewContext(methods+'\nprimaryAction();', componentScope(context));assert.deepEqual(calls,['发送']);
  context.draft.value='';vm.runInNewContext(methods+'\nprimaryAction(); stopFromMenu();', componentScope(context));assert.deepEqual(calls,['发送','停止','关闭菜单','停止']);
  context.draftImages.value=[{id:'image'}];vm.runInNewContext(methods+'\nprimaryAction();', componentScope(context));assert.equal(calls.at(-1),'发送');
  context.imageBusy.value=true;const count=calls.length;vm.runInNewContext(methods+'\nprimaryAction();', componentScope(context));assert.equal(calls.length,count);
});
