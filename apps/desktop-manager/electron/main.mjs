import {app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createManagerController, trustedSender} from './manager-controller.mjs';
import {createServiceSession} from './service-session.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const rendererFile = path.resolve(directory, '../dist/index.html'), rendererUrl = pathToFileURL(rendererFile).href;
let window = null, tray = null, controller;
let session, restoring, quitting = false, quitReady = false;
app.setName('CodeRoam 电脑管理');
if (process.platform === 'win32') app.setAppUserModelId('com.codexmobile.manager');
// 沿用旧数据目录及自定义配置；首次安装先创建目录，改名后仍能关联原服务。
const requestedUserData = process.env.CODEX_MOBILE_MANAGER_USER_DATA;
const userData = requestedUserData && path.isAbsolute(requestedUserData)
  ? requestedUserData : path.join(app.getPath('appData'), '掌上 Codex 电脑管理');
fs.mkdirSync(userData, {recursive: true, mode: 0o700});
app.setPath('userData', userData);

/** 默认只发现标准安装位置；旧安装可通过原生文件选择器关联，避免猜测私人目录。 */
function initialWorker() {
  const argument = process.argv.indexOf('--worker-config');
  if (argument >= 0) return process.argv[argument + 1] ?? '';
  if (process.env.CODEX_MOBILE_WORKER_CONFIG) return process.env.CODEX_MOBILE_WORKER_CONFIG;
  if (process.platform === 'win32' && process.env.ProgramData) {
    try { return JSON.parse(fs.readFileSync(path.join(process.env.ProgramData, 'CodexMobile', 'Bridge', 'service.json'), 'utf8').replace(/^\uFEFF/, '')).WorkerConfig ?? ''; } catch { /* 尚未安装标准服务时显示选择入口。 */ }
  }
  return '';
}

/** 关闭窗口保留托盘，托盘和系统退出入口统一等待守护收尾。 */
function showWindow() {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({
    title: 'CodeRoam · 电脑管理', icon: path.join(directory, 'tray.png'), width: 1080, height: 780, minWidth: 860, minHeight: 640,
    backgroundColor: '#f6f7fb', autoHideMenuBar: true, show: false,
    webPreferences: {preload: path.join(directory, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true},
  });
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', (event, url) => { if (url.split('#')[0] !== rendererUrl) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.once('ready-to-show', () => window?.show());
  window.once('closed', () => { window = null; });
  window.loadFile(rendererFile);
}

/** 所有页面 IPC 都校验发送窗口和顶层来源，错误只返回管理接口的说明。 */
function handle(channel, action) {
  ipcMain.handle(channel, async (event, value) => {
    if (!trustedSender(event, window, rendererUrl)) throw new Error('此窗口不能访问本机管理接口');
    if (quitting) throw new Error('正在退出，请等待服务收尾');
    try { return await action(value); }
    catch (error) {
      const message = /^(?:MANAGEMENT|MANAGER)_[A-Z_]+$/.test(error?.code ?? '') && typeof error?.message === 'string' ? error.message.slice(0, 300) : '管理服务暂时不可用，请确认守护进程已升级并正在运行';
      throw new Error(message);
    }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => { /* 关闭窗口后继续驻留托盘。 */ });
  app.on('before-quit', event => {
    if (!session || quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    tray?.setToolTip('CodeRoam 正在停止连接服务');
    void (async () => {
      try {
        await restoring;
        await session.close(controller.context().workerConfigPath);
        quitReady = true;
        app.quit();
      } catch (error) {
        quitting = false;
        tray?.setToolTip('CodeRoam 电脑管理');
        const message = error?.code?.startsWith('MANAGEMENT_') ? error.message : '暂未确认守护安全退出，请检查运行状态后重试。';
        dialog.showErrorBox('连接服务尚未停止', message);
      }
    })();
  });
  app.whenReady().then(async () => {
    const clientFile = app.isPackaged
      ? path.join(process.resourcesPath, 'bridge-runtime', 'apps', 'bridge', 'management-client.mjs')
      : path.resolve(directory, '../../bridge/management-client.mjs');
    const {connectManagement} = await import(pathToFileURL(clientFile).href);
    controller = createManagerController({
      preferencesPath: path.join(app.getPath('userData'), 'manager.json'), initialWorker: initialWorker(),
      version: app.getVersion(), platform: process.platform, connect: connectManagement,
      chooseFile: async () => {
        const result = await dialog.showOpenDialog(window ?? undefined, {title: '选择现有电脑服务的 worker.json', properties: ['openFile'], filters: [{name: '托管配置', extensions: ['json']}]});
        return result.canceled ? '' : result.filePaths[0];
      },
    });
    session = createServiceSession({
      file: path.join(userData, 'resume-service.json'), connect: connectManagement,
    });
    handle('manager:context', () => controller.context());
    handle('manager:choose-worker', () => controller.chooseWorker());
    handle('manager:status', () => controller.request('status'));
    handle('manager:read-config', () => controller.request('config.read'));
    handle('manager:save-config', value => controller.request('config.save', value));
    handle('manager:read-logs', value => controller.request('logs.read', value));
    handle('manager:set-background-sync', value => controller.request('sync.set', value));
    handle('manager:set-startup', value => controller.request('startup.set', value));
    handle('manager:restart', () => controller.request('service.restart'));
    handle('manager:start', () => controller.request('service.start'));
    handle('manager:stop', () => controller.request('service.stop'));
    const brand = nativeImage.createFromPath(path.join(directory, 'tray.png'));
    if (process.platform === 'darwin') app.dock.setIcon(brand);
    tray = new Tray(process.platform === 'darwin' ? brand.resize({width: 18, height: 18}) : brand);
    tray.setToolTip('CodeRoam 电脑管理');
    tray.setContextMenu(Menu.buildFromTemplate([
      {label: '打开管理界面', click: showWindow}, {type: 'separator'},
      {label: '退出并停止连接服务', click: () => app.quit()},
    ]));
    tray.on('double-click', showWindow);
    showWindow();
    restoring = session.resume(controller.context().workerConfigPath).catch(() => {
      dialog.showErrorBox('连接服务尚未恢复', '请查看当前运行状态，确认关联的守护配置仍有效。');
    });
  }).catch(() => {
    dialog.showErrorBox('管理客户端无法启动', '请确认安装包完整，或重新构建电脑管理客户端。'); app.quit();
  });
}
