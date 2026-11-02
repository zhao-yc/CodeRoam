import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 配置目录只留在本机，公网编号随机生成，不用目录散列或 PID 暴露本机信息。 */
export class InstanceRegistry {
  constructor({ file, hostId, defaultHome, label, backupDirectory = null, platform = process.platform }) {
    this.platform = platform;
    this.file = file; this.hostId = hostId; this.defaultHome = this.canonical(defaultHome); this.label = label;
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, entries: [] };
    if (saved.version !== 1 || !Array.isArray(saved.entries)) throw new Error('本机实例登记无效');
    const ids = new Set(), homes = new Set();
    for (const entry of saved.entries) {
      if (!entry || typeof entry.id !== 'string' || !(entry.id === hostId || entry.id.startsWith(hostId + '~') && /^[0-9a-f-]{36}$/i.test(entry.id.slice(hostId.length + 1))) || typeof entry.home !== 'string' || !path.isAbsolute(entry.home) || typeof entry.userData !== 'string' || entry.userData !== 'default' && !path.isAbsolute(entry.userData) || !Number.isSafeInteger(entry.ordinal) || entry.ordinal < 1 || ids.has(entry.id) || homes.has(entry.home + '\0' + entry.userData)) throw new Error('本机实例身份记录无效');
      ids.add(entry.id); homes.add(entry.home + '\0' + entry.userData);
    }
    this.entries = saved.entries;
    this.backupDirectory = backupDirectory;
  }
  /** Windows 保持既有大小写归一化；Mac 保留路径大小写，兼容区分大小写的卷。 */
  canonical(value) {
    let resolved = path.resolve(value);
    if (this.platform === 'darwin') { try { resolved = fs.realpathSync.native(resolved); } catch { /* 尚未创建的目录仍按原绝对路径登记。 */ } }
    const normalized = resolved.replace(/[\\/]+$/, '') || path.parse(resolved).root;
    return this.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }
  /** 默认配置复用原电脑身份；同目录多开按独立桌面用户目录区分。 */
  identify(instance) {
    const home = this.canonical(instance.codexHome), userData = instance.userData ? this.canonical(instance.userData) : 'default';
    let entry = this.entries.find(row => row.home === home && row.userData === userData);
    if (!entry) {
      const isDefault = home === this.defaultHome && !this.entries.some(row => row.id === this.hostId);
      const ordinal = this.entries.length + 1;
      entry = { home, userData, id: isDefault ? this.hostId : this.hostId + '~' + randomUUID(), ordinal };
      const entries = [...this.entries, entry];
      if (this.backupDirectory) {
        fs.mkdirSync(this.backupDirectory, { recursive: true });
        fs.writeFileSync(path.join(this.backupDirectory, 'instances.json'), JSON.stringify({ version: 1, entries }), { mode: 0o600 });
        fs.writeFileSync(path.join(this.backupDirectory, '实例登记备份说明.md'), '# 实例登记备份\n\n此文件保存本机配置目录与匿名设备编号的对应关系，不含登录或配对令牌。恢复时先停止电脑连接服务，将 instances.json 恢复至原连接服务数据目录，再核对原配对配置和目录归属。不要公开此目录。\n', { mode: 0o600 });
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      try { fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, this.file); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      this.entries = entries;
    }
    return { ...entry, label: entry.id === this.hostId ? this.label : this.label + ' · 实例 ' + entry.ordinal };
  }
}
