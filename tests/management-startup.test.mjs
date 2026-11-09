import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDesktopLogin} from '../apps/desktop-manager/electron/desktop-login.mjs';
import {createLegacyMigration} from '../apps/desktop-manager/electron/legacy-migration.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'coderoam-login-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}

test('Windows 登录项只确认本用户的托盘模式，系统停用后反映真实状态',()=>{
  const executable='C:\\example\\CodeRoam Manager.exe';
  let registration={name:'CodeRoamManager',path:executable,args:['--tray'],scope:'machine',enabled:true};
  const app={isPackaged:true,getLoginItemSettings:()=>({launchItems:registration?[registration]:[]}),setLoginItemSettings(options){
    assert.deepEqual(options.args,['--tray']);
    registration=options.openAtLogin?{...options,scope:'user'}:null;
  }};
  const login=createDesktopLogin({app,executable,platform:'win32'});
  assert.equal(login.read(),false);
  assert.deepEqual(login.set(true),{startupEnabled:true});
  registration.enabled=false;
  assert.equal(login.read(),false);
  assert.deepEqual(login.set(false),{startupEnabled:false});
});

test('macOS 登录项只启动桌面托盘一次，并保护外部同名登记',{skip:process.platform==='win32'},t=>{
  const homedir=fixture(t),options={app:{isPackaged:true},executable:'/example/CodeRoam Manager.app/Contents/MacOS/CodeRoam Manager',
    platform:'darwin',user:()=>({homedir,uid:process.getuid()})};
  const login=createDesktopLogin(options);
  assert.equal(login.read(),false);
  login.set(true);
  const file=path.join(homedir,'Library','LaunchAgents','com.coderoam.manager.plist');
  const bytes=fs.readFileSync(file,'utf8');
  assert.match(bytes,/<string>--tray<\/string>/);
  assert.doesNotMatch(bytes,/KeepAlive|service-supervisor/);
  assert.equal(login.read(),true);
  login.set(false);
  fs.writeFileSync(file,'合成外部登记');
  assert.equal(login.read(),undefined);
  assert.throws(()=>login.set(true),/归属/);
  assert.equal(fs.readFileSync(file,'utf8'),'合成外部登记');
});

for(const outcome of ['success','busy','canceled'])test(`迁移在排空后接管旧 Windows 服务，结果 ${outcome}`,async t=>{
  const worker=path.join(fixture(t),'worker.json');fs.writeFileSync(worker,'{}');
  const calls=[];
  const migrate=createLegacyMigration({
    platform:'win32',processGone:pid=>!pid||outcome==='success',
    login:{set:enabled=>calls.push(['login',enabled])},
    controlWindows:async(action,legacy,pid)=>{
      calls.push([action,pid]);
      if(action==='read')return {worker,name:'CodeRoamBridge',state:'Running',mode:'Auto'};
      if(action==='retire'&&outcome==='canceled')throw new Error('合成拒绝授权');
    },
    connect:()=>({request:async method=>{
      calls.push([method]);
      if(method==='status')return {supervisorPid:123,pid:124};
      if(method==='service.prepareQuit'){
        if(outcome==='busy')throw Object.assign(new Error('合成在途操作'),{code:'MANAGEMENT_IN_FLIGHT'});
        return {pid:123,wasRunning:true};
      }
    }}),
  });
  const common=[['read',undefined],['status'],['verify',123],['service.prepareQuit']];
  if(outcome==='busy'){
    await assert.rejects(migrate(worker),{code:'MANAGEMENT_IN_FLIGHT'});
    assert.deepEqual(calls,common);
  }else{
    common.push(['login',true],['retire',123]);
    if(outcome==='success')await migrate(worker);
    else{
      await assert.rejects(migrate(worker),{code:'MANAGEMENT_MIGRATION_FAILED'});
      common.push(['service.cancelQuit'],['service.start']);
    }
    assert.deepEqual(calls,common);
  }
});
