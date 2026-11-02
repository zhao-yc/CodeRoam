import { permissionState } from './permissions.mjs';
import { BridgeError } from '../../packages/protocol/contracts.mjs';
import { executionSettings } from './model-settings.mjs';
import { normalizeQuestions, parseQuestionReply, questionResponseText } from './questions.mjs';
import { MAX_IMAGES } from '../../packages/protocol/images.mjs';
import { readMessageImages, assistantImages } from './message-images.mjs';
import { currentActivity } from './activity.mjs';
import { normalizeGoal, goalRevision } from './goals.mjs';
import { taskNotificationState } from './task-notifications.mjs';
import { latestTurnSummary, boundedTurnMetadata, turnStatus } from './turn-failure.mjs';

/** 对本地快照应用 Immer 路径补丁，拒绝原型链路径和非法数组索引。 */
export function applyPatches(state, patches) {
  for (const patch of patches) {
    if (!Array.isArray(patch.path) || patch.path.some(key => ['__proto__','prototype','constructor'].includes(String(key)))) throw new BridgeError('BAD_PATCH', '收到不安全的聊天补丁');
    if (!['add','replace','remove'].includes(patch.op) || patch.path.length === 0) throw new BridgeError('BAD_PATCH', '不支持的聊天补丁');
    let target = state;
    for (const key of patch.path.slice(0,-1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target,key)) throw new BridgeError('PATCH_GAP', '聊天补丁缺少基础状态');
      target = target[key];
    }
    const key = patch.path.at(-1);
    if (!target || typeof target !== 'object') throw new BridgeError('BAD_PATCH','聊天补丁的目标不存在');
    if (Array.isArray(target)) {
      if (!Number.isInteger(key) || key < 0 || key > target.length || (patch.op !== 'add' && key === target.length)) throw new BridgeError('BAD_PATCH','数组补丁索引不合法');
      if (patch.op === 'remove') target.splice(key,1);
      else if (patch.op === 'add') target.splice(key,0,patch.value);
      else target[key] = patch.value;
    } else if (patch.op === 'remove') delete target[key];
    else target[key] = patch.value;
  }
  return state;
}

function textOf(content, hideImages = false) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : ['image','localImage'].includes(part?.type) ? (hideImages ? '' : '\n[图片]\n') : part?.text ?? '').join('');
  if (content && typeof content === 'object') return content.text ?? '';
  return '';
}

