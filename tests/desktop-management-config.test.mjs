import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DEFAULT_SETTINGS_CACHE,validateSettingsCache,readManagedConfig,saveManagedConfig} from '../apps/bridge/management-config.mjs';

/** 使用合成配置验证真实文件保存，清理范围仅包含本例创建的目录。 */
function fixture(t,config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'codex-management-config-'));
  const file = path.join(root,'bridge.json');
  const value = {relayUrl:'wss://relay.example.com/',token:'synthetic-private-token',hostId:'synthetic-host',dataPath:'.local/bridge',...config};
  fs.writeFileSync(file,JSON.stringify(value,null,2),{mode:0o600});
  t.after(() => {
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('codex-management-config-'));
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  return {root,file,value};
}

test('配置读取只返回允许字段和令牌存在标记，缺省值保持兼容',t => {
  const f = fixture(t,{secret:'synthetic-extra-secret'}),read = readManagedConfig(f.file);
  assert.match(read.revision,/^[a-f0-9]{64}$/);
  assert.deepEqual(read.values,{label:'',relayUrl:'wss://relay.example.com/',multiInstance:true,newConversationSettingsCache:{ttlMs:7200000,maxEntries:64}});
  assert.equal(read.tokenConfigured,true);
  const text = JSON.stringify(read);
  for (const forbidden of ['synthetic-private-token','synthetic-extra-secret','synthetic-host','dataPath']) assert.equal(text.includes(forbidden),false);
});

test('保存允许字段时保留敏感和未知配置，备份保持原始字节且不返回备份内容',t => {
  const f = fixture(t,{label:'合成电脑',custom:{preserved:true}}),before = fs.readFileSync(f.file);
  const read = readManagedConfig(f.file);
  const saved = saveManagedConfig(f.file,{expectedRevision:read.revision,values:{label:'新的合成电脑',newConversationSettingsCache:{ttlMs:10800000,maxEntries:32}}});
  assert.notEqual(saved.revision,read.revision);
  assert.equal(saved.values.label,'新的合成电脑');
  assert.deepEqual(saved.values.newConversationSettingsCache,{ttlMs:10800000,maxEntries:32});
  const actual = JSON.parse(fs.readFileSync(f.file,'utf8'));
  assert.equal(actual.token,f.value.token);assert.equal(actual.hostId,f.value.hostId);assert.deepEqual(actual.custom,{preserved:true});
  const backups = fs.readdirSync(f.root).filter(name=>name.endsWith('.backup.json'));
  assert.equal(backups.length,1);assert.deepEqual(fs.readFileSync(path.join(f.root,backups[0])),before);
  assert.equal(JSON.stringify(saved).includes('synthetic-private-token'),false);
  assert.deepEqual(fs.readdirSync(f.root).filter(name=>name.endsWith('.tmp')||name.endsWith('.management.lock')),[]);
  if(process.platform !== 'win32')for(const target of [f.file,path.join(f.root,backups[0])])assert.equal(fs.statSync(target).mode&0o077,0);
});

test('旧修订和并发保存锁均拒绝覆盖，原配置保持最新值',t => {
  const f = fixture(t,{label:'原始电脑'}),read = readManagedConfig(f.file);
  const saved = saveManagedConfig(f.file,{expectedRevision:read.revision,values:{label:'新电脑'}});
  assert.throws(()=>saveManagedConfig(f.file,{expectedRevision:read.revision,values:{label:'旧窗口'}}),{code:'MANAGEMENT_CONFIG_CHANGED'});
  assert.equal(readManagedConfig(f.file).values.label,'新电脑');
  fs.writeFileSync(f.file+'.management.lock','');
  assert.throws(()=>saveManagedConfig(f.file,{expectedRevision:saved.revision,values:{label:'竞争窗口'}}),{code:'MANAGEMENT_CONFIG_CHANGED'});
  assert.equal(readManagedConfig(f.file).values.label,'新电脑');
  assert.equal(fs.existsSync(f.file+'.management.lock'),true);
});

test('只修改缓存时长时保留已保存的数量上限',t => {
  const f = fixture(t,{newConversationSettingsCache:{ttlMs:7200000,maxEntries:12}}),read = readManagedConfig(f.file);
  const saved = saveManagedConfig(f.file,{expectedRevision:read.revision,values:{newConversationSettingsCache:{ttlMs:3600000}}});
  assert.deepEqual(saved.values.newConversationSettingsCache,{ttlMs:3600000,maxEntries:12});
});

test('异常退出留下的保存锁可回收，仍在运行的持有进程不会被抢占',t => {
  const f = fixture(t),read = readManagedConfig(f.file),lock = f.file+'.management.lock';
  const nonce = '00000000-0000-4000-8000-000000000001';
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,nonce}));
  assert.throws(()=>saveManagedConfig(f.file,{expectedRevision:read.revision,values:{label:'仍在保存'}}),{code:'MANAGEMENT_CONFIG_CHANGED'});
  const child=spawnSync(process.execPath,['-e','process.exit(0)'],{windowsHide:true});
  assert.equal(child.status,0);assert.ok(child.pid);
  fs.writeFileSync(lock,JSON.stringify({pid:child.pid,nonce}));
  const saved=saveManagedConfig(f.file,{expectedRevision:read.revision,values:{label:'已回收失效锁'}});
  assert.equal(saved.values.label,'已回收失效锁');assert.equal(fs.existsSync(lock),false);
});

