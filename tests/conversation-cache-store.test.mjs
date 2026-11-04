import test from 'node:test';
import assert from 'node:assert/strict';
import {Journal} from '../apps/bridge/journal.mjs';
import {ConversationCacheStore} from '../apps/bridge/conversation-cache-store.mjs';
import {conversationProjection,conversationContentRevision} from '../apps/bridge/conversation-prefetch.mjs';
import {CACHE_PERSISTENCE_INTERVAL_MS} from '../apps/bridge/cache-persistence.mjs';

const source=(id='a',text='合成正文')=>({threadId:id,title:'合成缓存会话',cwd:'/synthetic/example',messages:[{id:'message',role:'assistant',text,turnId:'turn',status:'inProgress'}],turns:[{turnId:'turn',status:'inProgress'}],status:'active',activeTurnId:'turn',approvals:[{id:'不应缓存的目标'}]});

/** 真实内存 SQLite 配合虚拟时钟，定时窗口测试不等待现实时间，也不访问原桌面。 */
function fixture(t,options={}) {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const journal=new Journal(),members=new Set(),blocked=new Set(),missing=[];
  const store=new ConversationCacheStore({db:journal.db,visible:ids=>new Set(ids.filter(id=>members.has(id))),blocked:id=>blocked.has(id),onMissing:id=>missing.push(id),...options});
  t.after(()=>{store.close();journal.close();});
  return {store,db:journal.db,members,blocked,missing,stage(value,savedSource){members.add(value.threadId);return store.stage(value,savedSource);},disk:id=>journal.db.prepare('SELECT * FROM conversation_cache WHERE thread_id=?').get(id),changes:()=>journal.db.prepare('SELECT total_changes() AS count').get().count};
}

test('stage和RAM读取立即可用且不查库，来源未知不伪造，canonical版本兼容既有helper',t=>{
  const f=fixture(t),original=f.db.prepare.bind(f.db);let queries=0;
  t.mock.method(f.db,'prepare',(...args)=>{queries++;return original(...args);});
  const value=source(),result=f.stage(value);value.messages[0].text='调用方后来的改动';
  assert.equal(queries,0);assert.equal(result.revision,conversationContentRevision(source()));assert.deepEqual(result.snapshot,conversationProjection(source()));assert.equal(result.baseRevision,undefined);
  assert.equal(f.store.metadata('a').saved_source,undefined);assert.equal(f.store.metadata('a').source,undefined);assert.equal(JSON.parse(f.store.row('a').snapshot).messages[0].text,'合成正文');assert.equal(f.store.baseline('a',result.revision).messages[0].text,'合成正文');assert.equal(queries,0);
  assert.equal(Object.hasOwn(result.snapshot,'approvals'),false);assert.equal(f.store.intervalMs,CACHE_PERSISTENCE_INTERVAL_MS);
});

test('1500毫秒固定首窗不被热更新延后，只写最新正文',t=>{
  const f=fixture(t);f.stage(source('a','首段'));const deadline=f.store.deadline;
  t.mock.timers.tick(1000);f.stage(source('a','最新段'));assert.equal(f.store.deadline,deadline);assert.equal(f.disk('a'),undefined);
  t.mock.timers.tick(499);assert.equal(f.disk('a'),undefined);t.mock.timers.tick(1);
  assert.equal(JSON.parse(f.disk('a').snapshot).messages[0].text,'最新段');assert.equal(f.store.pending.size,0);assert.equal(f.store.timer,null);
});

test('终态子集立即flush，不重置其他dirty原截止点',t=>{
  const f=fixture(t);f.stage(source('a'));t.mock.timers.tick(300);f.stage(source('b'));const timer=f.store.timer,deadline=f.store.deadline;
  t.mock.timers.tick(400);assert.equal(f.store.flush(['a']),true);assert.ok(f.disk('a'));assert.equal(f.disk('b'),undefined);assert.equal(f.store.timer,timer);assert.equal(f.store.deadline,deadline);
  t.mock.timers.tick(799);assert.equal(f.disk('b'),undefined);t.mock.timers.tick(1);assert.ok(f.disk('b'));assert.equal(f.store.pending.size,0);
});

test('事务失败不抛且RAM仍可用，整个批次回滚，下一窗口重试',t=>{
  const f=fixture(t),prepare=f.db.prepare.bind(f.db);let fail=true;
  t.mock.method(f.db,'prepare',sql=>{const statement=prepare(sql);return sql.startsWith('INSERT INTO conversation_cache')?{run(...args){if(args[0]==='b'&&fail){fail=false;throw Error('合成磁盘失败');}return statement.run(...args);}}:statement;});
  f.stage(source('a'));f.stage(source('b'));t.mock.timers.tick(1500);
  assert.equal(f.disk('a'),undefined);assert.equal(f.disk('b'),undefined);assert.equal(f.store.pending.size,2);assert.equal(JSON.parse(f.store.row('b').snapshot).threadId,'b');
  t.mock.timers.tick(1499);assert.equal(f.disk('a'),undefined);t.mock.timers.tick(1);assert.ok(f.disk('a'));assert.ok(f.disk('b'));assert.equal(f.store.pending.size,0);
});

