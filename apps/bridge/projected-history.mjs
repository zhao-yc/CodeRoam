import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {BridgeError} from '../../packages/protocol/contracts.mjs';
import {normalizeConversation} from './conversation.mjs';

const visibleTypes=['userMessage','steeringUserMessage','userInputResponse','agentMessage','assistantMessage','commandExecution','fileChange'];

/** 只从索引指定的会话文件读取继承关系；归档源会话也必须位于受控目录并匹配身份。 */
function sessionMetadata(row, home, inherited) {
  let fd;
  try {
    const file=fs.realpathSync.native(row.rollout_path);
    const roots=[path.join(home,'sessions'),...(inherited?[path.join(home,'archived_sessions')]:[])];
    if(!file.endsWith('.jsonl')||!roots.some(root=>{
      if(!fs.existsSync(root))return false;
      const relative=path.relative(fs.realpathSync.native(root),file);
      return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative);
    }))throw new BridgeError('HISTORY_UNAVAILABLE','历史记录路径不受支持');
    fd=fs.openSync(file,'r');
    const header=Buffer.alloc(Math.min(fs.fstatSync(fd).size,256*1024));fs.readSync(fd,header,0,header.length,0);
    const record=JSON.parse(header.toString('utf8').split('\n')[0]);
    if(record.type!=='session_meta'||record.payload?.id!==row.id)throw new BridgeError('HISTORY_ID_MISMATCH','历史记录与当前会话不匹配');
    return record.payload;
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}

/** 分叉关系只接受本机已保存的元数据，并逐层收紧继承上限，拒绝循环和未知来源。 */
function historySources(row, home) {
  const index=new DatabaseSync(path.join(home,'state_5.sqlite'),{readOnly:true});
  const sources=[],seen=new Set();let current=row,limit=Number.MAX_SAFE_INTEGER;
  try {
    while(current) {
      if(seen.has(current.id)||sources.length>=16)throw new BridgeError('HISTORY_UNAVAILABLE','历史继承关系无效');
      seen.add(current.id);
      const metadata=sessionMetadata(current,home,sources.length>0);
      sources.unshift({id:current.id,limit});
      const base=metadata.history_base;
      if(!base||base.thread_id===current.id)break;
      if(typeof base.thread_id!=='string'||!Number.isSafeInteger(base.end_ordinal_exclusive)||base.end_ordinal_exclusive<0||
        (metadata.forked_from_id&&metadata.forked_from_id!==base.thread_id))throw new BridgeError('HISTORY_UNAVAILABLE','历史继承边界无效');
      limit=Math.min(limit,base.end_ordinal_exclusive);
      current=index.prepare('SELECT id,rollout_path FROM threads WHERE id=?').get(base.thread_id);
      if(!current)throw new BridgeError('HISTORY_UNAVAILABLE','未找到这条会话继承的早期记录');
    }
    return sources;
  }finally{index.close();}
}

/** 新版历史库使用独立游标，客户端不能指定源会话、文件路径或越过分叉边界。 */
export function isProjectedCursor(value) {
  try{return JSON.parse(Buffer.from(value,'base64url').toString('utf8')).storage==='projection';}catch{return false;}
}

