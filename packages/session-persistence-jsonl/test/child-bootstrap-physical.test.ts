import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { append, createSession, exportConversationSeed } from '@i-harness/core-session'
import * as p from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'
import { bootstrapPathsForRoute } from '../src/backend/bootstrap-stage.ts'
import { pair, guards } from '../../session-persistence/test/child-bootstrap-fixture.ts'
import { fixtureLoader, fixtureRuntime } from './helpers/child-bootstrap-predecessor.ts'

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const sourceURL=(path:string)=>pathToFileURL(fileURLToPath(new URL(path,import.meta.url))).href
async function artifacts(root:string){return Promise.all((await readdir(root)).filter(n=>n==='target.jsonl'||n.startsWith('target.jsonl.bootstrap-')).sort().map(async name=>({name,base64:(await readFile(join(root,name))).toString('base64')})))}
function seededPair(){
 const original=pair(),source=createSession();append(source,{type:'turn/start'});append(source,{type:'user/message',text:'original parent seed'});append(source,{type:'turn/end'})
 const exported=exportConversationSeed(source,{kind:'session',sessionId:'parent'},{kind:'all'});if(exported.kind!=='seed')throw Error('actual V1 export required')
 const payload={...original.payload,seed:p.compileSemanticSeed(exported)},core:p.ChildBootstrapCore={...original.request.core,history:{selection:{kind:'all'},source:{kind:'session',sessionId:'parent'}}},intent=p.createChildBootstrapRequestIntent(core,{kind:'unmanaged'})
 payload.invocation={...payload.invocation,requestDigest:intent.requestDigest}
 return{payload,request:p.captureChildBootstrapCaptureRequest({version:1,kind:'child-bootstrap-capture-request',invocation:payload.invocation,core,requestIntent:intent.intent})}
}
const cuts=['exclusive-empty','reservation-short','reservation-sync','reservation-readback','reservation-close','confirmed-reservation','callback-returned','promotion-short','rename-before','rename-after','header','seed','complete-initial','receipt-confirmed'] as const

