import { BridgeError, requireString } from '../../packages/protocol/contracts.mjs';

const OPEN = '<send_user_message_question_reply>';
const CLOSE = '</send_user_message_question_reply>';

/** 待回答数量与阻塞状态分开同步，异步问题在任务运行时也需要可见提醒。 */
export function questionCounts(snapshot) {
  const pending = (snapshot.questionGroups ?? []).filter(group => group.state === 'pending');
  const running = !!snapshot.activeTurnId || snapshot.status === 'active';
  return {pendingQuestionCount: pending.filter(group => group.kind === 'native' || !running).length, unansweredQuestionCount: pending.length};
}

/** 只解析桌面明确标记的回答，不把普通消息列表误认为问答。 */
export function parseQuestionReply(text) {
  if (typeof text !== 'string' || !text.trim().startsWith(OPEN) || !text.trim().endsWith(CLOSE)) return [];
  try {
    const value = JSON.parse(text.trim().slice(OPEN.length, -CLOSE.length));
    return (Array.isArray(value) ? value : [value]).filter(x => typeof x?.questionItemId === 'string' && typeof x.answer === 'string');
  } catch { return []; }
}

/** 原生问答完成项按原位置显示为用户回复；保密题只展示已填写状态。 */
export function questionResponseText(item) {
  if(item.type !== 'userInputResponse' || item.completed !== true) return '';
  return (item.questions ?? []).slice(0,20).map(question => {
    const value=item.answers?.[question.id];
    const answer=(Array.isArray(value)?value:value?.answers??[]).filter(text=>typeof text==='string').join('、');
    return `${question.title ?? question.question ?? '问题'}\n回答：${answer.length ? question.isSecret === true ? '已填写' : answer : '未填写'}`;
  }).join('\n\n');
}

/** 统一原生请求与异步助手题目；题目身份始终来自桌面结构化数据。 */
export function normalizeQuestions(state, turns) {
  const replies = new Map();
  const positions = new Map();
  let position = 0;
  let latestConversationInput = -1;
  for (const turn of turns) for (const item of turn.items ?? []) {
    positions.set(item, position++);
    if (item.type !== 'userMessage' && !(item.type === 'steeringUserMessage' && item.status === 'accepted')) continue;
    const content = item.content ?? item.input;
    // 文本可与图片等附件并存；不能因内容块不止一项就漏掉已接受的结构化答案。
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? '' : '').join('\n') : '';
    const answers = parseQuestionReply(text);
    if (answers.length) for (const reply of answers) replies.set(reply.questionItemId, reply.answer);
    // 普通回复会继续对话，但不猜测它对应哪道题；此前未明确收齐答案的异步题组只标记过期。
    else if (text.trim() || (Array.isArray(content) && content.some(part => ['image', 'localImage'].includes(part?.type)))) latestConversationInput = positions.get(item);
  }
  const groups = new Map();
  const makeQuestions = (questions, asyncId) => (questions ?? []).slice(0, 20).map((q, index) => ({
    id: asyncId == null ? String(q.id) : JSON.stringify(['request_user_input_async', asyncId, index]),
    title: String(q.title ?? q.question ?? ''), header: String(q.header ?? ''),
    options: (q.options ?? []).slice(0, 50).map(option => typeof option === 'string' ? {label: option, description: ''} : {label: String(option.label ?? ''), description: String(option.description ?? '')}),
    isOther: q.isOther !== false, isSecret: q.isSecret === true, answer: ''
  }));
  for (const turn of turns) for (const item of turn.items ?? []) {
    if (item.type === 'agentMessage' && item.questions?.length) {
      const questions = makeQuestions(item.questions, item.id);
      for (const q of questions) q.answer = replies.get(q.id) ?? '';
      const answered = questions.every(q => q.answer.length > 0);
      const superseded = latestConversationInput > positions.get(item);
      groups.set(`async:${item.id}`, {id: `async:${item.id}`, kind: 'async', turnId: turn.turnId ?? '', state: answered ? 'answered' : superseded ? 'expired' : 'pending', questions});
    } else if (item.type === 'userInputResponse' && item.questions?.length) {
      const questions = makeQuestions(item.questions);
      for (const q of questions) {const answer=item.answers?.[q.id];q.answer=(Array.isArray(answer)?answer:answer?.answers??[]).join('、');}
      groups.set(`native:${item.requestId}`, {id: `native:${item.requestId}`, kind: 'native', turnId: turn.turnId ?? '', state: item.completed ? 'answered' : 'expired', questions});
    }
  }
  for (const entry of state.requests ?? []) {
    const request = entry.request ?? entry;
    if (request.method !== 'item/tool/requestUserInput' || request.completed === true) continue;
    // 已完成原生回答优先于同一轮尚未清理的请求，防止旧请求把题组改回待回答。
    const completed = groups.get(`native:${request.id}`);
    if (completed?.state === 'answered' && completed.turnId === (request.params.turnId ?? '')) continue;
    groups.set(`native:${request.id}`, {id: `native:${request.id}`, kind: 'native', turnId: request.params.turnId ?? '', state: 'pending', questions: makeQuestions(request.params.questions)});
  }
  return [...groups.values()].slice(-80);
}

/** 回传前按原题校验完整答案；不接受手机伪造问题、选项或请求编号。 */
export function validateQuestionAnswers(group, answers) {
  if (!Array.isArray(answers) || answers.length !== group.questions.length) throw new BridgeError('BAD_ANSWERS', '请完成本组所有问题后提交');
  const ids = new Set();
  return group.questions.map(question => {
    const answer = answers.find(value => value?.questionId === question.id);
    if (!answer || ids.has(answer.questionId)) throw new BridgeError('BAD_ANSWERS', '回答的问题编号不匹配');
    ids.add(answer.questionId);
    // 已回答的子题保持原值，避免多题分批回答时覆盖桌面结果。
    const text = requireString(answer.text, '答案', 32000).trim();
    if (question.answer && question.answer !== text) throw new BridgeError('STALE_QUESTION', '部分问题已在其他设备回答，请重新同步');
    if (!question.isOther && !question.options.some(option => option.label === text)) throw new BridgeError('BAD_ANSWERS', '请从提供的选项中选择');
    return {questionId: question.id, text};
  });
}

export function formatQuestionReply(group, answers) {
  return `${OPEN}\n${JSON.stringify(answers.filter(answer => !group.questions.find(q => q.id === answer.questionId).answer).map(answer => ({questionItemId: answer.questionId, question: group.questions.find(q => q.id === answer.questionId).title, answer: answer.text})))}\n${CLOSE}`;
}
