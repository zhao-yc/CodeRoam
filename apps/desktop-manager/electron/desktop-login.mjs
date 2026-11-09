import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const trayArgument = '--tray';
const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const failure = message => Object.assign(new Error(message), {code: 'MANAGEMENT_STARTUP_UNAVAILABLE'});

/** Mac 登录项只运行桌面程序一次，退出或崩溃后由用户决定何时再打开。 */
export function createDesktopLogin({app, executable = process.execPath, platform = process.platform, user = os.userInfo}) {
  if (!app.isPackaged) return {read: () => undefined, set: () => {throw failure('请使用固定位置的桌面应用设置登录启动');}};
  if (platform === 'win32') {
    const options = {name: 'CodeRoamManager', path: executable, args: [trayArgument]};
    const read = () => {
      const settings = app.getLoginItemSettings(options);
      return settings.launchItems.some(item => item.name === options.name && item.scope === 'user' && item.enabled
        && path.win32.normalize(item.path).toLowerCase() === path.win32.normalize(executable).toLowerCase()
        && item.args.length === 1 && item.args[0] === trayArgument);
    };
    return {read, set(enabled) {
      app.setLoginItemSettings({...options, openAtLogin: enabled, enabled});
      if (read() !== enabled) throw failure('Windows 未确认登录启动设置');
      return {startupEnabled: enabled};
    }};
  }
  if (platform !== 'darwin') return {read: () => undefined};
  const {homedir, uid} = user();
  const directory = path.join(homedir, 'Library', 'LaunchAgents');
  const label = 'com.coderoam.manager';
  const file = path.join(directory, label + '.plist');
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>Label</key><string>' + label + '</string>',
    '<key>ProgramArguments</key><array><string>' + xml(executable) + '</string><string>' + trayArgument + '</string></array>',
    '<key>RunAtLoad</key><true/>',
    '</dict></plist>',
    '',
  ].join('\n');
  function directoryInfo() {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o022)) throw failure('登录项目录归属异常');
  }
  function read() {
    try {
      directoryInfo();
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.uid !== uid || (info.mode & 0o022) || info.size > 65536) return undefined;
      return fs.readFileSync(file, 'utf8') === content ? true : undefined;
    } catch (error) { return error.code === 'ENOENT' ? false : undefined; }
  }
  return {read, set(enabled) {
    const current = read();
    if (current === undefined) throw failure('无法核对现有 CodeRoam 登录项的归属');
    if (current !== enabled) {
      if (enabled) {
        fs.mkdirSync(directory, {recursive: true, mode: 0o700}); directoryInfo();
        const temporary = fs.mkdtempSync(path.join(directory, '.coderoam-'));
        const candidate = path.join(temporary, 'manager.plist');
        try {
          fs.writeFileSync(candidate, content, {mode: 0o600, flag: 'wx'});
          fs.linkSync(candidate, file);
        } finally {
          if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
          fs.rmdirSync(temporary);
        }
      } else fs.unlinkSync(file);
    }
    if (read() !== enabled) throw failure('macOS 未确认登录启动设置');
    return {startupEnabled: enabled};
  }};
}
