import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import koffi from 'koffi'
import { AclSandbox } from '../../src/index.ts'
import { NativeInitOwner } from '../../src/init-owner.ts'
import { prepareChildStartup } from '../../src/startup-attributes.ts'
import { createWaitDrainBridge, verifyWaitAssets } from '../../src/native-wait-bridge.ts'
import { createWin32OutputPipe, win32PipeApi } from '../../src/win32-overlapped-read.ts'
import { registerWin32Wait } from '../../src/win32-wait.ts'
import { buildCommandLine } from '../../src/spawn.ts'
import { STARTUPINFOEXW, PROCESS_INFORMATION, type NativePtr, type Win32Bindings } from '../../src/ffi.ts'
const root = process.env.IH_ACL_ABI_ASSETS!, trace = process.env.IH_ACL_ABI_TRACE!, cwd = process.env.IH_ACL_ABI_CWD!
assert.equal(process.env.IH_ACL_ABI_QUALIFICATION, '1'); assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
const log = (event: string, detail: unknown = {}) => { const line = JSON.stringify({ event, detail }, (_k,v) => typeof v === 'bigint' ? String(v) : v); appendFileSync(trace,line+'\n'); process.stdout.write(line+'\n') }
log('verified-assets', verifyWaitAssets(root)); assert.equal(koffi.version,'3.1.6')
assert.equal(STARTUPINFOEXW.size,112); assert.equal(koffi.offsetof(STARTUPINFOEXW,'lpAttributeList'),104); assert.equal(PROCESS_INFORMATION.size,24)
log('identity', { node:process.version, executable:process.execPath, koffi:koffi.version, startup:112, attributeOffset:104, processInfo:24 })
const service = await createWaitDrainBridge(root)
const sandbox = new AclSandbox({ mode:'read-only', writableDirs:[], manageDacls:false })
let parent: NativeInitOwner | undefined
let out: ReturnType<typeof createWin32OutputPipe> | undefined, err: ReturnType<typeof createWin32OutputPipe> | undefined
let processHandle: NativePtr | undefined, rootWait: ReturnType<typeof registerWin32Wait> | undefined
let rootJoined = false
try {
  await sandbox.init(); log('original-sandbox-init')
  const original = sandbox as unknown as { api: Win32Bindings; token: NativePtr; initOwner: { entries: Array<{domain:string;value?:NativePtr;done:boolean}> } }
  const api = original.api; parent = new NativeInitOwner(api)
  // The copied logon SID is owned by the original init ledger. Derive its trusted string, no public SID input.
  const logon = original.initOwner.entries.find(entry => entry.domain==='heap' && entry.value && !entry.done && Number(koffi.decode(entry.value,'uint8'))===1 && Number(koffi.decode(entry.value,1,'uint8'))===3)
  assert.ok(logon?.value)
  const advapi = koffi.load('advapi32.dll'), kernel = koffi.load('kernel32.dll')
  assert.equal(advapi.func('__stdcall','IsTokenRestricted','int',['void *'])(original.token),1);log('original-token-is-restricted')
  const convert = advapi.func('__stdcall','ConvertSidToStringSidW','int',['void *','void *'])
  const slot = parent.slot()
  const text = parent.output(slot,'local','ConvertSidToStringSidW',()=>convert(logon.value,slot) as number)
  const sid = koffi.decode(text,'char16',-1) as string; assert.match(sid,/^S-1-5-5-\d+-\d+$/)
  parent.release(text,'local')
  const current = kernel.func('__stdcall','GetCurrentProcess','void *',[])()
  const duplicate = kernel.func('__stdcall','DuplicateHandle','int',['void *','void *','void *','void *','uint32','int','uint32'])
  const getFlags = kernel.func('__stdcall','GetHandleInformation','int',['void *','void *'])
  const event = kernel.func('__stdcall','CreateEventW','void *',['void *','int','int','str16'])
  function dup(handle: NativePtr) { const slot=parent!.slot(); return parent!.output(slot,'handle','DuplicateHandle',()=>duplicate(current,handle,current,slot,0,1,2) as number) }
  function flags(handle: NativePtr) { const slot=parent!.uint32(); assert.equal(getFlags(handle,slot),1); return koffi.decode(slot,'uint32') as number }
  const port = win32PipeApi(service)
  out=createWin32OutputPipe(sid,port); err=createWin32OutputPipe(sid,port)
  await out.initialize(); await err.initialize()
  const stdout=dup(out.writer()), stderr=dup(err.writer())
  assert.equal(flags(out.writer())&1,0); assert.equal(flags(err.writer())&1,0)
  const stdinReadSlot=parent.slot(), stdinWriteSlot=parent.slot()
  let stdinRead!:NativePtr
  const stdinWrite=parent.output(stdinWriteSlot,'handle','CreatePipe(write)',()=>{
    stdinRead=parent!.output(stdinReadSlot,'handle','CreatePipe(read)',()=>api.createPipe(stdinReadSlot,stdinWriteSlot,null,0));return 1
  })
  const stdin=dup(stdinRead)
  parent.release(stdinWrite,'handle'); parent.release(stdinRead,'handle')
  const sentinelBase=parent.handle(()=>event(null,1,0,null) as NativePtr,'CreateEventW')
  const sentinel=dup(sentinelBase)
  for(const handle of [stdin,stdout,stderr,sentinel]) assert.equal(flags(handle)&1,1)
  log('owned-inheritable-handles',{stdin,stdout,stderr,sentinel,originalWritersInherit:false})
  const initialize=api.initializeProcThreadAttributeList, update=api.updateProcThreadAttribute, destroy=api.deleteProcThreadAttributeList
  api.initializeProcThreadAttributeList=(...args)=>{ const result=initialize(...args);const code=result?0:api.getLastError();log('native-attribute-initialize',{sizing:args[0]===null,result,code,bytes:String(koffi.decode(args[3],'size_t'))});return result }
  api.updateProcThreadAttribute=(...args)=>{const result=update(...args);const code=result?0:api.getLastError();log('native-attribute-update',{result,code,attribute:String(args[2]),bytes:args[4]});return result}
  api.deleteProcThreadAttributeList=(...args)=>{const result=destroy(...args);log('native-attribute-delete',{returnedUndefined:result===undefined});return result}
  const attributes=prepareChildStartup(parent,[stdin,stdout,stderr])
  const pi=parent.bytes(24)
  const code=`const k=require(${JSON.stringify(createRequire(import.meta.url).resolve('koffi'))});const l=k.load('kernel32.dll');const f=l.func('__stdcall','GetHandleInformation','int',['void *','void *']);const e=l.func('__stdcall','GetLastError','uint32',[]);const a=k.load('advapi32.dll');const cur=l.func('__stdcall','GetCurrentProcess','void *',[]);const open=a.func('__stdcall','OpenProcessToken','int',['void *','uint32','void *']);const restricted=a.func('__stdcall','IsTokenRestricted','int',['void *']);const close=l.func('__stdcall','CloseHandle','int',['void *']);const ts=k.alloc('void *',1);if(!open(cur(),8,ts))throw Error('open self token');const token=k.decode(ts,'void *');const tokenRestricted=restricted(token);if(!close(token))throw Error('close self token');k.free(ts);const p=k.alloc('uint32',1);const ok=f(BigInt(${JSON.stringify(String(sentinel))}),p);const win32=ok?0:e();k.free(p);process.stdin.on('end',()=>{process.stdout.write(Buffer.from([0,1,127,128,255,65,66]));process.stderr.write(JSON.stringify({marker:'restricted-stderr',stdinEOF:true,tokenRestricted,sentinelOK:ok,sentinelError:win32}));process.exitCode=23});process.stdin.resume()`
  const command=buildCommandLine(process.execPath,['-e',code])
  log('controlled-child-command',{executable:process.execPath,args:['-e',code],commandLine:command,cwd,inheritHandles:true,creationFlags:attributes.creationFlags})
  const captureOut=out.readAll(), captureErr=err.readAll(); void captureOut.catch(()=>{});void captureErr.catch(()=>{})
  let created = false
  // Both output owners and original process-info storage exist before native creation.
  const thread=parent.handle(()=>{
    processHandle=parent!.output(pi,'handle','CreateProcessAsUserExW',()=>{
      attributes.assertCurrent()
      const result=api.createProcessAsUserExW(original.token,null,command,null,null,1,attributes.creationFlags,null,cwd,attributes.startupInfo,pi)
      if(result) created=true
      const code=result?0:api.getLastError(); log('native-create-process',{result,code,extendedFlags:attributes.creationFlags,created})
      return result
    })
    return koffi.decode(pi,8,'void *') as NativePtr
  },'created thread')
  assert.ok(processHandle)
  log('created-original-process',{pid:koffi.decode(pi,16,'uint32')})
  rootWait=registerWin32Wait(processHandle,service)
  attributes.close(); log('attributes-retired-after-create')
  parent.release(thread,'handle')
  for(const handle of [stdin,stdout,stderr]) parent.release(handle,'handle')
  await out.closeWriter(); await err.closeWriter()
  await rootWait.signalled
  const exit=parent.uint32(); assert.equal(api.getExitCodeProcess(processHandle,exit),1);const status=koffi.decode(exit,'uint32') as number
  await rootWait.close();rootJoined=true;log('root-result-and-unregister-ack',{status})
  const [output,error]=await Promise.all([captureOut,captureErr])
  assert.equal(status,23);assert.deepEqual(output,Buffer.from([0,1,127,128,255,65,66]))
  const detail=JSON.parse(error.toString('utf8'));assert.equal(detail.marker,'restricted-stderr');assert.equal(detail.stdinEOF,true);assert.equal(detail.tokenRestricted,1);assert.equal(detail.sentinelOK,0);assert.equal(detail.sentinelError,6)
  log('restricted-child-positive-and-whitelist-negative',{stdoutBytes:output.length,...detail})
} catch(error) {log('fixture-failure',{message:(error as Error).message,stack:(error as Error).stack});throw error}
finally {
  const api=(sandbox as unknown as {api?:Win32Bindings}).api
  if(processHandle && !rootJoined && api){const terminated=api.terminateProcess(processHandle,99);log('rollback-root-termination',{terminated});rootWait??=registerWin32Wait(processHandle,service);await rootWait.signalled;await rootWait.close();rootJoined=true}
  if(out) await out.cleanup();if(err) await err.cleanup()
  parent?.cleanup();await sandbox.disposeAsync();await service.close();log('all-original-owners-clean-and-worker-exit-joined',{rootJoined})
}
