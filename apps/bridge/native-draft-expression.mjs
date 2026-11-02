/** 所有动作仅作用于原桌面的可见原生草稿；手机不能传入脚本、模块或本机地址。 */
async function operateNativeDraft(modules, action, input) {
  const initial = await import('app://-/assets/'+modules.initial);
  const fail = code => { throw Error(code); };
  const roots = () => [...document.querySelectorAll('[data-codex-composer-root]')].filter(element => {
    if (element.getBoundingClientRect().width <= 0) return false;
    for (let ancestor=element;ancestor;ancestor=ancestor.parentElement) if (ancestor.hidden || ancestor.inert || ancestor.getAttribute('aria-hidden')==='true') return false;
    return true;
  });
  const fiber = element => element?.[Object.keys(element).find(key=>key.startsWith('__reactFiber$'))];
  const findStore = root => {
    for (let current=fiber(root),depth=0;current && depth<200;current=current.return,depth++) {
      for (let hook=current.memoizedState,n=0;hook && n<100;hook=hook.next,n++) {
        const values=[hook.memoizedState?.current,...(Array.isArray(hook.memoizedState)?hook.memoizedState:[])];
        for (const value of values) if (value?.node && value.chain && typeof value.get==='function' && typeof value.set==='function') return value;
      }
    }
    return null;
  };
  const root = roots();
  if (root.length!==1) fail('DRAFT_WINDOW_AMBIGUOUS');
  const store=findStore(root[0]);
  if (!store) fail('DRAFT_UNSUPPORTED');
  if (action==='capabilities') return {supported:typeof initial[modules.newChat]==='function',focused:document.hasFocus()};
  const draftId = () => store.get(initial[modules.draftAtom],initial[modules.draftLocation]({entrypoint:'home'}));
  const route = () => store.get(initial[modules.routeAtom]);
  const commands=window.__codexMobileNativeDraftCommands ??= new Map();
  if (action==='open') {
    const previous=commands.get(input.commandId);
    if (previous) return {clientDraftId:previous.clientDraftId};
    initial[modules.newChat](store,{activeProject:{projectKind:'local',projectId:input.projectId},prefillLocalExecution:true,prefillComposerMode:'local',selectChat:true});
    const id=draftId();
    if (typeof id!=='string' || !id.startsWith('client-new-thread:')) fail('DRAFT_NOT_READY');
    commands.set(input.commandId,{kind:'open',clientDraftId:id});
    return {clientDraftId:id};
  }
  const promoted=store.get(initial[modules.promotionAtom],input.clientDraftId);
  if (typeof promoted==='string' && /^[a-f0-9-]{36}$/i.test(promoted)) return {status:'promoted',threadId:promoted};
  if (route()?.pathname!=='/' || draftId()!==input.clientDraftId) return {status:'detached'};
  const activeRoot=roots()[0], properties=[],stack=[fiber(activeRoot)];
  for(let n=0;stack.length && n<6000;n++) {
    const current=stack.pop(); if(!current)continue;
    if(current.child)stack.push(current.child);
    if(current.sibling && current!==fiber(activeRoot))stack.push(current.sibling);
    if(current.memoizedProps && typeof current.memoizedProps==='object')properties.push(current.memoizedProps);
  }
  const pick=predicate=>{const values=properties.filter(predicate);return values[0]??null;};
  const power=pick(p=>p.modelListConfig?.options && Array.isArray(p.powerSelections) && typeof p.onSelectPower==='function');
  const composer=pick(p=>typeof p.onSubmitLocal==='function' && typeof p.setSelectedCollaborationMode==='function');
  if(!power || !composer)fail('DRAFT_NOT_READY');
  const project=composer.selectedProject;
  if(project?.id!==input.projectId && project?.projectId!==input.projectId)fail('DRAFT_PROJECT_CHANGED');
  const normalizePath=value=>{const normalized=String(value).replaceAll('\\','/').replace(/\/+$/,'');return /^[a-z]:/i.test(normalized)?normalized.toLowerCase():normalized;};
  const destination=pick(props=>props.currentLocalExecutionHostId==='local'&&typeof props.currentLocalExecutionCwd==='string');
  if(input.projectCwd!==undefined && (!destination||normalizePath(destination.currentLocalExecutionCwd)!==normalizePath(input.projectCwd)))fail('DRAFT_PROJECT_CHANGED');
  const selected=power.selectedPowerSelection??power.selectedLabelCandidate;
  if(!selected?.model)fail('DRAFT_NOT_READY');
  const catalogs=[];
  const collect=(value,depth=0)=>{
    if(!value || depth>4)return;
    if(Array.isArray(value)){if(value.some(item=>typeof item?.model==='string' && Array.isArray(item.supportedReasoningEfforts)))catalogs.push(value);else for(const item of value)collect(item,depth+1);}
    else if(typeof value==='object')for(const [key,item] of Object.entries(value))if(['data','models','pages','result'].includes(key))collect(item,depth+1);
  };
  for(const query of store.queryClient.getQueryCache().getAll())if(JSON.stringify(query.queryKey).toLowerCase().includes('model'))collect(query.state.data);
  const visible=power.modelListConfig.options.filter(option=>!option.disabled && !option.isLocked);
  const catalog=catalogs.find(items=>visible.every(option=>items.some(item=>item.model===option.id)));
  if(!catalog)fail('DRAFT_CATALOG_UNAVAILABLE');
  const speeds=(power.serviceTierOptions??[]).map(option=>({id:option.value??'',label:option.value==null?'常速':option.value==='priority'?'快速':String(option.label?.defaultMessage??option.value),description:String(option.description?.defaultMessage??'')}));
  const models=visible.map(option=>{
    const item=catalog.find(item=>item.model===option.id);
    return {id:item.model,label:option.label?.props?.displayName??item.displayName??item.model,defaultEffort:item.defaultReasoningEffort??'',efforts:item.model===selected.model?power.powerSelections.filter(p=>!p.isLocked).map(p=>p.reasoningEffort):item.supportedReasoningEfforts.filter(p=>p.reasoningEffort!=='persistent').map(p=>p.reasoningEffort),speeds,supportsImages:item.inputModalities?.includes('image')!==false};
  });
  const settings={model:selected.model,effort:selected.reasoningEffort??'',serviceTier:power.selectedServiceTier??'',mode:composer.activeCollaborationMode?.mode??'default'};
  const editor=activeRoot.querySelector('.ProseMirror[data-codex-composer]');
  const hasDesktopText=(editor?.textContent??'').trim().length>0||properties.some(props=>props.hasDraftAttachments===true);
  // 权限与首次发送适配器由同一原生状态容器提供，缺失时必须明确失败。
  const permissions=await readPermissionsNative(store,initial,modules,properties,input);
  const state={status:'ready',settings,models,permissions,hasDesktopText};
  state.nativeRevision=JSON.stringify([input.clientDraftId,input.projectId,settings,permissions,models,hasDesktopText]);
  if(action==='read')return state;
  if(input.expectedNativeRevision!==state.nativeRevision)fail('DRAFT_CHANGED');
  if(action==='update') {
    if(commands.has(input.commandId))return {submitted:true};
    commands.set(input.commandId,{kind:'update',clientDraftId:input.clientDraftId});
    const changes=input.changes;
    if(changes.model!==undefined && changes.model!==settings.model) {
      const option=visible.find(option=>option.id===changes.model);
      if(!option || typeof option.onSelect!=='function')fail('MODEL_UNAVAILABLE');
      option.onSelect();return {submitted:true};
    }
    if(changes.effort!==undefined && changes.effort!==settings.effort) {
      const option=power.powerSelections.find(option=>option.reasoningEffort===changes.effort && !option.isLocked);
      if(!option)fail('EFFORT_UNAVAILABLE');
      power.onSelectPower(option);
    }
    if(changes.serviceTier!==undefined && changes.serviceTier!==settings.serviceTier) {
      if(!speeds.some(option=>option.id===changes.serviceTier))fail('SPEED_UNAVAILABLE');
      power.onSelectServiceTier(changes.serviceTier||null);
    }
    if(changes.mode!==undefined && changes.mode!==settings.mode)composer.setSelectedCollaborationMode(changes.mode);
    if(changes.permissionMode!==undefined)await updatePermissionsNative(store,initial,modules,properties,input);
    return {submitted:true};
  }
  if(action==='send') {
    if(hasDesktopText)fail('DRAFT_DESKTOP_TEXT');
    return sendNativeDraft(store,initial,modules,properties,input,commands);
  }
  fail('DRAFT_UNSUPPORTED');
}

