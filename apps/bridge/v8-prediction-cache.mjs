const cageOf = address => address & ~0xffffffffn;
const tagged = address => Number(address & 0xffffffffn) + 1;
const hex = address => '0x' + address.toString(16);
const unavailable = () => new Error('桌面预测缓存结构暂不可读');

/** 只解释已核验进程中的数据字段，不执行 getter、脚本或预测生成方法。 */
export class V8PredictionCache {
  constructor(memory) {
    this.memory = memory;
    this.pages = new Map();
    this.anchors = null;
  }

  async bytes(address, length) {
    if (address < 0n || length < 0 || length > 65536) throw unavailable();
    const parts = [];
    for (let offset = 0; offset < length;) {
      const current = address + BigInt(offset), page = current & ~4095n;
      if (!this.pages.has(page)) this.pages.set(page, this.memory.read(hex(page), 4096));
      const buffer = await this.pages.get(page);
      if (!Buffer.isBuffer(buffer) || buffer.length !== 4096) throw unavailable();
      const start = Number(current - page), count = Math.min(length - offset, 4096 - start);
      parts.push(buffer.subarray(start, start + count));
      offset += count;
    }
    return Buffer.concat(parts);
  }

  async word(address) { return (await this.bytes(address, 4)).readUInt32LE(); }
  pointer(origin, value) {
    if ((value & 3) !== 1) throw unavailable();
    return cageOf(origin) + BigInt(value - 1);
  }
  async pointerAt(address) { return this.pointer(address, await this.word(address)); }

  async map(address) {
    const mapAddress = await this.pointerAt(address), buffer = await this.bytes(mapAddress, 40);
    const count = (buffer.readUInt32LE(12) >>> 10) & 1023;
    if (count > 512 || buffer[4] < 3 || buffer[5] > buffer[4]) throw unavailable();
    return { address: mapAddress, type: buffer.readUInt16LE(8), size: buffer[4], descriptors: this.pointer(mapAddress, buffer.readUInt32LE(24)), count };
  }

  async string(address, limit = 32000, depth = 0) {
    if (depth > 32) throw unavailable();
    const header = await this.bytes(address, 12), mapAddress = this.pointer(address, header.readUInt32LE());
    const type = (await this.bytes(mapAddress + 8n, 2)).readUInt16LE();
    const length = header.readInt32LE(8);
    if (type >= 128 || length < 0 || length > limit) throw unavailable();
    const representation = type & 7;
    if (representation === 0) {
      const oneByte = (type & 8) !== 0;
      return (await this.bytes(address + 12n, length * (oneByte ? 1 : 2))).toString(oneByte ? 'latin1' : 'utf16le');
    }
    if (representation === 1) {
      const first = await this.string(await this.pointerAt(address + 12n), limit, depth + 1);
      const second = await this.string(await this.pointerAt(address + 16n), limit - first.length, depth + 1);
      if (first.length + second.length !== length) throw unavailable();
      return first + second;
    }
    if (representation === 5) {
      const actual = await this.string(await this.pointerAt(address + 12n), limit, depth + 1);
      if (actual.length !== length) throw unavailable();
      return actual;
    }
    if (representation === 3) {
      const rawOffset = await this.word(address + 16n);
      if (rawOffset & 1) throw unavailable();
      const offset = rawOffset >> 1;
      if (offset < 0 || offset + length > 32000) throw unavailable();
      const parent = await this.string(await this.pointerAt(address + 12n), 32000, depth + 1);
      if (offset + length > parent.length) throw unavailable();
      return parent.slice(offset, offset + length);
    }
    // 外部字符串需要另一套指针表；未知布局保持不可读，不能猜测正文地址。
    throw unavailable();
  }

  async name(address) {
    try { return await this.string(address, 128); } catch { /* 私有字段的键为 Symbol。 */ }
    const mapAddress = await this.pointerAt(address);
    const type = (await this.bytes(mapAddress + 8n, 2)).readUInt16LE();
    if (type < 128 || type >= 256) throw unavailable();
    return '@' + await this.string(await this.pointerAt(address + 12n), 128);
  }

  async descriptors(address, count, requiredName) {
    const header = await this.bytes(address, 16), total = header.readUInt16LE(4), used = header.readUInt16LE(6);
    if (count < 1 || count > used || used > total || total > 512) throw unavailable();
    const candidates = [];
    for (const headerSize of [16, 20]) {
      try {
        const entries = await this.bytes(address + BigInt(headerSize), count * 12), fields = [];
        for (let index = 0; index < count; index++) {
          const rawDetails = entries.readUInt32LE(index * 12 + 4);
          if ((rawDetails & 1) !== 0) throw unavailable();
          fields.push({ name: await this.name(this.pointer(address, entries.readUInt32LE(index * 12))), details: rawDetails >>> 1 });
        }
        if (requiredName === undefined || fields.some(field => field.name === requiredName)) candidates.push(fields);
      } catch { /* 一个候选布局失败后只检查另一个已知布局。 */ }
    }
    if (candidates.length !== 1) throw unavailable();
    return candidates[0];
  }

