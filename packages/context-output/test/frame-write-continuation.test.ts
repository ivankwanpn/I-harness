import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createContextOutputService } from '../src/index.ts'
import { createExecFrameCapture } from '../../output-retention/src/result/exec-frames.ts'
import { encodeExecFrameRecord } from '@i-harness/core-session'

const fault = vi.hoisted(() => ({ rename: undefined as undefined | ((from: string, to: string) => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, rename: async (from: string, to: string) => { await fault.rename?.(from, to); return fs.rename(from, to) } }
})

it('injected owned metadata rename: two independent records recover with exact original bytes and hashes', async () => {
  const base = resolve(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'record-controls')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'r-'))
  const service = createContextOutputService({ root, workspaceId: 'recovery', config: { enabled: false, maxDiskBytes: 8_388_608 } })
  const scope = service.registerResultScope({ operationId: 'original', sessionId: 's', callId: 'c' }, () => true)
  const capture = createExecFrameCapture({ sourceId: 'original', openArtifact: () => service.beginResult(scope, 'exec-frames-v1') })
  const seen = new Set<number>(), failures: unknown[] = []
  let original: Error | undefined
  fault.rename = async (from, to) => {
    if (!to.endsWith('operation.json')) return
    const op = JSON.parse(await readFile(from, 'utf8'))
    if (op.phase !== 'capturing' || op.encodedBytes <= 9 || seen.has(op.encodedBytes)) return
    seen.add(op.encodedBytes)
    original ??= Object.assign(new Error('INJECTED operation metadata rename'), { code: 'EPERM', syscall: 'rename', dest: to })
    failures.push(original); throw original
  }
  const parts = [Buffer.from('first original bytes'), Buffer.from('second original bytes')]
  const records = parts.map((bytes, frame) => Buffer.from(encodeExecFrameRecord({ channel: 'stdout', frame, offset: 0, end: true, data: bytes.toString('base64') })))
  try {
    for (const [frame, bytes] of parts.entries()) {
      const writing = capture.write({ channel: 'stdout', frame, offset: 0, end: true, bytes }, { continuationAllowed: () => true })
      bytes.fill(0) // caller mutation after synchronous admission cannot replace original bytes
      await writing
    }
    capture.complete('complete')
    const saved = await capture.settle()
    expect(saved.kind).toBe('ready')
    if (saved.kind !== 'ready' || saved.dependency.retention.kind !== 'artifact') throw Error('Expected artifact')
    const ref = saved.dependency.retention.ref, chunks: Buffer[] = []
    let offset = 0
    for (;;) {
      const page = await service.readResult({ sessionId: 's' }, { ref, offset })
      chunks.push(page.data.kind === 'bytes' ? Buffer.from(page.data.base64, 'base64') : Buffer.from(page.data.text))
      if (page.eof) break
      offset = page.nextOffset!
    }
    const expected = Buffer.concat([Buffer.from('IHEXEC01\n'), ...records])
    expect(Buffer.concat(chunks)).toEqual(expected)
    expect(ref.contentDigest).toBe(createHash('sha256').update(expected).digest('hex'))
    expect(ref.completeness).toBe('complete')
    expect(failures).toHaveLength(2)
    expect(failures[0]).toBe(failures[1])
  } finally { fault.rename = undefined; await service.close() }
})

