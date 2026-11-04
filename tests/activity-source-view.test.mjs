import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {StateReader} from '../apps/bridge/state-reader.mjs';
import {DesktopAdapter} from '../apps/bridge/desktop-adapter.mjs';

/** 只创建独立的合成索引和JSONL，保留真实SQLite及路径安全路径。 */
function fixture(t,count=3,{wal=false}={}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'source-view-')),sessions=path.join(directory,'sessions');fs.mkdirSync(sessions);
  const db=new DatabaseSync(path.join(directory,'state_5.sqlite'));
  if(wal)db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT,cwd TEXT,updated_at INTEGER,updated_at_ms INTEGER,rollout_path TEXT,archived INTEGER DEFAULT 0)');
  const ids=Array.from({length:count},(_,i)=>'synthetic-'+i),files=new Map();
  for(const [index,id] of ids.entries()) {
    const file=path.join(sessions,id+'.jsonl');files.set(id,file);
    fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:index===0?'task_started':'task_complete',turn_id:'turn'}})+'\n');
    db.prepare('INSERT INTO threads(id,title,name,cwd,updated_at,updated_at_ms,rollout_path) VALUES (?,?,?,?,?,?,?)').run(id,'合成标题 '+index,index===0?'合成显示名':null,'/workspace/synthetic',index,1000+index,file);
  }
  const reader=new StateReader(directory),views=new Set(),createView=reader.historySourceView.bind(reader);
  reader.historySourceView=ids=>{const view=createView(ids);views.add(view);return view;};
  t.after(()=>{for(const view of views)view.close();db.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,sessions,db,ids,files,reader};
}

test('五十条后台来源共享一个SQLite连接和一次schema读取，指纹与单条新鲜读取完全相同',t=>{
  const f=fixture(t,50),expected=f.ids.map(id=>f.reader.historyCacheSource(id));
  const prepare=DatabaseSync.prototype.prepare,close=DatabaseSync.prototype.close,stat=fs.statSync;
  const connections=new Set();let schemas=0,closed=0,stats=0;
  t.mock.method(DatabaseSync.prototype,'prepare',function(sql,...args){connections.add(this);if(sql.startsWith('PRAGMA table_info'))schemas++;return prepare.call(this,sql,...args);});
  t.mock.method(DatabaseSync.prototype,'close',function(){closed++;return close.call(this);});
  t.mock.method(fs,'statSync',(...args)=>{if(String(args[0]).endsWith('.jsonl'))stats++;return stat(...args);});
  const view=f.reader.historySourceView([...f.ids,...f.ids]);
  assert.deepEqual(f.ids.map(id=>view.source(id)),expected);
  assert.equal(connections.size,1);assert.equal(schemas,1);assert.equal(closed,0);assert.equal(stats,50);
  assert.equal([...connections][0].isTransaction,false);
  assert.deepEqual(f.ids.map(id=>view.source(id)),expected);assert.equal(stats,50);
  assert.deepEqual(view.activity(f.ids[0]),{status:'active',turnId:'turn'});
  view.close();view.close();assert.equal(closed,1);
  assert.throws(()=>view.source(f.ids[0]),error=>error.code==='HISTORY_UNAVAILABLE');
});

test('本轮后台快照不能替代交互成员核验，归档和删除后的显式读取仍即时拒绝',t=>{
  const f=fixture(t),id=f.ids[0],view=f.reader.historySourceView(f.ids);assert.ok(view.source(id));
  f.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(id);
  assert.throws(()=>view.source(id),error=>error.code==='THREAD_NOT_FOUND');
  assert.throws(()=>view.activity(id),error=>error.code==='THREAD_NOT_FOUND');
  assert.equal(f.reader.containsThread(id),false);
  assert.throws(()=>f.reader.historyRow(id),error=>error.code==='THREAD_NOT_FOUND');
  assert.throws(()=>f.reader.historyCacheSource(id),error=>error.code==='THREAD_NOT_FOUND');
  assert.throws(()=>f.reader.readHistory(id),error=>error.code==='THREAD_NOT_FOUND');
  assert.throws(()=>f.reader.historySourceView(f.ids).source(id),error=>error.code==='THREAD_NOT_FOUND');
  f.db.prepare('DELETE FROM threads WHERE id=?').run(f.ids[1]);
  assert.throws(()=>f.reader.historySourceView(f.ids).activity(f.ids[1]),error=>error.code==='THREAD_NOT_FOUND');
  assert.throws(()=>view.source('unknown'),error=>error.code==='THREAD_NOT_FOUND');
});

