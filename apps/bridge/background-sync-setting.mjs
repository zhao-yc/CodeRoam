import fs from 'node:fs';
import {writePrivateJson} from './management-files.mjs';

/** 旧数据目录默认同步；现有设置损坏或不可读时保持暂停，等待本机用户重新确认。 */
export function readBackgroundSyncSetting(file) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > 4096) return false;
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.enabled === true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

/** 先持久化用户选择，再更新各实例的有效值；文件写入失败时继续使用原状态。 */
export function applyBackgroundSyncSetting(file, config, agents, enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('后台数据同步开关必须是布尔值');
  writePrivateJson(file, {enabled});
  config.backgroundSyncEnabled = enabled;
  for (const agent of agents()) agent.setBackgroundSyncEnabled(enabled);
  return {backgroundSyncEnabled: enabled};
}
