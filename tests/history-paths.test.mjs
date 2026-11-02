import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readHistoricalSnapshot} from '../apps/bridge/history-reader.mjs';

/** 复现 Codex 索引中的 Windows 长路径，不修改真实索引与会话。 */
test('Windows 长路径前缀可读取，普通路径和长路径得到相同的只读历史', {skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codex-history-path-'));
  const file=path.join(root,'历史会话.jsonl');
  try {
    fs.writeFileSync(file,[{type:'session_meta',payload:{id:'thread'}},{type:'event_msg',payload:{type:'user_message',message:'已有消息'}}].map(JSON.stringify).join('\n')+'\n');
    const row={id:'thread',title:'标题',cwd:root,updatedAt:123,rollout_path:file};
    const normal=readHistoricalSnapshot(row,root);
    for(const sessionDirectory of [root,path.toNamespacedPath(root)]) {
      const snapshot=readHistoricalSnapshot({...row,rollout_path:path.toNamespacedPath(file)},sessionDirectory);
      assert.deepEqual(snapshot,normal);assert.equal(snapshot.readOnly,true);assert.equal(snapshot.messages[0].text,'已有消息');
    }
    assert.throws(()=>readHistoricalSnapshot({...row,id:'other',rollout_path:path.toNamespacedPath(file)},root),error=>error.code==='HISTORY_ID_MISMATCH');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('原生真实路径解析仍拒绝链接跳出 sessions 目录，兼容 Windows 长路径',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'codex-history-boundary-'));
  const sessions=path.join(directory,'sessions'),outside=path.join(directory,'outside');
  fs.mkdirSync(sessions);fs.mkdirSync(outside);
  try {
    const file=path.join(outside,'thread.jsonl');fs.writeFileSync(file,JSON.stringify({type:'session_meta',payload:{id:'thread'}})+'\n');
    const link=path.join(sessions,'link');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
    for(const rollout_path of [file,path.join(link,'thread.jsonl'),path.toNamespacedPath(path.join(link,'thread.jsonl'))]) {
      assert.throws(()=>readHistoricalSnapshot({id:'thread',rollout_path},sessions),error=>error.code==='HISTORY_UNAVAILABLE');
    }
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