import * as locking from '@i-harness/fs-lock'
import { createArtifactWriter, type WriterAuthority } from '../src/artifact/writer.ts'
import { createWorkspaceMutationOwner } from '../src/workspace-mutation.ts'
import { afterEach } from 'vitest'
afterEach(() => { fault.rename = undefined; vi.restoreAllMocks() })
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function writerFixture() {
  const base = resolve(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'writer-controls')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, 'w-')), directory = resolve(root, 'artifact')
  const owner = createWorkspaceMutationOwner({ root, workspaceId: 'original' })
  let current: ReturnType<WriterAuthority['lifetime']> = 'current', live = true, mutations = 0
  const operation: WriterAuthority['operation'] = { version: 1, owner: { operationId: 'original', sessionId: 's', callId: 'c' }, codec: 'exec-frames-v1', id: 'ctxv1_' + 'a'.repeat(64), phase: 'capturing', encodedBytes: 0 }
  const authority: WriterAuthority = { directory, operation, mutate: work => { mutations++; return owner.mutate(work) }, reserve: async () => {}, lifetime: () => current, recoveryAllowed: () => live, cancelPublication: async () => {}, closed() {} }
  const sink = await createArtifactWriter(authority)
  const cause = Object.assign(Error('INJECTED metadata rename'), { code: 'EPERM', syscall: 'rename', dest: resolve(directory, 'operation.json') })
  const fail = () => { throw cause }
  return { sink, cause, fail, directory, authority, owner, mutations: () => mutations, lifetime: (v: typeof current) => { current = v }, closing: () => { live = false }, close: async () => { fault.rename = undefined; await sink.suspend(); await owner.close() } }
}
it('permanent injection consumes one record attempt; explicit reconciliation retains it exactly once', async () => {
  const f = await writerFixture()
  try {
    fault.rename = f.fail
    await expect(f.sink.write(Buffer.from('original'))).rejects.toBe(f.cause)
    expect(await f.sink.continueFailedWrite!(f.cause, () => true)).toMatchObject({ kind: 'unresolved', progress: 'pending' })
    expect(await f.sink.continueFailedWrite!(f.cause, () => true)).toMatchObject({ kind: 'not-eligible' })
    expect(f.mutations()).toBe(2)
    await expect(f.sink.write(Buffer.from('later'))).rejects.toThrow()
    fault.rename = undefined
    expect(await f.sink.reconcileWrite()).toBe('ready')
    expect(await readFile(resolve(f.directory, 'body'), 'utf8')).toBe('original')
    expect(await f.sink.continueFailedWrite!(f.cause, () => true)).toMatchObject({ kind: 'not-eligible' })
    expect(await f.sink.finish('producer-incomplete')).toMatchObject({ kind: 'committed', ref: { completeness: 'producer-incomplete', encodedBytes: 8 } })
  } finally { await f.close() }
})
it.each(['no-pending', 'wrong-cause', 'reconciled', 'wrong-code', 'wrong-syscall', 'wrong-dest', 'null', 'aggregate', 'closed', 'deleted', 'unavailable', 'gate-throws', 'gate-false'] as const)('ineligible original control: %s', async control => {
  const f = await writerFixture()
  try {
    if (control !== 'no-pending') {
      let error: unknown = f.cause
      if (control === 'wrong-code') f.cause.code = 'EACCES'
      if (control === 'wrong-syscall') f.cause.syscall = 'write'
      if (control === 'wrong-dest') f.cause.dest += '.foreign'
      if (control === 'null') error = null
      if (control === 'aggregate') error = new AggregateError([f.cause], 'INJECTED aggregate')
      fault.rename = async () => { throw error }
      await f.sink.write(Buffer.from('original')).catch(() => {})
    }
    if (control === 'reconciled') { fault.rename = undefined; await f.sink.reconcileWrite() }
    if (control === 'closed') f.closing()
    if (control === 'deleted' || control === 'unavailable') f.lifetime(control)
    const before = f.mutations()
    const result = await f.sink.continueFailedWrite!(control === 'wrong-cause' ? Error('wrong') : f.cause, () => { if (control === 'gate-throws') throw Error('policy'); return control !== 'gate-false' })
    expect(result.kind).toBe('not-eligible'); expect(f.mutations()).toBe(before)
  } finally { await f.close() }
})
it('concurrent calls consume one allowance and retain the original receiver and single mutation layer', async () => {
  const f = await writerFixture(), entered = deferred(), release = deferred()
  try {
    fault.rename = f.fail
    await f.sink.write(Buffer.from('original')).catch(() => {})
    fault.rename = async () => { entered.resolve(); await release.promise }
    const first = f.sink.continueFailedWrite!(f.cause, () => true)
    await entered.promise
    expect(await f.sink.continueFailedWrite!(f.cause, () => true)).toMatchObject({ kind: 'not-eligible' })
    release.resolve(); expect(await first).toEqual({ kind: 'written' }); expect(f.mutations()).toBe(2)
  } finally { release.resolve(); await f.close() }
})
it.each(['closing', 'deleted', 'unavailable', 'producer'] as const)('gate lost after physical continuation success: %s', async control => {
  const f = await writerFixture(); let producer = true
  try {
    fault.rename = f.fail; await f.sink.write(Buffer.from('original')).catch(() => {})
    fault.rename = async () => { if (control === 'closing') f.closing(); else if (control === 'producer') producer = false; else f.lifetime(control) }
    expect(await f.sink.continueFailedWrite!(f.cause, () => producer)).toMatchObject({ kind: 'unresolved', progress: 'record-applied', reason: 'gate-denied' })
    expect(await readFile(resolve(f.directory, 'body'), 'utf8')).toBe('original')
    expect(await f.sink.continueFailedWrite!(f.cause, () => true)).toMatchObject({ kind: 'not-eligible' })
  } finally { await f.close() }
})
it('closing while the continuation waits for the genuine shared turn prevents recovery IO', async () => {
  const f = await writerFixture(), held = deferred(), release = deferred(); let renames = 0
  try {
    fault.rename = f.fail; await f.sink.write(Buffer.from('original')).catch(() => {})
    const block = f.owner.mutate(async () => { held.resolve(); await release.promise })
    await held.promise; fault.rename = async () => { renames++ }
    const continuation = f.sink.continueFailedWrite!(f.cause, () => true)
    // Let the writer queue issue its mutation while the original owner is held.
    await new Promise<void>(done => setImmediate(done)); f.closing(); release.resolve(); await block
    expect(await continuation).toMatchObject({ kind: 'unresolved', progress: 'pending' }); expect(renames).toBe(0)
  } finally { release.resolve(); await f.close() }
})
it.each(['original-both', 'original-cleanup', 'continuation-cleanup'] as const)('genuine owner retirement control: %s', async control => {
  const f = await writerFixture(), acquire = locking.acquireSessionLock
  let retireFailure = false, releases = 0
  const spy = vi.spyOn(locking, 'acquireSessionLock').mockImplementation(async options => {
    const lease = await acquire(options)
    return { get held() { return lease.held }, async release() {
      releases++
      if (retireFailure) { retireFailure = false; throw f.cause }
      await lease.release()
    } }
  })
  try {
    if (control !== 'original-cleanup') fault.rename = f.fail
    if (control !== 'continuation-cleanup') retireFailure = true
    const outer = await f.sink.write(Buffer.from('original')).catch(error => error)
    if (control === 'original-both') { expect(outer).toBeInstanceOf(AggregateError); expect(outer.errors).toEqual([f.cause, f.cause]) }
    else expect(outer).toBe(f.cause)
    fault.rename = undefined
    if (control === 'continuation-cleanup') {
      retireFailure = true
      expect(await f.sink.continueFailedWrite!(f.cause, () => true)).toMatchObject({ kind: 'unresolved', progress: 'record-applied', reason: 'continuation-failed' })
    } else expect(await f.sink.continueFailedWrite!(outer, () => true)).toMatchObject({ kind: 'not-eligible' })
    expect(await readFile(resolve(f.directory, 'body'), 'utf8')).toBe('original')
    await expect(f.owner.mutate(async () => {})).rejects.toThrow(/unresolved/)
    await f.owner.cleanup(async () => {})
    expect(releases).toBe(control === 'continuation-cleanup' ? 4 : 3)
  } finally { await f.close(); spy.mockRestore() }
})
it.each([false, true])('original frame flight fences complete and settle; clears before awaited fulfillment (recovering=%s)', async recovering => {
  const f = await writerFixture(), entered = deferred(), release = deferred()
  const capture = createExecFrameCapture({ sourceId: 'original', openArtifact: async () => f.sink })
  let writes = 0
  fault.rename = async () => {
    writes++
    if (recovering && writes === 2) throw f.cause
    if (writes === (recovering ? 3 : 2)) { entered.resolve(); await release.promise }
  }
  try {
    const write = capture.write({ channel: 'stdout', frame: 0, offset: 0, end: true, bytes: Buffer.from('one') }, { continuationAllowed: () => true })
    await entered.promise
    expect(() => capture.complete('complete')).toThrow(/outstanding/)
    expect(await capture.settle()).toEqual({ kind: 'recovery-required' })
    await expect(capture.write({ channel: 'stdout', frame: 1, offset: 0, end: true, bytes: Buffer.from('two') })).rejects.toThrow()
    expect(writes).toBe(recovering ? 3 : 2)
    release.resolve(); await write; capture.complete('complete')
    expect((await capture.settle()).kind).toBe('ready')
  } finally { release.resolve(); await f.close() }
})
it.each(['missing-options', 'missing-port', 'header', 'post-written-gate'] as const)('frame fallback compatibility: %s', async control => {
  const f = await writerFixture(); let gate = true
  const originalPort = f.sink.continueFailedWrite
  if (control === 'missing-port') delete f.sink.continueFailedWrite
  if (control === 'post-written-gate') f.sink.continueFailedWrite = async function (...args) { expect(this).toBe(f.sink); const result = await originalPort!.apply(this, args); gate = false; return result }
  let failures = 0
  fault.rename = async (from) => { const op = JSON.parse(await readFile(from, 'utf8')); if ((control === 'header' || op.encodedBytes > 9) && failures++ === 0) throw f.cause }
  const capture = createExecFrameCapture({ sourceId: 'original', openArtifact: async () => f.sink })
  try {
    await expect(capture.write({ channel: 'stdout', frame: 0, offset: 0, end: true, bytes: Buffer.from('one') }, control === 'missing-options' ? undefined : { continuationAllowed: () => gate })).rejects.toBe(f.cause)
    capture.complete('producer-incomplete'); fault.rename = undefined
    expect((await capture.settle()).kind).toBe('ready')
  } finally { await f.close() }
})

