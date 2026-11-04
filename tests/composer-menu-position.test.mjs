import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = stripTypeScriptTypes(fs.readFileSync('apps/mobile/services/composer-menu-position.uts', 'utf8'), { mode: 'transform' });
const { composerMenuPosition } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('加号与模型菜单距离触发入口均为 8px，输入区增高不改变间距', () => {
  for (const top of [730, 560, 350]) {
    const add = composerMenuPosition(20, 64, top, 0, 60, 844, 390, 330, false);
    const model = composerMenuPosition(230, 340, top, 0, 60, 844, 390, 330, true);
    assert.equal(844 - add.bottom, top - 8);
    assert.equal(844 - model.bottom, top - 8);
    assert.equal(add.left, 20); assert.equal(model.left, 14);
  }
});
test('宽屏菜单使用所在分栏坐标，小屏限制滚动高度并保留两侧边距', () => {
  const pane = composerMenuPosition(420, 464, 700, 400, 80, 800, 600, 330, false);
  assert.equal(pane.left, 20); assert.equal(800 - pane.bottom, 692);
  const small = composerMenuPosition(240, 288, 260, 0, 60, 420, 320, 292, true);
  assert.equal(small.left, 14); assert.ok(small.left + 292 <= 320 - 14);
  assert.equal(small.height + 56 + 12 + 8, 260 - 60);
});
