import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const key = 'codex-mobile-new-message-behavior';
/** 执行实际偏好模块和设置组件，使用独立存储验证跨启动恢复及失败边界。 */
function fixture(storage = new Map(), readError = false) {
  let sheet;
  const notices = [], uni = {
    getStorageSync(name) { if (readError) throw Error('合成读取错误'); return storage.get(name); },
    setStorageSync(name, value) { storage.set(name, value); },
    hideKeyboard() {}, showActionSheet(options) { sheet = options; }, showToast(options) { notices.push(options.title); }
  };
  const context = vm.createContext({ reactive: value => value, computed: fn => ({ get value() { return fn(); } }), uni });
  const source = fs.readFileSync('apps/mobile/services/message-sending-preferences.uts', 'utf8').replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
  const component = fs.readFileSync('apps/mobile/components/message-sending-setting/message-sending-setting.uvue', 'utf8').split('<script setup lang="uts">')[1].split('</script>')[0].replace(/^import .*\r?\n/gm, '');
  vm.runInContext(stripTypeScriptTypes(source + '\n' + component, { mode: 'transform' }) + '\nglobalThis.subject={messageSendingPreferences,setMessageSendingBehavior,messageSendingBehaviorLabel,chooseBehavior,behaviorLabel};', context);
  return { ...context.subject, uni, storage, notices, sheet: () => sheet };
}

test('未设置、无效值和读取失败均默认排队，两种有效偏好可跨启动恢复', () => {
  for (const value of [undefined, '', 'invalid', 0, null, {}, ['steer']]) assert.equal(fixture(new Map([[key, value]])).messageSendingPreferences.behavior, 'queue');
  assert.equal(fixture(new Map(), true).messageSendingPreferences.behavior, 'queue');
  const first = fixture();
  first.setMessageSendingBehavior('steer'); assert.equal(first.behaviorLabel.value, '追加指令');
  assert.equal(fixture(first.storage).messageSendingPreferences.behavior, 'steer');
  first.setMessageSendingBehavior('queue'); assert.equal(fixture(first.storage).behaviorLabel.value, '排队');
  assert.deepEqual([...first.storage.keys()], [key]);
});

test('存储失败或非法选项不改变已确认偏好，错误不暴露原始异常', () => {
  const f = fixture(); f.setMessageSendingBehavior('steer');
  f.uni.setStorageSync = () => { throw Error('不应展示的合成原始错误'); };
  assert.throws(() => f.setMessageSendingBehavior('queue'), /无法保存新消息发送行为/);
  assert.equal(f.messageSendingPreferences.behavior, 'steer'); assert.equal(f.storage.get(key), 'steer');
  assert.throws(() => f.setMessageSendingBehavior('invalid'), /选项无效/);
});

test('设置选择器提供排队与追加指令，取消不保存，选择后立即显示实际值', () => {
  const f = fixture(); f.chooseBehavior();
  assert.deepEqual(Array.from(f.sheet().itemList), ['排队', '追加指令']);
  f.sheet().fail({}); assert.equal(f.storage.size, 0);
  f.sheet().success({ tapIndex: 1 }); assert.equal(f.behaviorLabel.value, '追加指令'); assert.equal(f.storage.get(key), 'steer');
  f.sheet().success({ tapIndex: -1 }); assert.equal(f.storage.get(key), 'steer');
  f.uni.setStorageSync = () => { throw Error('合成原始错误'); };
  f.sheet().success({ tapIndex: 0 }); assert.equal(f.behaviorLabel.value, '追加指令'); assert.match(f.notices[0], /无法保存新消息发送行为/);
});