test('来源批次仍拒绝目录外文件、非JSONL以及逃逸目录连接，活动尾读核验真实会话身份',t=>{
  const f=fixture(t),id=f.ids[0],outside=path.join(f.directory,'outside');fs.mkdirSync(outside);
  const wrong=path.join(outside,'wrong.jsonl');fs.writeFileSync(wrong,JSON.stringify({type:'session_meta',payload:{id}})+'\n');
  f.db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(wrong,id);
  assert.equal(f.reader.historySourceView([id]).source(id),'');
  assert.throws(()=>f.reader.historySourceView([id]).activity(id),error=>error.code==='HISTORY_UNAVAILABLE');
  const text=path.join(f.sessions,'not-history.txt');fs.writeFileSync(text,'合成内容');f.db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(text,id);
  assert.equal(f.reader.historySourceView([id]).source(id),'');
  f.db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(f.files.get(f.ids[1]),id);
  assert.throws(()=>f.reader.historySourceView([id]).activity(id),error=>error.code==='HISTORY_UNAVAILABLE');
  const link=path.join(f.sessions,'escape');
  try{fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');}
  catch(error){if(['EPERM','EACCES'].includes(error.code)){t.diagnostic('当前环境禁止目录连接，其他越界和身份检查已验证');return;}throw error;}
  f.db.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(path.join(link,'wrong.jsonl'),id);
  assert.equal(f.reader.historySourceView([id]).source(id),'');
});

test('活动查询只对没有可信live状态的目标开一份来源批次，并共享并发读取',async t=>{
  const f=fixture(t,6),client=new EventEmitter();client.close=()=>{};client.assertCurrent=()=>{};client.allowedClients=new Set(['owner']);
  const adapter=new DesktopAdapter({client,index:f.reader,attachments:{},goalController:{available:false}});t.after(()=>adapter.close());
  const live=(id,state,owner='owner')=>adapter.conversations.set(id,{owner:{clientId:owner},state:{id,...state},watchers:new Set(),waiters:[]});
  live(f.ids[0],{threadRuntimeStatus:{type:'idle'},turns:[{status:'inProgress'}],turnHistory:{history:{islands:[{entries:[{value:'latest'}]}],entitiesByKey:{latest:{status:'completed'}}}}});
  live(f.ids[1],{threadRuntimeStatus:{type:'idle',activeFlags:['waitingOnApproval']}});
  live(f.ids[2],{requests:[{request:{method:'item/tool/requestUserInput'}}]});
  live(f.ids[3],{turns:[{status:'inProgress'}]},'other-owner');
  live(f.ids[4],{});
  const original=f.reader.historySourceView.bind(f.reader);let batches=0,requested;
  f.reader.historySourceView=ids=>{batches++;requested=ids;return original(ids);};
  const rows=f.reader.list({limit:50});
  const [one,two]=await Promise.all([adapter.readActivityInventory({rows}),adapter.readActivityInventory({rows})]);
  assert.deepEqual(one,two);assert.equal(one.complete,false);assert.equal(batches,1);
  assert.deepEqual(requested,[f.ids[5],f.ids[3]]);
  assert.deepEqual(new Set(one.threadIds),new Set([f.ids[1],f.ids[2]]));
  await adapter.readActivityInventory({rows});assert.equal(batches,2);
});

test('来源不变不重复解析活动，索引新鲜变化后才重新读尾部，失败不保留旧活动猜测',async t=>{
  const f=fixture(t,2),client=new EventEmitter();client.close=()=>{};
  const adapter=new DesktopAdapter({client,index:f.reader,attachments:{},goalController:{available:false}});t.after(()=>adapter.close());
  const original=f.reader.historySourceView.bind(f.reader);let parses=0;
  f.reader.historySourceView=ids=>{const view=original(ids);return {source:id=>view.source(id),activity:id=>{parses++;return view.activity(id);},close:()=>view.close()};};
  assert.deepEqual((await adapter.readActivityInventory()).threadIds,[f.ids[0]]);assert.equal(parses,2);
  await adapter.readActivityInventory();assert.equal(parses,2);
  fs.appendFileSync(f.files.get(f.ids[0]),JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'turn'}})+'\n');
  assert.deepEqual((await adapter.readActivityInventory()).threadIds,[]);assert.equal(parses,3);
  fs.rmSync(f.files.get(f.ids[1]));assert.deepEqual((await adapter.readActivityInventory()).threadIds,[]);
});

