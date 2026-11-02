import {createHash} from 'node:crypto';
import {WebSocket} from 'ws';
import {ComposerPredictionReader} from './composer-prediction.mjs';
import {nativeDraftModules} from './native-draft-modules.mjs';
import {nativeDraftExpression} from './native-draft-expression.mjs';
import {withDesktopUi} from './desktop-ui-coordinator.mjs';
import {BridgeError} from '../../packages/protocol/contracts.mjs';

const messages={DRAFT_WINDOW_AMBIGUOUS:'无法唯一确定所选电脑的新建窗口',DRAFT_UNSUPPORTED:'当前桌面暂不支持原生新建草稿，请更新连接服务',DRAFT_NOT_READY:'电脑新建页面尚未准备好，请稍后重新读取',DRAFT_PROJECT_CHANGED:'电脑新建项目已变化，请重新连接草稿',DRAFT_CATALOG_UNAVAILABLE:'电脑新建页模型列表尚未就绪，请重新读取',DRAFT_PERMISSIONS_UNAVAILABLE:'电脑新建页权限尚未就绪，请重新读取',DRAFT_CHANGED:'电脑设置已变化，请读取最新设置后重试',DRAFT_DESKTOP_TEXT:'PC 草稿中已有未发送内容，请先在电脑处理；手机内容已保留',DRAFT_SEND_UNAVAILABLE:'当前桌面暂不支持提交原生草稿',MODEL_UNAVAILABLE:'此模型当前不可用',EFFORT_UNAVAILABLE:'此模型不支持所选推理强度',SPEED_UNAVAILABLE:'此模型不支持所选速度'};

/** 固定程序与数据通过已核验的回环页面调用，原始异常不得泄露桌面路径或草稿内容。 */
export async function evaluateNativeDraft(url,expression,write=false) {
  const socket=new WebSocket(url,{handshakeTimeout:2000,maxPayload:4*1024*1024,perMessageDeflate:false});
  try {
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
    return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.terminate();reject(new BridgeError(write?'OUTCOME_UNKNOWN':'DRAFT_UNAVAILABLE',write?'草稿操作结果需要核对，请勿重复提交':'电脑草稿读取超时，请重试',write));},write?50000:10000);
      let finished=false;
      const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(value);};
      socket.once('error',()=>finish(new BridgeError('DRAFT_UNAVAILABLE','电脑草稿连接已中断',write)));
      socket.once('close',()=>finish(new BridgeError(write?'OUTCOME_UNKNOWN':'DRAFT_UNAVAILABLE','电脑草稿连接已中断，请核对原操作',write)));
      socket.on('message',data=>{
        let message;try{message=JSON.parse(data);}catch{return;}
        if(message.id!==1)return;
        const description=message.result?.exceptionDetails?.exception?.description??'';
        const code=Object.keys(messages).find(code=>new RegExp('(?:Error: |^)'+code+'(?:\\n|$)').test(description));
        if(code)return finish(new BridgeError(code,messages[code]));
        if(message.error||message.result?.exceptionDetails)return finish(new BridgeError(write?'OUTCOME_UNKNOWN':'DRAFT_UNAVAILABLE',write?'原生草稿操作未确认，请核对电脑后再继续':'原生草稿接口暂不可用，请更新连接服务',write));
        finish(null,message.result?.result?.value);
      });
      socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true,timeout:write?45000:8000}}));
    });
  } finally {socket.terminate();}
}

