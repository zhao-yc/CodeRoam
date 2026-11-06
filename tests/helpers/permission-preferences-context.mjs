import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const source = fs.readFileSync(new URL('../../apps/mobile/services/permission-preferences.uts', import.meta.url), 'utf8');
const body = source.replace(/^import .*\r?\n/gm, '').replace(/\bexport /g, '');
const script = new vm.Script(stripTypeScriptTypes('(() => { const reactive = value => value;\n' + body + '\nreturn {readPermissionPreference, savePermissionPreference}; })()', { mode: 'transform' }));

/** 每个组件测试使用独立偏好模块，存储接口由调用方提供。 */
export function installPermissionPreferences(scope) {
  const preferences = script.runInContext(vm.createContext(scope));
  for (const [name, value] of Object.entries(preferences)) scope[name] ??= value;
}
