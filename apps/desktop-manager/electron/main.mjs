import {app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createManagerController, trustedSender} from './manager-controller.mjs';
import {createServiceSession} from './service-session.mjs';
import {createDesktopLogin, trayArgument} from './desktop-login.mjs';
import {createLegacyMigration, discoverLegacyWorker} from './legacy-migration.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const rendererFile = path.resolve(directory, '../dist/index.html'), rendererUrl = pathToFileURL(rendererFile).href;
let window = null, tray = null, controller;
let session, restoring, choosing, quitting = false, quitReady = false, startError = '', trayReading = false;
let trayLabel = '';
const trayOnly = process.argv.includes(trayArgument);
const quitOnly = process.argv.includes('--quit');
let allowActivate = !trayOnly;
app.setName('CodeRoam 电脑管理');
if (process.platform === 'win32') app.setAppUserModelId('com.codexmobile.manager');
// 沿用旧数据目录及自定义配置；首次安装先创建目录，改名后仍能关联原服务。
const requestedUserData = process.env.CODEX_MOBILE_MANAGER_USER_DATA;
const userData = requestedUserData && path.isAbsolute(requestedUserData)
  ? requestedUserData : path.join(app.getPath('appData'), '掌上 Codex 电脑管理');
fs.mkdirSync(userData, {recursive: true, mode: 0o700});
app.setPath('userData', userData);

function initialWorker() {
  const argument = process.argv.indexOf('--worker-config');
  if (argument >= 0) return process.argv[argument + 1] ?? '';
  if (process.env.CODEX_MOBILE_WORKER_CONFIG) return process.env.CODEX_MOBILE_WORKER_CONFIG;
  const bridgeArgument = process.argv.indexOf('--bridge-config');
  if (!app.isPackaged && bridgeArgument >= 0) {
    const argumentPath = name => {
      const index = process.argv.indexOf(name);
      return index < 0 ? undefined : path.resolve(directory, '../../..', process.argv[index + 1] ?? '');
    };
    return localWorker(argumentPath('--bridge-config'), argumentPath('--bridge-working-directory'), argumentPath('--run-directory'));
  }
  return '';
}

/** 保留已有业务配置与相对数据路径；新开发托管文件只存本机路径。 */
function localWorker(bridgeConfig, projectRoot = path.resolve(directory, '../../..'), runDirectory) {
  const config = JSON.parse(fs.readFileSync(bridgeConfig, 'utf8').replace(/^\uFEFF/, ''));
  const data = path.resolve(projectRoot, config.dataPath ?? '.local/bridge');
  const file = path.join(path.dirname(bridgeConfig), path.basename(bridgeConfig, '.json') + '.worker.json');
  const worker = {
    bridgeConfig, projectRoot, entry: path.resolve(directory, '../../bridge/cli.mjs'),
    runDirectory: runDirectory ?? path.join(data, 'run'), logDirectory: path.join(data, 'logs'), statusFile: path.join(data, 'runtime-status.json'),
  };
  try { fs.writeFileSync(file, JSON.stringify(worker), {mode: 0o600, flag: 'wx'}); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Object.entries(worker).some(([key, value]) => saved[key] !== value)) throw new Error('已有开发托管文件的路径不同，请核对原配置');
  }
  return file;
}

function defaultWorker(legacyWorker) {
  if (typeof legacyWorker === 'string' && path.isAbsolute(legacyWorker) && fs.existsSync(legacyWorker)) return legacyWorker;
  if (!app.isPackaged) {
    const bridgeConfig = path.resolve(directory, '../../../.local/bridge.json');
    if (fs.existsSync(bridgeConfig)) return localWorker(bridgeConfig);
  }
  return '';
}

