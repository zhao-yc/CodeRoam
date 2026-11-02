import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {StateReader} from '../apps/bridge/state-reader.mjs';

/** 用独立索引、归档源会话及投影库复现分叉历史，不访问实际桌面数据。 */
function fixture() {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'codex-projected-history-'));
  fs.mkdirSync(path.join(home,'sessions'));fs.mkdirSync(path.join(home,'archived_sessions'));
  const index=new DatabaseSync(path.join(home,'state_5.sqlite'));
  index.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,rollout_path TEXT,updated_at INTEGER,archived INTEGER)');
  const db=new DatabaseSync(path.join(home,'thread_history_1.sqlite'));
  db.exec('CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,item_json TEXT,item_type TEXT,updated_at_ordinal INTEGER);CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,error_json TEXT,duration_ms INTEGER,rollout_end_ordinal INTEGER)');
  function session(id,metadata={},archived=0) {
    const file=path.join(home,archived?'archived_sessions':'sessions',id+'.jsonl');
    fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id,history_mode:'paginated',...metadata}})+'\n');
    index.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?)').run(id,'合成会话','',file,1,archived);
    return file;
  }
  function item(thread,id,ordinal,{type='agentMessage',text=id,turn='turn',updated=ordinal,...extra}={}) {
    const value={id,type,text,...extra};
    db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)').run(thread,turn,id,ordinal,JSON.stringify(value),type,updated);
  }
  return {home,index,db,session,item,reader:new StateReader(home),close(){db.close();index.close();fs.rmSync(home,{recursive:true});}};
}

test('报告读取越过最近消息窗口，继承记录遵守分叉边界且报告身份必须匹配',()=>{
  const f=fixture();try{
    f.session('parent',{},1);f.session('child',{history_base:{thread_id:'parent',end_ordinal_exclusive:200}});
    f.item('parent','edit',1,{type:'fileChange',status:'completed',changes:[{path:'src/demo.uts',kind:{type:'update'},diff:'@@ -1 +1 @@\n-old\n+new\n'}]});
    for(let i=2;i<150;i++)f.item('parent','cmd-'+i,i,{type:'commandExecution'});
    f.item('parent','report',150,{phase:'final_answer'});f.item('parent','later',210,{phase:'final_answer'});
    const report=f.reader.readHistory('child',{rawTurns:true,reportId:'report'});
    assert.equal(report.sourceTurns[0].items[0].id,'edit');assert.equal(report.sourceTurns[0].items.at(-1).id,'report');
    assert.throws(()=>f.reader.readHistory('child',{rawTurns:true,reportId:'cmd-3'}),/不是任务报告/);
    const missing=f.reader.readHistory('child',{rawTurns:true,reportId:'later'});assert.equal(missing.sourceTurns.some(turn=>turn.items.some(item=>item.id==='later')),false);
  }finally{f.close();}
});

test('分叉分页从归档源会话定位早期消息，跨源连续翻页且不带入分叉后的内容',()=>{
  const f=fixture();try {
    const parent=f.session('parent',{},1),child=f.session('child',{forked_from_id:'parent',history_base:{thread_id:'parent',end_ordinal_exclusive:180}});
    for(let i=0;i<200;i++)f.item('parent','p-'+i,i);
    f.item('parent','future-update',100,{updated:190,text:'源会话后来更改的内容'});
    for(let i=180;i<200;i++)f.item('child','c-'+i,i);
    f.db.prepare('INSERT INTO thread_turns VALUES(?,?,?,?,?,?)').run('parent','turn','completed',null,1234,190);
    const before=[fs.readFileSync(parent,'utf8'),fs.readFileSync(child,'utf8')];
    const first=f.reader.readHistory('child',{page:true,beforeMessageId:'p-150'});
    assert.deepEqual(first.messages.map(m=>m.id),Array.from({length:80},(_,i)=>'p-'+(70+i)));
    assert.equal(first.turns[0].status,'');assert.equal(first.turns[0].durationMs,undefined);
    const second=f.reader.readHistory('child',{page:true,before:first.cursor});
    assert.deepEqual(second.messages.map(m=>m.id),Array.from({length:70},(_,i)=>'p-'+i));assert.equal(second.hasMore,false);
    let cursor='',more=true;const pages=[];
    for(let n=0;more&&n<10;n++){const page=f.reader.readHistory('child',{page:true,before:cursor});pages.unshift(...page.messages.map(m=>m.id));cursor=page.cursor;more=page.hasMore;}
    assert.equal(more,false);assert.deepEqual(pages,[...Array.from({length:180},(_,i)=>'p-'+i),...Array.from({length:20},(_,i)=>'c-'+(180+i))]);
    assert.deepEqual([fs.readFileSync(parent,'utf8'),fs.readFileSync(child,'utf8')],before);
    assert.throws(()=>f.reader.readHistory('parent',{page:true}),e=>e.code==='THREAD_NOT_FOUND');
  }finally{f.close();}
});

