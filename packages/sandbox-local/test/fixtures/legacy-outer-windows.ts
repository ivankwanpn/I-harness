import assert from 'node:assert/strict'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createLocalExecutionBackends } from '../../src/execution-backends.ts'
import { compileExecutionPolicy } from '@i-harness/sandbox-policy'
import type { TransportExecutionHandle, ExecutionSettlement, ProcessSpec } from '@i-harness/sandbox'
import { verifyHelper } from '../../../sandbox-windows-psec/src/integrity.ts'
import { verifyWaitAssets } from '../../../sandbox-windows-acl/src/native-wait-assets.mjs'

assert.equal(process.env.IH_LEGACY_OUTER_QUALIFICATION, '1')
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64'); assert.equal(process.version, 'v24.15.0')
const root = process.env.IH_LEGACY_OUTER_ROOT!
const record = (event: string, data: object = {}) => appendFileSync(join(root, 'trace.jsonl'), JSON.stringify({ event, ...data, at: new Date().toISOString() }) + '\n')
const aclRequire = createRequire(new URL('../../../sandbox-windows-acl/package.json', import.meta.url))
const koffiEntry = aclRequire.resolve('koffi')
const runner = fileURLToPath(new URL('../../../sandbox-windows-acl/src/runner.ts', import.meta.url))
const runnerLoader = new URL('file:///' + aclRequire.resolve('tsx/esm').replaceAll('\\', '/')).href
function hostIdentity() {
  const k = aclRequire('koffi'), kernel = k.load('kernel32.dll')
  const currentProcess = kernel.func('__stdcall', 'GetCurrentProcess', 'void *', [])
  const getTimes = kernel.func('__stdcall', 'GetProcessTimes', 'int', ['void *', 'void *', 'void *', 'void *', 'void *'])
  const times = Buffer.alloc(32)
  assert.notEqual(getTimes(currentProcess(), times, times.subarray(8), times.subarray(16), times.subarray(24)), 0)
  return { pid: process.pid, parentPid: process.ppid, creationFileTime: times.readBigUInt64LE().toString(), executable: process.execPath, argv: process.argv, cwd: process.cwd() }
}
// The finite child uses the qualified self-token size/query pattern. Only its
// original process token is opened; native pointer ranges stay within Buffer.
const childProgram = (phase: string) => `
const assert=require('node:assert/strict'),k=require(${JSON.stringify(koffiEntry)});
const a=k.load('advapi32.dll'), n=k.load('kernel32.dll');
const bind=(d,name,r,args)=>d.func('__stdcall',name,r,args);
const open=bind(a,'OpenProcessToken','int',['void *','uint32','void *']);
const get=bind(a,'GetTokenInformation','int',['void *','uint32','void *','uint32','void *']);
const current=bind(n,'GetCurrentProcess','void *',[]),close=bind(n,'CloseHandle','int',['void *']);
const last=bind(n,'GetLastError','uint32',[]),times=bind(n,'GetProcessTimes','int',['void *','void *','void *','void *','void *']);
const deadline=setTimeout(()=>process.exit(99),8000),slot=Buffer.alloc(8),needed=Buffer.alloc(4),t=Buffer.alloc(32);
let token, count, sids, cleanupAcknowledged=false;
try {
 assert.notEqual(open(current(),8,slot),0);token=k.decode(slot,'void *');
 assert.equal(get(token,11,null,0,needed),0);assert.equal(last(),122);
 const size=needed.readUInt32LE();assert(size>=8&&size<=65536);const b=Buffer.alloc(size);
 assert.notEqual(get(token,11,b,size,needed),0);const returned=needed.readUInt32LE();assert(returned<=size&&returned>=8);
 count=b.readUInt32LE();assert(count>0&&count<=256&&8+16*count<=returned);
 const base=k.address(b);sids=Array.from({length:count},(_,i)=>{
  const p=b.readBigUInt64LE(8+16*i);assert(p>=base&&p+8n<=base+BigInt(returned));
  const h=new Uint8Array(k.view(p,8)),len=8+4*h[1];assert(h[0]===1&&h[1]<=15&&p+BigInt(len)<=base+BigInt(returned));
  const v=new DataView(k.view(p,len));let authority=0;for(let j=2;j<8;j++)authority=authority*256+h[j];
  return 'S-1-'+authority+Array.from({length:h[1]},(_,j)=>'-'+v.getUint32(8+4*j,true)).join('');
 });assert(sids.includes('S-1-1-0'));assert(sids.some(x=>x.startsWith('S-1-5-5-')));
 assert.notEqual(times(current(),t,t.subarray(8),t.subarray(16),t.subarray(24)),0);
} finally {if(token)assert.notEqual(close(token),0);cleanupAcknowledged=true;}
const ready=JSON.stringify({event:'READY',phase:${JSON.stringify(phase)},pid:process.pid,parentPid:process.ppid,creationFileTime:t.readBigUInt64LE().toString(),restrictingSids:sids,cleanupAcknowledged})+'\\n';
const input=[];process.stdin.on('data',b=>input.push(b));
process.stdin.on('end',()=>{
 if(${JSON.stringify(phase)}!=='normal')process.exit(98);
 assert.deepEqual(Buffer.concat(input),Buffer.from([73,72,0,255,10]));
 process.stdout.write(Buffer.from([0,255,65,0,226,152,131]));process.stderr.write('stderr-雪\\n');
 clearTimeout(deadline);process.exitCode=23;
});process.stdout.write(ready);process.stdin.resume();
`

