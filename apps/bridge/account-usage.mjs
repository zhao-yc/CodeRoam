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

/** 仅提取接口公开的登录邮箱或登录方式，不透传账号对象和凭据。 */
export function normalizeAccountLabel(response) {
  const account=response?.account;
  if(account===null)return '未登录';
  if(account?.type==='apiKey')return 'API Key 登录';
  if(account?.type!=='chatgpt'||typeof account.email!=='string')return '';
  const email=account.email.trim();
  return email.length<=254&&!/[\u0000-\u001f\u007f<>]/.test(email)&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)?email:'';
}

/** 同一受控短连接并行读取账号和额度，各自失败不抹掉另一项；不主动刷新登录。 */
export async function readAccountUsage(service) {
  try {
    return await service.creation.run(service.codexHome,async request=>{
      const [usage,account]=await Promise.allSettled([
        request('account/rateLimits/read',{}),request('account/read',{refreshToken:false}),
      ]);
      return {...normalizeAccountUsage(usage.status==='fulfilled'?usage.value:null),accountLabel:account.status==='fulfilled'?normalizeAccountLabel(account.value):''};
    });
  } catch {return {available:false,windows:[],accountLabel:''};}
}