test('字段白名单和无效设置在写入前拒绝，不生成备份或修改配置',t => {
  const f = fixture(t),read = readManagedConfig(f.file),before = fs.readFileSync(f.file);
  const invalidValues = [
    {},null,[],{token:'replacement'},{dataPath:'elsewhere'},{hostId:'replacement'},{label:''},{label:'\n错误名称'},{label:'a'.repeat(81)},
    {relayUrl:'https://relay.example.com/'},{relayUrl:'ws://relay.example.com/'},{relayUrl:'wss://user:secret@relay.example.com/'},
    {relayUrl:'wss://relay.example.com/?token=value'},{relayUrl:'wss://relay.example.com/#fragment'},{multiInstance:'true'},
    {newConversationSettingsCache:{ttlMs:-1}},{newConversationSettingsCache:{ttlMs:86400001}},{newConversationSettingsCache:{ttlMs:1.1}},
    {newConversationSettingsCache:{maxEntries:0}},{newConversationSettingsCache:{maxEntries:513}},{newConversationSettingsCache:{unknown:true}},
  ];
  for(const values of invalidValues)assert.throws(()=>saveManagedConfig(f.file,{expectedRevision:read.revision,values}),{code:'MANAGEMENT_CONFIG_INVALID'});
  assert.deepEqual(fs.readFileSync(f.file),before);assert.deepEqual(fs.readdirSync(f.root),['bridge.json']);
});

test('允许本机明文调试地址并规范化空白名称，缓存零时长可以关闭复用',t => {
  const f = fixture(t),read = readManagedConfig(f.file);
  const saved = saveManagedConfig(f.file,{expectedRevision:read.revision,values:{label:'  合成电脑  ',relayUrl:'ws://localhost:8787',multiInstance:false,newConversationSettingsCache:{ttlMs:0,maxEntries:1}}});
  assert.equal(saved.values.label,'合成电脑');assert.equal(saved.values.relayUrl,'ws://localhost:8787/');assert.equal(saved.values.multiInstance,false);
  assert.deepEqual(saved.values.newConversationSettingsCache,{ttlMs:0,maxEntries:1});
  assert.doesNotThrow(()=>validateSettingsCache({ttlMs:86400000,maxEntries:512}));
});

test('配置文件过大、非对象、解析失败和相对路径均安全拒绝',t => {
  const f = fixture(t);
  for(const body of ['[]','null','{invalid',JSON.stringify({label:{private:'synthetic-secret'}}),' '.repeat(1024*1024+1)]) {
    fs.writeFileSync(f.file,body);assert.throws(()=>readManagedConfig(f.file),{code:'MANAGEMENT_CONFIG_INVALID'});
  }
  assert.throws(()=>readManagedConfig('relative.json'),{code:'MANAGEMENT_CONFIG_INVALID'});
  assert.throws(()=>readManagedConfig(path.join(f.root,'missing.json')),{code:'MANAGEMENT_CONFIG_UNAVAILABLE'});
});

test('符号链接配置不允许读取或替换',t => {
  const f = fixture(t),linked=path.join(f.root,'linked.json');
  try { fs.symlinkSync(f.file,linked,'file'); }
  catch(error) { if(process.platform==='win32'&&['EPERM','EACCES'].includes(error.code)){t.skip('当前 Windows 用户无创建符号链接权限');return;}throw error; }
  assert.throws(()=>readManagedConfig(linked),{code:'MANAGEMENT_CONFIG_INVALID'});
  assert.throws(()=>saveManagedConfig(linked,{expectedRevision:readManagedConfig(f.file).revision,values:{label:'不能替换'}}),{code:'MANAGEMENT_CONFIG_INVALID'});
  assert.equal(fs.lstatSync(linked).isSymbolicLink(),true);
});

test('缓存默认值每次返回独立对象，未知字段和非整数不会进入实例',()=>{
  assert.deepEqual(DEFAULT_SETTINGS_CACHE,{ttlMs:7200000,maxEntries:64});
  const first=validateSettingsCache();first.ttlMs=0;
  assert.deepEqual(validateSettingsCache(),{ttlMs:7200000,maxEntries:64});
  assert.deepEqual(validateSettingsCache({maxEntries:12}),{ttlMs:7200000,maxEntries:12});
  for(const value of [null,[],1,{ttlMs:undefined},{ttlMs:NaN},{maxEntries:Infinity},{maxEntries:'64'},{extra:1}])assert.throws(()=>validateSettingsCache(value),{code:'MANAGEMENT_CONFIG_INVALID'});
});
