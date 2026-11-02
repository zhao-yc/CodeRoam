/** 只绑定已确认到达最新端的最后一个完成轮次，不从旧历史页猜测。 */
export function predictionTurnId(state) {
  const history=state?.turnHistory?.history;
  let turn;
  if(history){
    const tails=(history.islands??[]).filter(island=>island.newerBoundary?.status==='exhausted');
    if(tails.length!==1)return '';
    turn=history.entitiesByKey?.[tails[0].entries?.at(-1)?.value];
  }else turn=state?.turns?.at(-1);
  return turn?.status==='completed'&&!turn.error&&typeof turn.turnId==='string'?turn.turnId:'';
}
