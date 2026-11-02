import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';

/** 私钥只在本机使用；对来自构建服务器的未签名包签名并核对覆盖安装身份。 */
const manifestSource=JSON.parse(fs.readFileSync('apps/mobile/manifest.json','utf8'));
const {values}=parseArgs({options:{input:{type:'string'},version:{type:'string',default:manifestSource.versionName},code:{type:'string',default:String(manifestSource.versionCode)}}});
if(!values.input)throw new Error('请通过 --input 指定未签名 APK');
if(!/^\d+\.\d+\.\d+$/.test(values.version)||!/^\d+$/.test(values.code))throw new Error('版本格式不合法');
const config=JSON.parse(fs.readFileSync('.local/android/pack.json','utf8'));
const android=config.android, directory=path.resolve('.cache/releases');
fs.mkdirSync(directory,{recursive:true});
const apk=path.join(directory,`codex-mobile-${values.version}.apk`);
if(fs.existsSync(apk))throw new Error('该版本安装包已经存在，拒绝覆盖，请先核对既有产物');
const hbxHome=process.env.HBUILDERX_HOME;
if(!hbxHome)throw new Error('请通过 HBUILDERX_HOME 指定 HBuilderX 安装目录');
const java=path.join(hbxHome,"plugins/amazon-corretto/bin/java.exe");
const signer=path.join(hbxHome,"plugins/app-safe-pack/apksigner.jar");
const environment={...process.env,CODEX_MOBILE_STORE_PASSWORD:android.storepassword,CODEX_MOBILE_KEY_PASSWORD:android.certpassword};
function run(binary,args,env=process.env) {
  const result=spawnSync(binary,args,{env,encoding:'utf8',windowsHide:true});
  // 工具错误输出不直接转发，防止以后版本将环境配置写入日志。
  if(result.status!==0)throw new Error('本机签名或核验工具执行失败，请在本机受控环境核对');
  return result.stdout;
}
run(java,['-jar',signer,'sign','--ks',android.certfile,'--ks-key-alias',android.certalias,'--ks-pass','env:CODEX_MOBILE_STORE_PASSWORD','--key-pass','env:CODEX_MOBILE_KEY_PASSWORD','--out',apk,path.resolve(values.input)],environment);
const signature=run(java,['-jar',signer,'verify','--verbose','--print-certs',apk]);
const certificate=run(path.join(hbxHome,"plugins/amazon-corretto/bin/keytool.exe"),['-list','-v','-keystore',android.certfile,'-storepass:env','CODEX_MOBILE_STORE_PASSWORD'],environment);
const digest=/certificate SHA-256 digest: ([a-f0-9]+)/i.exec(signature)?.[1].toLowerCase();
const expected=/SHA256: ([A-F0-9:]+)/i.exec(certificate)?.[1].replaceAll(':','').toLowerCase();
if(!digest||digest!==expected)throw new Error('安装包签名与原有证书不一致');
const manifest=run(path.join(hbxHome,"plugins/uts-development-android/static/win/aapt2.exe"),['dump','badging',apk]);
const pkg=/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/.exec(manifest);
if(pkg?.[1]!=='org.example.codexmobile'||pkg[2]!==values.code||pkg[3]!==values.version)throw new Error('安装包包名或版本不正确');
const permissions=[...manifest.matchAll(/uses-permission: name='([^']+)'/g)].map(match=>match[1]);
const allowed=new Set(['android.permission.INTERNET','android.permission.ACCESS_NETWORK_STATE','org.example.codexmobile.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION']);
if(permissions.some(permission=>!allowed.has(permission)))throw new Error('安装包含有未预期权限，禁止发布');
const bytes=fs.readFileSync(apk);
const result={status:'本机签名及清单核验通过',version:pkg[3],versionCode:pkg[2],packageName:pkg[1],file:apk,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),certificateSha256:digest,schemes:signature.split(/\r?\n/).filter(line=>/Verified using/.test(line)),permissions,createdAt:new Date().toISOString()};
fs.writeFileSync(path.join(directory,`android-${values.version}.json`),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
