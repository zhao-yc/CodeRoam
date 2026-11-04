import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientPresenceController } from '../apps/bridge/client-presence.mjs';

/** 小型虚拟时钟让五分钟边界无需真实等待，并确保取消的任务不会执行。 */
function fixture() {
  let now = 0, sequence = 0;
  const jobs = new Map(), changes = [];
  const controller = new ClientPresenceController({ onModeChange: mode => changes.push(mode), setTimeout: (run, delay) => { const id = ++sequence; jobs.set(id, { run, at: now + delay }); return id; }, clearTimeout: id => jobs.delete(id) });
  const advance = amount => {
    const end = now + amount;
    while (true) {
      const due = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; jobs.delete(due[0]); due[1].run();
    }
    now = end;
  };
  const configure = extra => controller.configure({ hostId: 'pc', supported: true, ...extra });
  const update = (onlineCount, revision, extra) => controller.update({ v: 1, type: 'clients.presence', hostId: 'pc', onlineCount, revision, ...extra });
  return { controller, configure, update, advance, changes, jobs };
}

test('旧中转和初次无快照保持兼容模式，不根据缺失人数进入轻量模式', () => {
  const f = fixture();
  f.controller.configure({ hostId: 'pc', supported: false });
  f.controller.disconnected(); f.advance(600000);
  assert.equal(f.controller.mode, 'legacy');
  assert.equal(f.update(0, 1), false);
  f.configure(); f.advance(600000);
  assert.equal(f.controller.mode, 'legacy');
  f.controller.disconnected(); f.advance(300000);
  assert.equal(f.controller.mode, 'light');
  f.controller.configure({ hostId: 'pc', supported: false });
  assert.equal(f.controller.mode, 'legacy');
});

test('连续无人五分钟才进入轻量模式，重复零人数与断线不会延长宽限', () => {
  const f = fixture(); f.configure();
  assert.equal(f.update(0, 1), true);
  assert.equal(f.controller.mode, 'grace');
  f.advance(120000); f.update(0, 2); f.controller.disconnected();
  f.advance(179999); assert.equal(f.controller.mode, 'grace');
  f.advance(1); assert.equal(f.controller.mode, 'light');
  f.update(0, 3); f.advance(600000);
  assert.deepEqual(f.changes, ['grace', 'light']);
});

test('临界重连有人立即恢复，取消旧计时；再次无人拥有新的五分钟', () => {
  const f = fixture(); f.configure(); f.update(1, 1); f.controller.disconnected();
  f.advance(299999); f.configure(); f.update(1, 1); f.advance(1);
  assert.equal(f.controller.mode, 'online'); assert.equal(f.jobs.size, 0);
  f.update(0, 2); f.advance(299999); assert.equal(f.controller.mode, 'grace');
  f.advance(1); assert.equal(f.controller.mode, 'light');
  f.update(2, 3); assert.equal(f.controller.mode, 'online');
});

test('重连零人数保留连续宽限，旧序号代次和无效计数不切换模式', () => {
  const f = fixture(), generation = 'generation-one'; f.configure({ generation });
  assert.equal(f.update(2, 10, { generation }), true);
  for (const message of [{ generation, revision: 9 }, { generation, revision: 10 }, { generation: 'old-generation', revision: 11 }, { generation, revision: 11, hostId: 'other' }, { generation, revision: 11, onlineCount: -1 }, { generation, revision: 11, onlineCount: 1.5 }, { generation, revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(f.update(0, 11, message), false);
  }
  assert.equal(f.controller.mode, 'online');
  f.controller.disconnected();
  assert.equal(f.update(1, 11, { generation }), false);
  f.advance(120000); f.configure({ generation });
  assert.equal(f.update(0, 1, { generation }), true);
  f.advance(180000); assert.equal(f.controller.mode, 'light');
  f.configure({ generation: 'generation-two' });
  assert.equal(f.update(1, 100, { generation }), false);
  assert.equal(f.update(1, 1, { generation: 'generation-two' }), true);
  assert.equal(f.controller.mode, 'online');
});

test('关闭会取消定时器并忽略后续快照与配置', () => {
  const f = fixture(); f.configure(); f.update(0, 1); f.controller.close();
  f.advance(600000); assert.deepEqual(f.changes, ['grace']); assert.equal(f.jobs.size, 0);
  assert.equal(f.update(1, 2), false); f.controller.disconnected(); f.configure();
  assert.equal(f.jobs.size, 0);
});
