import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {BridgeError} from '../../packages/protocol/contracts.mjs';
const helper=fileURLToPath(new URL('./windows-archive.ps1',import.meta.url));

/** 通过已核对进程身份的桌面原生工具管道归档，已有写入者仍由原桌面管理。 */
export class DesktopArchiveController {
  constructor({platform=process.platform,launch=spawn,executable=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe')}={}) {
    this.launch=launch;this.executable=executable;this.available=platform==='win32'&&fs.existsSync(executable)&&fs.existsSync(helper);
  }
  archive(params,beforeCommit) {
    if(!this.available)throw new BridgeError('ARCHIVE_UNSUPPORTED','此电脑暂不支持原生归档，请更新 Windows 连接服务');
    return new Promise((resolve,reject)=>{
      const child=this.launch(this.executable,['-NoProfile','-NonInteractive','-File',helper],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
      const decoder=new StringDecoder('utf8');let buffer='',committed=false,settled=false,verifying=false;
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);child.stdin.end();child.kill();error?reject(error):resolve();};
      const fail=()=>finish(new BridgeError('ARCHIVE_CONNECTION_LOST',committed?'归档结果需要核对，请勿重复提交':'电脑归档连接未就绪，请稍后重试',committed));
      const timer=setTimeout(fail,Math.max(1,params.deadline-Date.now()));
      child.on('error',fail);child.on('exit',fail);child.stdin.on('error',fail);child.stderr.on('data',()=>{});
      child.stdout.on('data',data=>{
        buffer+=decoder.write(data);if(buffer.length>65536)return fail();let newline;
        while((newline=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,newline).trim();buffer=buffer.slice(newline+1);let message;
          try{message=JSON.parse(line);}catch{return fail();}
          if(message.stage==='ready'&&!verifying){
            verifying=true;
            Promise.resolve().then(beforeCommit).then(()=>{if(settled)return;committed=true;child.stdin.write(JSON.stringify({commit:true})+'\n');},finish);
          }else if(message.stage==='done'&&committed)finish();
          else if(message.stage==='error')finish(new BridgeError('ARCHIVE_REJECTED',committed?'归档结果需要核对，请勿重复提交':'电脑端暂不支持归档或连接未就绪，请更新后重试',committed||message.outcomeUnknown===true));
        }
      });
      // 仅通过标准输入传递固定字段，手机不能指定工具、管道、脚本或程序。
      child.stdin.write(JSON.stringify(params)+'\n');
    });
  }
}
