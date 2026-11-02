import path from 'node:path';
import {AsarReader} from '../../packages/protocol/asar-reader.mjs';
import {BridgeError} from '../../packages/protocol/contracts.mjs';
import {threadMentionModules} from './thread-mention-modules.mjs';

/** 只从已核验安装包解析原生入口；导出名变化时重新定位，不复制或修改桌面代码。 */
export function nativeDraftModules(executable) {
  const windows = /[\\/]WindowsApps[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/](?:ChatGPT|Codex)\.exe$/i.test(executable ?? '');
  const mac = /\.app\/Contents\/MacOS\/(?:Codex|ChatGPT)$/i.test(executable ?? '');
  if (!windows && !mac) throw new BridgeError('DRAFT_UNSUPPORTED','当前桌面版本暂不支持原生新建草稿');
  const archive = windows ? path.join(path.dirname(executable),'resources/app.asar') : path.resolve(path.dirname(executable),'../Resources/app.asar');
  const reader = new AsarReader(archive);
  try {
    const names = [...reader.files.keys()].filter(name => /^webview\/assets\/app-initial-[a-f0-9]+\.js$/.test(name));
    if (names.length !== 1) throw Error();
    const source = reader.text(names[0]);
    const exported = (name,body=source) => {
      const exports=body.slice(body.lastIndexOf('export{'));
      const value = exports.match(new RegExp('(?<=[{,])'+name.replaceAll('$','\\$')+' as ([\\w$]+)(?=[,}])'))?.[1];
      if (!value) throw Error();
      return value;
    };
    const marker = source.indexOf('freshDraft:');
    if (marker < 0) throw Error();
    const start = source.lastIndexOf('function ',marker), end = source.indexOf('function ',marker);
    const entry = source.slice(start,end), name = entry.match(/^function ([\w$]+)\(/)?.[1];
    const draftAtom = entry.match(/\.get\(([\w$]+),[\w$]+\)/)?.[1];
    const location = entry.match(/sitePreviewDraft==null\?([\w$]+)\(\{entrypoint:/)?.[1];
    const routeAtom = entry.match(/\.get\(([\w$]+)\)\.prepareNavigation/)?.[1];
    const promotionMarker = source.indexOf('preserveSidebarIdentity:e.get(');
    const promotion = source.slice(source.lastIndexOf('function ',promotionMarker),promotionMarker);
    const promotionAtom = promotion.match(/\.get\(([\w$]+),[\w$]+\)!==/)?.[1];
    if (![name,draftAtom,location,routeAtom,promotionAtom].every(Boolean)) throw Error();
    const primaryNames=[...reader.files.keys()].filter(name=>/^webview\/assets\/app-primary-[a-f0-9]+\.js$/.test(name));
    if(primaryNames.length!==1)throw Error();
    const primary=reader.text(primaryNames[0]);
    const permissionModes=source.match(/function ([\w$]+)\(\{isConfigDataPending:[^)]{0,1800}hasAuthoritativeGuardianApprovalDefault:[^)]*\)/)?.[1];
    const permissionWorkspaceMode=source.match(/function ([\w$]+)\(\{isProjectless:[\w$]+,requirements:[\w$]+\}\)\{return[^}]{0,300}`granular`[^}]{0,100}`auto`/ )?.[1];
    const keyMarker=source.indexOf('permission-selection-by-host-id:');
    const keyFunction=source.slice(source.lastIndexOf('function ',keyMarker),keyMarker).match(/^function ([\w$]+)\(/)?.[1];
    const remember=keyFunction&&source.match(new RegExp('function ([\\w$]+)\\([\\w$]+,[\\w$]+\\)\\{[\\w$]+\\('+keyFunction.replaceAll('$','\\$')+'\\('))?.[1];
    const submitMarker=primary.indexOf('clearDraftAttachments:');
    const registration=primary.slice(Math.max(0,submitMarker-1200),submitMarker).match(/([\w$]+)\([\w$]+,\{submit:/)?.[1];
    const registerStart=registration?primary.indexOf('function '+registration+'('):-1;
    const nativeSubmitAtom=registerStart<0?null:primary.slice(registerStart,registerStart+1000).match(/\.set\(([\w$]+),[\w$]+\)/)?.[1];
    if(![permissionModes,permissionWorkspaceMode,remember,nativeSubmitAtom].every(Boolean))throw Error();
    // 引用模块不兼容时保留原有无引用草稿能力，发送引用时再明确拒绝。
    let threadMentions;
    try { threadMentions=threadMentionModules(executable); } catch {}
    return {initial:path.posix.basename(names[0]),primary:path.posix.basename(primaryNames[0]),newChat:exported(name),draftAtom:exported(draftAtom),draftLocation:exported(location),routeAtom:exported(routeAtom),promotionAtom:exported(promotionAtom),permissionModes:exported(permissionModes),permissionWorkspaceMode:exported(permissionWorkspaceMode),rememberPermissionSelection:exported(remember),nativeSubmitAtom:exported(nativeSubmitAtom,primary),...(threadMentions?{threadMentions}:{})};
  } catch { throw new BridgeError('DRAFT_UNSUPPORTED','原生新建草稿接口暂不兼容，请更新电脑连接服务'); }
  finally { reader.close(); }
}