let current: TransportExecutionHandle | undefined, aborted = false
let abortReject!: (e: Error) => void
const abort = new Promise<never>((_, reject) => { abortReject = reject }); void abort.catch(() => {})
process.on('message', message => { if ((message as any)?.event === 'abort-qualification') {
  aborted = true; record('abort-request'); abortReject(new Error('wrapper watchdog expired'))
  if (current) void current.cancel('timeout').then(value => record('abort-cancel', { value }), error => record('abort-cancel-error', { error: String(error) }))
} })
const settled = (value: ExecutionSettlement) => {
  assert.equal(value.kind, 'settled'); if (value.kind !== 'settled') throw new Error('incomplete ownership')
  assert.equal(value.treeEmpty, true); assert.equal(value.ioSettled, true); assert.equal(value.resourcesReleased, true)
}
async function main() {
  const cwd = join(root, 'cwd'), temp = join(root, 'temp')
  mkdirSync(cwd); mkdirSync(temp)
  record('host-provenance', hostIdentity())
  record('assets', { outer: await verifyHelper(), inner: verifyWaitAssets(fileURLToPath(new URL('../../../sandbox-windows-acl/native/runtime/', import.meta.url))) })
  const local = createLocalExecutionBackends({ windowsSelection: 'legacy', legacyPrivateTempRoot: temp })
  try {
    for (const phase of ['normal', 'cancel']) {
      assert.equal(aborted, false)
      const owner = Object.freeze({ sessionId: 'legacy-outer-qualified' })
      const policy = compileExecutionPolicy({ mode: 'read-only', owner, authority: { kind: 'unbound', revision: 'outer-fixture-v1', workspaceRoot: cwd } })
      const spec: ProcessSpec = { argv: [process.execPath, '-e', childProgram(phase)], cwd,
        env: { SystemRoot: process.env.SystemRoot!, TEMP: temp, TMP: temp }, owner, transport: 'pipe', lifetime: 'complete-tree', argumentEncoding: 'crt' }
      const sourceRunnerArgv = [process.execPath, '--import', runnerLoader, runner, '--workspace', cwd, '--temp', temp, '--mode', 'read-only', '--windows-hide', 'true', '--', ...spec.argv]
      writeFileSync(join(root, phase + '-command.json'), JSON.stringify({ spec, policy, sourceRunnerArgv,
        runnerArgvProvenance: 'source-derived from current index.ts aclRunnerArgv/confineExecution read-only CRT branch; production owner retained without interception' }, null, 2))
      const backend = local.select(policy, 'pipe', spec)
      const probe = await backend.probe(); record('probe', { phase, probe }); assert.equal(probe.availability, 'available'); assert.equal(probe.features.pipes, true)
      const prepared = await backend.prepare(spec, policy); record('prepared', { phase })
      let handle: TransportExecutionHandle | undefined
      try {
        handle = await prepared.commit(() => { assert.equal(aborted, false); assert.equal(policy.owner.sessionId, owner.sessionId) })
        current = handle
        record('committed', { phase, runnerPid: handle.pid, receipt: handle.receipt, runner: handle.runner })
        assert.equal(handle.receipt.backendId, 'windows-acl-legacy'); assert.equal(handle.receipt.policyFingerprint, policy.fingerprint); assert.deepEqual(handle.receipt.owner, owner)
        assert.equal(handle.runner?.enforcement, 'partial'); assert(handle.runner.denialSignatures.length); assert(handle.runner.runnerFailureRules.length)
        const h = handle, out: Buffer[] = [], err: Buffer[] = []
        let readyResolve!: (value: any) => void, readyReject!: (e: unknown) => void
        const ready = new Promise<any>((yes, no) => { readyResolve = yes; readyReject = no }); void ready.catch(() => {})
        let readyBytes: Buffer | undefined
        const consume = (async () => { try {
          for await (const frame of h.io.output) {
            const b = Buffer.from(frame.data); (frame.channel === 'stdout' ? out : err).push(b)
            if (!readyBytes && frame.channel === 'stdout') {
              const all = Buffer.concat(out), end = all.indexOf(10)
              if (end >= 0) { readyBytes = all.subarray(0, end + 1); const identity = JSON.parse(readyBytes.toString()); record('READY', { phase, identity, hex: readyBytes.toString('hex') }); readyResolve(identity) }
            }
          }
          record('output-EOF', { phase }); if (!readyBytes) readyReject(new Error('EOF before READY'))
        } catch (e) { readyReject(e); throw e } })(); void consume.catch(() => {})
        const rootExit = h.rootExited.then(value => { record('root-exited', { phase, value }); return value }); void rootExit.catch(() => {})
        const whole = h.settled.then(value => { record('whole-settlement', { phase, value }); return value }); void whole.catch(() => {})
        const identity = await Promise.race([ready, abort]); assert.equal(identity.event, 'READY'); assert.equal(identity.phase, phase); assert.equal(identity.cleanupAcknowledged, true); assert(identity.restrictingSids.includes('S-1-1-0'))
        if (phase === 'normal') {
          await h.io.write(Buffer.from([73,72,0,255,10])); record('input-written', { phase })
          await h.io.endInput(); record('input-EOF', { phase })
        } else { record('cancel-request', { phase, readyHex: readyBytes!.toString('hex') }); const value = await h.cancel('cancelled'); record('cancel-return', { phase, value }); settled(value) }
        const [status, , value] = await Promise.race([Promise.all([rootExit, consume, whole]), abort])
        assert.equal(status.observationError, undefined); assert.notEqual(status.exitCode, 99); if (phase === 'cancel') assert.notEqual(status.exitCode, 98, 'stdin EOF caused cancellation-phase exit')
        settled(value)
        if (phase === 'normal') { assert.equal(status.exitCode, 23); assert.deepEqual(Buffer.concat(out), Buffer.concat([readyBytes!, Buffer.from([0,255,65,0,226,152,131])])); assert.equal(Buffer.concat(err).toString(), 'stderr-雪\n') }
        record('output-and-diagnostics', { phase, stdoutHex: Buffer.concat(out).toString('hex'), stderrHex: Buffer.concat(err).toString('hex'), diagnostics: h.io.diagnostics?.() })
        const release = await h.release(); record('release-ACK', { phase, value: release }); settled(release)
      } finally {
        if (!handle) { await prepared.rollback(); record('rollback-ACK', { phase }) }
        else { const release = await handle.release(); record('finally-release-ACK', { phase, value: release }); settled(release); current = undefined }
      }
    }
  } finally { await local.dispose(); record('local-dispose-ACK') }
  record('qualification-complete'); process.stdout.write(JSON.stringify({ event: 'qualification-complete' }) + '\n')
}
try { await main() } catch (error) { record('qualification-failed', { error: String(error) }); process.exitCode = 1 }
finally { process.disconnect?.() }