  async fields(address) {
    const shape = await this.map(address);
    if (shape.type < 256 || shape.count === 0) return [];
    const descriptors = await this.descriptors(shape.descriptors, shape.count);
    const fields = [];
    for (const descriptor of descriptors) {
      if ((descriptor.details & 1) !== 0 || ((descriptor.details >>> 5) & 1) !== 0) continue;
      if (((descriptor.details >>> 6) & 7) === 2) continue;
      const offset = (descriptor.details >>> 19) & 2047, inObject = (descriptor.details >>> 30) !== 0;
      let location;
      if (inObject) {
        if (offset < 3 || offset >= shape.size) throw unavailable();
        location = address + BigInt(offset * 4);
      } else {
        const properties = await this.pointerAt(address + 4n), capacity = ((await this.word(properties + 4n)) >>> 1) & 1023;
        if (offset < 2 || offset - 2 >= capacity) throw unavailable();
        location = properties + BigInt(offset * 4);
      }
      fields.push({ name: descriptor.name, location, value: await this.word(location) });
    }
    return fields;
  }

  async property(address, name) {
    const field = (await this.fields(address)).find(item => item.name === name);
    if (!field) throw unavailable();
    return { ...field, address: this.pointer(field.location, field.value) };
  }

  /** 以主宿主上的公开字段为锚点，避免把堆中已失效的预测对象直接当成当前缓存。 */
  async locate() {
    const keys = await this.memory.findKeys(['cumberbatchController']);
    if (keys.truncated || !keys.keys.length) throw unavailable();
    const references = await this.memory.references(keys.keys.map(key => {
      const address = BigInt(key.address);
      return { cage: hex(cageOf(address)), value: tagged(address) };
    }));
    if (references.truncated) throw unavailable();
    const arrays = new Map();
    for (const reference of references.matches) {
      const address = BigInt(reference.address);
      for (const headerSize of [16, 20]) for (let index = 0; index < 128; index++) {
        const candidate = address - BigInt(headerSize + index * 12);
        if (arrays.has(candidate)) continue;
        try {
          const header = await this.bytes(candidate, 16), count = header.readUInt16LE(6);
          if (count <= index || count > 512) continue;
          const fields = await this.descriptors(candidate, count, 'cumberbatchController');
          arrays.set(candidate, fields);
        } catch { /* 静态键也会出现在代码及过渡表中，只保留结构完整的描述数组。 */ }
      }
    }
    if (!arrays.size || arrays.size > 64) throw unavailable();
    const mapReferences = await this.memory.references([...arrays.keys()].map(address => ({ cage: hex(cageOf(address)), value: tagged(address) })));
    if (mapReferences.truncated) throw unavailable();
    const maps = new Set();
    for (const reference of mapReferences.matches) {
      const address = BigInt(reference.address) - 24n;
      try {
        const buffer = await this.bytes(address, 40), count = (buffer.readUInt32LE(12) >>> 10) & 1023;
        const descriptors = this.pointer(address, buffer.readUInt32LE(24));
        const fields = arrays.get(descriptors);
        if (buffer.readUInt16LE(8) < 256 || buffer[4] < 3 || !fields?.slice(0, count).some(field => field.name === 'cumberbatchController')) continue;
        maps.add(address);
      } catch { /* 错误偏移和回收中的 Map 不能成为对象来源。 */ }
    }
    const objectReferences = await this.memory.references([...maps].map(address => ({ cage: hex(cageOf(address)), value: tagged(address) })));
    if (objectReferences.truncated) throw unavailable();
    const anchors = new Map();
    for (const reference of objectReferences.matches) {
      try {
        const host = BigInt(reference.address), field = await this.property(host, 'cumberbatchController');
        const fields = await this.fields(field.address);
        if (!['queries', 'service', 'moderationMetadataBySourceTurn'].every(name => fields.some(item => item.name === name))) continue;
        const service = await this.property(field.address, 'service');
        if ((await this.property(service.address, 'controller')).address !== field.address) continue;
        anchors.set(field.location, { host, location: field.location, controller: field.address });
      } catch { /* 服务和控制器必须保持原始双向关系。 */ }
    }
    if (!anchors.size) throw unavailable();
    this.anchors = [...anchors.values()];
  }

