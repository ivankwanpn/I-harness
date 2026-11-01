import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { CompiledSandboxPolicy, ProcessSpec, PreparedTransportExecution, TransportExecutionHandle } from '@i-harness/sandbox'
import { ControllerGuard, strictFrame, auditWorker, IDENTITY_HELPER, recordedDiagnostic } from './actual-controller-guard.ts'

const state = vi.hoisted(() => ({ guard: undefined as ControllerGuard | undefined }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>()
  return { ...original,
    spawn: (...args: unknown[]) => state.guard
      ? state.guard.acquire('worker', () => Reflect.apply(original.spawn, original, args), { executable: args[0], args: args[1], options: args[2] })
      : Reflect.apply(original.spawn, original, args),
    execFile: (...args: unknown[]) => state.guard
      ? state.guard.acquire('helper', () => Reflect.apply(original.execFile, original, args), { executable: args[0], args: args[1], options: args[2] })
      : Reflect.apply(original.execFile, original, args),
  }
})
import { createWslExecutionBackend } from '../src/index.ts'
import { BOOTSTRAP, WSL_EXE } from '../src/transport.ts'

function fakeChild() {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false })
  return child
}
it('controller guard retains the original before returning to bootstrap and deduplicates ownership', () => {
  const guard = new ControllerGuard(), child = fakeChild()
  expect(guard.acquire('worker', () => child, {})).toBe(child)
  expect(guard.entries[0].child).toBe(child)
  guard.acquire('worker', () => child, {})
  expect(guard.entries.filter(entry => entry.child === child)).toHaveLength(1)
  child.emit('close', 0, null)
})
it('controller guard refuses exit without stream EOF and original close', () => {
  const guard = new ControllerGuard(), child = fakeChild()
  guard.acquire('worker', () => child, {})
  child.emit('exit', 0, null)
  expect(() => guard.audit()).toThrow()
  child.emit('close', 0, null)
})

