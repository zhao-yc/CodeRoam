import {BridgeError} from '../../packages/protocol/contracts.mjs';

/** 按原桌面最终回复划分报告，只收集这份报告之前成功完成的结构化文件修改。 */
export function fileReportSource(state, reportId) {
  const history=state.turnHistory?.history;
  const turns=state.sourceTurns??(history?.entitiesByKey?(history.islands??[]).flatMap(island=>(island.entries??[]).map(entry=>history.entitiesByKey[entry.value]).filter(Boolean)):state.turns??[]);
  for(const turn of turns){
    const items=(turn.items??[]).filter(Boolean),end=items.findIndex(item=>item.id===reportId&&['agentMessage','assistantMessage'].includes(item.type)&&item.phase==='final_answer');
    if(end<0)continue;
    let start=0;
    for(let i=0;i<end;i++)if(['agentMessage','assistantMessage'].includes(items[i].type)&&items[i].phase==='final_answer')start=i+1;
    if(start===0&&turn.itemsPagination?.hasLoadedOldest===false)return null;
    // 历史尾部截断时不能把半份报告当完整汇总。
    if(state.historyTruncated&&start===0)throw new BridgeError('REPORT_INCOMPLETE','这份报告的早期修改记录未完整保留，请在电脑端查看');
    const batches=[];
    let bytes=0;
    for(const item of items.slice(start,end)){
      if(item.type!=='fileChange'||item.status!=='completed')continue;
      if((item.changes??[]).some(change=>typeof change.path!=='string'||typeof change.diff!=='string'||!['add','update','delete'].includes(change.kind?.type)))throw new BridgeError('REPORT_INCOMPLETE','这份旧记录未保留完整差异，请在电脑端查看');
      const changes=(item.changes??[]).filter(change=>typeof change.path==='string'&&typeof change.diff==='string'&&['add','update','delete'].includes(change.kind?.type));
      bytes+=Buffer.byteLength(JSON.stringify(changes));
      if(bytes>1024*1024)throw new BridgeError('REPORT_TOO_LARGE','这份报告的差异过大，请在电脑端查看');
      if(changes.length)batches.push({changes,cwd:turn.params?.cwd??state.cwd??null});
    }
    return {reportId,turnId:turn.turnId??'',batches};
  }
  return null;
}
