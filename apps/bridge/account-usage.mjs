/** 只输出真实账户窗口的剩余百分比，未知、无限额或无效数据都不伪造额度。 */
export function normalizeAccountUsage(response) {
  const limits=response?.rateLimitsByLimitId;
  const selected=limits?.codex ?? response?.rateLimits;
  const windows=[];
  for(const value of [selected?.primary,selected?.secondary]) {
    if(typeof value?.usedPercent!=='number'||!Number.isFinite(value.usedPercent)||value.usedPercent<0||value.usedPercent>100||!Number.isFinite(value.windowDurationMins)||value.windowDurationMins<=0)continue;
    const minutes=value.windowDurationMins;
    windows.push({label:minutes===10080?'本周':minutes===300?'5 小时':minutes>=1440?`${Math.round(minutes/1440)} 天`:`${minutes} 分钟`,remainingPercent:Math.floor(100-value.usedPercent)});
  }
  return {available:windows.length>0,windows};
}

/** 复用受控本机短连接读取额度，不读取或透传鉴权文件，不启动执行轮次。 */
export async function readAccountUsage(service) {
  try {return normalizeAccountUsage(await service.creation.run(service.codexHome,request=>request('account/rateLimits/read',{})));}
  catch {return {available:false,windows:[]};}
}