test('多层继承取最小边界，同序号按编号翻页，正文有大小限制且排除内部内容',()=>{
  const f=fixture();try {
    f.session('grandparent',{},1);f.session('parent',{history_base:{thread_id:'grandparent',end_ordinal_exclusive:100}},1);
    f.session('child',{history_base:{thread_id:'parent',end_ordinal_exclusive:50}});
    f.item('grandparent','early',10);f.item('grandparent','too-late',60);f.item('parent','parent-late',55);
    for(let i=0;i<90;i++)f.item('child','m-'+String(i).padStart(3,'0'),200,{text:'正文'.repeat(6000)});
    f.item('child','hidden',201,{phase:'analysis',text:'内部推理'});f.item('child','reason',202,{type:'reasoning',text:'内部推理'});
    let before='',hasMore=true;const messages=[];
    for(let n=0;n<20&&hasMore;n++) {
      const page=f.reader.readHistory('child',{page:true,before});
      assert.ok(page.messages.reduce((sum,m)=>sum+m.text.length,0)<=120000);
      messages.unshift(...page.messages.map(m=>m.id));hasMore=page.hasMore;before=page.cursor;
    }
    assert.equal(hasMore,false);assert.deepEqual(messages,['early',...Array.from({length:90},(_,i)=>'m-'+String(i).padStart(3,'0'))]);
  }finally{f.close();}
});

test('投影游标拒绝其他会话、无关来源及越过分叉边界，继承循环和目录越界也拒绝',()=>{
  const f=fixture();try {
    f.session('parent',{},1);f.session('child',{history_base:{thread_id:'parent',end_ordinal_exclusive:50}});f.session('other');
    for(let i=0;i<90;i++)f.item('parent','p-'+i,i);
    const first=f.reader.readHistory('child',{page:true});
    // 继承仅有五十条，构造合法格式的游标来验证权限边界。
    const valid={storage:'projection',threadId:'child',source:'parent',ordinal:20,itemId:'p-20'};
    for(const change of [{threadId:'other'},{source:'other'},{ordinal:50},{ordinal:-1}]) {
      const before=Buffer.from(JSON.stringify({...valid,...change})).toString('base64url');
      assert.throws(()=>f.reader.readHistory('child',{page:true,before}),e=>e.code==='BAD_HISTORY_CURSOR');
    }
    assert.equal(first.hasMore,false);
    const childFile=path.join(f.home,'sessions/child.jsonl');
    const outside=path.join(f.home,'outside.jsonl');fs.writeFileSync(outside,fs.readFileSync(childFile));
    f.index.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(outside,'child');
    assert.throws(()=>f.reader.readHistory('child',{page:true}),e=>e.code==='HISTORY_UNAVAILABLE');
    f.index.prepare('UPDATE threads SET rollout_path=? WHERE id=?').run(childFile,'child');
    fs.writeFileSync(path.join(f.home,'archived_sessions/parent.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'parent',history_base:{thread_id:'child',end_ordinal_exclusive:30}}})+'\n');
    assert.throws(()=>f.reader.readHistory('child',{page:true}),e=>e.code==='HISTORY_UNAVAILABLE');
  }finally{f.close();}
});
