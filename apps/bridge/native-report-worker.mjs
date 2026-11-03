import { workerData, parentPort } from 'node:worker_threads';
import vm from 'node:vm';

/** 仅提供 UTF-8 编解码的原始字符串入口，避免将宿主对象、异常或函数原型交给隔离区。 */
function primitiveBridge(fn) {
  return Object.setPrototypeOf((...args)=>{
    try { return fn(...args); } catch { return null; }
  },null);
}
const sandbox = Object.create(null);
sandbox.encodeUtf8 = primitiveBridge(value=>typeof value==='string'?Buffer.from(value,'utf8').toString('latin1'):null);
sandbox.decodeUtf8 = primitiveBridge((value,fatal,ignoreBOM)=>typeof value==='string'?new TextDecoder('utf-8',{fatal,ignoreBOM}).decode(Buffer.from(value,'latin1')):null);
sandbox.input = workerData.input;
const context = vm.createContext(sandbox,{codeGeneration:{strings:false,wasm:false}});
const prelude = `
  'use strict';
  class TextEncoder {
    encodeInto(value,target) {
      const bytes=encodeUtf8(value);
      if(bytes===null||bytes.length>target.length) throw new Error('UTF-8 缓冲区不足');
      for(let i=0;i<bytes.length;i++)target[i]=bytes.charCodeAt(i);
      return {read:value.length,written:bytes.length};
    }
  }
  class TextDecoder {
    constructor(_, {fatal=false,ignoreBOM=false}={}) { this.fatal=fatal;this.ignoreBOM=ignoreBOM; }
    decode(bytes) {
      let raw='';
      for(const byte of bytes)raw+=String.fromCharCode(byte);
      const value=decodeUtf8(raw,this.fatal,this.ignoreBOM);
      if(value===null)throw new Error('无效 UTF-8');
      return value;
    }
  }
`;

/** 保留桥接现有的文件分组流程，差异和行数由官方闭包产生。 */
function report(functions,batches) {
  const {convert,serialize,parse,summarize}=functions;
  const files=new Map(),parsed=[];
  for(const batch of batches)for(const change of batch.changes){
    const converted=convert([change]);
    if(Object.keys(converted).length===0)continue;
    const diff=serialize(converted,batch.cwd,null);
    if(diff==null)throw new Error('差异过大');
    const parts=parse(diff);
    if(parts.length!==1)throw new Error('原生差异数据不完整');
    const part=parts[0],path=change.kind.move_path??change.path;
    let file=files.get(path);
    if(!file){file={path,kind:change.kind.type,parts:[],diffs:[]};files.set(path,file);}
    if(change.kind.type==='delete'||file.kind!=='add')file.kind=change.kind.type;
    file.parts.push(part);file.diffs.push(diff);parsed.push(part);
  }
  const total=summarize(parsed);
  return {additions:total.linesAdded,deletions:total.linesDeleted,files:[...files.values()].map(file=>{
    const stats=summarize(file.parts);
    return {path:file.path,kind:file.kind,additions:stats.linesAdded,deletions:stats.linesDeleted,binary:file.parts.some(part=>part.isBinary),diffs:file.diffs};
  })};
}

try {
  const script = prelude+'\nconst native=(()=>{'+workerData.source+'})();\nJSON.stringify(('+report.toString()+')(native, JSON.parse(input)));';
  const output = vm.runInContext(script,context,{timeout:2500});
  if(Buffer.byteLength(output)>1_600_000)throw new Error('差异输出过大');
  parentPort.postMessage({output});
} catch {
  parentPort.postMessage({error:true});
}