test('真实WAL外部提交后原view立即看见归档删除，不依赖mtime或重开连接',async t=>{
  const f=fixture(t,3,{wal:true}),id=f.ids[0],stat=fs.statSync,first=stat(f.reader.filePath,{bigint:true});
  t.mock.method(fs,'statSync',(...args)=>{const value=stat(...args);if(args[0]===f.reader.filePath){value.mtimeNs=first.mtimeNs;value.mtimeMs=first.mtimeMs;}return value;});
  const view=f.reader.historySourceView(f.ids),source=view.source(id);
  await new Promise(resolve=>setImmediate(resolve));
  f.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(id);
  assert.throws(()=>view.source(id),error=>error.code==='THREAD_NOT_FOUND');
  assert.throws(()=>view.activity(id),error=>error.code==='THREAD_NOT_FOUND');
  f.db.prepare('UPDATE threads SET archived=0,name=? WHERE id=?').run('外部新名称',id);
  assert.notEqual(view.source(id),source);
  f.db.prepare('DELETE FROM threads WHERE id=?').run(f.ids[1]);
  assert.throws(()=>view.source(f.ids[1]),error=>error.code==='THREAD_NOT_FOUND');
});

test('source计算期间发生真实提交时重查行，不返回刚被归档的旧指纹',t=>{
  const f=fixture(t,1,{wal:true}),id=f.ids[0],view=f.reader.historySourceView(f.ids),stat=fs.statSync;let committed=false;
  t.mock.method(fs,'statSync',(...args)=>{
    const value=stat(...args);
    if(args[0]===f.files.get(id)&&!committed){committed=true;f.db.prepare('UPDATE threads SET archived=1 WHERE id=?').run(id);}
    return value;
  });
  assert.throws(()=>view.source(id),error=>error.code==='THREAD_NOT_FOUND');assert.equal(committed,true);
});

test('数据库dev或ino变化即拒绝当前view，close幂等且不靠mtime识别替换',t=>{
  const f=fixture(t,1),view=f.reader.historySourceView(f.ids),stat=fs.statSync;
  assert.ok(view.source(f.ids[0]));
  t.mock.method(fs,'statSync',(...args)=>{const value=stat(...args);if(args[0]===f.reader.filePath)value.ino+=1n;return value;});
  assert.throws(()=>view.source(f.ids[0]),error=>error.code==='HISTORY_UNAVAILABLE');
  assert.throws(()=>view.activity(f.ids[0]),error=>error.code==='HISTORY_UNAVAILABLE');
  assert.doesNotThrow(()=>{view.close();view.close();});
});

test('外部持续提交导致data_version不能稳定时有界返回未知',t=>{
  const f=fixture(t,1,{wal:true}),prepare=DatabaseSync.prototype.prepare;let changing=false,commits=0;
  t.mock.method(DatabaseSync.prototype,'prepare',function(sql,...args){
    const statement=prepare.call(this,sql,...args);
    if(sql!=='PRAGMA data_version')return statement;
    return {get(){const value=statement.get();if(changing){f.db.prepare('UPDATE threads SET updated_at=updated_at+1 WHERE id=?').run(f.ids[0]);commits++;}return value;}};
  });
  const view=f.reader.historySourceView(f.ids);changing=true;
  assert.throws(()=>view.source(f.ids[0]),error=>error.code==='HISTORY_UNAVAILABLE');
  assert.ok(commits>1&&commits<=10);changing=false;assert.ok(view.source(f.ids[0]));
});

test('adapter活动轮次无论完成或中途停止都关闭本轮view',async t=>{
  const f=fixture(t,2),client=new EventEmitter();client.close=()=>{};
  const adapter=new DesktopAdapter({client,index:f.reader,attachments:{},goalController:{available:false}});t.after(()=>adapter.close());
  const original=f.reader.historySourceView.bind(f.reader);let closes=0;
  f.reader.historySourceView=ids=>{const view=original(ids);return {source:id=>view.source(id),activity:id=>view.activity(id),close(){closes++;view.close();}};};
  await adapter.readActivityInventory();assert.equal(closes,1);
  const reading=adapter.readActivityInventory();adapter.stopped=true;await reading;assert.equal(closes,2);
});