/** 关闭窗口保留托盘，托盘和系统退出入口统一等待守护收尾。 */
function showWindow() {
  allowActivate = true;
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

/** 用户从托盘退出时窗口可能已关，系统确认框也要能独立显示。 */
async function confirmPendingExit() {
  const options = {
    type: 'warning', title: '手机操作尚未完成', message: '仍然退出 CodeRoam？',
    detail: '退出会中断手机连接，正在处理的操作结果可能需要重新核对。',
    buttons: ['继续运行', '仍然退出'], defaultId: 0, cancelId: 0, noLink: true,
  };
  const result = window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return result.response === 1;
}

const errorMessage = error => /^(?:MANAGEMENT|MANAGER)_[A-Z_]+$/.test(error?.code ?? '') && typeof error?.message === 'string'
  ? error.message : '连接服务未能启动，请检查托管配置后重试。';

function showTrayStatus(label) {
  if (trayLabel === label) return;
  trayLabel = label;
  tray.setToolTip('CodeRoam · ' + label);
  tray.setContextMenu(Menu.buildFromTemplate([
    {label, enabled: false}, {label: '打开管理界面', click: showWindow}, {type: 'separator'},
    {label: '退出并停止连接服务', click: () => app.quit()},
  ]));
}

if (!app.requestSingleInstanceLock() || quitOnly) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--quit')) app.quit();
    else if (!argv.includes(trayArgument) && tray && !quitting) showWindow();
  });
  app.on('activate', () => { if (allowActivate && tray && !quitting) showWindow(); });
  app.on('window-all-closed', () => { /* 关闭窗口后继续驻留托盘。 */ });
  app.on('before-quit', event => {
    if (!session || quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    if (tray) showTrayStatus('正在停止连接服务');
    void (async () => {
      try {
        await restoring;
        await choosing?.catch(() => {});
        const worker = controller.context().workerConfigPath;
        try { await session.close(worker); }
        catch (error) {
          if (error?.code !== 'MANAGEMENT_IN_FLIGHT') throw error;
          if (!await confirmPendingExit()) return;
          await session.close(worker, true);
        }
        quitReady = true;
        app.quit();
      } catch (error) {
        const message = error?.code?.startsWith('MANAGEMENT_') ? error.message : '暂未确认守护安全退出，请检查运行状态后重试。';
        dialog.showErrorBox('连接服务尚未停止', message);
      } finally {
        if (!quitReady) {
          quitting = false;
          if (tray) showTrayStatus('正在读取连接状态');
        }
      }
    })();
  });
  app.whenReady().then(async () => {
    const runtime = app.isPackaged ? path.join(process.resourcesPath, 'bridge-runtime') : path.resolve(directory, '../../..');
    const bridge = path.join(runtime, 'apps', 'bridge');
    const clientFile = path.join(bridge, 'management-client.mjs');
    const {connectManagement} = await import(pathToFileURL(clientFile).href);
    const login = createDesktopLogin({app});
    const selected = initialWorker();
    const legacyWorker = selected ? '' : await discoverLegacyWorker().catch(() => '');
    controller = createManagerController({
      preferencesPath: path.join(app.getPath('userData'), 'manager.json'), initialWorker: selected,
      defaultWorker: () => defaultWorker(legacyWorker),
      beforeChoose: async (_next, current) => { await session.close(current); },
      version: app.getVersion(), platform: process.platform, connect: connectManagement,
      chooseFile: async () => {
        const result = await dialog.showOpenDialog(window ?? undefined, {title: '选择现有电脑服务的 worker.json', properties: ['openFile'], filters: [{name: '托管配置', extensions: ['json']}]});
        return result.canceled ? '' : result.filePaths[0];
      },
    });
    session = createServiceSession({
      connect: connectManagement,
      node: app.isPackaged ? path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node') : process.env.npm_node_execpath ?? 'node',
      supervisor: path.join(bridge, 'service-supervisor.mjs'), entry: path.join(bridge, 'cli.mjs'),
      trayReady: () => Boolean(tray && !tray.isDestroyed() && !quitting),
      beforeStart: createLegacyMigration({connect: connectManagement, login}),
    });
    async function start() {
      startError = '';
      try { return await session.start(controller.context().workerConfigPath); }
      catch (error) { startError = errorMessage(error); throw error; }
    }
    async function status() {
      const worker = controller.context().workerConfigPath;
      const startupEnabled = login.read();
      if (session.owns(worker)) return {...await controller.request('status'), startupEnabled};
      return {
        running: false, connected: false, pid: null, supervisorPid: null, serviceState: session.starting() ? 'starting' : 'stopped',
        version: app.getVersion(), activeRevision: '', savedRevision: '', restartRequired: false,
        maintenance: {}, instances: [], configPath: '', startupEnabled, startError,
      };
    }
    async function refreshTray() {
      if (trayReading || quitting || !tray || tray.isDestroyed()) return;
      trayReading = true;
      try {
        const state = await status().catch(() => null);
        const label = state?.connected ? '已连接'
          : restoring || !state || state.serviceState === 'starting' ? '正在连接'
            : state.running ? '已断开' : '服务已停止';
        if (!quitting && !tray.isDestroyed()) showTrayStatus(label);
      } finally { trayReading = false; }
    }
    handle('manager:context', () => controller.context());
    handle('manager:choose-worker', () => {
      if (choosing) return choosing;
      const previous = controller.context().workerConfigPath;
      choosing = (async () => {
        await restoring;
        const context = await controller.chooseWorker();
        if (context.workerConfigPath !== previous && !quitting) await start().catch(() => {});
        return context;
      })().finally(() => { choosing = null; });
      return choosing;
    });
    handle('manager:status', status);
    const request = (method, params) => {
      if (!session.owns(controller.context().workerConfigPath)) throw Object.assign(new Error('请先启动 CodeRoam 连接服务'), {code: 'MANAGEMENT_UNAVAILABLE'});
      return controller.request(method, params);
    };
    handle('manager:read-config', () => request('config.read'));
    handle('manager:save-config', value => request('config.save', value));
    handle('manager:read-logs', value => request('logs.read', value));
    handle('manager:set-background-sync', value => request('sync.set', value));
    handle('manager:set-startup', value => {
      if (typeof value?.enabled !== 'boolean') throw Object.assign(new Error('登录启动开关必须是布尔值'), {code: 'MANAGER_CONFIG_INVALID'});
      return login.set(value.enabled);
    });
    handle('manager:restart', () => request('service.restart'));
    handle('manager:start', start);
    handle('manager:stop', () => request('service.stop'));
    const brand = nativeImage.createFromPath(path.join(directory, 'tray.png'));
    if (brand.isEmpty()) throw new Error('托盘图标不可用');
    if (process.platform === 'darwin') app.dock.setIcon(brand);
    tray = new Tray(process.platform === 'darwin' ? brand.resize({width: 18, height: 18}) : brand);
    showTrayStatus('正在连接');
    tray.on('double-click', showWindow);
    if (!trayOnly || !controller.context().configured) showWindow();
    if (controller.context().configured) {
      restoring = start().catch(() => { if (!quitting) showWindow(); }).finally(() => { restoring = null; void refreshTray(); });
    } else void refreshTray();
    setInterval(() => void refreshTray(), 2000).unref();
  }).catch(() => {
    dialog.showErrorBox('管理客户端无法启动', '请确认安装包完整，或重新构建电脑管理客户端。'); app.quit();
  });
}