/** 将桌面内部时间线压缩为手机需要的消息、执行状态与待审批项。 */
export function normalizeConversation(state, { imageMessageId, imageIndex, maxMessages = 80, maxCharacters = 120000, preserveDialogue = true } = {}) {
  const history = state.turnHistory?.history;
  const turns = history?.entitiesByKey ? (history.islands ?? []).flatMap(island => (island.entries ?? []).map(entry => history.entitiesByKey[entry.value]).filter(Boolean)) : state.turns ?? [];
  const messages = [];
  const seen = new Set();
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      let role = 'tool';
      let text = '';
      let summary;
      let imageParts=[];
      if (['userMessage','steeringUserMessage'].includes(item.type)) { role='user'; const content=item.content ?? item.input; imageParts=Array.isArray(content)?content.filter(part=>['image','localImage'].includes(part?.type)).slice(0,MAX_IMAGES):[]; text=textOf(content,imageParts.length>0); const replies=parseQuestionReply(text); if(replies.length) text=replies.map(reply=>`${reply.question ?? '问题'}\n回答：${reply.answer}`).join('\n\n'); }
      else if (item.type === 'userInputResponse') { role='user'; text=questionResponseText(item); }
      else if (item.type === 'planImplementation') { role='assistant'; text=typeof item.planContent === 'string' ? item.planContent : ''; }
      else if (item.type === 'imageGeneration' && item.status === 'completed') {
        // 生成图片是独立可见记录，只同步图片，不发送提示词、生成参数或本地保存路径。
        role='assistant';
        if (typeof item.savedPath === 'string' && item.savedPath) imageParts=[{type:'localImage',path:item.savedPath}];
        else if (typeof item.result === 'string' && item.result) imageParts=[{type:'image',url:item.result.startsWith('data:image/')?item.result:`data:image/${item.result.startsWith('/9j/')?'jpeg':'png'};base64,${item.result}`}];
      }
      else if (item.type === 'agentMessage' || item.type === 'assistantMessage') {
        role='assistant';
        const extracted=assistantImages(textOf(item.text ?? item.content));
        text=extracted.text; imageParts=extracted.parts;
      }
      else if (item.type === 'commandExecution') {
        text = `${item.command ?? '执行命令'}\n${item.aggregatedOutput ?? item.output ?? ''}`;
        // 摘要从原始命令提取，长输出截断后仍能显示真实命令入口。
        if (typeof item.command === 'string' && item.command.trim()) summary = item.command.replace(/\s+/g,' ').trim().slice(0,240);
      }
      else if (item.type === 'fileChange') {
        const changes = item.changes ?? [];
        text = changes.map(change => `${change.kind?.type ?? change.kind ?? '修改'} ${change.path}`).join('\n');
        // 摘要只读取结构化文件路径，不从执行输出猜测文件名。
        const paths = changes.map(change => change.path).filter(path => typeof path === 'string' && path.length > 0);
        if (paths.length > 0) summary = `${paths[0]}${paths.length > 1 ? ` 等${paths.length}个文件` : ''}`.slice(0,240);
      }
      // 日常快照只同步数量；查看时仅读取桌面目标消息已附加的图片，不抓取远程地址。
      const images=String(item.id)===imageMessageId?readMessageImages(imageParts,imageIndex):[];
      if (text.trim() || imageParts.length) messages.push({ id:String(item.id), role, kind:item.type, ...(imageParts.length?{imageCount:imageParts.length}:{}), ...(images.length?{images}:{}), ...(summary === undefined ? {} : { summary }), ...(role === 'assistant' && typeof item.phase === 'string' ? {phase:item.phase} : {}), text:text.slice(-10000), turnId:turn.turnId ?? '', status:turn.status ?? '' });
    }
  }
  // 先给提问和最终报告预留空间，避免长任务的命令记录挤掉所有早期对话。
  const selectedIds = new Set();
  let total = 0;
  if (preserveDialogue) {
    for (const message of [...messages].reverse()) {
      if (selectedIds.size >= Math.min(40, maxMessages)) break;
      if ((message.role === 'user' || message.phase === 'final_answer') && total + message.text.length <= Math.min(90000, maxCharacters)) {
        selectedIds.add(message.id); total += message.text.length;
      }
    }
  }
  for (const message of [...messages].reverse()) {
    if (selectedIds.size >= maxMessages) break;
    if (!selectedIds.has(message.id) && total + message.text.length <= maxCharacters) { selectedIds.add(message.id); total += message.text.length; }
  }
  const selected = messages.filter(message => selectedIds.has(message.id));
  const active = [...turns].reverse().find(turn => turn.status === 'inProgress');
  const approvals = (state.requests ?? []).flatMap(entry => {
    const request = entry.request ?? entry;
    const kind = request.method === 'item/commandExecution/requestApproval' ? 'command' : request.method === 'item/fileChange/requestApproval' ? 'file' : null;
    if (!kind || request.id === undefined) return [];
    const params = request.params ?? {};
    return [{ id:String(request.id), kind, turnId:params.turnId ?? active?.turnId ?? '', title:kind==='command'?'执行命令审批':'修改文件审批', detail:String(params.command ?? params.reason ?? '请核对桌面聊天后选择是否允许').slice(0,6000), cwd:params.cwd ?? '' }];
  });
  // 仅保留消息窗口、最新轮次和跨度内的空失败，旧失败由历史分页补齐。
  const selectedTurnIds = new Set(selected.map(message => message.turnId).filter(Boolean));
  const latestTurn = latestTurnSummary(state, turns);
  const messageTurnIds = new Set(messages.map(message => message.turnId));
  const windowIndexes = turns.flatMap((turn,index) => selectedTurnIds.has(turn.turnId) || turn.turnId === latestTurn?.turnId ? [index] : []);
  const firstTurn = windowIndexes[0] ?? -1, lastTurn = windowIndexes.at(-1) ?? -1;
  const relevantTurns = turns.filter((turn,index) => selectedTurnIds.has(turn.turnId) || turn.turnId === latestTurn?.turnId || (index >= firstTurn && index <= lastTurn && !messageTurnIds.has(turn.turnId) && turnStatus(turn) === 'failed'));
  const turnInfo = new Map(boundedTurnMetadata(relevantTurns,latestTurn?.turnId,selectedTurnIds).map(turn => [turn.turnId,turn]));
  // 只展示桌面明确等待确认的计划，不从普通回复猜测。
  const candidate=[...turns].reverse().flatMap(turn=>(turn.items??[]).filter(item=>item.type==='planImplementation').reverse().map(item=>({item,turn})))[0];
  const pendingPlan=candidate&&candidate.item.isCompleted===false&&!active&&typeof candidate.item.planContent==='string'?{id:String(candidate.item.id),turnId:candidate.item.turnId??candidate.turn.turnId??'',text:candidate.item.planContent}:null;
  const notificationState=taskNotificationState(latestTurn ? [turns.at(-1)] : [],normalizeQuestions(state,turns),approvals,pendingPlan);
  return { supportsTurnRetry:true, ...(latestTurn ? {latestTurn} : {}), supportsFileReports:process.platform==='win32', notificationState, pendingPlan, supportsPlanImplementation:true, ...(typeof state.hasUnreadTurn === 'boolean' ? {hasUnreadTurn:state.hasUnreadTurn} : {}), ...(Array.isArray(state.threadRuntimeStatus?.activeFlags) ? {activeFlags:state.threadRuntimeStatus.activeFlags.filter(flag=>['waitingOnUserInput','waitingOnApproval'].includes(flag))} : {}), goal:normalizeGoal(state), goalRevision:goalRevision(normalizeGoal(state)), supportsGoals:Object.hasOwn(state,'threadGoal'), activity:currentActivity(active), supportsPlanReset:true, supportsPermissionSettings:true, permissionSettings:permissionState(state), supportsExecutionSettings:true, supportsAttachments:true, executionSettings:executionSettings(state), supportsImages:true, supportsHistoryPages:true, threadId:state.id, title:state.title ?? state.fallbackSearchTitle ?? '未命名聊天', cwd:state.cwd ?? '', status:state.threadRuntimeStatus?.type ?? (active?'active':'idle'), activeTurnId:active?.turnId ?? '', messages:selected, turns:[...turnInfo.values()], approvals, questionGroups:normalizeQuestions(state,turns), updatedAt:Date.now() };
}
