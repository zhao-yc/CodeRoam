import {BridgeError} from '../../packages/protocol/contracts.mjs';

/** 原生工具与会话流必须属于同一桌面进程，多实例时不能按枚举顺序猜测。 */
export function selectNativeEndpoint({candidates=[],ipcProcessId=null}={},preferredPath='') {
  const valid=candidates.filter(entry=>/^\\\\\.\\pipe\\codex-app-tools-[0-9a-f-]+$/i.test(entry?.path)&&Number.isSafeInteger(entry.pid)&&entry.pid>0);
  let matches;
  if(Number.isSafeInteger(ipcProcessId)&&ipcProcessId>0)matches=valid.filter(entry=>entry.pid===ipcProcessId);
  else {
    matches=valid.filter(entry=>entry.path===preferredPath);
    if(!matches.length){const visible=valid.filter(entry=>entry.hasWindow===true);matches=visible.length?visible:valid;}
  }
  if(matches.length!==1)throw new BridgeError('DESKTOP_NATIVE_UNAVAILABLE','无法确定会话所属的桌面实例，请确认电脑连接后重试');
  return matches[0];
}
