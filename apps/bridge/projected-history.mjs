import fs from 'node:fs';
import {CONVERSATION_PAGE_SIZE, CONVERSATION_PAGE_BYTES} from './conversation-page.mjs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {BridgeError} from '../../packages/protocol/contracts.mjs';
import {isFinalAssistantReply,normalizeConversation} from './conversation.mjs';
import {projectedTurnMetadata} from './turn-failure.mjs';

// 方案是独立的可见项目，不能仅查询普通回复；保留原编号以复用历史分页游标。
const visibleTypes=['userMessage','steeringUserMessage','userInputResponse','agentMessage','assistantMessage','plan','planImplementation','imageGeneration','commandExecution','fileChange'];

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
    if(record.type!=='session_meta'||record.payload?.id!==row.id)throw new BridgeError('HISTORY_ID_MISMATCH','历史记录与当前聊天不匹配');
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
      if(!current)throw new BridgeError('HISTORY_UNAVAILABLE','未找到这条聊天继承的早期记录');
    }
    return sources;
  }finally{index.close();}
}

/** 新版历史库使用独立游标，客户端不能指定源会话、文件路径或越过分叉边界。 */
export function isProjectedCursor(value) {
  try{return JSON.parse(Buffer.from(value,'base64url').toString('utf8')).storage==='projection';}catch{return false;}
}

/** 报告按明确最终回复定位完整轮次，不受手机最近 80 条消息窗口影响，继承边界沿用历史读取规则。 */
export function readProjectedFileReport(row,home,reportId) {
  const file=path.join(home,'thread_history_1.sqlite');
  if(!fs.existsSync(file))return null;
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    db.exec('BEGIN');
    const sources=historySources(row,home);
    for(const source of sources.reverse()){
      const target=db.prepare('SELECT turn_id,item_json,rollout_ordinal FROM thread_items WHERE thread_id=? AND item_id=? AND rollout_ordinal<? AND updated_at_ordinal<?').get(source.id,reportId,source.limit,source.limit);
      if(!target)continue;
      const final=JSON.parse(target.item_json);
      if(final.id!==reportId||!isFinalAssistantReply(final))throw new BridgeError('REPORT_NOT_FOUND','指定消息不是任务报告');
      const records=db.prepare(`SELECT item_json FROM thread_items WHERE thread_id=? AND turn_id=? AND rollout_ordinal<=? AND updated_at_ordinal<? AND item_type IN (${visibleTypes.map(()=>'?').join(',')}) ORDER BY rollout_ordinal,item_id LIMIT 2001`).all(source.id,target.turn_id,target.rollout_ordinal,source.limit,...visibleTypes);
      if(records.length>2000||records.reduce((size,item)=>size+Buffer.byteLength(item.item_json),0)>8*1024*1024)throw new BridgeError('REPORT_TOO_LARGE','这份报告的记录过多，请在电脑端查看');
      return {cwd:row.cwd,sourceTurns:[{turnId:target.turn_id,items:records.map(record=>JSON.parse(record.item_json))}]};
    }
    return null;
  }finally{db.close();}
}

