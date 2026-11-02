import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../../packages/protocol/contracts.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : '';

/** 父电脑的鉴权覆盖其匿名实例编号，运行代次只保存在内存，重启后一律离线。 */
export class HostInstances {
  constructor(file = null) {
    this.file = file; this.entries = new Map(); this.managed = new Set();
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.instances)) throw new Error('实例登记文件无效');
      for (const row of saved.instances) {
        if (!this.validId(row.parentId, row.id)) throw new Error('实例归属记录无效');
        this.entries.set(row.id, { id: row.id, parentId: row.parentId, label: clean(row.label), online: false, generation: null });
      }
    }
  }
  validId(parentId, id) { return typeof parentId === 'string' && typeof id === 'string' && (id === parentId || id.startsWith(parentId + '~') && uuid.test(id.slice(parentId.length + 1))); }
  /** 完整校验和原子落盘成功后才替换登记，不能留下半份设备清单。 */
  update(parentId, instances) {
    if (!Array.isArray(instances) || instances.length > 16) throw new BridgeError('BAD_INSTANCES', '实例清单无效');
    const next = new Map(this.entries), ids = new Set();
    for (const [id, row] of next) if (row.parentId === parentId) next.set(id, { ...row, online: false, generation: null });
    for (const row of instances) {
      if (!row || !this.validId(parentId, row.id) || ids.has(row.id) || !uuid.test(row.generation ?? '') || typeof row.online !== 'boolean') throw new BridgeError('BAD_INSTANCES', '实例身份或运行代次无效');
      ids.add(row.id);
      next.set(row.id, { id: row.id, parentId, generation: row.generation, online: row.online, label: clean(row.label), reason: row.online ? '' : '实例连接尚未就绪' });
    }
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      try { fs.writeFileSync(temporary, JSON.stringify({ version: 1, instances: [...next.values()].map(({ id, parentId, label }) => ({ id, parentId, label })) }), { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, this.file); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }
    this.entries = next; this.managed.add(parentId);
    return [...next.values()].filter(row => row.parentId === parentId);
  }
  ids(parents) { return [...new Set(parents.flatMap(parent => [parent, ...[...this.entries.values()].filter(row => row.parentId === parent && row.id !== parent).map(row => row.id)]))]; }
  authorized(parents, id) { return parents.includes(id) || parents.includes(this.entries.get(id)?.parentId); }
  row(id) { return this.entries.get(id); }
  owns(parent, id, generation) { const row = this.row(id); return row?.parentId === parent && row.online && row.generation === generation; }
  disconnect(parent) { this.managed.delete(parent); for (const [id, row] of this.entries) if (row.parentId === parent) this.entries.set(id, { ...row, online: false, generation: null }); }
}
