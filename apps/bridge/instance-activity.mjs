import {instanceBindingModules} from './instance-binding-modules.mjs';
import {instancePages,evaluateInstancePage,instanceServicesExpression} from './instance-binding.mjs';

const validId=value=>typeof value==='string'&&/^[0-9a-f-]{36}$/i.test(value);

/** 固定只读查询只返回当前实例实际所有者的活动候选，不把缓存会话混入活动清单。 */
export function instanceActivityExpression(modules) {
  return `(async()=>{${instanceServicesExpression(modules)}const threadIds=new Set();let complete=true;for(const hostId of ['local','durable']){try{const opened=await services.appServerManagers.open(hostId);if(opened.status!=='ready'){complete=false;continue;}const manager=opened.manager;const rows=await manager.getWorkInProgress();if(!Array.isArray(rows)){complete=false;continue;}if(rows.length>256)complete=false;for(let i=0;i<Math.min(rows.length,256);i+=16){await Promise.all(rows.slice(i,i+16).map(async row=>{const id=row?.conversationId;if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id)){complete=false;return;}try{const role=await manager.getStreamRole(id);if(role?.role==='owner')threadIds.add(id);}catch{complete=false;}}));}}catch{complete=false;}}return {complete,threadIds:[...threadIds]}})()`;
}

/** 沿用已核验的安装包、回环端口和页面；失败保持未知，绝不扫描其他实例端点。 */
export async function readInstanceActivity(instance,{pages=instancePages,evaluate=evaluateInstancePage,resolveModules=instanceBindingModules}={}) {
  const unknown={complete:false,threadIds:[]};
  if(!instance?.alive||!instance.ready||!instance.port)return unknown;
  const generation=instance.generation;
  try {
    const expression=instanceActivityExpression(resolveModules(instance.executable));
    for(const url of (await pages(instance)).slice(0,2)) {
      try {
        const result=await evaluate(url,expression,{timeoutMs:2000});
        if(!instance.alive||!instance.ready||instance.generation!==generation)return unknown;
        if(typeof result?.complete!=='boolean'||!Array.isArray(result.threadIds)||result.threadIds.length>256||!result.threadIds.every(validId))continue;
        return {complete:result.complete,threadIds:[...new Set(result.threadIds)]};
      }catch{/* 页面尚未就绪时尝试同实例另一个已核验页面。 */}
    }
  }catch{/* 不兼容的活动查询不会妨碍列表索引和原详情接口。 */}
  return unknown;
}
