import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { AclSandbox } from '../../src/index.ts'
import { verifyWaitAssets } from '../../src/native-wait-bridge.ts'

assert.equal(process.env.IH_ACL_INHERITED_QUALIFICATION, '1')
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
const cwd = process.env.IH_ACL_INHERITED_CWD, trace = process.env.IH_ACL_INHERITED_TRACE
assert.ok(cwd && trace)
const log = (event: string, detail: unknown = {}) => appendFileSync(trace, JSON.stringify({ event, detail }) + '\n')
log('verified-default-assets', verifyWaitAssets(fileURLToPath(new URL('../../native/runtime/', import.meta.url))))
const koffi = createRequire(import.meta.url).resolve('koffi')
const source = `const k=require(${JSON.stringify(koffi)});const l=k.load('kernel32.dll'),a=k.load('advapi32.dll');const cur=l.func('__stdcall','GetCurrentProcess','void *',[]),open=a.func('__stdcall','OpenProcessToken','int',['void *','uint32','void *']),restricted=a.func('__stdcall','IsTokenRestricted','int',['void *']),close=l.func('__stdcall','CloseHandle','int',['void *']);const s=k.alloc('void *',1);if(!open(cur(),8,s))throw Error('open token');const t=k.decode(s,'void *'),r=restricted(t);if(!close(t))throw Error('close token');k.free(s);const deadline=setTimeout(()=>process.exit(99),4000);process.stdin.on('end',()=>{setTimeout(()=>{clearTimeout(deadline);process.stdout.write('inherited-out-雪:'+r);process.stderr.write('inherited-err-雪:EOF');process.exitCode=259},200)});process.stdin.resume()`
const sandbox = new AclSandbox({ mode: 'read-only', writableDirs: [], manageDacls: false })
try {
  await sandbox.init()
  log('child-command', { executable: process.execPath, args: ['-e', source], cwd, stdio: 'inherit' })
  const child = await sandbox.spawn({ command: process.execPath, args: ['-e', source], cwd, stdio: 'inherit' })
  let progress = false
  const timer = setTimeout(() => { progress = true; log('progress-callback') }, 30)
  try {
    const first = child.wait(), second = child.wait()
    assert.equal(first, second)
    const result = await first
    assert.equal(progress, true, 'event loop must progress during wait')
    assert.equal(result.exitCode, 259)
    assert.deepEqual(result.stdout, Buffer.alloc(0)); assert.deepEqual(result.stderr, Buffer.alloc(0))
    log('inherited-complete', { pid: child.pid, exitCode: result.exitCode, progress })
  } finally { clearTimeout(timer) }
} catch (error) { log('fixture-failure', { message: String(error), stack: error instanceof Error ? error.stack : undefined }); throw error }
finally { await sandbox.disposeAsync(); log('sandbox-disposed') }
