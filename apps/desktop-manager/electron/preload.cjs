const {contextBridge, ipcRenderer} = require('electron');

// Electron 的内部通道名称不进入用户提示，保留后台返回的中文操作说明。
async function invoke(channel, value) {
  try { return await ipcRenderer.invoke(channel, value); }
  catch (error) { throw new Error(String(error.message ?? '').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || '管理操作未完成，请重试'); }
}

// 渲染页面只获得固定管理动作，不能提交任意 IPC 方法、路径或系统命令。
contextBridge.exposeInMainWorld('desktopManager', Object.freeze({
  getContext: () => invoke('manager:context'),
  chooseWorker: () => invoke('manager:choose-worker'),
  status: () => invoke('manager:status'),
  readConfig: () => invoke('manager:read-config'),
  saveConfig: value => invoke('manager:save-config', value),
  readLogs: value => invoke('manager:read-logs', value ?? {}),
  setBackgroundSync: value => invoke('manager:set-background-sync', value),
  setStartup: value => invoke('manager:set-startup', value),
  restart: () => invoke('manager:restart'),
  start: () => invoke('manager:start'),
  stop: () => invoke('manager:stop'),
}));
