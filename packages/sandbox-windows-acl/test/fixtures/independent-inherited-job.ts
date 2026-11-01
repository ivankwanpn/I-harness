import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import koffi from 'koffi'
import { AclSandbox } from '../../src/index.ts'
import { verifyWaitAssets } from '../../src/native-wait-bridge.ts'

async function main() {
  // Import/transform gate only: no DLL, asset validation or sandbox construction.
  if (process.argv.includes('--source-check')) {
    process.stdout.write(JSON.stringify({ event: 'source-check-ok', fixture: fileURLToPath(import.meta.url), loader: 'node-experimental-transform-types' }) + '\n')
    return
  }
  assert.equal(process.env.IH_ACL_INDEPENDENT_JOB, '1')
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
  const nonce = process.env.IH_ACL_JOB_NONCE!, cwd = process.env.IH_ACL_JOB_CWD!, trace = process.env.IH_ACL_JOB_TRACE!
  assert.match(nonce, /^[a-f0-9-]{36}$/); assert.ok(cwd && trace)
  const emit = (event: string, detail: object = {}) => {
    const record = { event, nonce, ...detail }
    appendFileSync(trace, JSON.stringify(record) + '\n')
    process.stdout.write(JSON.stringify(record) + '\n')
  }
  function provenance() {
    const kernel = koffi.load('kernel32.dll')
    const self = kernel.func('__stdcall', 'GetCurrentProcess', 'void *', [])
    const times = kernel.func('__stdcall', 'GetProcessTimes', 'int', ['void *', 'void *', 'void *', 'void *', 'void *'])
    const bytes = Buffer.alloc(32)
    assert.notEqual(times(self(), bytes.subarray(0, 8), bytes.subarray(8, 16), bytes.subarray(16, 24), bytes.subarray(24, 32)), 0)
    return { pid: process.pid, parentPid: process.ppid, executable: process.execPath, argv: process.argv, creationFileTime: bytes.readBigUInt64LE(0).toString() }
  }
  const fixture = fileURLToPath(import.meta.url)
  if (process.argv.includes('--descendant')) {
    // This deadline is a negative only. The outer same-handle check rejects99.
    setTimeout(() => { emit('descendant-deadline-failure'); process.exit(99) }, 4000)
    emit('descendant-ready', provenance())
    return
  }
  if (process.argv.includes('--root')) {
    const deadline = setTimeout(() => { emit('root-deadline-failure'); process.exit(99) }, 4000)
    let input = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => {
      input += chunk
      assert.ok(input.length <= 256)
      if (!input.includes('\n')) return
      assert.equal(input, `EXIT ${nonce}\n`)
      clearTimeout(deadline)
      process.stdin.pause()
      emit('root-exit-requested', { pid: process.pid })
      process.exit(23)
    })
    const child = spawn(process.execPath, ['--experimental-transform-types', fixture, '--descendant'], {
      stdio: ['inherit', 'inherit', 'inherit'], windowsHide: true,
    })
    emit('descendant-launch', { pid: child.pid, parentPid: process.pid, executable: process.execPath, argv: child.spawnargs })
    child.once('error', error => { emit('descendant-launch-failure', { error: String(error) }); process.exit(98) })
    child.unref()
    return
  }
  const sandbox = new AclSandbox({ mode: 'read-only', writableDirs: [], manageDacls: false })
  try {
    emit('host-provenance', provenance())
    emit('verified-default-assets', verifyWaitAssets(fileURLToPath(new URL('../../native/runtime/', import.meta.url))))
    await sandbox.init()
    emit('root-command', { executable: process.execPath, args: ['--experimental-transform-types', fixture, '--root'], cwd })
    const root = await sandbox.spawn({ command: process.execPath, args: ['--experimental-transform-types', fixture, '--root'], cwd, stdio: 'inherit' })
    emit('root-admitted', { pid: root.pid })
    const result = await root.wait()
    assert.equal(result.exitCode, 23)
    await sandbox.disposeAsync()
    emit('root-wait-and-dispose-complete', { pid: root.pid, exitCode: result.exitCode })
    // Root alone consumed stdin before exit. Host now waits for the outer proof,
    // so host teardown/watchdog cannot be counted as descendant-kill evidence.
    const control = await new Promise<string>((resolve, reject) => {
      let pending = ''
      process.stdin.setEncoding('utf8')
      const data = (chunk: string) => {
        pending += chunk
        if (pending.length > 256) { done(); reject(new Error('oversized host control')); return }
        if (pending.includes('\n')) { done(); resolve(pending) }
      }
      const end = () => { done(); reject(new Error('host control EOF before proof')) }
      const done = () => { process.stdin.off('data', data); process.stdin.off('end', end); process.stdin.pause() }
      process.stdin.on('data', data); process.stdin.once('end', end); process.stdin.resume()
    })
    if (control === `CLEANUP ${nonce}\n`) {
      await sandbox.disposeAsync()
      emit('original-owner-cleanup-attempted')
      throw new Error('outer observation refused qualification')
    }
    assert.equal(control, `ACK ${nonce}\n`)
    emit('independent-job-complete')
  } catch (error) {
    emit('fixture-failure', { error: String(error) })
    throw error
  } finally {
    await sandbox.disposeAsync()
  }
}
await main()