/** 从可见权限组件已经计算好的状态与闭包读取；不重新调用 React hook，不打开菜单。 */
async function readPermissionsNative(store,initial,modules,properties,input,internal=false) {
  const unavailable=()=>{throw Error('DRAFT_PERMISSIONS_UNAVAILABLE');};
  const roots=[...document.querySelectorAll('[data-codex-composer-root]')].filter(element=>{
    if(element.getBoundingClientRect().width<=0 || element.closest('[data-app-shell-active-page="false"]'))return false;
    for(let ancestor=element;ancestor;ancestor=ancestor.parentElement)if(ancestor.hidden||ancestor.inert||ancestor.getAttribute('aria-hidden')==='true')return false;
    return true;
  });
  if(roots.length!==1)unavailable();
  const root=roots[0],button=root.querySelector('button[data-composer-navigation-target="permissions"]');
  let fiber=button?.[Object.keys(button).find(key=>key.startsWith('__reactFiber$'))];
  let permission,preference,config,permissionProps,composerScope,composerProps,hasDesktopAttachments=false;
  const optionProps=new Map();
  const labels=new Map([
    ['composer.permissionsDropdown.default.approvalOptionLabel','default'],
    ['composer.permissionsDropdown.guardianApproval.optionLabel','auto-review'],
    ['composer.permissionsDropdown.fullAccess.optionLabel','full-access'],
  ]);
  // 菜单的 React 元素已在缓存中；只读元素数据即可取得真实 disabled 与默认选择回调。
  const labelIds=(value,depth=0)=>{
    if(!value||depth>16)return [];
    if(Array.isArray(value))return value.flatMap(child=>labelIds(child,depth+1));
    if(typeof value!=='object'||!value.props)return [];
    return [...(labels.has(value.props.id)?[labels.get(value.props.id)]:[]),...labelIds(value.props.children,depth+1)];
  };
  const visit=(value,seen=new Set(),depth=0)=>{
    if(!value||typeof value!=='object'||depth>20||seen.has(value))return;
    seen.add(value);
    if(Array.isArray(value)){for(const child of value)visit(child,seen,depth+1);return;}
    const props=value.props;
    if(!props)return;
    if(typeof props.onClick==='function')for(const id of labelIds(props.children))optionProps.set(id,props);
    visit(props.children,seen,depth+1);
  };
  for(let depth=0;fiber&&depth<100;fiber=fiber.return,depth++) {
    const cache=fiber.updateQueue?.memoCache?.data??[];
    const props=fiber.memoizedProps,values=cache.flat();
    if(props?.hasDraftAttachments===true)hasDesktopAttachments=true;
    const permissionValue=values.find(value=>value&&typeof value.setAgentMode==='function'&&typeof value.setPermissionProfileId==='function');
    const preferenceValue=values.find(value=>value&&typeof value.setPreferredNonFullAccessMode==='function');
    const configValue=values.find(value=>value&&typeof value==='object'&&'resolvedConfig'in value&&'requirements'in value);
    // 以同一 fiber 的语义数据绑定权限，避免依赖版本间变化的压缩组件名。
    if(props&&'conversationId'in props&&'hostId'in props&&('cwdOverride'in props||'configDataOverride'in props||'permissionProfilesOverride'in props)&&permissionValue&&preferenceValue&&configValue) {
      if(permissionProps)unavailable();
      permissionProps=props;permission=permissionValue;preference=preferenceValue;config=configValue;
      for(const value of values)visit(value);
    }
    if(typeof fiber.memoizedProps?.onSubmitLocal==='function') {
      composerProps=fiber.memoizedProps;
      for(const row of cache)for(const value of row)if(value?.node&&typeof value.get==='function'&&typeof value.set==='function'&&value.value?.kind==='new'&&value.value.clientThreadId===input.clientDraftId)composerScope=value;
      if(composerScope)break;
    }
  }
  if(!permission||!preference||!config||!composerScope||!composerProps||permissionProps?.conversationId!=null||permissionProps?.hostId!=='local'||config.isConfigDataPending||permission.isAgentModePending||permission.isAgentModeLoading)unavailable();
  const modeMap={auto:'default',granular:'default','guardian-approvals':'auto-review','read-only':'read-only','full-access':'full-access',custom:'custom'};
  const mode=modeMap[permission.agentMode];
  if(!mode)unavailable();
  const listModes=initial[modules.permissionModes],workspaceMode=initial[modules.permissionWorkspaceMode];
  if(typeof listModes!=='function'||typeof workspaceMode!=='function')unavailable();
  const available=listModes({...config,defaultWorkspaceWriteMode:workspaceMode(config),showFullAccessInComposer:true,isAutoReviewRequiredForSelectedModel:permission.isAutoReviewRequiredForSelectedModel,hasAuthoritativeGuardianApprovalDefault:false}).availableAgentModes;
  if(!Array.isArray(available))unavailable();
  const definitions=[['default','默认权限','按原生工作区规则请求批准'],['auto-review','自动审查','由原生审查器检查额外访问请求'],['read-only','只读','使用原生只读沙箱'],['full-access','完整访问','不受沙箱限制，需明确确认']];
  const options=definitions.map(([id,label,description])=>{
    const native=optionProps.get(id);
    const enabled=id==='read-only'?available.includes('read-only')&&!permission.isAutoReviewRequiredForSelectedModel:!!native&&native.disabled!==true;
    return {id,label,description,enabled,disabledReason:enabled?'':'当前原生模型、工作区或管理策略不允许此权限'};
  });
  const reviewer=permission.permissionOverrideThreadSettings?.approvalsReviewer??permission.approvalsReviewerOverride??(permission.agentMode==='guardian-approvals'?'guardian_subagent':'user');
  // 修订摘要涵盖原生约束与覆盖值，但不向手机返回工作目录或管理配置。
  const revisionBytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([mode,reviewer,permission.permissionProfileId,permission.permissionOverrideThreadSettings,permission.shouldSendPermissionOverrides,permission.isAutoReviewRequiredForSelectedModel,options])));
  const snapshot={mode,reviewer,options,revision:[...new Uint8Array(revisionBytes)].map(value=>value.toString(16).padStart(2,'0')).join('')};
  return internal?{snapshot,permission,preference,optionProps,composerScope,composerProps,root,hasDesktopAttachments,hostId:permissionProps.hostId}:snapshot;
}

