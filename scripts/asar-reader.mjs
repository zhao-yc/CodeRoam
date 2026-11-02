import fs from 'node:fs';

/** 按文件索引读取安装包；不解包、不执行安装包中的代码。 */
export class AsarReader {
  constructor(filePath) {
    this.fd = fs.openSync(filePath, 'r');
    const prefix = Buffer.alloc(16);
    fs.readSync(this.fd, prefix, 0, 16, 0);
    const size = prefix.readUInt32LE(12);
    if (size <= 0 || size > 32 * 1024 * 1024) throw new Error('安装包索引长度异常');
    this.dataOffset = 8 + prefix.readUInt32LE(4);
    const header = Buffer.alloc(size);
    fs.readSync(this.fd, header, 0, size, 16);
    this.files = new Map();
    this.walk(JSON.parse(header.toString('utf8')));
  }

  walk(entry, base = '') {
    for (const [name, metadata] of Object.entries(entry.files ?? {})) {
      const filePath = base + name;
      if (metadata.files) this.walk(metadata, `${filePath}/`);
      else this.files.set(filePath, metadata);
    }
  }

  text(filePath) {
    const metadata = this.files.get(filePath);
    if (!metadata || metadata.unpacked || metadata.size > 16 * 1024 * 1024) throw new Error(`无法读取安装包文件：${filePath}`);
    const data = Buffer.alloc(metadata.size);
    fs.readSync(this.fd, data, 0, data.length, this.dataOffset + Number(metadata.offset));
    return data.toString('utf8');
  }

  close() { fs.closeSync(this.fd); }
}