test('失败或未知visible拒写但保留dirty，missing先forget且通知异常不影响其他目标',t=>{
  const f=fixture(t);f.stage(source('a'));f.stage(source('b'));f.store.visible=()=>null;assert.equal(f.store.flush(),false);assert.equal(f.store.pending.size,2);assert.equal(f.disk('a'),undefined);
  f.store.visible=()=>{throw Error('合成成员核验不可用');};assert.equal(f.store.flush(),false);
  f.store.visible=()=>new Set(['b']);f.store.onMissing=id=>{f.missing.push(id);assert.equal(f.store.records.has(id),false);assert.equal(f.store.pending.has(id),false);throw Error('合成上层通知失败');};
  assert.equal(f.store.flush(),true);assert.deepEqual(f.missing,['a']);assert.equal(f.store.row('a'),undefined);assert.ok(f.disk('b'));
});

test('forget先取消待写，visible回调内删除也不能被捕获的旧批次回灌',t=>{
  const f=fixture(t);f.stage(source('a'));assert.equal(f.store.forget('a'),true);t.mock.timers.tick(3000);assert.equal(f.disk('a'),undefined);assert.deepEqual(f.missing,[]);
  f.stage(source('a','再次合成'));f.store.visible=ids=>{f.store.forget('a');return new Set(ids);};assert.equal(f.store.flush(),true);assert.equal(f.disk('a'),undefined);assert.equal(f.store.pending.size,0);
});

test('成功只清同一待写版本，核验回调中产生的新stage仍保留',t=>{
  const f=fixture(t);f.stage(source('a','旧合成'));let once=true;
  f.store.visible=ids=>{if(once){once=false;f.stage(source('a','新合成'));}return new Set(ids);};
  assert.equal(f.store.flush(),true);assert.equal(f.store.pending.size,1);assert.equal(f.disk('a'),undefined);t.mock.timers.tick(1500);assert.equal(JSON.parse(f.disk('a').snapshot).messages[0].text,'新合成');
});

test('数据库已保存旧版本后发生新stage，提交成功也不能清掉新pending',t=>{
  const f=fixture(t),prepare=f.db.prepare.bind(f.db);let once=true;
  t.mock.method(f.db,'prepare',sql=>{const statement=prepare(sql);return sql.startsWith('INSERT INTO conversation_cache')?{run(...args){const result=statement.run(...args);if(once){once=false;f.stage(source('a','写入期间的新合成'));}return result;}}:statement;});
  f.stage(source('a','本轮捕获的合成'));assert.equal(f.store.flush(),true);assert.equal(JSON.parse(f.disk('a').snapshot).messages[0].text,'本轮捕获的合成');assert.equal(f.store.pending.size,1);
  t.mock.timers.tick(1500);assert.equal(JSON.parse(f.disk('a').snapshot).messages[0].text,'写入期间的新合成');assert.equal(f.store.pending.size,0);
});

test('RAM只留相邻两版，baseline独立且可回查磁盘两版，SQL内部保留已落盘前版',t=>{
  const f=fixture(t),a=f.stage(source('a','甲'));f.store.flush();const b=f.stage(source('a','乙')),c=f.stage(source('a','丙'));
  assert.equal(c.baseRevision,b.revision);assert.equal(c.baseSnapshot.messages[0].text,'乙');assert.equal(f.store.baseline('a',a.revision).messages[0].text,'甲');
  const clone=f.store.baseline('a',b.revision);clone.messages[0].text='修改独立副本';assert.equal(f.store.baseline('a',b.revision).messages[0].text,'乙');
  f.store.flush();assert.equal(f.disk('a').revision,c.revision);assert.equal(f.disk('a').previous_revision,a.revision);assert.equal(f.store.row('a').previous_revision,b.revision);
  f.stage(source('a','丁'));assert.equal(f.store.baseline('a',b.revision),undefined);assert.equal(f.store.baseline('a',a.revision).messages[0].text,'甲');
});

test('同版本不写盘，仅source变化更新来源，首次stage不读DB且flush才继承磁盘source',t=>{
  const f=fixture(t);const first=f.stage(source(),'source-one');f.store.flush();const after=f.changes();
  f.stage({...source(),updatedAt:999,status:'idle'},'source-one');assert.equal(f.store.flush(),true);assert.equal(f.changes(),after);assert.equal(f.disk('a').previous_revision,null);
  f.stage(source(),'source-two');f.store.flush();assert.equal(f.changes(),after+1);assert.equal(f.disk('a').previous_revision,null);
  f.store.trimClean();const unknown=f.stage(source());assert.equal(unknown.revision,first.revision);assert.equal(f.store.metadata('a').source,undefined);const before=f.changes();f.store.flush();assert.equal(f.store.metadata('a').source,'source-two');assert.equal(f.changes(),before);
});