  async mapEntry(address, expectedKey) {
    const table = await this.pointerAt(address + 12n), header = await this.bytes(table, 20);
    const length = header.readInt32LE(4), count = header.readInt32LE(8) >> 1;
    const deleted = header.readInt32LE(12) >> 1, buckets = header.readInt32LE(16) >> 1;
    if (count < 0 || deleted < 0 || count + deleted > 4096 || buckets < 0 || buckets > 4096 || (buckets & (buckets - 1)) !== 0 || length < 3 + buckets + (count + deleted) * 3) throw unavailable();
    const entries = await this.bytes(table + BigInt(20 + buckets * 4), (count + deleted) * 12);
    const found = [];
    for (let index = 0; index < count + deleted; index++) {
      try {
        const key = this.pointer(table, entries.readUInt32LE(index * 12));
        if (await this.string(key, 256) !== expectedKey) continue;
        found.push({ address: this.pointer(table, entries.readUInt32LE(index * 12 + 4)), table });
      } catch { /* 已删除槽位及其他查询不作为候选。 */ }
    }
    if (found.length > 1) throw unavailable();
    return found[0] ?? null;
  }

  async queries(controller, expectedKey) {
    const client = (await this.property(controller, 'queries')).address;
    const mapType = (await this.map((await this.property(controller, 'moderationMetadataBySourceTurn')).address)).type;
    const found = [];
    // QueryClient 的私有字段经描述表定位，按实际 Map 类型寻找 QueryCache 的索引。
    for (const clientField of await this.fields(client)) {
      if ((clientField.value & 3) !== 1) continue;
      try {
        const cache = this.pointer(clientField.location, clientField.value);
        for (const cacheField of await this.fields(cache)) {
          if ((cacheField.value & 3) !== 1) continue;
          const index = this.pointer(cacheField.location, cacheField.value);
          if ((await this.map(index)).type !== mapType) continue;
          const entry = await this.mapEntry(index, expectedKey);
          if (entry) found.push({ ...entry, index });
        }
      } catch { /* 默认设置和 MutationCache 等字段没有目标查询索引。 */ }
    }
    return found;
  }

  async readQuery(query, hostId, threadId, turnId) {
    const key = (await this.property(query.address, 'queryKey')).address;
    if ((await this.word(key + 12n)) !== 6) throw unavailable();
    const elements = await this.pointerAt(key + 8n);
    for (const [index, expected] of [hostId, threadId, turnId].entries()) {
      if (await this.string(await this.pointerAt(elements + 8n + BigInt(index * 4)), 128) !== expected) throw unavailable();
    }
    const state = (await this.property(query.address, 'state')).address;
    if (await this.string((await this.property(state, 'status')).address, 16) !== 'success' || await this.string((await this.property(state, 'fetchStatus')).address, 16) !== 'idle') return null;
    const data = (await this.property(state, 'data')).address;
    if (await this.string((await this.property(data, 'sourceTurnId')).address, 128) !== turnId) return null;
    const text = await this.string((await this.property(data, 'text')).address);
    return text.length ? { data, text } : null;
  }

  /** 两次独立回读缓存索引和字段；回收、替换、清空或歧义均不得返回旧预测。 */
  async read(hostId, threadId, turnId) {
    this.pages.clear();
    if (!this.anchors) await this.locate();
    const expectedKey = JSON.stringify([hostId, threadId, turnId]), values = [];
    for (const anchor of this.anchors) {
      if (await this.pointerAt(anchor.location) !== anchor.controller) throw unavailable();
      for (const query of await this.queries(anchor.controller, expectedKey)) {
        const result = await this.readQuery(query, hostId, threadId, turnId);
        if (result) values.push({ anchor, query, ...result });
      }
    }
    if (values.length !== 1) return null;
    const value = values[0];
    this.pages.clear();
    const anchor = await this.property(value.anchor.host, 'cumberbatchController');
    if (anchor.location !== value.anchor.location || anchor.address !== value.anchor.controller) throw unavailable();
    const queries = await this.queries(anchor.address, expectedKey);
    if (queries.length !== 1) return null;
    const entry = queries[0];
    if (entry.address !== value.query.address || entry.index !== value.query.index || entry.table !== value.query.table) return null;
    const repeated = await this.readQuery(entry, hostId, threadId, turnId);
    if (repeated?.data !== value.data || repeated.text !== value.text) return null;
    return { threadId, sourceTurnId: turnId, text: value.text };
  }
}
