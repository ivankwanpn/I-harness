import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import koffi from 'koffi'
import { expect, it } from 'vitest'

it.skipIf(process.env.IH_ACL_INDEPENDENT_JOB !== '1')('proves one inner Job descendant exit with a pinned test observation handle', async () => {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
  const evidence = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
  assert.ok(evidence)
  const cwd = join(evidence, 'independent-inherited-job'), temp = join(cwd, 'temp'), trace = join(cwd, 'trace.jsonl'), nonce = randomUUID()
  mkdirSync(cwd); mkdirSync(temp)
  const record = (event: string, detail: object = {}) => appendFileSync(trace, JSON.stringify({ event, nonce, ...detail, at: new Date().toISOString() }) + '\n')
  const fixture = fileURLToPath(new URL('./fixtures/independent-inherited-job.ts', import.meta.url))
  const args = ['--experimental-transform-types', fixture]
  const env = { ...process.env, NODE_OPTIONS: '', NODE_DISABLE_COMPILE_CACHE: '1', TEMP: temp, TMP: temp, IH_ACL_JOB_NONCE: nonce, IH_ACL_JOB_CWD: cwd, IH_ACL_JOB_TRACE: trace }
  writeFileSync(join(cwd, 'command.json'), JSON.stringify({ executable: process.execPath, args, cwd, temp, nonce, watchdogMs: 20000, scope: 'all-inherited-only; observation-handle-not-production-authority' }, null, 2))
  const kernel = koffi.load('kernel32.dll')
  const open = kernel.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int', 'uint32'])
  const wait = kernel.func('__stdcall', 'WaitForSingleObject', 'uint32', ['void *', 'uint32'])
  const times = kernel.func('__stdcall', 'GetProcessTimes', 'int', ['void *', 'void *', 'void *', 'void *', 'void *'])
  const exitCode = kernel.func('__stdcall', 'GetExitCodeProcess', 'int', ['void *', 'void *'])
  const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['void *'])
  let observation: unknown, closeIssued = false, rootPid: number | undefined, ready: Record<string, unknown> | undefined
  let captured = false, proved = false, expired = false, failure: unknown, stdout = '', stderr = '', pending = ''
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  record('outer-host-started', { pid: child.pid, parentPid: process.pid, executable: process.execPath, args })
  const creation = () => {
    const bytes = Buffer.alloc(32)
    assert.notEqual(times(observation, bytes.subarray(0, 8), bytes.subarray(8, 16), bytes.subarray(16, 24), bytes.subarray(24, 32)), 0)
    return bytes.readBigUInt64LE(0).toString()
  }
  const alive = () => assert.equal(wait(observation, 0), 258, 'same observation handle must still be live')
  const cleanup = (error: unknown) => {
    failure ??= error
    record('qualification-failure', { error: String(error), cleanup: 'original sandbox owner only; never PID control' })
    if (!child.stdin.destroyed) child.stdin.write(`CLEANUP ${nonce}\n`)
  }
  function captureIdentity() {
    if (captured || !rootPid || !ready) return
    captured = true
    const pid = ready.pid
    assert.ok(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff)
    assert.equal(ready.parentPid, rootPid)
    assert.equal(resolve(String(ready.executable)).toLowerCase(), resolve(process.execPath).toLowerCase())
    // Test-only observation rights. No terminate, duplicate or set-information.
    const acquired = open(0x00100000 | 0x1000, 0, pid)
    assert.ok(typeof acquired === 'bigint' && acquired > 0n && acquired < 0xffffffffffffffffn)
    observation = acquired
    alive(); const before = creation()
    const script = `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`
    record('identity-snapshot-command', { executable: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script], targetPid: pid })
    const snapshot = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { cwd, windowsHide: true, encoding: 'utf8', timeout: 5000 }))
    alive(); const after = creation()
    assert.equal(snapshot.ProcessId, pid); assert.equal(snapshot.ParentProcessId, rootPid)
    assert.equal(resolve(snapshot.ExecutablePath).toLowerCase(), resolve(process.execPath).toLowerCase())
    assert.equal(before, after); assert.equal(before, ready.creationFileTime)
    record('observation-identity-captured', { pid, rootPid, creationFileTime: before, snapshot, rights: 'SYNCHRONIZE|QUERY_LIMITED_INFORMATION', provenance: 'OpenProcess test observation; not original creation handle' })
    child.stdin.write(`EXIT ${nonce}\n`)
    record('exit-root-sent', { rootPid })
  }
  child.stdout.on('data', chunk => {
    stdout += chunk.toString(); appendFileSync(join(cwd, 'stdout.txt'), chunk); pending += chunk.toString()
    try {
      assert.ok(pending.length <= 65536)
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n'), line = pending.slice(0, end), item = JSON.parse(line); pending = pending.slice(end + 1)
        assert.equal(item.nonce, nonce)
        // Preserve exact confined records here, never by a confined file write.
        if (item.role !== 'host') appendFileSync(trace, line + '\n')
        if (String(item.event).includes('failure')) throw new Error(JSON.stringify(item))
        if (item.event === 'root-admitted') { assert.equal(rootPid, undefined); rootPid = item.pid }
        if (item.event === 'descendant-ready') { assert.equal(ready, undefined); ready = item }
        captureIdentity()
        if (item.event === 'root-wait-and-dispose-complete') {
          assert.ok(captured && observation && !expired && !failure)
          assert.equal(item.pid, rootPid); assert.equal(item.exitCode, 23)
          assert.equal(wait(observation, 0), 0, 'descendant must have exited before outer teardown')
          const code = Buffer.alloc(4); assert.notEqual(exitCode(observation, code), 0)
          assert.notEqual(code.readUInt32LE(0), 99, 'descendant deadline cannot supply positive proof')
          proved = true
          record('same-handle-descendant-exit-proved', { pid: ready!.pid, exitCode: code.readUInt32LE(0), beforeOuterTeardown: true })
          child.stdin.end(`ACK ${nonce}\n`)
        }
      }
    } catch (error) { cleanup(error) }
  })
  child.stderr.on('data', chunk => { stderr += chunk.toString(); appendFileSync(join(cwd, 'stderr.txt'), chunk) })
  child.on('error', cleanup)
  const timer = setTimeout(() => { expired = true; record('outer-watchdog-failure', { pid: child.pid }); child.kill() }, 20000)
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>(done => child.once('close', (code, signal) => done({ code, signal })))
    writeFileSync(join(cwd, 'result.json'), JSON.stringify({ ...result, pid: child.pid, expired, proved, failure: failure === undefined ? undefined : String(failure), stdout, stderr }, null, 2))
    expect(expired).toBe(false); expect(failure).toBeUndefined(); expect(proved).toBe(true)
    expect(result.code, stderr + stdout).toBe(0)
    expect(stdout).toContain('independent-job-complete')
  } finally {
    clearTimeout(timer)
    if (observation && !closeIssued) { closeIssued = true; assert.notEqual(close(observation), 0, 'observation handle close refused') }
  }
}, 25000)
