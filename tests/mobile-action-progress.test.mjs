import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const ref = value => ({ value });

/** 以同步观察模拟同一事件循环内的断开和自动重连。 */
test('手动重连只跟踪本次握手，自动重连和其他入口各自独立', () => {
  const source = fs.readFileSync('apps/mobile/services/manual-reconnect.uts', 'utf8').replace(/^import .*\n/gm, '').replace('export ', '');
  const connection = { connected: false, connectionAttempt: 0 };
  const observers = [];
  let resumes = 0;
  function setAttempt(value) {
    connection.connectionAttempt = value;
    for (const changed of observers) changed(value);
  }
  const scope = vm.createContext({
    connection, ref, watch: (_read, changed) => observers.push(changed),
    bridge: { resume() { resumes++; if (!connection.connectionAttempt) setAttempt(1); } }
  });
  vm.runInContext(stripTypeScriptTypes(source) + '\nglobalThis.entry = useManualReconnect;', scope);
  const first = ref(false), second = ref(false);
  const reconnectFirst = scope.entry(value => { first.value = value; });
  const reconnectSecond = scope.entry(value => { second.value = value; });
  reconnectFirst(); reconnectFirst();
  assert.equal(resumes, 1);
  assert.equal(first.value, true);
  assert.equal(second.value, false);
  setAttempt(0); setAttempt(2);
  assert.equal(first.value, false);
  reconnectSecond();
  assert.equal(second.value, true);
  setAttempt(0);
  assert.equal(second.value, false);
});
