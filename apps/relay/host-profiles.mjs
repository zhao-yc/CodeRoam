import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../../packages/protocol/contracts.mjs';

export const HOST_ICONS = new Set(['code', 'terminal', 'laptop', 'desktop']);

/** 连接外观独立于鉴权配置；同步写入在事件循环内串行执行，落盘成功才更新内存。 */
export class HostProfiles {
  constructor(file = null) {
    this.file = file;
    this.entries = new Map();
    if (!file || !fs.existsSync(file)) return;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.hosts)) throw new Error();
      for (const entry of saved.hosts) {
        if (!entry || typeof entry.id !== 'string' || typeof entry.reportedLabel !== 'string' || typeof entry.hostname !== 'string' || !['', 'codex-desktop'].includes(entry.connectionType) || !Number.isSafeInteger(entry.lastConnectedAt) || entry.lastConnectedAt < 0 || !Number.isSafeInteger(entry.profileRevision) || entry.profileRevision < 0 || !HOST_ICONS.has(entry.icon) || typeof entry.displayName !== 'string') throw new Error();
        this.entries.set(entry.id, entry);
      }
    } catch { throw new Error('连接显示信息无法读取，请检查数据文件或恢复备份'); }
  }

  get(id) {
    return this.entries.get(id) ?? { id, reportedLabel: '', hostname: '', connectionType: '', lastConnectedAt: 0, displayName: '', icon: 'laptop', profileRevision: 0 };
  }

  /** 原子替换独立数据文件，失败时保留旧文件、旧内存以及用户草稿。 */
  commit(entry) {
    const next = new Map(this.entries).set(entry.id, entry);
    if (this.file) {
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      let descriptor;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify({ version: 1, hosts: [...next.values()] }));
        fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
        fs.renameSync(temporary, this.file);
      } catch {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        try { fs.unlinkSync(temporary); } catch {}
        throw new BridgeError('PROFILE_STORAGE_FAILED', '连接显示信息保存失败，请稍后重试');
      }
    }
    this.entries = next;
    return entry;
  }

  /** 主机上报不覆盖手机设置的名称和图标，也不递增用户编辑版本。 */
  observe(id, message) {
    const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : '';
    const previous = this.get(id);
    return this.commit({ ...previous, reportedLabel: clean(message.label) || previous.reportedLabel, hostname: clean(message.hostname) || previous.hostname, connectionType: message.connectionType === 'codex-desktop' ? message.connectionType : previous.connectionType, lastConnectedAt: Date.now() });
  }

  /** 版本检查防止多台手机用旧草稿覆盖已保存的设置。 */
  update(id, { displayName, icon, expectedRevision }) {
    const previous = this.get(id);
    if (previous.profileRevision !== expectedRevision) throw new BridgeError('PROFILE_CONFLICT', '连接已在其他客户端修改，请关闭后重新打开编辑');
    return this.commit({ ...previous, displayName: displayName.trim(), icon, profileRevision: previous.profileRevision + 1 });
  }

  computer(id, online) {
    const entry = this.get(id);
    return { id, label: entry.displayName || entry.reportedLabel || id, online, icon: entry.icon, hostname: entry.hostname, connectionType: entry.connectionType, lastConnectedAt: entry.lastConnectedAt, profileRevision: entry.profileRevision };
  }
}
