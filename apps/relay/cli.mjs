import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { createRelay } from './server.mjs';
import path from 'node:path';
import { HostProfiles } from './host-profiles.mjs';
import { HostInstances } from './host-instances.mjs';

const { values } = parseArgs({ options: { config: { type: 'string', default: '.local/relay.json' }, data: { type: 'string', default: '.local/relay-data' }, port: { type: 'string', default: '8787' }, host: { type: 'string', default: '127.0.0.1' } } });
try {
  const relay = createRelay({ ...JSON.parse(fs.readFileSync(values.config, 'utf8')), profiles: new HostProfiles(path.join(values.data, 'host-profiles.json')), instances: new HostInstances(path.join(values.data, 'host-instances.json')) });
  const address = await relay.listen(Number(values.port), values.host);
  console.log(`中转服务已启动：http://${address.address}:${address.port}/healthz`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await relay.close(); };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
} catch (error) { console.error(`中转服务启动失败：${error.message}`); process.exitCode = 1; }
