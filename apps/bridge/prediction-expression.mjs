/** 此函数仅在已核对身份的桌面页面内只读执行；不调用预测生成、采纳或编辑器写方法。 */
function readDisplayedPrediction(expectedHost, expectedThread, expectedTurn) {
  const results=[];
  for(const editor of document.querySelectorAll('.ProseMirror[data-codex-composer]')) {
    // 桌面被浏览器遮挡时 visibilityState 也会变为 hidden，但预测仍在原输入框中。
    // 以选中的会话面板或新版可见主内容区为准，先排除没有预测的旧编辑器。
    if(!editor.querySelector('[data-cumberbatch] .cumberbatch-content'))continue;
    let panel=null,hidden=false,inMain=false,ancestor=editor,depth=0;
    for(;ancestor&&depth<100;depth++,ancestor=ancestor.parentElement){
      if(panel===null&&ancestor.getAttribute('role')==='tabpanel')panel=ancestor;
      if(ancestor.tagName==='MAIN')inMain=true;
      if(ancestor.getAttribute('hidden')!==null||ancestor.getAttribute('inert')!==null||ancestor.getAttribute('aria-hidden')==='true')hidden=true;
      // 新版把后台 Workspace 保留在 DOM，并用内联 display:none 隐藏，不再提供 tabpanel。
      const style=ancestor.getAttribute('style')??'';
      if(/(^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|content-visibility\s*:\s*hidden)\s*(?:!important\s*)?(;|$)/i.test(style))hidden=true;
    }
    if(ancestor||hidden)continue;
    const tab=panel?.id?document.querySelector('[role="tab"][aria-controls="'+panel.id+'"]'):null;
    // 旧标签布局继续核对选中态；无标签的新布局必须位于未隐藏的主内容区。
    if(panel!==null?tab?.getAttribute('aria-selected')!=='true':!inMain)continue;
    let host=editor;
    while(host&&!Object.keys(host).some(key=>key.startsWith('__reactFiber$')))host=host.parentElement;
    let fiber=host?.[Object.keys(host).find(key=>key.startsWith('__reactFiber$'))];
    let controller=null;
    const threads=[],hosts=[];
    for(let depth=0;fiber&&depth<100;depth++,fiber=fiber.return){
      const props=fiber.memoizedProps??{};
      if(controller===null&&props.composerController)controller=props.composerController;
      if(typeof props.conversationId==='string'&&!threads.includes(props.conversationId))threads.push(props.conversationId);
      if(typeof props.hostId==='string'&&!hosts.includes(props.hostId))hosts.push(props.hostId);
    }
    if(threads.length!==1||hosts.length!==1||threads[0]!==expectedThread||hosts[0]!==expectedHost)continue;
    const view=controller?.view,state=view?.state;
    if(view?.dom!==editor||!state)continue;
    const keys=Object.keys(state).filter(key=>key.startsWith('cumberbatch$'));
    if(keys.length!==1)continue;
    const plugin=state[keys[0]],prediction=plugin?.prediction;
    if(typeof prediction?.text!=='string'||prediction.text.length===0||prediction.text.length>32000||prediction.sourceTurnId!==expectedTurn)continue;
    const paragraphs=state.doc?.content?.content;
    if(paragraphs?.length!==1||paragraphs[0]?.type?.name!=='paragraph'||paragraphs[0]?.content?.size!==0||view.input?.composing===true||plugin.hiddenForComposition===true)continue;
    results.push({threadId:expectedThread,sourceTurnId:expectedTurn,text:prediction.text});
  }
  return results;
}

/** 固定程序加 JSON 参数，手机无法传入代码或调试地址。 */
export function predictionExpression(hostId,threadId,turnId){return `(${readDisplayedPrediction.toString()})(${JSON.stringify(hostId)},${JSON.stringify(threadId)},${JSON.stringify(turnId)})`;}
