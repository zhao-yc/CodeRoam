import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { withDesktopUi } from './desktop-ui-coordinator.mjs';
import { sharedNativeDesktop } from './native-desktop.mjs';

/** 原生确认目标会话已打开后才提交已读，不把系统启动当作切换成功。 */
export function openDesktopThread(threadId,{platform=process.platform,nativeApi,isCurrent=()=>true}={}) {
  return withDesktopUi(async()=>{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId))throw new BridgeError('BAD_THREAD_ID','会话编号无效');
    if(platform!=='win32')throw new BridgeError('DESKTOP_LOAD_UNSUPPORTED','当前电脑暂不支持加载桌面会话');
    if(!isCurrent())throw new BridgeError('SUBSCRIPTION_CANCELED','会话已切换，已取消旧的电脑导航');
    await (nativeApi??sharedNativeDesktop()).navigate(threadId,isCurrent);
  });
}
