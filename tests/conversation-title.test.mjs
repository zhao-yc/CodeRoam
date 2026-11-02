import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StateReader} from '../apps/bridge/state-reader.mjs';

/** 隔离验证标题缺失、后续更新及索引故障，不连接真实桌面。 */
function fixture(readTitle) {
  const client=new EventEmitter();client.close=()=>{};
  const adapter=new DesktopAdapter({client,index:{readTitle}});
  adapter.conversations.set('thread',{watchers:new Set(),waiters:[]});
  return adapter;
}
test('实时标题为空时从对应索引补全，流式更新复用缓存',()=>{
  let reads=0;const adapter=fixture(id=>{assert.equal(id,'thread');reads++;return '索引中的会话名称';});
  try {
    for(const title of [null,undefined,'','   '])assert.equal(adapter.snapshot({id:'thread',title}).title,'索引中的会话名称');
    assert.equal(reads,1);
    assert.equal(adapter.snapshot({id:'thread',title:'刚修改的名称'}).title,'刚修改的名称');
    assert.equal(adapter.snapshot({id:'thread',title:null}).title,'刚修改的名称');
  } finally {adapter.close();}
});
test('有效实时标题优先，索引不可用不影响正文快照',()=>{
  const adapter=fixture(()=>{throw new Error('索引暂不可读');});
  try {
    assert.equal(adapter.snapshot({id:'thread',title:'实时名称'}).title,'实时名称');
    assert.equal(adapter.snapshot({id:'thread',title:null}).title,'实时名称');
    adapter.conversations.get('thread').lastTitle='';
    assert.equal(adapter.snapshot({id:'thread',title:null}).title,'未命名聊天');
  } finally {adapter.close();}
});
test('名称查询兼容新旧索引，尊重改名并排除已归档会话',()=>{
  fs.mkdirSync(path.resolve('.cache'),{recursive:true});
  const directory=fs.mkdtempSync(path.resolve('.cache/title-index-'));
  const db=new DatabaseSync(path.join(directory,'state_5.sqlite'));
  try {
    db.exec("CREATE TABLE threads(id TEXT,title TEXT,archived INTEGER); INSERT INTO threads VALUES('old','原有标题',0),('archived','归档标题',1)");
    const reader=new StateReader(directory);
    assert.equal(reader.readTitle('old'),'原有标题');
    assert.equal(reader.readTitle('archived'),'');assert.equal(reader.readTitle('missing'),'');
    db.exec("ALTER TABLE threads ADD COLUMN name TEXT; UPDATE threads SET name='用户改名' WHERE id='old'");
    assert.equal(reader.readTitle('old'),'用户改名');
    db.exec("UPDATE threads SET name='  ' WHERE id='old'");
    assert.equal(reader.readTitle('old'),'原有标题');
  } finally {db.close();fs.rmSync(directory,{recursive:true});}
});