/** 草稿固定到一个桌面进程、页面和原生编号，后台核对不会把 PC 导航拉回。 */
export class NativeDraftController extends ComposerPredictionReader {
  constructor({adapter,instance,resolveModules=nativeDraftModules,evaluateNative=evaluateNativeDraft,...options}={}){super(options);this.adapter=adapter;this.instance=instance;this.resolveModules=resolveModules;this.evaluateNative=evaluateNative;this.pendingOpens=new Map();}
  async candidates(){
    if(this.instance)await this.instance.verify?.();
    if(!this.adapter?.native?.processId&&!this.instance)await this.adapter?.native?.connect();
    const pid=this.instance?.pid??this.adapter?.native?.processId;
    const ports=(await this.endpoints()).filter(port=>pid==null||port.pid===pid),out=[];
    for(const port of ports){
      const modules=this.resolveModules(port.executable??this.instance?.executable);
      for(const url of await this.targets(port))try{const value=await this.evaluateNative(url,nativeDraftExpression(modules,'capabilities',{}));if(value?.supported)out.push({port,url,modules,focused:value.focused});}catch{}
    }
    return out;
  }
  async capabilities(){try{return(await this.candidates()).length>0;}catch{return false;}}
  async assertBinding(binding){
    if(this.closed||this.instance&&(this.instance.alive!==true||this.instance.generation!==binding.generation))throw new BridgeError('DRAFT_DETACHED','所选电脑已重启，请重新连接草稿');
    if(this.instance)await this.instance.verify?.();
    if(!(await this.endpoints()).some(port=>port.pid===binding.port.pid&&port.port===binding.port.port))throw new BridgeError('DRAFT_DETACHED','电脑草稿连接已变化，请重新连接');
  }
  async invoke(binding,action,input={},write=false){await this.assertBinding(binding);return this.evaluateNative(binding.url,nativeDraftExpression(binding.modules,action,{projectId:binding.projectId,projectCwd:binding.cwd,clientDraftId:binding.clientDraftId,...input}),write);}
  normalize(binding,value){
    if(!value||!['ready','detached','promoted'].includes(value.status))throw new BridgeError('DRAFT_NOT_READY',messages.DRAFT_NOT_READY);
    const {nativeRevision,...publicValue}=value;
    const merged={...binding.lastSnapshot,...publicValue};
    merged.revision=createHash('sha256').update(nativeRevision??JSON.stringify([merged.status,merged.threadId])).digest('hex');
    binding.nativeRevision=nativeRevision;binding.lastSnapshot=merged;return merged;
  }
  async read(binding){return this.normalize(binding,await this.invoke(binding,'read'));}
  async settle(binding,predicate){
    for(let n=0;n<30;n++){
      try{const snapshot=await this.read(binding);if(predicate(snapshot))return snapshot;}
      catch(error){if(!['DRAFT_NOT_READY','DRAFT_CATALOG_UNAVAILABLE','DRAFT_PERMISSIONS_UNAVAILABLE'].includes(error.code))throw error;}
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    throw new BridgeError('DRAFT_NOT_READY',messages.DRAFT_NOT_READY);
  }
  async open(project,commandId){
    return withDesktopUi(async()=>{
      const candidates=await this.candidates(),focused=candidates.filter(item=>item.focused),chosen=focused.length===1?focused:candidates;
      if(chosen.length!==1)throw new BridgeError('DRAFT_WINDOW_AMBIGUOUS',messages.DRAFT_WINDOW_AMBIGUOUS);
      const binding={...chosen[0],projectId:project.id,cwd:project.cwd,generation:this.instance?.generation};
      this.pendingOpens.set(commandId,binding);
      const opened=await this.invoke(binding,'open',{projectId:project.id,commandId},true);
      binding.clientDraftId=opened?.clientDraftId;
      if(typeof binding.clientDraftId!=='string'||!binding.clientDraftId.startsWith('client-new-thread:'))throw new BridgeError('OUTCOME_UNKNOWN','电脑新建草稿结果需要核对，请勿重复打开',true);
      let snapshot;
      try { snapshot=await this.settle(binding,snapshot=>snapshot.status==='ready'); }
      catch { throw new BridgeError('OUTCOME_UNKNOWN','电脑已接收新建草稿，请核对原操作，勿重复打开',true); }
      return{binding,snapshot};
    });
  }
  /** 新建动作已有原生编号但能力尚未就绪时，只读恢复原绑定，不能重新点击新聊天。 */
  async recoverOpen(project,commandId){
    const binding=this.pendingOpens.get(commandId);
    if(!binding||binding.projectId!==project.id||!binding.clientDraftId)throw new BridgeError('OUTCOME_UNKNOWN','无法确认原新建动作，请在电脑核对，勿重复打开',true);
    return{binding,snapshot:await this.read(binding)};
  }
  async update(binding,changes,{expectedRevision,confirmedFullAccess,commandId}){
    return withDesktopUi(async()=>{
      const current=await this.read(binding);
      if(current.status!=='ready'||current.revision!==expectedRevision)throw new BridgeError('DRAFT_CHANGED',messages.DRAFT_CHANGED);
      // 多字段按原生回执逐项落实，模型变化后重新读取它自己的推理选项。
      let confirmedRevision=current.revision;
      for(const [key,value]of Object.entries(changes)){
        const before=await this.read(binding);
        if(before.status!=='ready')throw new BridgeError('DRAFT_DETACHED','电脑已离开此草稿，请重新连接');
        if(before.revision!==confirmedRevision)throw new BridgeError('DRAFT_CHANGED',messages.DRAFT_CHANGED);
        await this.invoke(binding,'update',{changes:{[key]:value},expectedNativeRevision:binding.nativeRevision,confirmedFullAccess,commandId:commandId+':'+key},true);
        let confirmed;
        try {confirmed=await this.settle(binding,snapshot=>snapshot.status==='ready'&&(key==='permissionMode'?(snapshot.permissions.mode===value||value==='default'&&snapshot.permissions.mode==='read-only'):snapshot.settings[key]===value));}
        catch {throw new BridgeError('OUTCOME_UNKNOWN','电脑已接收设置变更，请先核对原操作，勿重复提交',true);}
        confirmedRevision=confirmed.revision;
      }
      return this.read(binding);
    });
  }
  async send(binding,input,{expectedRevision,commandId,onCreated}){
    return withDesktopUi(async()=>{
      const current=await this.read(binding);
      if(current.status!=='ready'||current.revision!==expectedRevision)throw new BridgeError('DRAFT_CHANGED',messages.DRAFT_CHANGED);
      if(current.hasDesktopText)throw new BridgeError('DRAFT_DESKTOP_TEXT',messages.DRAFT_DESKTOP_TEXT);
      const result=await this.invoke(binding,'send',{...input,commandId,expectedNativeRevision:binding.nativeRevision},true);
      const threadId=result?.threadId;
      if(typeof threadId!=='string'||!/^[a-f0-9-]{36}$/i.test(threadId))throw new BridgeError('OUTCOME_UNKNOWN','原生草稿提交结果需要核对，请勿重复发送',true);
      onCreated?.({threadId});
      return{threadId,snapshot:this.normalize(binding,{status:'promoted',threadId})};
    });
  }
}
