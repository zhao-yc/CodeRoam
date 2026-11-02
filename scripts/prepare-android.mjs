import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';

/** 创建项目独立 Android 签名并先完成备份，密码只经子进程环境传给 keytool。 */
const backupRoot=process.env.CODEX_MOBILE_BACKUP_ROOT;
if(!backupRoot)throw new Error('请先通过 CODEX_MOBILE_BACKUP_ROOT 指定私有签名备份目录');
const hbxHome=process.env.HBUILDERX_HOME;
if(!hbxHome)throw new Error('请通过 HBUILDERX_HOME 指定 HBuilderX 安装目录');
const manifest=JSON.parse(fs.readFileSync('apps/mobile/manifest.json','utf8'));
if(!manifest.appid||manifest.appid==='__UNI__0000000')throw new Error('请先在 HBuilderX 中申请自己的 AppID');
const directory=path.resolve('.local/android');fs.mkdirSync(directory,{recursive:true});
const configFile=path.join(directory,'pack.json');
if(fs.existsSync(configFile)){console.log('复用已经备份的 Android 签名配置');process.exit(0);}
const certFile=path.join(directory,'codex-mobile.p12');
if(fs.existsSync(certFile))throw new Error('发现未完成配置的签名文件，请先核对备份，不能覆盖');
const password=randomBytes(32).toString('base64url');
execFileSync(path.join(hbxHome,'plugins/amazon-corretto/bin/keytool.exe'),['-genkeypair','-alias','codex-mobile','-keyalg','RSA','-keysize','2048','-validity','10000','-storetype','PKCS12','-keystore',certFile,'-storepass:env','CODEX_MOBILE_ANDROID_PASSWORD','-keypass:env','CODEX_MOBILE_ANDROID_PASSWORD','-dname','CN=Codex Mobile, O=Codex Mobile Contributors'],{env:{...process.env,CODEX_MOBILE_ANDROID_PASSWORD:password},stdio:['ignore','pipe','pipe']});
const config={project:path.resolve('apps/mobile'),platform:'android',iscustom:false,sourceMap:false,splashads:false,rpads:false,unimpads:false,ignoreWarnings:true,android:{packagename:'org.example.codexmobile',androidpacktype:0,certalias:'codex-mobile',certfile:certFile,certpassword:password,storepassword:password}};
const backup=path.resolve(backupRoot,new Date().toISOString().replace(/[:.]/g,'-')+'-android');fs.mkdirSync(backup,{recursive:true});
fs.copyFileSync(certFile,path.join(backup,'codex-mobile.p12'),fs.constants.COPYFILE_EXCL);
fs.writeFileSync(path.join(backup,'pack.json'),JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
fs.writeFileSync(path.join(backup,'备份说明.md'),'# Android 签名备份\n\n应用：掌上 Codex；AppID 以自己的 manifest.json 为准；包名 org.example.codexmobile。\n\ncodex-mobile.p12 是本应用独立签名，pack.json 包含签名密码和本机绝对路径，禁止提交 Git 或上传公开存储。更换电脑后请更新 config 中 project、certfile 的绝对路径，保持同一证书才能覆盖安装更新。此证书不是 Google Play 上传密钥，也不代表已经上架。\n',{flag:'wx'});
fs.writeFileSync(configFile,JSON.stringify(config,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:'Android 独立签名已生成并备份',backup}));