/** 复用原生 setter 与选择记忆；完整访问沿用手机已确认的授权，不再弹桌面菜单。 */
async function updatePermissionsNative(store,initial,modules,properties,input) {
  const native=await readPermissionsNative(store,initial,modules,properties,input,true),mode=input.changes?.permissionMode;
  if(!native.snapshot.options.some(option=>option.id===mode&&option.enabled))throw Error('DRAFT_PERMISSIONS_UNAVAILABLE');
  if(mode==='full-access'&&input.confirmedFullAccess!==true)throw Error('DRAFT_PERMISSIONS_UNAVAILABLE');
  if(mode===native.snapshot.mode)return;
  if(mode==='default'||mode==='auto-review') {
    // 默认模式包含 Windows 沙箱及内建权限档案的判断，直接复用原生选项闭包。
    const option=native.optionProps.get(mode);
    if(typeof option?.onClick!=='function'||option.disabled===true)throw Error('DRAFT_PERMISSIONS_UNAVAILABLE');
    option.onClick();
    return;
  }
  const remember=initial[modules.rememberPermissionSelection];
  if(typeof remember!=='function')throw Error('DRAFT_PERMISSIONS_UNAVAILABLE');
  const agentMode=mode==='read-only'?'read-only':'full-access';
  if(mode==='read-only')native.preference.setPreferredNonFullAccessMode(null);
  // 草稿的 setAgentMode 同时清理该 host/cwd 的临时权限档案，不提前创建正式聊天。
  native.permission.setAgentMode(agentMode);
  remember(native.hostId,{kind:'agent-mode',agentMode});
}

