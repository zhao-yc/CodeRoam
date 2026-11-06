/** 详情和后台缓存共用消息窗口的排序、替换和文本追加。 */
export function messageWindowUpdate(beforeMessages, messages) {
  const old=new Map(beforeMessages.map(message=>[message.id,message]));
  const upserts=[],appends=[];
  for(const message of messages){
    const before=old.get(message.id);
    if(before&&JSON.stringify(before)===JSON.stringify(message))continue;
    // 耗时等展示字段可能在正文结束后才到达，变化时需要替换消息。
    if(before&&message.role===before.role&&message.kind===before.kind&&message.summary===before.summary&&message.phase===before.phase&&message.workedMs===before.workedMs&&message.imageCount===before.imageCount&&message.detailRevision===before.detailRevision&&message.turnId===before.turnId&&typeof message.text==='string'&&typeof before.text==='string'&&message.text.startsWith(before.text))appends.push({id:message.id,text:message.text.slice(before.text.length),status:message.status});
    else upserts.push(message);
  }
  return {order:messages.map(message=>message.id),upserts,appends};
}

/** 只传输新增消息和增长的文本，避免每个输出片段重复发送整段历史。 */
export function conversationUpdate(previous, snapshot) {
  if(!previous)return {kind:'snapshot',snapshot};
  const {messages,...metadata}=snapshot;
  const delta={kind:'delta',baseSeq:previous.seq,update:{...metadata,...messageWindowUpdate(previous.snapshot.messages,messages)}};
  return JSON.stringify(delta).length<JSON.stringify(snapshot).length?delta:{kind:'snapshot',snapshot};
}

/** 验收工具重建同样的时间线；基础游标不一致时要求重取快照。 */
export function applyConversationUpdate(current, event) {
  if(event.snapshot)return {snapshot:event.snapshot,epoch:event.epoch,seq:event.seq};
  if(event.kind!=='delta'||!current||current.epoch!==event.epoch||current.seq!==event.baseSeq)return null;
  const messages=new Map(current.snapshot.messages.map(message=>[message.id,{...message}]));
  for(const message of event.update.upserts)messages.set(message.id,message);
  for(const append of event.update.appends){const message=messages.get(append.id);if(!message)return null;message.text+=append.text;message.status=append.status;}
  const {order,upserts,appends,...metadata}=event.update;
  return {snapshot:{...metadata,messages:order.map(id=>messages.get(id))},epoch:event.epoch,seq:event.seq};
}
