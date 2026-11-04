import { createHash } from 'node:crypto';

const PREVIEW_ID = /^preview:[a-f0-9]{32}$/;
const text = value => typeof value === 'string' ? value : '';

/** 问题缓存仅保留题干和选项；显示编号不可用于桌面的回答请求。 */
export function questionPreviews(source) {
  const live = Array.isArray(source.questionGroups);
  const groups = live ? source.questionGroups : source.questionPreviews;
  if (!Array.isArray(groups)) return [];
  const result = [];
  let bytes = 0;
  for (const group of groups.slice(-80)) {
    if (!group || live && group.state !== 'pending' || !Array.isArray(group.questions)) continue;
    if (!live && !PREVIEW_ID.test(group.id)) continue;
    const id = live ? 'preview:' + createHash('sha256').update(JSON.stringify([text(group.id), text(group.turnId)])).digest('hex').slice(0, 32) : group.id;
    const questions = group.questions.slice(0, 20).filter(item => item && typeof item.title === 'string').map((item, index) => ({
      id: id + ':' + index, title: item.title, header: text(item.header),
      options: (Array.isArray(item.options) ? item.options : []).slice(0, 50).filter(option => option && typeof option.label === 'string').map(option => ({ label: option.label, description: text(option.description) })),
      isOther: item.isOther !== false, isSecret: item.isSecret === true,
    }));
    if (!questions.length) continue;
    const preview = { id, questions };
    bytes += Buffer.byteLength(JSON.stringify(preview));
    if (bytes > 128 * 1024) break;
    result.push(preview);
  }
  return result;
}