/** 调用已注册的独立原生提交服务；先发送首轮，再由原生映射解析正式编号。 */
async function sendNativeDraft(store,initial,modules,properties,input,commands) {
  if(!/^app-primary-[a-f0-9]+\.js$/.test(modules.primary??'')||typeof modules.nativeSubmitAtom!=='string')throw Error('DRAFT_SEND_UNAVAILABLE');
  const primary=await import('app://-/assets/'+modules.primary);
  const native=await readPermissionsNative(store,initial,modules,properties,input,true);
  if(native.root.getBoundingClientRect().width<=0||native.root.closest('[data-app-shell-active-page="false"]')||native.composerScope.value?.kind!=='new'||native.composerScope.value.clientThreadId!==input.clientDraftId)throw Error('DRAFT_SEND_UNAVAILABLE');
  // 权限摘要计算含异步步骤；提交前重新读取当前项目，不能用旧 props 向另一个目录发送。
  const start=native.root[Object.keys(native.root).find(key=>key.startsWith('__reactFiber$'))],stack=[start];
  let currentComposer,currentDestination;
  for(let count=0;stack.length&&count<6000;count++){
    const fiber=stack.pop();if(!fiber)continue;
    if(fiber.child)stack.push(fiber.child);if(fiber.sibling&&fiber!==start)stack.push(fiber.sibling);
    const props=fiber.memoizedProps;
    if(!currentComposer&&typeof props?.onSubmitLocal==='function'&&typeof props?.setSelectedCollaborationMode==='function')currentComposer=props;
    if(!currentDestination&&props?.currentLocalExecutionHostId==='local'&&typeof props?.currentLocalExecutionCwd==='string')currentDestination=props;
  }
  const project=currentComposer?.selectedProject;
  const normalizePath=value=>{const normalized=String(value).replaceAll('\\','/').replace(/\/+$/,'');return /^[a-z]:/i.test(normalized)?normalized.toLowerCase():normalized;};
  if(!currentComposer||(project?.id!==input.projectId&&project?.projectId!==input.projectId)||input.projectCwd!==undefined&&(!currentDestination||normalizePath(currentDestination.currentLocalExecutionCwd)!==normalizePath(input.projectCwd)))throw Error('DRAFT_PROJECT_CHANGED');
  const editor=native.root.querySelector('.ProseMirror[data-codex-composer]');
  const button=native.root.querySelector('button[data-composer-navigation-target="permissions"]');
  let current=button?.[Object.keys(button).find(key=>key.startsWith('__reactFiber$'))],hasAttachments=native.hasDesktopAttachments;
  for(let depth=0;current&&depth<100;current=current.return,depth++)if(current.memoizedProps?.hasDraftAttachments===true)hasAttachments=true;
  if((editor?.textContent??'').trim()||hasAttachments||properties.some(props=>props.hasDraftAttachments===true))throw Error('DRAFT_DESKTOP_TEXT');
  const service=native.composerScope.get(primary[modules.nativeSubmitAtom]);
  if(typeof service?.submit!=='function'||service.newThreadDestination?.kind!=='app-server'||service.newThreadDestination?.hostId!=='local')throw Error('DRAFT_SEND_UNAVAILABLE');
  const previous=commands.get(input.commandId);
  if(previous?.kind==='send') {
    if(previous.threadId)return {threadId:previous.threadId};
    throw Error('DRAFT_SEND_OUTCOME_UNKNOWN');
  }
  for(const entry of commands.values())if(entry.kind==='send'&&entry.clientDraftId===input.clientDraftId)throw Error('DRAFT_SEND_OUTCOME_UNKNOWN');
  const images=input.images??[],attachments=input.attachments??[];
  if(typeof input.text!=='string'||input.text.length>32000||!Array.isArray(images)||!Array.isArray(attachments)||images.length+attachments.length>3||(!input.text.trim()&&!images.length&&!attachments.length))throw Error('DRAFT_SEND_UNAVAILABLE');
  const imageAttachments=images.map((src,index)=>{
    if(typeof src!=='string'||!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(src))throw Error('DRAFT_SEND_UNAVAILABLE');
    return {id:input.commandId+':image:'+index,src};
  });
  const fileAttachments=attachments.map(file=>{
    if(!file||typeof file.label!=='string'||typeof file.path!=='string'||!/^(?:[A-Za-z]:[\\/]|\/)/.test(file.path))throw Error('DRAFT_SEND_UNAVAILABLE');
    return {label:file.label,path:file.path};
  });
  const entry={kind:'send',clientDraftId:input.clientDraftId,status:'submitting'};
  commands.set(input.commandId,entry);
  try {
    // 服务内部合并原生项目、模型与权限，检查图片能力，并调用原生新建及首轮提交。
    await service.submit({prompt:input.text,imageAttachments,fileAttachments,addedFiles:[],ideContext:null,pastedTextAttachments:[],commentAttachments:[],appshotContexts:[]});
    for(let attempt=0;attempt<100;attempt++) {
      const threadId=store.get(initial[modules.promotionAtom],input.clientDraftId);
      if(typeof threadId==='string'&&/^[a-f0-9-]{36}$/i.test(threadId)) {
        entry.status='promoted';entry.threadId=threadId;
        return {threadId};
      }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
  } catch {
    entry.status='outcome-unknown';
    throw Error('DRAFT_SEND_OUTCOME_UNKNOWN');
  }
  entry.status='outcome-unknown';
  throw Error('DRAFT_SEND_OUTCOME_UNKNOWN');
}

export function nativeDraftExpression(modules,action,input) {
  if(!/^app-initial-[a-f0-9]+\.js$/.test(modules.initial) || !['capabilities','open','read','update','send'].includes(action))throw Error('原生草稿请求无效');
  for(const [key,value] of Object.entries(modules))if(key==='primary'?!/^app-primary-[a-f0-9]+\.js$/.test(value):key!=='initial'&&!/^[\w$]+$/.test(value))throw Error('原生草稿模块无效');
  return `(()=>{const readPermissionsNative=${readPermissionsNative.toString()};const updatePermissionsNative=${updatePermissionsNative.toString()};const sendNativeDraft=${sendNativeDraft.toString()};return (${operateNativeDraft.toString()})(${JSON.stringify(modules)},${JSON.stringify(action)},${JSON.stringify(input)})})()`;
}
