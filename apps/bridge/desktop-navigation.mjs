import {BridgeError} from '../../packages/protocol/contracts.mjs';

/** 只管理明确点击产生的导航意图；同目标并发合并，后续点击使旧队列项失效。 */
export class DesktopNavigation {
  current=null;
  begin(threadId,deviceId) {
    if(this.current?.pending&&this.current.threadId===threadId){this.current.devices.add(deviceId);return this.current;}
    return this.current={threadId,devices:new Set([deviceId]),pending:true,promise:null};
  }
  isCurrent(token){return this.current===token&&token.devices.size>0;}
  assertCurrent(token){if(!this.isCurrent(token))throw new BridgeError('SUBSCRIPTION_CANCELED','聊天已切换，已取消旧的电脑导航');}
  run(token,open) {
    token.promise??=Promise.resolve().then(async()=>{this.assertCurrent(token);await open(token.threadId,{isCurrent:()=>this.isCurrent(token)});this.assertCurrent(token);}).finally(()=>{token.pending=false;});
    return token.promise;
  }
  cancel(threadId,deviceId){if(this.current?.threadId===threadId)this.current.devices.delete(deviceId);}
  close(){this.current=null;}
}