test('容量20且超限只淘汰展示副本，不触发归档通知，单条超过512KiB拒绝',t=>{
  const f=fixture(t);for(let i=0;i<21;i++)f.stage(source('id-'+i));assert.equal(f.store.records.size,20);assert.equal(f.store.pending.size,20);assert.equal(f.store.row('id-0'),undefined);f.store.flush();assert.equal(f.db.prepare('SELECT count(*) AS count FROM conversation_cache').get().count,20);
  f.stage(source('new-id'));f.store.flush();assert.ok(f.disk('new-id'));assert.equal(f.db.prepare('SELECT count(*) AS count FROM conversation_cache').get().count,20);assert.deepEqual(f.missing,[]);
  assert.equal(f.stage(source('oversized','合'.repeat(180000))),undefined);assert.equal(f.store.records.has('oversized'),false);
});

test('暂停自动持久化但允许显式terminal，trimClean保留dirty，恢复重新建立固定窗',t=>{
  const f=fixture(t);f.stage(source('a'));f.stage(source('b'));f.store.setPaused(true);t.mock.timers.tick(5000);assert.equal(f.disk('a'),undefined);assert.equal(f.store.timer,null);
  assert.equal(f.store.flush(['a']),true);f.store.trimClean();assert.equal(f.store.records.has('a'),false);assert.equal(f.store.records.has('b'),true);assert.equal(f.store.pending.size,1);assert.equal(f.store.timer,null);
  f.store.setPaused(false);t.mock.timers.tick(1499);assert.equal(f.disk('b'),undefined);t.mock.timers.tick(1);assert.ok(f.disk('b'));
});

test('blocked只暂停待写不猜测归档，删除SQL失败时三种读取均不能回读旧DB',t=>{
  const f=fixture(t);f.stage(source());f.store.flush();f.stage(source('a','新合成'));f.blocked.add('a');assert.equal(f.store.flush(),false);assert.equal(f.store.pending.size,1);assert.equal(f.store.stage(source('a')),undefined);
  f.blocked.delete('a');const prepare=f.db.prepare.bind(f.db);let fail=true;t.mock.method(f.db,'prepare',sql=>{if(sql.startsWith('DELETE FROM conversation_cache WHERE thread_id=?')&&fail)throw Error('合成删除失败');return prepare(sql);});
  assert.equal(f.store.forget('a'),false);assert.equal(f.store.row('a'),undefined);assert.equal(f.store.metadata('a'),undefined);assert.equal(f.store.baseline('a',conversationContentRevision(source())),undefined);assert.ok(f.disk('a'));assert.equal(f.store.pending.size,0);
  fail=false;f.stage(source('a','重新核验后的新合成'),'fresh-source');assert.ok(f.store.row('a'));assert.equal(f.store.flush(),true);assert.equal(JSON.parse(f.disk('a').snapshot).messages[0].text,'重新核验后的新合成');
});

test('失败删除屏障最多128个，超限后拒绝磁盘回退而不是无界保存编号',t=>{
  const f=fixture(t),prepare=f.db.prepare.bind(f.db);t.mock.method(f.db,'prepare',sql=>{if(sql.startsWith('DELETE FROM conversation_cache WHERE thread_id=?'))throw Error('合成删除失败');return prepare(sql);});
  for(let i=0;i<140;i++)f.store.forget('id-'+i);assert.equal(f.store.deleteBarriers.size,128);assert.equal(f.store.diskFallbackBlocked,true);assert.equal(f.store.row('id-0'),undefined);
});

test('DB完全不可用时RAM仍可stage/row/baseline，close失败也无残留timer且幂等',t=>{
  const f=fixture(t);t.mock.method(f.db,'prepare',()=>{throw Error('合成数据库不可用');});t.mock.method(f.db,'exec',()=>{throw Error('合成数据库不可用');});
  const current=f.stage(source());assert.ok(f.store.row('a'));assert.equal(f.store.baseline('a',current.revision).messages.length,1);assert.equal(f.store.flush(),false);assert.equal(f.store.pending.size,1);
  assert.equal(f.store.close(),false);assert.equal(f.store.timer,null);assert.equal(f.store.records.size,0);assert.equal(f.store.pending.size,0);assert.equal(f.store.close(),false);t.mock.timers.tick(5000);assert.equal(f.store.stage(source()),undefined);
});

test('close立即保存最后dirty并只执行一次，关闭后不再持有正文或定时器',t=>{
  const f=fixture(t);f.stage(source('a','关闭前合成'));assert.equal(f.store.close(),true);assert.equal(JSON.parse(f.disk('a').snapshot).messages[0].text,'关闭前合成');
  const changes=f.changes();assert.equal(f.store.close(),true);t.mock.timers.tick(10000);assert.equal(f.changes(),changes);assert.equal(f.store.timer,null);assert.equal(f.store.records.size,0);
});
