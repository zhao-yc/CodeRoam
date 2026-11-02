const MAX_ACTIVITY_LENGTH = 160;

/** 只提取桌面公开摘要的标题，不读取 reasoning.content 或工具输入输出。 */
export function activityHeading(summary) {
  if (!Array.isArray(summary)) return '';
  const lines = summary.filter(value => typeof value === 'string').slice(-8).flatMap(value => value.slice(0, 8192).split(/\r?\n/));
  let heading = '';
  for (const line of lines) {
    const match = line.match(/^\s{0,3}(?:#{1,6}\s+(.+?)\s*#*|\*\*([^*]+)\*\*)\s*$/);
    if (match) heading = match[1] ?? match[2];
  }
  // 旧桌面也会直接提供不带 Markdown 的单行动作名称；多段正文不当作标题传播。
  const nonempty = lines.map(line => line.trim()).filter(Boolean);
  if (!heading && nonempty.length === 1 && nonempty[0].length <= MAX_ACTIVITY_LENGTH && !/[<>`*_]/.test(nonempty[0])) heading = nonempty[0];
  return heading.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ACTIVITY_LENGTH);
}

/** 仅当前运行轮次可以产生动作；优先复用桌面底部显示的最新摘要标题。 */
export function currentActivity(turn) {
  if (turn?.status !== 'inProgress' || turn.error) return '';
  const items = turn.items ?? [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.type !== 'reasoning') continue;
    const heading = activityHeading(item.summary);
    if (heading) return heading;
  }
  // 未提供公开标题时，只按结构化类型描述动作，不把原始命令或私有推理当进度。
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.completedAtMs != null || ['completed', 'failed', 'declined', 'interrupted'].includes(item.status)) continue;
    if (item.type === 'commandExecution') {
      const actions = item.commandActions ?? [];
      if (actions.length && actions.every(action => action.type === 'read')) return '正在读取文件';
      if (actions.length && actions.every(action => action.type === 'search')) return '正在搜索代码';
      if (actions.length && actions.every(action => action.type === 'listFiles')) return '正在查看文件目录';
      return '正在执行命令';
    }
    if (item.type === 'fileChange') return '正在修改文件';
    if (item.type === 'webSearch') return '正在搜索网页';
    if (['mcpToolCall', 'dynamicToolCall'].includes(item.type)) return '正在调用工具';
    if (item.type === 'automaticApprovalReview') return '正在核对操作权限';
    if (['agentMessage', 'assistantMessage'].includes(item.type)) return '正在生成回复';
    if (item.type === 'reasoning') return '正在分析';
  }
  return '';
}
