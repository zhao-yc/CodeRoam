/** 固定只读程序调用桌面自带的转换器、解析器及统计函数，不在手机或桥接层重新计算行数。 */
async function readNativeFileReport(modules,batches) {
  const main=[...document.scripts].find(script=>/\/index-[a-f0-9]+\.js$/.test(script.src));
  if(!main||!main.src.startsWith('app://-/'))throw new Error('原生差异模块未就绪');
  const initial=await import(new URL(modules.initial,main.src).href);
  const summaryModule=await import(new URL(modules.summary,main.src).href);
  const functions=Object.values(initial).filter(value=>typeof value==='function');
  const unique=predicate=>{const matches=functions.filter(predicate);if(matches.length!==1)throw new Error('原生差异模块暂不兼容');return matches[0];};
  const convert=unique(fn=>fn.length===1&&fn.toString().includes('kind:')&&fn.toString().includes('unified_diff:')&&fn.toString().includes('content:'));
  const serialize=unique(fn=>fn.length===3&&fn.toString().includes('Object.entries(')&&fn.toString().includes('1048576')&&fn.toString().includes('.join('));
  const parse=unique(fn=>fn.toString().includes('firstAdditionLine:')&&fn.toString().includes('deletions:'));
  const summarize=Object.values(summaryModule).find(fn=>typeof fn==='function'&&fn.toString().includes('fileCount:')&&fn.toString().includes('linesDeleted:'));
  if(!summarize)throw new Error('原生统计模块暂不兼容');
  const files=new Map(),parsed=[];
  for(const batch of batches)for(const change of batch.changes){
    const converted=convert([change]);
    // 原桌面不纳入汇总的特殊产物继续使用其过滤结果。
    if(Object.keys(converted).length===0)continue;
    const diff=serialize(converted,batch.cwd,null);
    if(diff==null)throw new Error('差异过大');
    const parts=parse(diff);
    if(parts.length!==1)throw new Error('原生差异数据不完整');
    const part=parts[0],path=change.kind.move_path??change.path;
    let file=files.get(path);
    if(!file){file={path,kind:change.kind.type,parts:[],diffs:[]};files.set(path,file);}
    if(change.kind.type==='delete'||file.kind!=='add')file.kind=change.kind.type;
    file.parts.push(part);file.diffs.push(diff);parsed.push(part);
  }
  const total=summarize(parsed);
  return {additions:total.linesAdded,deletions:total.linesDeleted,files:[...files.values()].map(file=>{
    const stats=summarize(file.parts);
    return {path:file.path,kind:file.kind,additions:stats.linesAdded,deletions:stats.linesDeleted,binary:file.parts.some(part=>part.isBinary),diffs:file.diffs};
  })};
}

/** 模块名来自已验证桌面的安装包索引；手机只能指定报告编号，不能传入模块或脚本。 */
export function fileReportExpression(modules,batches) {
  if(!/^app-initial-[a-f0-9]+\.js$/.test(modules.initial)||!/^diff-summary-[a-f0-9]+\.js$/.test(modules.summary))throw new Error('原生模块标识无效');
  return `(${readNativeFileReport.toString()})(${JSON.stringify(modules)},${JSON.stringify(batches)})`;
}
