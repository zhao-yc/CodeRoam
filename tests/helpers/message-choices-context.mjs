import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../../apps/mobile/services/message-choices.uts', import.meta.url), 'utf8');
const names = [...source.matchAll(/export function (\w+)/g)].map(match => match[1]);
const body = source.replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
const script = new vm.Script(stripTypeScriptTypes('(() => { const reactive = value => value;\n' + body + '\nreturn {' + names.join(',') + '}; })()', { mode: 'transform' }));

/** 组件单元测试执行真实选项草稿模块，各上下文独立保存数据。 */
export function installMessageChoices(scope) {
  const helpers = script.runInContext(vm.createContext(scope));
  for (const [name, value] of Object.entries(helpers)) scope[name] ??= value;
  scope.submissionHasMessageChoices ??= () => false;
}