it('interrupts real child birth at original native IO and receipt boundaries and cold-restarts without recapture',async()=>{
 for(const cut of cuts){
  const runtime=await fixtureRuntime('physical-'+cut),root=runtime.root,{request,payload}=seededPair(),script=join(root,'process.mjs')
  const body=`
import {createRequire,syncBuiltinESMExports} from 'node:module';
const fs=createRequire(import.meta.url)('node:fs').promises,cut=${JSON.stringify(cut)},root=${JSON.stringify(root)},operations=[];let callbacks=0,barrierUsed=false;
async function barrier(point,extra={}){if(barrierUsed)return;barrierUsed=true;process.stdout.write(JSON.stringify({barrier:point,callbacks,operations,...extra})+'\\n');setInterval(()=>{},1000);await new Promise(()=>{})}
const originalOpen=fs.open,originalRename=fs.rename;
fs.open=async(...args)=>{const handle=await originalOpen(...args),path=String(args[0]),reservation=path.endsWith('.stage')&&args[1]==='wx',promotion=path.endsWith('.promote'),writable=typeof args[1]==='string'&&/[wa+]/.test(args[1]);operations.push({operation:'open',path,flags:args[1]});
 if(reservation&&cut==='exclusive-empty')await barrier(cut);
 return new Proxy(handle,{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;
 return async(...values)=>{if(['write','sync','readFile','close','truncate','appendFile'].includes(key))operations.push({operation:key,path,fd:target.fd});
 if(key==='write'&&reservation&&cut==='reservation-short'){const result=await target.write(values[0],values[1],13,values[3]);await barrier(cut,{bytesWritten:result.bytesWritten})}
 if(key==='write'&&promotion&&cut==='promotion-short'){const result=await target.write(values[0],values[1],19,values[3]);await barrier(cut,{bytesWritten:result.bytesWritten})}
 const result=await value.apply(target,values);
 if(reservation&&key==='sync'&&cut==='reservation-sync')await barrier(cut);
 if(path.endsWith('.stage')&&args[1]==='r'&&key==='readFile'&&cut==='reservation-readback')await barrier(cut);
 if(reservation&&key==='close'&&cut==='reservation-close')await barrier(cut);
 return result}
 }})};
fs.rename=async(...args)=>{operations.push({operation:'rename',from:String(args[0]),to:String(args[1])});if(String(args[0]).endsWith('.promote')&&cut==='rename-before')await barrier(cut);const result=await originalRename(...args);if(String(args[0]).endsWith('.promote')&&cut==='rename-after')await barrier(cut);return result};syncBuiltinESMExports();
const p=await import(${JSON.stringify(sourceURL('../../session-persistence/src/index.ts'))}),{createJsonlBackend}=await import(${JSON.stringify(sourceURL('../src/index.ts'))});
const request=${JSON.stringify(request)},payload=${JSON.stringify(payload)},backend=createJsonlBackend(root),guards={assertCurrent(){},dependencies:{async confirm(){throw Error('no artifacts')},async reconcile(){throw Error('no artifacts')}}};
const reserve=backend.bootstrapRoutes.reserveCapture;backend.bootstrapRoutes.reserveCapture=async(...args)=>{const result=await reserve(...args);operations.push({operation:'reserve-result',kind:result.kind});if(cut==='confirmed-reservation'){if(result.kind!=='committed-new')throw Error('actual reservation required');await barrier(cut)}return result};
const header=backend.prepareBootstrapHeader;backend.prepareBootstrapHeader=async(...args)=>{if(cut==='callback-returned')await barrier(cut);const result=await header(...args);operations.push({operation:'header-result',kind:result.kind});if(cut==='header'){if(result.kind!=='committed')throw Error('actual header required');await barrier(cut)}return result};
const appendBatch=backend.appendOwnedBatch;backend.appendOwnedBatch=async(...args)=>{const result=await appendBatch(...args),batchId=args[3].key.batchId;operations.push({operation:'batch-result',batchId,kind:result.kind});if(cut==='seed'&&batchId.endsWith(':seed')||cut==='complete-initial'&&batchId.endsWith(':complete'))await barrier(cut,{batchId,result});return result};
const confirm=backend.confirmBootstrapFrames;backend.confirmBootstrapFrames=async(...args)=>{const result=await confirm(...args);operations.push({operation:'receipt-result',kind:result.kind});if(cut==='receipt-confirmed')await barrier(cut,{confirmation:result});return result};
const coordinator=p.createSessionCoordinator(backend,{lock:{enabled:true}});const outcome=await coordinator.bootstrapChildTargetWithCapture(request,guards,async()=>{callbacks++;return payload});process.stdout.write(JSON.stringify({unexpectedOutcome:outcome,callbacks,operations})+'\\n');throw Error('birth completed without requested barrier '+cut+' '+outcome.kind);
`
  await writeFile(script,body)
  const args=['--import',fixtureLoader,script],child=spawn(process.execPath,args,{cwd:process.cwd(),env:runtime.env,windowsHide:true,stdio:['ignore','pipe','pipe']}),reached=Promise.withResolvers<any>();let output='',stderr='',exitCode:number|null=null,signal:string|null=null
  const exited=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,sig)=>{exitCode=code;signal=sig;reached.reject(Error('child exited before barrier: '+stderr));resolve()})})
  child.stdout.on('data',bytes=>{output+=String(bytes);for(const line of output.split('\n').filter(Boolean)){try{const value=JSON.parse(line);if(value.barrier===cut)reached.resolve(value)}catch{}}});child.stderr.on('data',bytes=>{stderr+=String(bytes)})
  const timer=setTimeout(()=>reached.reject(Error('process barrier deadline '+cut)),20000)
  let barrier:any
  try{barrier=await reached.promise;child.kill();await exited}finally{clearTimeout(timer);if(child.exitCode===null&&!child.killed)child.kill();await exited;await writeFile(join(root,'process.json'),JSON.stringify({cut,cwd:process.cwd(),node:process.execPath,nodeSha256:hash(await readFile(process.execPath)),args,scriptSha256:hash(Buffer.from(body)),roots:runtime.roots,output,stderr,exitCode,signal,interruption:'parent child.kill after observed real native/backend barrier'},null,2))}
  expect(stderr).toBe('');expect(barrier.callbacks).toBe(['exclusive-empty','reservation-short','reservation-sync','reservation-readback','reservation-close','confirmed-reservation'].includes(cut)?0:1)
  const before=await artifacts(root),stagePath=bootstrapPathsForRoute(join(root,'target.jsonl'),{protocol:'child-v1',request}).stage,stage=await readFile(stagePath),full=(()=>{try{return JSON.parse(stage.toString()).kind==='semantic-bootstrap-header'}catch{return false}})()
  const backend=createJsonlBackend(root),cold=p.createSessionCoordinator(backend,{lock:{enabled:true}});let callbacks=0
  try{
   const retry=await cold.bootstrapChildTargetWithCapture!(request,guards,async()=>{callbacks++;return payload});expect(callbacks).toBe(0)
   if(!full){expect(retry.kind).not.toBe('ready');const resumed=await cold.resumeChildTarget!(request,guards,payload);expect(resumed.kind).not.toBe('ready');expect(await artifacts(root)).toEqual(before)}
   else{
    // A full stage retains commitment, never prompt authority. Supply only the
    // original frozen payload held by this test's original parent process.
    const resumed=await cold.resumeChildTarget!(request,guards,payload);expect(['ready','already-ready']).toContain(resumed.kind)
    if(resumed.kind!=='ready'&&resumed.kind!=='already-ready')throw Error('real recovery receipt required')
    expect(resumed.receipt.initial).toMatchObject({inputId:payload.initial!.inputId,startedAt:payload.initial!.startedAt,expiresAt:payload.initial!.expiresAt})
    expect(resumed.document.view.events.filter(event=>event.type==='agent/input/admitted')).toHaveLength(1)
    expect(resumed.document.view.events.find(event=>event.type==='agent/input/admitted')).toMatchObject({text:payload.initial!.text})
    expect(await readFile(stagePath)).toEqual(stage)
    const after=await readFile(join(root,'target.jsonl')),original=before.find(row=>row.name==='target.jsonl');if(original)expect(after.subarray(0,Buffer.from(original.base64,'base64').length)).toEqual(Buffer.from(original.base64,'base64'))
    await writeFile(join(root,'recovery.json'),JSON.stringify({cut,callbacks,receipt:resumed.receipt,stageSha256:hash(stage),targetSha256:hash(after),birthFrameSha256:hash(after.subarray(after.indexOf(10)+1)),before,after:await artifacts(root)},null,2))
   }
  }finally{await cold.close()}
 }
},360000)
