import { installMessageChoices } from './message-choices-context.mjs';
import { installPermissionPreferences } from './permission-preferences-context.mjs';
import vm from 'node:vm';

/** 为 UTS 组件脚本提供 Vue 宏和面板显隐，沿用各用例原有的计时器与页面模拟。 */
export function componentScope(scope) {
  const connection = scope.connection ?? {};
  const props = {active: false, paneWidth: 390, paneHeight: 800, target: {hostId: connection.hostId ?? 'pc', threadId: connection.activeThreadId ?? 'thread', title: '', projectName: '', cacheNamespace: connection.cacheNamespace ?? ''}, ...scope.props};
  scope.props ??= props;
  scope.defineProps ??= () => ({...props, ...scope.props});
  scope.withDefaults ??= (value, defaults) => ({...defaults, ...value});
  scope.defineExpose ??= () => {};
  scope.defineEmits ??= () => scope.emit ?? (() => {});
  scope.onMounted ??= callback => scope.onLoad?.(callback);
  scope.onUnmounted ??= callback => scope.onUnload?.(callback);
  scope.onPaneShow ??= scope.onShow ?? (() => {});
  scope.onPaneHide ??= scope.onHide ?? (() => {});
  scope.onPaneResize ??= scope.onResize ?? (() => {});
  scope.showTaskNoticeThread ??= () => 0;
  scope.hideTaskNoticeThread ??= () => {};
  // Node 中执行组件脚本时使用跨平台后备控件。
  scope.useLiquidGlass ??= () => false;
  // 测试各页面时注入连接入口，握手代次由专门用例执行真实实现。
  scope.useManualReconnect ??= () => () => scope.bridge?.resume?.();
  scope.interactionSubmissions ??= [];
  const watch = scope.watch;
  if (watch != null) scope.watch = (source, callback, options) => {
    if (typeof source === 'function' && /props\.active/.test(source.toString())) {
      scope.onHide?.(() => callback(false));
      scope.onShow?.(() => callback(true));
    }
    return watch(source, callback, options);
  };
  installMessageChoices(scope);
  installPermissionPreferences(scope);
  return scope;
}
export function componentContext(scope) { return vm.createContext(componentScope(scope)); }
