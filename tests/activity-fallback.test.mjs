import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';

test('没有页面入口的普通适配器只按保存版本检测活动候选，静态历史不重复解析',async t=>{
  const client=new EventEmitter();client.close=()=>{};
  const versions=new Map([['a',1],['b',1]]),events=new Map([['a','active'],['b','completed']]);let metadata=0;
  const adapter=new DesktopAdapter({client,index:{list:()=>[...versions.keys()].map(id=>({id})),historyCacheSource:id=>String(versions.get(id)),historyActivity:id=>{metadata++;return {status:events.get(id)};},readHistory:()=>assert.fail('活动检测不能读取完整正文')}});
  t.after(()=>adapter.close());
  assert.deepEqual(await adapter.readActivityInventory(),{complete:false,threadIds:['a']});assert.equal(metadata,2);
  assert.deepEqual(await adapter.readActivityInventory(),{complete:false,threadIds:['a']});assert.equal(metadata,2);
  events.set('a','completed');versions.set('a',2);
  assert.deepEqual(await adapter.readActivityInventory(),{complete:false,threadIds:[]});assert.equal(metadata,3);
  adapter.index.historyActivity=()=>{throw Error('合成暂时不可用');};versions.set('b',2);
  assert.equal((await adapter.readActivityInventory()).complete,false);
});
