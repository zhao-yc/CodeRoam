import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StateReader} from '../apps/bridge/state-reader.mjs';

test('永久删除范围仅沿附属关系递归，包含归档子对话并防止循环，不包括普通分叉', t => {
  const f=fixture(['attached_thread_parent_id']);t.after(()=>f.close());
  f.add({id:'root',title:'合成主对话',attached_thread_parent_id:null});
  f.add({id:'child',title:'合成子对话',attached_thread_parent_id:'root'});
  f.add({id:'grandchild',title:'合成归档子对话',attached_thread_parent_id:'child',archived:1});
  f.add({id:'fork',title:'独立分叉',attached_thread_parent_id:null});
  assert.deepEqual(f.reader.readDeletionTree('root'),[{id:'root',archived:false},{id:'child',archived:false},{id:'grandchild',archived:true}]);
  assert.deepEqual(f.reader.existingThreadIds(['root','grandchild','missing']).sort(),['grandchild','root']);
  assert.equal(f.reader.readDeletionTree('missing').length,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM threads').get().count,4);
});

/** 仅创建隔离索引，覆盖实际来源格式和旧版字段，绝不更改真实 Codex 数据。 */
function fixture(extraColumns=[]) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-thread-list-'));
  const db=new DatabaseSync(path.join(directory,'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,archived INTEGER DEFAULT 0${extraColumns.map(name=>`,${name} TEXT`).join('')})`);
  const reader=new StateReader(directory);
  return {db,reader,add(row){const keys=Object.keys(row);db.prepare(`INSERT INTO threads (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(key=>row[key]));},close(){db.close();fs.rmSync(directory,{recursive:true});}};
}

test('归档查询分页搜索且不混入普通会话，也不修改索引',()=>{
  const f=fixture(['thread_source']);
  try {
    f.add({id:'active',title:'当前会话',cwd:'/synthetic',updated_at:4});
    f.add({id:'archived-new',title:'归档甲',cwd:'/synthetic',updated_at:3,archived:1});
    f.add({id:'archived-old',title:'归档乙',cwd:'/synthetic',updated_at:2,archived:1});
    f.add({id:'hidden',title:'内部',updated_at:5,archived:1,thread_source:'subagent'});
    const before=f.db.prepare('SELECT * FROM threads ORDER BY id').all();
    assert.deepEqual(f.reader.list().map(row=>row.id),['active']);
    assert.deepEqual(f.reader.list({archived:true,limit:1,offset:1}).map(row=>row.id),['archived-old']);
    assert.deepEqual(f.reader.list({archived:true,search:'归档甲'}).map(row=>row.id),['archived-new']);
    assert.deepEqual(f.db.prepare('SELECT * FROM threads ORDER BY id').all(),before);
  } finally {f.close();}
});

test('按真实来源隐藏内部审核和子智能体，保留同名及未知来源的普通聊天',()=>{
  const f=fixture(['source','thread_source']);
  try {
    const rows=[
      {id:'review',title:'Guardian review',source:'{"subagent":{"other":"guardian"}}',thread_source:'guardian_review'},
      {id:'legacy-review',title:'改名后的审核',source:'{ "subagent": { "other": "guardian" } }',thread_source:'subagent'},
      {id:'typed-review',title:'新来源格式的审核',source:'future-source',thread_source:'guardian_review'},
      {id:'same-title',title:'Guardian review',source:'cli',thread_source:'app'},
      {id:'normal',title:'项目会话',source:'unknown-source',thread_source:null},
      {id:'worker',title:'普通子会话',source:'{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}',thread_source:'subagent'},
      {id:'legacy-worker',title:'',source:'{ "subagent": { "thread_spawn": { "parent_thread_id": "parent" } } }',thread_source:null},
      {id:'typed-worker',title:'已命名内部任务',source:'future-source',thread_source:'subagent'},
      {id:'same-worker-title',title:'普通子会话',source:'vscode',thread_source:'user'},
      {id:'unnamed',title:'',source:'vscode',thread_source:'user'},
      {id:'null-subagent',title:'普通来源',source:'{"subagent":null}',thread_source:null},
      {id:'empty-source',title:'空来源的会话',source:null,thread_source:null},
      {id:'archived',title:'已归档普通会话',source:'cli',thread_source:'app',archived:1}
    ];
    rows.forEach((row,index)=>f.add({cwd:'C:/project',updated_at:100-index,...row}));
    const before=f.db.prepare('SELECT * FROM threads ORDER BY id').all();
    assert.deepEqual(f.reader.list().map(row=>row.id),['same-title','normal','same-worker-title','unnamed','null-subagent','empty-source']);
    assert.deepEqual(f.reader.list({search:'普通子会话'}).map(row=>row.id),['same-worker-title']);
    assert.equal(f.reader.list().find(row=>row.id==='unnamed').title,'未命名聊天');
    assert.deepEqual(f.reader.list({search:'Guardian review'}).map(row=>row.id),['same-title']);
    assert.deepEqual(f.reader.list({search:'审核'}),[]);
    assert.deepEqual(f.reader.list({search:'C:/project',limit:2,offset:1}).map(row=>row.id),['normal','same-worker-title']);
    assert.deepEqual(f.db.prepare('SELECT * FROM threads ORDER BY id').all(),before);
  } finally {f.close();}
});

test('只有 source 的旧索引也能在分页前排除审核和内部子智能体',()=>{
  const f=fixture(['source']);
  try {
    f.add({id:'review',title:'Guardian review',cwd:'C:/project',updated_at:4,source:'{"subagent":{"other":"guardian"}}'});
    f.add({id:'worker',title:'',cwd:'C:/project',updated_at:5,source:'{"subagent":{"thread_spawn":{"parent_thread_id":"parent"}}}'});
    f.add({id:'first',title:'第一个项目',cwd:'C:/project',updated_at:3,source:'cli'});
    f.add({id:'second',title:'第二个项目',cwd:'C:/project',updated_at:2,source:'null'});
    assert.equal(f.reader.list({limit:1})[0].id,'first');
    assert.equal(f.reader.list({limit:1,offset:1})[0].id,'second');
  } finally {f.close();}
});

test('只有规范来源字段时排除审核和内部子智能体',()=>{
  const f=fixture(['thread_source']);
  try {
    f.add({id:'review',title:'内部审核',updated_at:2,thread_source:'guardian_review'});
    f.add({id:'worker',title:'',updated_at:3,thread_source:'subagent'});
    f.add({id:'normal',title:'Guardian review',updated_at:1,thread_source:'app'});
    assert.deepEqual(f.reader.list().map(row=>row.id),['normal']);
  } finally {f.close();}
});

test('缺少来源字段的旧索引不凭标题误删会话',()=>{
  const f=fixture();
  try {
    f.add({id:'normal',title:'Guardian review',updated_at:1});
    assert.deepEqual(f.reader.list().map(row=>row.id),['normal']);
  } finally {f.close();}
});

test('保留已命名的新会话及消息索引滞后的聊天，搜索和分页使用显示名称',()=>{
  const f=fixture(['name','has_user_event','first_user_message']);
  try {
    f.add({id:'placeholder',title:'',name:'手机目标验收（专用）',updated_at:5,has_user_event:0,first_user_message:''});
    f.add({id:'renamed',title:'真实消息',name:'新的名称',updated_at:4,has_user_event:0,first_user_message:'真实消息'});
    f.add({id:'message-only',title:'',updated_at:3,has_user_event:0,first_user_message:'已有输入'});
    f.add({id:'event-only',title:'',updated_at:2,has_user_event:1,first_user_message:''});
    const before=f.db.prepare('SELECT * FROM threads ORDER BY id').all();
    assert.deepEqual(f.reader.list().map(row=>row.id),['placeholder','renamed','message-only','event-only']);
    assert.equal(f.reader.list({search:'手机目标验收'})[0].id,'placeholder');
    assert.equal(f.reader.list({search:'新的名称'})[0].id,'renamed');
    assert.equal(f.reader.list({limit:1})[0].id,'placeholder');
    assert.equal(f.reader.list({limit:1,offset:1})[0].id,'renamed');
    assert.deepEqual(f.db.prepare('SELECT * FROM threads ORDER BY id').all(),before);
  } finally {f.close();}
});
