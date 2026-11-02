import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { withDesktopUi } from './desktop-ui-coordinator.mjs';
import { sharedNativeDesktop } from './native-desktop.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);

/** Windows 原生确认后提交已读；Mac 用固定会话链接导航，调用方仍须核对所有者和快照。 */
export function openDesktopThread(threadId,{platform=process.platform,nativeApi,isCurrent=()=>true,launch=execute}={}) {
  return withDesktopUi(async()=>{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId))throw new BridgeError('BAD_THREAD_ID','会话编号无效');
    if(!['win32','darwin'].includes(platform))throw new BridgeError('DESKTOP_LOAD_UNSUPPORTED','当前电脑暂不支持加载桌面会话');
    if(!isCurrent())throw new BridgeError('SUBSCRIPTION_CANCELED','会话已切换，已取消旧的电脑导航');
    if(platform==='darwin') {
      // 只传递校验过的会话编号，不允许手机拼接提示词、程序、路径或额外参数。
      try { await launch('/usr/bin/open',['-b','com.openai.codex',`codex://threads/${threadId}`],{timeout:5000,maxBuffer:4096}); }
      catch { throw new BridgeError('DESKTOP_LOAD_FAILED','无法打开 Mac 桌面会话，请确认 Codex 已安装并正在运行'); }
      if(!isCurrent())throw new BridgeError('SUBSCRIPTION_CANCELED','会话已切换，已忽略旧的电脑导航');
      return;
    }
    await (nativeApi??sharedNativeDesktop()).navigate(threadId,isCurrent);
  });
}