it('controller guard retains acquired child when observer setup throws', () => {
  const guard = new ControllerGuard(), child = fakeChild()
  const on = child.on.bind(child)
  child.on = ((event: string, callback: (...args: unknown[]) => void) => {
    if (event === 'error') throw new Error('observer install failed')
    return on(event, callback)
  }) as typeof child.on
  expect(guard.acquire('worker', () => child, {})).toBe(child)
  expect(guard.entries[0].child).toBe(child)
  expect(child.stdin!.destroyed).toBe(true)
  expect(() => guard.audit()).toThrow()
  clearTimeout(guard.entries[0].timer)
})
it('controller guard keeps producer failure distinct from an acquired original', () => {
  const guard = new ControllerGuard()
  expect(() => guard.acquire('worker', () => { throw new Error('not created') }, {})).toThrow('not created')
  expect(guard.entries[0].child).toBeUndefined()
  expect(guard.entries[0].producerFailed).toBe(true)
  expect(() => guard.audit()).toThrow()
})
it('controller guard latches timeout before closing a blocked control and never promotes late close', async () => {
  vi.useFakeTimers()
  try {
    const guard = new ControllerGuard(10), child = fakeChild()
    let failedAtEnd = false
    child.stdin!.end = (() => { failedAtEnd = guard.failures.length > 0; return child.stdin }) as NonNullable<ChildProcess['stdin']>['end']
    guard.acquire('worker', () => child, {})
    await vi.advanceTimersByTimeAsync(10)
    expect(failedAtEnd).toBe(true)
    child.stdout!.emit('end'); child.stderr!.emit('end'); child.emit('close', 0, null)
    expect(() => guard.audit()).toThrow()
  } finally { vi.useRealTimers() }
})
it('controller guard attempts independent original controls and retains unresolved operations', async () => {
  const guard = new ControllerGuard(), a = fakeChild(), b = fakeChild()
  guard.acquire('worker', () => a, {}); guard.acquire('worker', () => b, {})
  a.stdin!.end = (() => { throw new Error('independent end failed') }) as NonNullable<ChildProcess['stdin']>['end']
  void guard.track('unresolved original', new Promise(() => {})).catch(() => {})
  guard.fail(new Error('primary'))
  guard.closeControls(); guard.closeControls()
  expect(b.stdin!.destroyed).toBe(true)
  expect(a.stdin!.destroyed).toBe(true)
  expect(guard.failures.map(String)).toContain('Error: primary')
  await expect(guard.join(0)).rejects.toThrow('UNKNOWN')
  a.emit('close', 0, null); b.emit('close', 0, null)
  expect(guard.operations[0].state).toBe('pending')
})
it('controller guard rejects duplicate nested fields trailing faults and truncated frames', () => {
  expect(() => strictFrame('{"a":{"x":1,"x":2}}')).toThrow('duplicate')
  const nonce = 'a'.repeat(64), digest = 'b'.repeat(64)
  const hello = { v: 1, nonce, type: 'hello', sha256: digest, workerPid: 1 }
  const line = (f: object) => JSON.stringify(f) + '\n'
  const bytes = Buffer.from(line(hello) + line({ v: 1, nonce, type: 'probe', available: true }))
  expect(auditWorker(bytes, digest, false, true)).toHaveLength(2)
  expect(() => auditWorker(Buffer.concat([bytes, Buffer.from(line({ v: 1, nonce, type: 'error' }))]), digest, false, true)).toThrow()
  expect(() => auditWorker(bytes.subarray(0, -1), digest, false, true)).toThrow('truncated')
})
it('controller guard bounds cleanup without discarding the original pending operation', async () => {
  const guard = new ControllerGuard()
  await expect(guard.cleanup('stuck original cleanup', new Promise(() => {}), 1)).rejects.toThrow('cleanup deadline')
  expect(guard.operations[0].state).toBe('pending')
  expect(() => guard.audit()).toThrow()
})
it('controller guard records only the exact observed diagnostic and preserves decoded helper text', () => {
  const bytes = Buffer.from('wsl: 偵測到 localhost Proxy 設定，但未鏡像到 WSL。NAT 模式中的 WSL 不支援 localhost Proxy。\r\n', 'utf16le')
  const guard = new ControllerGuard(), child = fakeChild()
  Object.assign(child, { spawnfile: WSL_EXE, spawnargs: [WSL_EXE, '--distribution', 'Ubuntu', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C', '/usr/bin/python3', '-I', '-B', '-u', '-c', BOOTSTRAP] })
  guard.acquire('worker', () => child, { executable: WSL_EXE, args: child.spawnargs.slice(1) })
  child.stderr!.emit('data', bytes)
  expect(recordedDiagnostic(guard.entries[0]).format).toBe('native-buffer')
  expect(recordedDiagnostic(guard.entries[0]).classification).toBe('recorded-localhost-proxy-nat-warning')
  child.emit('close', 0, null)
  const helper = fakeChild(), args = ['--distribution', 'Ubuntu', '--exec', '/usr/bin/python3', '-I', '-B', '-c', IDENTITY_HELPER, 'controlled-payload']
  Object.assign(helper, { spawnfile: WSL_EXE, spawnargs: [WSL_EXE, ...args] })
  helper.stderr!.setEncoding('utf8') // The original execFile representation; no encoding change in observer.
  guard.acquire('helper', () => helper, { executable: WSL_EXE, args })
  helper.stderr!.emit('data', bytes.toString('utf8'))
  const result = recordedDiagnostic(guard.entries[1])
  expect(result.format).toBe('decoded-string:utf8')
  expect(result.nativeByteExact).toBe(false)
  expect(result.text).toBe(bytes.toString('utf8'))
  expect(Buffer.byteLength(result.text, 'utf8')).toBe(159)
  expect(result.text).toContain('\ufffd')
  for (const changed of [result.text + 'extra', result.text.slice(0, -1), 'Traceback']) {
    const entry = guard.entries[1]
    const original = entry.representations.stderr
    entry.representations.stderr = [{ format: 'string', text: changed, encoding: 'utf8' }]
    expect(() => recordedDiagnostic(entry)).toThrow()
    entry.representations.stderr = original
  }
  helper.emit('close', 0, null)
})
it('controller guard rejects altered extra unknown diagnostics and an untrusted producer', () => {
  const known = Buffer.from('wsl: 偵測到 localhost Proxy 設定，但未鏡像到 WSL。NAT 模式中的 WSL 不支援 localhost Proxy。\r\n', 'utf16le')
  for (const bytes of [Buffer.from('Traceback'), Buffer.concat([known, Buffer.from('extra')]), Buffer.concat([known, known]), Buffer.from(known.subarray(0, -2))]) {
    const guard = new ControllerGuard(), child = fakeChild()
    Object.assign(child, { spawnfile: WSL_EXE, spawnargs: [WSL_EXE, '--distribution', 'Ubuntu', '--exec', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C', '/usr/bin/python3', '-I', '-B', '-u', '-c', BOOTSTRAP] })
    guard.acquire('worker', () => child, { executable: WSL_EXE, args: child.spawnargs.slice(1) })
    child.stderr!.emit('data', bytes)
    expect(() => recordedDiagnostic(guard.entries[0])).toThrow()
    child.emit('close', 0, null)
  }
  const guard = new ControllerGuard(), child = fakeChild()
  guard.acquire('worker', () => child, { executable: 'other.exe', args: [] })
  child.stderr!.emit('data', known)
  expect(() => recordedDiagnostic(guard.entries[0])).toThrow()
  child.emit('close', 0, null)
})
it('controller guard continues protocol diagnostic and backend audits after independent failures', () => {
  const guard = new ControllerGuard(), called: string[] = []
  const errors = guard.runAudits([
    ['ownership', () => { called.push('ownership'); throw new Error('cleanup failed') }],
    ['protocol', () => { called.push('protocol'); throw new Error('trailing frame') }],
    ['diagnostic', () => { called.push('diagnostic') }],
    ['backend', () => { called.push('backend') }],
  ])
  expect(called).toEqual(['ownership', 'protocol', 'diagnostic', 'backend'])
  expect(errors).toHaveLength(2)
  expect(guard.audits.map(audit => audit.ok)).toEqual([false, false, true, true])
  expect(() => guard.audit()).toThrow()
})

type LinuxIdentity = { pid: number; parent: number; start: string; exe: string; argv: string[] }
async function releaseNaturalRoot(owned: LinuxIdentity[], worker: LinuxIdentity, rootPid: number,
  write: (bytes: Buffer) => Promise<void>, endInput: () => Promise<void>) {
  const ids = new Map<number, LinuxIdentity>()
  for (const entry of owned) {
    if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0 || !/^[1-9]\d*$/.test(entry.start) || ids.has(entry.pid)) throw new Error('ambiguous captured lifetime')
    ids.set(entry.pid, entry)
  }
  const original = ids.get(worker.pid), root = ids.get(rootPid)
  if (!original || JSON.stringify(original) !== JSON.stringify(worker) || !root || root.parent !== worker.pid) throw new Error('original worker/root edge absent')
  const belowRoot = (entry: LinuxIdentity) => {
    const seen = new Set<number>()
    while (entry.pid !== rootPid) {
      if (seen.has(entry.pid)) return false
      seen.add(entry.pid)
      const parent = ids.get(entry.parent)
      if (!parent || parent.pid === worker.pid) return false
      entry = parent
    }
    return true
  }
  const writer = (marker: string) => {
    const matches = owned.filter(entry => entry.exe === '/usr/bin/bash'
      && JSON.stringify(entry.argv) === JSON.stringify(['/bin/bash', '-c', `sleep 4; touch ${marker}`]))
    if (matches.length !== 1 || !belowRoot(matches[0])) throw new Error('required original named writer absent/ambiguous')
    return matches[0]
  }
  const roles = { root, detachedCommand: writer('detached-late'), ordinaryCommand: writer('ordinary-late') }
  // Only command stdin opens this gate. No cancellation/control frame is issued.
  await write(Buffer.from('GO\n'))
  await endInput()
  return roles
}
it('controller C4 forbids GO for missing changed duplicate or disconnected named lifetimes', async () => {
  const worker: LinuxIdentity = { pid: 1, parent: 9, start: '100', exe: '/usr/bin/python3.12', argv: ['original'] }
  const root = { pid: 2, parent: 1, start: '101', exe: '/usr/bin/bwrap', argv: ['root'] }
  const detached = { pid: 3, parent: 2, start: '102', exe: '/usr/bin/bash', argv: ['/bin/bash', '-c', 'sleep 4; touch detached-late'] }
  const ordinary = { pid: 4, parent: 2, start: '103', exe: '/usr/bin/bash', argv: ['/bin/bash', '-c', 'sleep 4; touch ordinary-late'] }
  for (const owned of [[worker, root, detached], [worker, root, detached, { ...ordinary, start: '' }],
    [worker, root, detached, ordinary, { ...ordinary }], [worker, root, detached, { ...ordinary, parent: 999 }],
    [{ ...worker, start: '999' }, root, detached, ordinary], [worker, { ...root, parent: 999 }, detached, ordinary]]) {
    const calls: string[] = []
    await expect(releaseNaturalRoot(owned, worker, root.pid, async () => { calls.push('GO') }, async () => { calls.push('EOF') })).rejects.toThrow()
    expect(calls).toEqual([])
  }
  const calls: string[] = []
  const roles = await releaseNaturalRoot([worker, root, detached, ordinary], worker, root.pid,
    async bytes => { calls.push(bytes.toString('hex')) }, async () => { calls.push('endInput') })
  expect(calls).toEqual(['474f0a', 'endInput'])
  expect(roles.detachedCommand).toBe(detached); expect(roles.ordinaryCommand).toBe(ordinary)
})
it('controller C4 retains GO delivery failure without issuing endInput or inventing natural completion', async () => {
  const worker: LinuxIdentity = { pid: 1, parent: 9, start: '100', exe: 'python', argv: [] }
  const root = { pid: 2, parent: 1, start: '101', exe: 'bwrap', argv: [] }
  const writers = ['detached-late', 'ordinary-late'].map((marker, index) => ({ pid: index + 3, parent: 2, start: '102', exe: '/usr/bin/bash', argv: ['/bin/bash', '-c', `sleep 4; touch ${marker}`] }))
  const cause = new Error('original write failed'), calls: string[] = []
  await expect(releaseNaturalRoot([worker, root, ...writers], worker, 2, async () => { calls.push('write'); throw cause }, async () => { calls.push('endInput') })).rejects.toBe(cause)
  expect(calls).toEqual(['write'])
})
async function identity(guard: ControllerGuard, request: object): Promise<{ worker: LinuxIdentity; owned: LinuxIdentity[]; survivors?: LinuxIdentity[] }> {
  const payload = Buffer.from(JSON.stringify(request)).toString('base64')
  return guard.track('read-only original identity', new Promise((resolve, reject) => {
    execFile(WSL_EXE, ['--distribution', 'Ubuntu', '--exec', '/usr/bin/python3', '-I', '-B', '-c', IDENTITY_HELPER, payload],
      { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 }, (error, stdout) => {
        if (error) reject(error)
        else { try { resolve(JSON.parse(stdout)) } catch (cause) { reject(cause) } }
      })
  }))
}

const actual = process.platform === 'win32' && process.env.IH_WSL_ACTUAL_CONTROLLER === '1'
it.skipIf(!actual).each([
  ['C1 public-probe-binary-echo', 'echo'], ['C2 public-cancel-tree', 'cancel'], ['C4 public-natural-root-tree', 'natural'],
] as const)('actual-controller %s', async (_name, mode) => {
  const cancelled = mode === 'cancel', natural = mode === 'natural', tree = mode !== 'echo'
  if (process.env.I_HARNESS_DIST !== undefined) throw new Error('source mode required')
  const digest = createHash('sha256').update(readFileSync(new URL('../worker/runner.py', import.meta.url))).digest('hex')
  expect(digest).toBe('2c90059a35ccae024dc96806e603d1261626f883a8984cd59cc38e7ed8ace857')
  expect(existsSync(new URL('../worker/manifest.json', import.meta.url))).toBe(false)
  const base = process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT
  if (!base) throw new Error('fresh six-root evidence required')
  const fixture = mkdtempSync(join(base, natural ? 'controller-C4-' : cancelled ? 'controller-C2-' : 'controller-C1-'))
  const work = join(fixture, 'work'), reference = join(fixture, 'reference')
  mkdirSync(work); mkdirSync(reference); writeFileSync(join(reference, 'sentinel'), 'REFERENCE_KEPT')
  const backend = createWslExecutionBackend({ distribution: 'Ubuntu' })
  const guard = new ControllerGuard(), errors: unknown[] = [], calls: string[] = []
  state.guard = guard
  const caseDeadline = setTimeout(() => { guard.fail(new Error('whole case deadline; cleanup unconfirmed')); guard.closeControls() }, 90_000)
  let prepared: PreparedTransportExecution | undefined, handle: TransportExecutionHandle | undefined
  let worker: LinuxIdentity | undefined, owned: LinuxIdentity[] = [], namedWriters: Awaited<ReturnType<typeof releaseNaturalRoot>> | undefined, authorityCalls = 0, completed = false
  const owner = { sessionId: natural ? 'actual-controller-C4' : cancelled ? 'actual-controller-C2' : 'actual-controller-C1' }
  const policy: CompiledSandboxPolicy = { mode: 'workspace-write', owner, authorityKind: 'bound', authorityRevision: 'fixture',
    primaryRoot: work, readable: 'caller', authorityRoots: [work], writeRoots: [work], referenceRoots: [reference], fingerprint: owner.sessionId }
  const script = "/usr/bin/setsid /bin/bash -c 'sleep 4; touch detached-late' & /bin/bash -c 'sleep 4; touch ordinary-late' & sleep 0.1; printf READY; "
    + (natural ? "IFS= read -r -t 10 token && test \"$token\" = GO || exit 23; printf ROOT_EXIT; exit 0" : 'sleep 10')
  const spec: ProcessSpec = { argv: tree ? ['/bin/bash', '-c', script] : ['/usr/bin/cat'], cwd: work, env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    owner, transport: 'pipe', lifetime: 'complete-tree', argumentEncoding: 'crt' }
  try {
    if (!tree) { calls.push('probe'); expect((await guard.track('public probe', backend.probe())).availability).toBe('available') }
    calls.push('prepare'); prepared = await guard.track('public prepare', backend.prepare(spec, policy))
    const entry = guard.entries.filter(item => item.role === 'worker').at(-1)!
    const hello = Buffer.concat(entry.bytes.stdout).toString().split('\n').filter(Boolean).map(strictFrame).find(frame => frame.type === 'hello')!
    const original = await identity(guard, { mode: 'worker', pid: hello.workerPid, argv: ['/usr/bin/python3', '-I', '-B', '-u', '-c', BOOTSTRAP] })
    worker = original.worker
    calls.push('commit'); handle = await guard.track('public commit', prepared.commit(() => { authorityCalls++ }))
    let ready!: () => void
    const readiness = new Promise<void>(resolve => { ready = resolve })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    const output = guard.track('public output EOF', (async () => {
      for await (const frame of handle!.io.output) {
        if (frame.channel === 'stdout') { stdout.push(Buffer.from(frame.data)); if (Buffer.concat(stdout).includes(Buffer.from('READY'))) ready() }
        else if (frame.channel === 'stderr') stderr.push(Buffer.from(frame.data))
        else throw new Error('unexpected PTY')
      }
    })())
    let settlement
    if (tree) {
      await guard.track('public READY', readiness)
      const lineage = await identity(guard, { mode: 'tree', pid: worker.pid, start: worker.start, argv: worker.argv, root: handle.pid })
      owned = lineage.owned
      expect(owned.length).toBeGreaterThanOrEqual(5)
      if (natural) {
        writeFileSync(join(fixture, 'before-GO-lineage.json'), JSON.stringify({ worker, owned, calls, termination: handle.terminationObservation?.() }, null, 2))
        expect(handle.terminationObservation?.()).toEqual({ kind: 'none' })
        namedWriters = await releaseNaturalRoot(owned, worker, handle.pid,
          bytes => { calls.push('GO'); return guard.track('public GO input', handle!.io.write(bytes)) },
          () => { calls.push('endInput'); return guard.track('public endInput', handle!.io.endInput()) })
        settlement = await guard.track('public natural settlement', handle.settled)
        expect(handle.terminationObservation?.()).toEqual({ kind: 'none' })
      } else {
        calls.push('cancel'); settlement = await guard.track('public cancel', handle.cancel('cancelled'))
        expect(handle.terminationObservation?.()).toEqual({ kind: 'confirmed', reason: 'cancelled' })
      }
    } else {
      const payload = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from('{"type":"shutdown"}\n{"type":"settled"}\n')])
      calls.push('write'); await guard.track('public input', handle.io.write(payload))
      calls.push('endInput'); await guard.track('public endInput', handle.io.endInput())
      writeFileSync(join(fixture, 'input.bin'), payload)
      settlement = await guard.track('public settlement', handle.settled)
      await output; expect(Buffer.concat(stdout)).toEqual(payload)
    }
    const root = await guard.track('public root', handle.rootExited)
    expect(root).toEqual(cancelled ? { exitCode: null, signal: 'KILL' } : { exitCode: 0 })
    expect(settlement).toEqual({ kind: 'settled', root, treeEmpty: true, ioSettled: true, resourcesReleased: true })
    expect(await guard.track('public release', handle.release())).toEqual(settlement)
    await output; expect(Buffer.concat(stderr)).toHaveLength(0)
    writeFileSync(join(fixture, 'output.bin'), Buffer.concat(stdout))
    writeFileSync(join(fixture, 'public-result.json'), JSON.stringify({ root, settlement, receipt: handle.receipt, authorityCalls, worker, owned, namedWriters, calls, termination: handle.terminationObservation?.() }, null, 2))
    if (tree) {
      expect(Buffer.concat(stdout).toString()).toBe(natural ? 'READYROOT_EXIT' : 'READY')
      expect((await identity(guard, { mode: 'check', owned: owned.filter(value => value.pid !== worker!.pid) })).survivors).toEqual([])
      await new Promise(resolve => setTimeout(resolve, 4500))
      expect(existsSync(join(work, 'ordinary-late'))).toBe(false); expect(existsSync(join(work, 'detached-late'))).toBe(false)
    }
    expect(readFileSync(join(reference, 'sentinel'), 'utf8')).toBe('REFERENCE_KEPT')
    expect(authorityCalls).toBe(1)
    completed = true
  } catch (error) { errors.push(error); guard.fail(error); guard.closeControls() }
  finally {
    // Each independent public cleanup route is attempted even after a primary failure.
    for (const [label, action] of [
      ['cancel active original', () => !completed && handle ? handle.cancel('cancelled') : Promise.resolve()],
      ['rollback prepared original', () => !handle && prepared ? prepared.rollback() : Promise.resolve()],
      ['dispose original backend', () => backend.dispose()],
    ] as const) {
      try { await guard.cleanup<unknown>(label, action()) } catch (error) { errors.push(error); guard.fail(error); guard.closeControls() }
    }
    try { await guard.join() } catch (error) { errors.push(error); guard.fail(error) }
    const workers = guard.entries.filter(entry => entry.role === 'worker')
    errors.push(...guard.runAudits([
      ['original ownership/cleanup', () => guard.audit()],
      ['worker cardinality', () => expect(workers).toHaveLength(tree ? 1 : 2)],
      ...workers.map((entry, index) => [`worker-${index} protocol`, () => {
        const frames = auditWorker(Buffer.concat(entry.bytes.stdout), digest, cancelled, !tree && index === 0)
        writeFileSync(join(fixture, `worker-${index}-frames.json`), JSON.stringify(frames, null, 2))
      }] as const),
      ...guard.entries.map((entry, index) => [`child-${index} diagnostic`, () => {
        const diagnostic = recordedDiagnostic(entry)
        writeFileSync(join(fixture, `child-${index}-diagnostic.json`), JSON.stringify({ entryIndex: index, pid: entry.pid, ...diagnostic }, null, 2))
      }] as const),
      ['public backend diagnostics', () => {
        const diagnostics = backend.diagnostics()
        writeFileSync(join(fixture, 'backend-diagnostics.json'), JSON.stringify(diagnostics, null, 2))
        expect(diagnostics.every(d => !d.outputAbandoned && d.discardedOutputBytes === 0 && d.discardedLauncherStderrBytes === 0)).toBe(true)
      }],
    ]))
    try { guard.save(fixture) } catch (error) { errors.push(error) }
    clearTimeout(caseDeadline)
    state.guard = undefined
  }
  if (errors.length) throw new AggregateError(errors, 'actual controller gate failed/UNKNOWN; no next case')
}, 120_000)