it('a close request fences recovery while preserving ordinary admitted-write drain', async () => {
  for (const recovering of [false, true]) {
    const base = resolve(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'close-controls')
    await mkdir(base, { recursive: true })
    const root = await mkdtemp(resolve(base, 'c-')), service = createContextOutputService({ root, workspaceId: 'close' })
    const scope = service.registerResultScope({ operationId: 'original', sessionId: 's', callId: 'c' }, () => true)
    const sink = await service.beginResult(scope, 'exec-frames-v1')
    const capture = createExecFrameCapture({ sourceId: 'original', openArtifact: async () => sink })
    let closing: Promise<void> | undefined, attempts = 0
    const entered = deferred(), release = deferred()
    const cause = Object.assign(Error('INJECTED original metadata'), { code: 'EPERM', syscall: 'rename', dest: '' })
    fault.rename = async (from, to) => {
      if (!to.endsWith('operation.json')) return
      const op = JSON.parse(await readFile(from, 'utf8'))
      if (op.phase !== 'capturing' || op.encodedBytes <= 9) return
      attempts++
      if (recovering && attempts === 1) { cause.dest = to; throw cause }
      entered.resolve(); await release.promise
    }
    try {
      const writing = capture.write({ channel: 'stdout', frame: 0, offset: 0, end: true, bytes: Buffer.from('original') }, { continuationAllowed: () => true })
      const observed = writing.then(() => undefined, error => error)
      await entered.promise; closing = service.close(); release.resolve()
      if (recovering) expect(await observed).toBe(cause)
      else expect(await observed).toBeUndefined()
      expect(attempts).toBe(recovering ? 2 : 1)
      capture.complete('producer-incomplete')
    } finally { release.resolve(); fault.rename = undefined; await closing; await service.close() }
  }
})
it('a claimed continuation denied on the writer queue stays consumed', async () => {
  const f = await writerFixture()
  try {
    fault.rename = f.fail; await f.sink.write(Buffer.from('original')).catch(() => {})
    fault.rename = async () => { throw Error('must not issue') }
    const result = f.sink.continueFailedWrite!(f.cause, () => true); f.closing()
    expect(await result).toMatchObject({ kind: 'unresolved', progress: 'pending' })
    expect(f.mutations()).toBe(1)
    expect(await f.sink.continueFailedWrite!(f.cause, () => true)).toMatchObject({ kind: 'not-eligible' })
  } finally { await f.close() }
})
import * as nativeFs from 'node:fs/promises'
it.each(['body', 'leaf', 'reserve', 'quota'] as const)('non-metadata stage never gains recovery authority: %s', async stage => {
  const f = await writerFixture()
  let hits = 0
  const sample = await nativeFs.open(resolve(f.directory, 'body'), 'r+')
  const prototype = Object.getPrototypeOf(sample)
  await sample.close()
  const write = prototype.write
  const writeSpy = vi.spyOn(prototype, 'write').mockImplementation(function (this: unknown, ...args: unknown[]) {
    if (stage === 'body' || stage === 'leaf') {
      const bytes = args[0] as Buffer
      if (stage === 'body' && bytes.length === 65536 || stage === 'leaf' && bytes.length === 32) { hits++; throw f.cause }
    }
    return write.apply(this, args)
  })
  if (stage === 'reserve') f.authority.reserve = async () => { throw f.cause }
  if (stage === 'quota') f.authority.reserve = async () => { throw Object.assign(Error('INJECTED quota'), { code: 'ARTIFACT_QUOTA' }) }
  try {
    await f.sink.write(Buffer.alloc(65536, 120)).catch(() => {})
    expect(await f.sink.continueFailedWrite!(f.cause, () => true)).toMatchObject({ kind: 'not-eligible' })
    if (stage === 'body' || stage === 'leaf') expect(hits).toBe(1)
  } finally { writeSpy.mockRestore(); await f.close() }
})
import { nativeFixture } from '../../exec/test/native-fixture.ts'
it.each(['cancel-before-continuation', 'cancel-during-continuation', 'timeout-during-continuation'] as const)('original exec live cancellation gate: %s', async control => {
  const f = await writerFixture(), controller = new AbortController()
  let attempts = 0, continued = 0
  const continuation = f.sink.continueFailedWrite!
  f.sink.continueFailedWrite = async function (...args) { continued++; return continuation.apply(this, args) }
  fault.rename = async (from) => {
    const op = JSON.parse(await readFile(from, 'utf8'))
    if (op.phase !== 'capturing' || op.encodedBytes <= 9) return
    attempts++
    if (attempts === 1) { if (control === 'cancel-before-continuation') controller.abort(); throw f.cause }
    if (attempts === 2) {
      if (control === 'cancel-during-continuation') controller.abort()
      else if (control === 'timeout-during-continuation') await new Promise(done => setTimeout(done, 80))
    }
  }
  let capture!: ReturnType<typeof createExecFrameCapture>
  const native = nativeFixture({ liveTree: true, resultRetention: {
    begin: ({ sourceId }) => capture = createExecFrameCapture({ sourceId, openArtifact: async () => f.sink }),
    observe: capture => capture.settle(), settle: capture => capture.settle(),
  } })
  try {
    const result = await native.exec.run({ argv: ['controlled-native-gate'], abortSignal: controller.signal, ...(control === 'timeout-during-continuation' ? { timeoutMs: 40 } : {}) })
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(control === 'timeout-during-continuation')
    expect(continued).toBe(control === 'cancel-before-continuation' ? 0 : 1)
    expect(await capture.settle()).toMatchObject({ kind: 'ready', dependency: { retention: { kind: 'artifact', ref: { completeness: 'producer-incomplete' } } } })
    expect(native.counts()).toEqual({ launches: 1, terminations: 1, releases: 1 })
  } finally { native.finish(); fault.rename = undefined; await native.exec.dispose(); await f.close() }
})
it.each(['closing', 'deleted', 'producer'] as const)('gate loss during genuine lease retirement denies Written after physical application: %s', async control => {
  const f = await writerFixture(), acquire = locking.acquireSessionLock
  let gate = true
  try {
    fault.rename = f.fail; await f.sink.write(Buffer.from('original')).catch(() => {})
    fault.rename = undefined
    const spy = vi.spyOn(locking, 'acquireSessionLock').mockImplementation(async options => {
      const lease = await acquire(options)
      return { get held() { return lease.held }, async release() {
        if (control === 'closing') f.closing()
        else if (control === 'deleted') f.lifetime('deleted')
        else gate = false
        await lease.release()
      } }
    })
    expect(await f.sink.continueFailedWrite!(f.cause, () => gate)).toMatchObject({ kind: 'unresolved', progress: 'record-applied', reason: 'gate-denied' })
    expect(await readFile(resolve(f.directory, 'body'), 'utf8')).toBe('original')
    spy.mockRestore()
  } finally { await f.close() }
})
it('a stale rejection cannot claim the next record and one encoding preserves split-frame progression', async () => {
  const f = await writerFixture(), capture = createExecFrameCapture({ sourceId: 'original', openArtifact: async () => f.sink })
  let failures = 0
  fault.rename = async from => {
    const op = JSON.parse(await readFile(from, 'utf8'))
    if (op.phase === 'capturing' && op.encodedBytes > 9 && failures++ === 0) throw f.cause
  }
  try {
    await capture.write({ channel: 'stdout', frame: 0, offset: 0, end: false, bytes: Buffer.from('one') }, { continuationAllowed: () => true })
    expect(await f.sink.continueFailedWrite!(f.cause, () => true)).toMatchObject({ kind: 'not-eligible' })
    await capture.write({ channel: 'stdout', frame: 0, offset: 3, end: true, bytes: Buffer.from('two') }, { continuationAllowed: () => true })
    const body = await readFile(resolve(f.directory, 'body'), 'utf8')
    expect(body.slice(9).split('\n').filter(Boolean).map(line => JSON.parse(line))).toEqual([
      { channel: 'stdout', frame: 0, offset: 0, end: false, data: Buffer.from('one').toString('base64') },
      { channel: 'stdout', frame: 0, offset: 3, end: true, data: Buffer.from('two').toString('base64') },
    ])
    capture.complete('complete'); expect((await capture.settle()).kind).toBe('ready')
  } finally { await f.close() }
})
