/** 发送前按本次选择校对模式，防止旧计划快照或电脑设置让下一条意外继承计划。 */
export async function preparePlanForSend(adapter,params,deviceId,commandId) {
  const current=await adapter.readSettings(params.threadId,deviceId);
  if(current.settings.mode!==params.planMode)await adapter.operate('thread.settings.update',{threadId:params.threadId,changes:{mode:params.planMode}},commandId+':plan-prepare',deviceId);
}

/** 消息已接收后仅恢复下一轮模式；失败作为独立结果返回，绝不重发正文。 */
export async function resetPlanAfterSend(adapter,threadId,deviceId,commandId) {
  try {
    await adapter.watch(threadId,deviceId,{fresh:true,history:false});
    const current=await adapter.readSettings(threadId,deviceId);
    if(current.settings.mode==='default')return {planReset:true,nextSettings:current.settings};
    const reset=await adapter.operate('thread.settings.update',{threadId,changes:{mode:'default'}},commandId+':plan-reset',deviceId);
    if(reset.settings?.mode!=='default')throw new Error('普通模式尚未确认');
    return {planReset:true,nextSettings:reset.settings};
  }catch{
    return {planReset:false,planResetError:'消息已发送，恢复普通模式尚未确认，请重试恢复；请勿重复发送消息。'};
  }
}
