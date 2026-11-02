import { hostname } from 'node:os';

/** 默认名称随系统电脑名变化；兼容旧配对配置，同时保留用户设置的别名。 */
export function computerName(label) {
  const custom = typeof label === 'string' ? label.trim() : '';
  return custom && custom !== '我的 Windows 电脑' ? custom : hostname();
}
