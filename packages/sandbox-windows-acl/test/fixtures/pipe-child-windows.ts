import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { AclSandbox } from '../../src/index.ts'
import { verifyWaitAssets } from '../../src/native-wait-bridge.ts'

assert.equal(process.env.IH_ACL_PIPE_QUALIFICATION, '1')
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
const cwd = process.env.IH_ACL_PIPE_CWD, trace = process.env.IH_ACL_PIPE_TRACE
assert.ok(cwd && trace)
const log = (event: string, detail: unknown = {}) => {
  const line = JSON.stringify({ event, detail })
  appendFileSync(trace, line + '\n')
  process.stdout.write(line + '\n')
}
const assets = fileURLToPath(new URL('../../native/runtime/', import.meta.url))
log('verified-default-assets', verifyWaitAssets(assets))
const koffi = createRequire(import.meta.url).resolve('koffi')
const code = `const k=require(${JSON.stringify(koffi)});const l=k.load('kernel32.dll'),a=k.load('advapi32.dll');const cur=l.func('__stdcall','GetCurrentProcess','void *',[]),open=a.func('__stdcall','OpenProcessToken','int',['void *','uint32','void *']),restricted=a.func('__stdcall','IsTokenRestricted','int',['void *']),close=l.func('__stdcall','CloseHandle','int',['void *']);const s=k.alloc('void *',1);if(!open(cur(),8,s))throw Error('open token');const t=k.decode(s,'void *'),r=restricted(t);if(!close(t))throw Error('close token');k.free(s);process.stdin.on('end',()=>{process.stdout.write(Buffer.from([0,1,127,128,255,65]));process.stderr.write(JSON.stringify({text:'雪',stdinEOF:true,restricted:r}));process.exitCode=23});process.stdin.resume()`
const sandbox = new AclSandbox({ mode: 'read-only', writableDirs: [], manageDacls: false })
try {
  await sandbox.init()
  log('initialized')
  const child = await sandbox.spawn({ command: process.execPath, args: ['-e', code], cwd })
  const first = child.wait(), second = child.wait()
  assert.equal(first, second)
  const result = await first
  assert.equal(result.exitCode, 23)
  assert.deepEqual(result.stdout, Buffer.from([0, 1, 127, 128, 255, 65]))
  assert.deepEqual(JSON.parse(result.stderr.toString('utf8')), { text: '雪', stdinEOF: true, restricted: 1 })
  sandbox.dispose()
  await sandbox.disposeAsync()
  log('public-pipe-complete', { pid: child.pid, exitCode: result.exitCode })
} catch (error) {
  log('fixture-failure', { message: String(error), stack: error instanceof Error ? error.stack : undefined })
  throw error
} finally {
  await sandbox.disposeAsync()
}