/** 只读新版可见项目投影，兼容分叉与压缩；旧版无投影时继续使用原日志分页。 */
export function readProjectedHistory(row, home, {before='',beforeMessageId='',imageMessageId,imageIndex,executionMessageId}={}) {
  const file=path.join(home,'thread_history_1.sqlite'),continuing=isProjectedCursor(before);
  if(before&&!continuing)return null;
  if(!fs.existsSync(file)) {
    if(continuing)throw new BridgeError('BAD_HISTORY_CURSOR','历史游标已失效，请重新打开聊天');
    return null;
  }
  const db=new DatabaseSync(file,{readOnly:true});
  try {
    const columns=new Set(db.prepare('PRAGMA table_info(thread_items)').all().map(column=>column.name));
    if(!['thread_id','turn_id','item_id','rollout_ordinal','item_json','item_type','updated_at_ordinal'].every(name=>columns.has(name))) {
      if(continuing)throw new BridgeError('BAD_HISTORY_CURSOR','历史游标已失效，请重新打开聊天');
      return null;
    }
    // 在同一个只读事务中定位消息和翻页，避免并发投影更新使边界前后不一致。
    db.exec('BEGIN');
    const sources=historySources(row,home);
    // 图片按明确消息编号定位，不受最近一页窗口影响，沿用继承边界。
    if(imageMessageId || executionMessageId) {
      for(const source of [...sources].reverse()) {
        const saved=db.prepare('SELECT turn_id,item_json FROM thread_items WHERE thread_id=? AND item_id=? AND rollout_ordinal<? AND updated_at_ordinal<?').get(source.id,executionMessageId ?? imageMessageId,source.limit,source.limit);
        if(!saved)continue;
        const item=JSON.parse(saved.item_json);
        if(item.id!==(executionMessageId ?? imageMessageId)||!visibleTypes.includes(item.type)||executionMessageId&&!['commandExecution','fileChange'].includes(item.type))return {messages:[]};
        return normalizeConversation({id:row.id,turns:[{turnId:saved.turn_id,items:[item]}]},{imageMessageId,imageIndex,executionMessageId});
      }
      return executionMessageId ? {messages:[]} : null;
    }
    const turnColumns=new Set(db.prepare('PRAGMA table_info(thread_turns)').all().map(column=>column.name));
    let sourceIndex=sources.length-1,ordinal=Number.MAX_SAFE_INTEGER,itemId='';
    if(continuing) {
      const cursor=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));
      sourceIndex=sources.findIndex(source=>source.id===cursor.source);
      if(cursor.threadId!==row.id||sourceIndex<0||!Number.isSafeInteger(cursor.ordinal)||cursor.ordinal<0||typeof cursor.itemId!=='string'||cursor.itemId.length>1000||cursor.ordinal>=sources[sourceIndex].limit)
        throw new BridgeError('BAD_HISTORY_CURSOR','历史游标无效，请重新打开聊天');
      ordinal=cursor.ordinal;itemId=cursor.itemId;
    }else if(beforeMessageId) {
      let anchor;
      for(let i=sources.length-1;i>=0;i--) {
        anchor=db.prepare('SELECT rollout_ordinal,item_id FROM thread_items WHERE thread_id=? AND item_id=? AND rollout_ordinal<? AND updated_at_ordinal<?').get(sources[i].id,beforeMessageId,sources[i].limit,sources[i].limit);
        if(anchor){sourceIndex=i;ordinal=anchor.rollout_ordinal;itemId=anchor.item_id;break;}
      }
      if(!anchor)return null;
    }else if(!sources.some(source=>db.prepare('SELECT 1 FROM thread_items WHERE thread_id=? AND rollout_ordinal<? LIMIT 1').get(source.id,source.limit)||db.prepare(`SELECT 1 FROM thread_turns WHERE thread_id=? AND ${turnColumns.has('rollout_ordinal')?'rollout_ordinal':'rollout_end_ordinal'}<? LIMIT 1`).get(source.id,source.limit)))return null;
    const timingColumns=['started_at_ms','completed_at_ms'].filter(name=>columns.has(name));
    const query=db.prepare(`SELECT turn_id,item_id,rollout_ordinal,item_json${timingColumns.map(name=>','+name).join('')} FROM thread_items WHERE thread_id=? AND rollout_ordinal<? AND updated_at_ordinal<? AND (rollout_ordinal<? OR (rollout_ordinal=? AND item_id<?)) AND item_type IN (${visibleTypes.map(()=>'?').join(',')}) ORDER BY rollout_ordinal DESC,item_id DESC LIMIT 81`);
    const turns=db.prepare('SELECT * FROM thread_turns WHERE thread_id=? AND turn_id=?');
    // 新版有起始位置；旧版按项目位置或结束位置定位没有消息的失败轮次。
    const turnPosition=`COALESCE(${turnColumns.has('rollout_ordinal')?'t.rollout_ordinal,':''}(SELECT MIN(i.rollout_ordinal) FROM thread_items i WHERE i.thread_id=t.thread_id AND i.turn_id=t.turn_id),t.rollout_end_ordinal)`;
    const failureQuery=db.prepare(`SELECT t.*,${turnPosition} AS position FROM thread_turns t WHERE t.thread_id=? AND ${turnPosition}>=? AND ${turnPosition}<? AND ${turnPosition}<? ORDER BY position`);
    const messages=[],turnInfo=new Map(),turnPositions=new Map();let bytes=0,cursor='',hasMore=false;
    if(!before&&!beforeMessageId){
      const latestQuery=db.prepare(`SELECT t.*,${turnPosition} AS position FROM thread_turns t WHERE t.thread_id=? AND ${turnPosition}<? ORDER BY ${turnPosition} DESC,t.turn_id DESC LIMIT 1`);
      for(const source of [...sources].reverse()){
        const latest=latestQuery.get(source.id,source.limit);
        if(latest){turnInfo.set(latest.turn_id,projectedTurnMetadata(latest,latest.turn_id,source.limit));turnPositions.set(latest.turn_id,[sources.indexOf(source),latest.position]);break;}
      }
    }
    // 限制每次查询和页面正文大小；隐藏项目也推进位置，不能卡在不可见记录上。
    for(let scanned=0;sourceIndex>=0&&scanned<16;scanned++) {
      const source=sources[sourceIndex],upper=ordinal,rows=query.all(source.id,source.limit,source.limit,ordinal,ordinal,itemId,...visibleTypes);
      for(const saved of rows) {
        const item=JSON.parse(saved.item_json);
        const savedTurn=turns.get(source.id,saved.turn_id),metadata=projectedTurnMetadata(savedTurn,saved.turn_id,source.limit);
        const status=metadata.status;
        // 只给投影确认的末条回复附上生成区间，翻页时不会把整轮计时分给中间消息。
        if(savedTurn?.final_agent_item_id===item.id && isFinalAssistantReply(item)) {
          item.startedAtMs=saved.started_at_ms;
          item.completedAtMs=saved.completed_at_ms;
        }
        // 仅转换明确的可见项目，禁止把推理、内部提示或未知结构当正文。
        const normalized=item.id===saved.item_id&&visibleTypes.includes(item.type)&&item.phase!=='analysis'&&item.channel!=='analysis'
          ?normalizeConversation({id:row.id,turns:[{turnId:saved.turn_id,status,durationMs:metadata.durationMs,items:[item]}]},{preserveDialogue:false,executionDetails:false}).messages[0]:null;
        const size=normalized?Buffer.byteLength(JSON.stringify(normalized)):0;
        if(normalized&&messages.length&&(messages.length>=CONVERSATION_PAGE_SIZE||bytes+size>CONVERSATION_PAGE_BYTES)){hasMore=true;break;}
        ordinal=saved.rollout_ordinal;itemId=saved.item_id;
        cursor=Buffer.from(JSON.stringify({storage:'projection',threadId:row.id,source:source.id,ordinal,itemId})).toString('base64url');
        if(normalized){messages.unshift(normalized);bytes+=size;turnInfo.set(saved.turn_id,metadata);turnPositions.set(saved.turn_id,[sourceIndex,savedTurn?.rollout_ordinal??saved.rollout_ordinal]);}
      }
      // 只附带当前翻页范围内的失败，不能把游标之后的轮次混进早期历史。
      for(const saved of failureQuery.all(source.id,rows.length===81||hasMore?ordinal:0,upper,source.limit)){
        const metadata=projectedTurnMetadata(saved,saved.turn_id,source.limit);
        if(['failed','interrupted'].includes(metadata.status)){turnInfo.set(saved.turn_id,metadata);turnPositions.set(saved.turn_id,[sourceIndex,saved.position]);}
      }
      if(hasMore)break;
      if(rows.length===81)continue;
      sourceIndex--;ordinal=Number.MAX_SAFE_INTEGER;itemId='';
    }
    if(sourceIndex>=0)hasMore=true;
    const orderedTurns=[...turnInfo.values()].sort((left,right)=>{const a=turnPositions.get(left.turnId),b=turnPositions.get(right.turnId);return a[0]-b[0]||a[1]-b[1];});
    return {messages,turns:orderedTurns,hasMore,cursor:hasMore?cursor:''};
  }catch(error){
    if(error instanceof BridgeError)throw error;
    const failure=new BridgeError('HISTORY_UNAVAILABLE','读取早期记录失败，请稍后重试');failure.cause=error;throw failure;
  }finally{db.close();}
}
