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
const code = `const k=require(${JSON.stringify(koffi)});const l=k.load('kernel32.dll'),a=k.load('advapi32.dll');const cur=l.func('__stdcall','GetCurrentProcess','void *',[]),open=a.func('__stdcall','OpenProcessToken','int',['void *','uint32','void *']),restricted=a.func('__stdcall','IsTokenRestricted','int',['void *']),close=l.func('__stdcall','CloseHandle','int',['void *']);const s=k.alloc('void *',1);if(!open(cur(),8,s))throw Error('open token');const t=k.decode(s,'void *'),r=restricted(t);if(!close(t))throw Error('close token');k.free(s);const deadline=setTimeout(()=>process.exit(99),4000);process.stdin.on('end',()=>{clearTimeout(deadline);process.stdout.write(Buffer.from([0,1,127,128,255,65]));process.stderr.write(JSON.stringify({text:'雪',stdinEOF:true,restricted:r}));process.exitCode=23});process.stdin.resume()`
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

// Each phase owns its sandboxes through final disposal, including failed setup.
async function withSandbox<T>(action: (sandbox: AclSandbox) => Promise<T>): Promise<T> {
  const owner = new AclSandbox({ mode: 'read-only', writableDirs: [], manageDacls: false })
  try { await owner.init(); return await action(owner) } finally { await owner.disposeAsync() }
}
async function launch(owner: AclSandbox, source: string) {
  log('child-command', { executable: process.execPath, args: ['-e', source], cwd })
  return owner.spawn({ command: process.execPath, args: ['-e', source], cwd })
}
await withSandbox(async owner => {
  const source = `const deadline=setTimeout(()=>process.exit(99),4000);process.stdin.on('end',()=>{clearTimeout(deadline);process.stdout.write(Buffer.from([0,255,42]));process.stderr.write('雪259');process.exitCode=259});process.stdin.resume()`
  const child = await launch(owner, source)
  const result = await child.wait()
  assert.equal(result.exitCode, 259)
  assert.deepEqual(result.stdout, Buffer.from([0, 255, 42]))
  assert.deepEqual(result.stderr, Buffer.from('雪259'))
  owner.dispose()
  log('phase-exit-259', { pid: child.pid, exitCode: result.exitCode, stdout: result.stdout.toString('hex'), stderr: result.stderr.toString('hex') })
})
await withSandbox(async owner => {
  const api = (owner as unknown as { api: { getExitCodeProcess: (...args: any[]) => number } }).api
  const original = api.getExitCodeProcess
  let rootObserved: number | undefined
  api.getExitCodeProcess = function (...args) { const result = original.apply(this, args); rootObserved = Date.now(); log('tail-root-status-read', { at: rootObserved, result }); return result }
  try {
    const grandchild = `const deadline=setTimeout(()=>process.exit(99),4000);setTimeout(()=>{clearTimeout(deadline);process.stdout.write('TAIL');process.stderr.write(String(Date.now()));},200)`
    const source = `const deadline=setTimeout(()=>process.exit(99),4000);process.stdin.on('end',()=>{const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit'],windowsHide:true,detached:true});c.unref();process.stdout.write('ROOT');clearTimeout(deadline);process.exitCode=23});process.stdin.resume()`
    const child = await launch(owner, source)
    const result = await child.wait()
    assert.equal(result.exitCode, 23)
    assert.deepEqual(result.stdout, Buffer.from('ROOTTAIL'))
    const tailAt = Number(result.stderr.toString('utf8'))
    assert.ok(Number.isSafeInteger(tailAt) && rootObserved !== undefined && rootObserved < tailAt, 'root status must be observed before tail write')
    owner.dispose()
    log('phase-root-before-tail', { pid: child.pid, rootObserved, tailAt, stdout: result.stdout.toString('hex'), stderr: result.stderr.toString('hex') })
  } finally { api.getExitCodeProcess = original }
})
const sharedA = new AclSandbox({ mode: 'read-only', writableDirs: [], manageDacls: false })
const sharedB = new AclSandbox({ mode: 'read-only', writableDirs: [], manageDacls: false })
try {
  await Promise.all([sharedA.init(), sharedB.init()])
  const source = (label: string, delay: number) => `const deadline=setTimeout(()=>process.exit(99),4000);process.stdin.on('end',()=>{setTimeout(()=>{clearTimeout(deadline);process.stdout.write(${JSON.stringify(label)});process.stderr.write(${JSON.stringify('雪' + label)});process.exitCode=23},${delay})});process.stdin.resume()`
  const [a, b] = await Promise.all([launch(sharedA, source('A', 100)), launch(sharedB, source('B', 800))])
  const order: string[] = []
  const aWait = a.wait().then(value => { order.push('A'); return value })
  const bWait = b.wait().then(value => { order.push('B'); return value })
  const first = await aWait
  assert.deepEqual(order, ['A'])
  assert.equal(first.exitCode, 23); assert.deepEqual(first.stdout, Buffer.from('A')); assert.deepEqual(first.stderr, Buffer.from('雪A'))
  sharedA.dispose()
  const second = await bWait
  assert.deepEqual(order, ['A', 'B'])
  assert.equal(second.exitCode, 23); assert.deepEqual(second.stdout, Buffer.from('B')); assert.deepEqual(second.stderr, Buffer.from('雪B'))
  sharedB.dispose()
  log('phase-shared-clients', { pids: [a.pid, b.pid], order, stdout: [first.stdout.toString('hex'), second.stdout.toString('hex')], stderr: [first.stderr.toString('hex'), second.stderr.toString('hex')] })
} finally { await Promise.all([sharedA.disposeAsync(), sharedB.disposeAsync()]) }