/** 只读新版可见项目投影，兼容分叉与压缩；旧版无投影时继续使用原日志分页。 */
export function readProjectedHistory(row, home, {before='',beforeMessageId=''}={}) {
  const file=path.join(home,'thread_history_1.sqlite'),continuing=isProjectedCursor(before);
  if(before&&!continuing)return null;
  if(!fs.existsSync(file)) {
    if(continuing)throw new BridgeError('BAD_HISTORY_CURSOR','历史游标已失效，请重新打开会话');
    return null;
  }
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    const columns=new Set(db.prepare('PRAGMA table_info(thread_items)').all().map(column=>column.name));
    if(!['thread_id','turn_id','item_id','rollout_ordinal','item_json','item_type','updated_at_ordinal'].every(name=>columns.has(name))) {
      if(continuing)throw new BridgeError('BAD_HISTORY_CURSOR','历史游标已失效，请重新打开会话');
      return null;
    }
    // 在同一个只读事务中定位消息和翻页，避免并发投影更新使边界前后不一致。
    db.exec('BEGIN');
    const sources=historySources(row,home);
    let sourceIndex=sources.length-1,ordinal=Number.MAX_SAFE_INTEGER,itemId='';
    if(continuing) {
      const cursor=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));
      sourceIndex=sources.findIndex(source=>source.id===cursor.source);
      if(cursor.threadId!==row.id||sourceIndex<0||!Number.isSafeInteger(cursor.ordinal)||cursor.ordinal<0||typeof cursor.itemId!=='string'||cursor.itemId.length>1000||cursor.ordinal>=sources[sourceIndex].limit)
        throw new BridgeError('BAD_HISTORY_CURSOR','历史游标无效，请重新打开会话');
      ordinal=cursor.ordinal;itemId=cursor.itemId;
    }else if(beforeMessageId) {
      let anchor;
      for(let i=sources.length-1;i>=0;i--) {
        anchor=db.prepare('SELECT rollout_ordinal,item_id FROM thread_items WHERE thread_id=? AND item_id=? AND rollout_ordinal<? AND updated_at_ordinal<?').get(sources[i].id,beforeMessageId,sources[i].limit,sources[i].limit);
        if(anchor){sourceIndex=i;ordinal=anchor.rollout_ordinal;itemId=anchor.item_id;break;}
      }
      if(!anchor)return null;
    }else if(!sources.some(source=>db.prepare('SELECT 1 FROM thread_items WHERE thread_id=? AND rollout_ordinal<? LIMIT 1').get(source.id,source.limit)))return null;
    const query=db.prepare(`SELECT turn_id,item_id,rollout_ordinal,item_json FROM thread_items WHERE thread_id=? AND rollout_ordinal<? AND updated_at_ordinal<? AND (rollout_ordinal<? OR (rollout_ordinal=? AND item_id<?)) AND item_type IN (${visibleTypes.map(()=>'?').join(',')}) ORDER BY rollout_ordinal DESC,item_id DESC LIMIT 81`);
    const turns=db.prepare('SELECT status,error_json,duration_ms,rollout_end_ordinal FROM thread_turns WHERE thread_id=? AND turn_id=?');
    const messages=[],turnInfo=new Map();let characters=0,cursor='',hasMore=false;
    // 限制每次查询和页面正文大小；隐藏项目也推进位置，不能卡在不可见记录上。
    for(let scanned=0;sourceIndex>=0&&scanned<16;scanned++) {
      const source=sources[sourceIndex],rows=query.all(source.id,source.limit,source.limit,ordinal,ordinal,itemId,...visibleTypes);
      for(const saved of rows) {
        const item=JSON.parse(saved.item_json);
        const turn=turns.get(source.id,saved.turn_id),complete=turn&&Number.isSafeInteger(turn.rollout_end_ordinal)&&turn.rollout_end_ordinal<source.limit;
        const status=complete?(turn.error_json?'failed':turn.status):'';
        // 仅转换明确的可见项目，禁止把推理、内部提示或未知结构当正文。
        const normalized=item.id===saved.item_id&&visibleTypes.includes(item.type)&&item.phase!=='analysis'&&item.channel!=='analysis'
          ?normalizeConversation({id:row.id,turns:[{turnId:saved.turn_id,status,items:[item]}]},{preserveDialogue:false}).messages[0]:null;
        if(normalized&&(messages.length>=80||characters+normalized.text.length>120000)){hasMore=true;break;}
        ordinal=saved.rollout_ordinal;itemId=saved.item_id;
        cursor=Buffer.from(JSON.stringify({storage:'projection',threadId:row.id,source:source.id,ordinal,itemId})).toString('base64url');
        if(normalized){messages.unshift(normalized);characters+=normalized.text.length;turnInfo.set(saved.turn_id,{turnId:saved.turn_id,status,...(complete&&Number.isFinite(turn.duration_ms)&&turn.duration_ms>=0?{durationMs:turn.duration_ms}:{})});}
      }
      if(hasMore)break;
      if(rows.length===81)continue;
      sourceIndex--;ordinal=Number.MAX_SAFE_INTEGER;itemId='';
    }
    if(sourceIndex>=0)hasMore=true;
    return {messages,turns:[...turnInfo.values()].reverse(),hasMore,cursor:hasMore?cursor:''};
  }catch(error){
    if(error instanceof BridgeError)throw error;
    const failure=new BridgeError('HISTORY_UNAVAILABLE','读取早期记录失败，请稍后重试');failure.cause=error;throw failure;
  }finally{db.close();}
}
