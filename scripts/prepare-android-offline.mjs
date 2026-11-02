import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

/** 从 HBuilderX 导出资源和官方同版本 SDK 组装未签名工程，禁止混入任何本地配对或签名配置。 */
const {values}=parseArgs({options:{resources:{type:'string'},sdk:{type:'string'},output:{type:'string'}}});
if(!values.resources||!values.sdk||!values.output)throw new Error('需要指定 --resources、--sdk 和 --output');
const resources=path.resolve(values.resources),sdk=path.resolve(values.sdk),output=path.resolve(values.output);
if(fs.existsSync(output))throw new Error('输出目录已经存在，保留现场，不覆盖既有工程');
const appId=JSON.parse(fs.readFileSync('apps/mobile/manifest.json','utf8')).appid;
if(!appId||appId==='__UNI__0000000')throw new Error('请先在 HBuilderX 中申请自己的 AppID');
const manifest=JSON.parse(fs.readFileSync(path.join(resources,appId+'/www/manifest.json'),'utf8'));
if(manifest.id!==appId||manifest['uni-app-x']?.compilerVersion!=='5.26')throw new Error('AppID 或编译器版本与本原生模板不匹配');
const template=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../native/android');
const gradle=fs.readFileSync(path.join(template,'app/build.gradle'),'utf8');
// 从实际原生模板核对版本，避免新包仍沿用旧版本号而无法覆盖安装。
if(manifest.version?.name!==/versionName '([^']+)'/.exec(gradle)?.[1]||String(manifest.version?.code)!==/versionCode (\d+)/.exec(gradle)?.[1])throw new Error('资源版本与原生模板不匹配，请先同步原生版本配置');
// 键盘库提供会话返回和打开面板时使用的 hideKeyboard，须随官方 SDK 一起编入。
const modules=['uts-runtime','app-common','app-runtime','breakpad-build','dcloud-layout','framework','uni-exit','uni-getAccessibilityInfo','uni-getAppAuthorizeSetting','uni-getAppBaseInfo','uni-getSystemSetting','uni-openAppAuthorizeSetting','uni-prompt','uni-storage','uni-getDeviceInfo','uni-getSystemInfo','uni-rpx2px','uni-theme','uni-websocket','uni-network','uni-getNetworkType','uni-keyboard','uni-clipboard','uni-actionSheet','uni-modal','uni-showLoading','uni-loading'];
// 先核对全部输入，缺失依赖时不创建半成品目录。
for(const name of modules)if(!fs.existsSync(path.join(sdk,`SDK/libs/${name}-release.aar`)))throw new Error(`官方 SDK 缺少模块：${name}`);
if(!fs.existsSync(path.join(sdk,'plugins/uts-kotlin-compiler-plugin-0.0.1.jar')))throw new Error('SDK 缺少 UTS 编译插件');
fs.cpSync(template,output,{recursive:true});
const androidManifest=path.join(output,'app/src/main/AndroidManifest.xml');
fs.writeFileSync(androidManifest,fs.readFileSync(androidManifest,'utf8').replace('__UNI__0000000',appId));
fs.cpSync(path.join(sdk,'plugins'),path.join(output,'plugins'),{recursive:true});
fs.cpSync(path.join(resources,'uniappx/app-android/src'),path.join(output,'app/src/main/java'),{recursive:true});
fs.cpSync(path.join(resources,appId),path.join(output,'app/src/main/assets/apps/'+appId),{recursive:true});
fs.mkdirSync(path.join(output,'app/libs'),{recursive:true});
for(const name of modules)fs.copyFileSync(path.join(sdk,`SDK/libs/${name}-release.aar`),path.join(output,`app/libs/${name}-release.aar`));
console.log(JSON.stringify({status:'已准备未签名 Android 离线工程',output,version:manifest.version.name,signingMaterialsIncluded:false}));
