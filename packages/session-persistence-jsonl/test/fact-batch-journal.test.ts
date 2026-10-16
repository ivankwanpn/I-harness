import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonlBackend } from '../src/index.ts'
import { createSessionCoordinator, ownedContextReadiness, forkSession } from '@i-harness/session-persistence'
import { append, createSession } from '@i-harness/core-session'
import * as core from '@i-harness/core-session'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})

it('quarantines a same-size committed-prefix conflict before issuance instead of proving absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-prefix-conflict-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const originalOpen = vi.mocked(open).getMockImplementation()!
  try {
    const first = await document.metadata.admit({ type: 'plan/mode', mode: 'on' })
    expect(first.kind).toBe('committed')
    const path = join(root, `${id}.jsonl`), original = await readFile(path, 'utf8')
    const changed = original.replace(/("prefixDigest":")([a-f0-9])([a-f0-9]{63}"}\n)$/, (_whole, start, first, end) => start + (first === '0' ? '1' : '0') + end)
    expect(changed.length).toBe(original.length); expect(changed).not.toBe(original)
    await writeFile(path, changed)
    let writes = 0
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await originalOpen(...args)
      const write = handle.write.bind(handle)
      handle.write = ((...args: Parameters<typeof write>) => { writes++; return write(...args) }) as typeof handle.write
      return handle
    })
    const outcome = await document.metadata.admit({ type: 'plan/mode', mode: 'off' })
    expect(outcome.kind).toBe('conflict')
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'off' })).toEqual({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    expect(document.view.events).toHaveLength(1); expect(writes).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(changed)
    vi.mocked(open).mockImplementation(originalOpen)
  } finally { vi.mocked(open).mockImplementation(originalOpen); await coordinator.close().catch(() => {}) }
})

it('publishes an atomic source-order frame only after a scoped receipt and reopens it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create()
  try {
    const document = await coordinator.openManagedDocument(id)
    const result = await document.metadata.admit({ type: 'plan/mode', mode: 'on' })
    expect(result.kind).toBe('committed')
    if (result.kind !== 'committed') throw new Error('Expected committed fact')
    expect(result.seqs).toEqual([0])
    expect(document.view.events).toEqual([{ type: 'plan/mode', mode: 'on', seq: 0 }])
    const lines = (await readFile(join(root, `${id}.jsonl`), 'utf8')).trimEnd().split('\n')
    expect(JSON.parse(lines[0]!).formatVersion).toBe(7)
    expect(JSON.parse(lines[1]!)).toMatchObject({ recordKind: 'session/fact-batch', version: 1, firstSeq: 0, count: 1 })
    expect((await coordinator.snapshot!(id)).session.events).toEqual([{ type: 'plan/mode', mode: 'on', seq: 0 }])
  } finally { await coordinator.close() }
})

it('quarantines an unknown issued frame, reconciles exactly it, and never installs a foreign receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-unknown-'))
  const backend = createJsonlBackend(root)
  const appendOwned = backend.appendOwnedBatch!
  let writes = 0
  backend.appendOwnedBatch = async (...args) => {
    writes++
    await appendOwned(...args)
    return { kind: 'unknown', key: args[3].key }
  }
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  try {
    const document = await coordinator.openManagedDocument(id)
    const outcome = await document.metadata.admit({ type: 'plan/mode', mode: 'on' })
    expect(outcome.kind).toBe('unknown')
    expect(document.view.events).toEqual([])
    await expect(coordinator.snapshot!(id)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'off' })).toEqual({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    if (outcome.kind !== 'unknown') throw new Error('Expected unknown')
    const reconcile = backend.reconcileOwnedBatch!
    backend.reconcileOwnedBatch = async (...args) => {
      const result = await reconcile(...args)
      if (result.kind !== 'committed') return result
      return { ...result, receipt: { ...result.receipt, owner: { ...result.receipt.owner, sessionId: 'another-document' } } }
    }
    expect((await document.reconcile(outcome.key)).kind).toBe('unknown')
    expect(document.view.events).toEqual([])
    backend.reconcileOwnedBatch = reconcile
    const committed = await document.reconcile(outcome.key)
    expect(committed.kind).toBe('committed')
    expect(document.view.events).toEqual([{ type: 'plan/mode', mode: 'on', seq: 0 }])
    expect(writes).toBe(1)
    expect((await backend.read(id)).events).toHaveLength(1)
  } finally { await coordinator.close().catch(() => {}) }
})

it('returns FIFO actual seqs, coalesces ready metadata, and releases the lane before recursive observers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-seqs-'))
  const backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const seed = createSession()
  for (let index = 0; index < 7; index++) append(seed, { type: 'plan/mode', mode: index % 2 ? 'off' : 'on' })
  await coordinator.append(id, seed.events)
  try {
    const document = await coordinator.openManagedDocument(id)
    const [a, b] = await Promise.all([
      document.metadata.admit({ type: 'plan/mode', mode: 'off' }),
      document.metadata.admit({ type: 'plan/mode', mode: 'on' }),
    ])
    expect(a.kind).toBe('committed'); expect(b.kind).toBe('committed')
    if (a.kind !== 'committed' || b.kind !== 'committed') throw new Error('Expected committed')
    expect(a.seqs).toEqual([7]); expect(b.seqs).toEqual([8])
    expect(a.receipt.key).toEqual(b.receipt.key)
    const { subscribe } = await import('@i-harness/core-session')
    const recursive = Promise.withResolvers<unknown>()
    const unsubscribe = subscribe(document.view as any, async event => {
      if (event.seq === 9) recursive.resolve(await document.metadata.admit({ type: 'plan/mode', mode: 'on' }))
    })
    await document.metadata.admit({ type: 'plan/mode', mode: 'off' })
    expect(await recursive.promise).toMatchObject({ kind: 'committed', seqs: [10] })
    unsubscribe()
  } finally { await coordinator.close() }
}, 3000)

it('completes actual short writes 3+2+remaining and installs the same single frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-short-'))
  const backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const lengths: number[] = []
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await native.open(...args)
    if (String(args[0]) !== join(root, `${id}.jsonl`) || args[1] !== 'r+') return handle
    return new Proxy(handle, { get(target, name) {
      if (name === 'write') return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
        const size = lengths.length === 0 ? 3 : lengths.length === 1 ? 2 : length
        lengths.push(size)
        return target.write(buffer, offset, size, position)
      }
      const value = Reflect.get(target, name)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  try {
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'committed', seqs: [0] })
    expect(lengths.slice(0, 2)).toEqual([3, 2])
    expect(lengths).toHaveLength(3)
    expect((await backend.read(id)).events).toEqual([{ type: 'plan/mode', mode: 'on', seq: 0 }])
  } finally { vi.mocked(open).mockImplementation(native.open); await coordinator.close() }
})

it('keeps complete bytes private when sync and rollback fail and reconciles without writing again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-sync-'))
  const backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let writes = 0
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await native.open(...args)
    if (String(args[0]) !== join(root, `${id}.jsonl`) || args[1] !== 'r+') return handle
    return new Proxy(handle, { get(target, name) {
      if (name === 'sync' || name === 'truncate') return async () => { throw new Error('controlled unavailable storage') }
      if (name === 'write') return async (...values: Parameters<typeof target.write>) => { writes++; return (target.write as Function)(...values) }
      const value = Reflect.get(target, name)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  try {
    const outcome = await document.metadata.admit({ type: 'plan/mode', mode: 'on' })
    expect(outcome.kind).toBe('unknown')
    expect(document.view.events).toEqual([])
    expect((await backend.read(id)).events).toHaveLength(1)
    vi.mocked(open).mockImplementation(native.open)
    if (outcome.kind !== 'unknown') throw new Error('Expected unknown')
    expect(await document.reconcile(outcome.key)).toMatchObject({ kind: 'committed', seqs: [0] })
    expect(writes).toBe(1)
    expect(document.view.events).toHaveLength(1)
  } finally { vi.mocked(open).mockImplementation(native.open); await coordinator.close().catch(() => {}) }
})

it('revokes the old optional action before issue while its already-real settlement and a later human action survive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-stop-'))
  const backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  try {
    const action = document.beginAction()
    const source = action.registerSettlementSource(async () => {})
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const actual = backend.appendOwnedBatch!
    backend.appendOwnedBatch = async (...args) => { entered.resolve(); await release.promise; return actual(...args) }
    const optional = action.facts.metadata.admit({ type: 'plan/mode', mode: 'on' })
    await entered.promise
    action.stop()
    const required = source.tools.result({ type: 'tool/result', callId: 'real', name: 'read', output: { content: 'done' } })
    release.resolve()
    expect(await optional).toEqual({ kind: 'not-issued', code: 'FACT_CANCELLED' })
    expect(await required).toMatchObject({ kind: 'committed', seqs: [0] })
    expect(() => action.assertOpen()).toThrow()
    expect(await document.beginAction().facts.metadata.admit({ type: 'plan/mode', mode: 'off' })).toMatchObject({ kind: 'committed', seqs: [1] })
    expect(document.view.events.map(event => event.type)).toEqual(['tool/result', 'plan/mode'])
  } finally { await coordinator.close() }
})

it('allocates input-start 7/8/9 atomically and rejects a second claim without writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-input-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), seed = createSession()
  for (let index = 0; index < 6; index++) append(seed, { type: 'plan/mode', mode: 'on' })
  append(seed, { type: 'agent/input/admitted', version: 1, inputId: 'input-A', text: 'hello', delivery: 'queue', intent: 'user' })
  await coordinator.append(id, seed.events)
  try {
    const document = await coordinator.openManagedDocument(id)
    const outcome = await document.inputs.start({ type: 'agent/input/promoted', version: 1, inputId: 'input-A' }, { type: 'user/message', text: 'hello', input: { inputId: 'input-A', intent: 'user' } })
    expect(outcome).toMatchObject({ kind: 'committed', seqs: [7, 8, 9] })
    const before = await readFile(join(root, `${id}.jsonl`))
    expect(await document.inputs.start({ type: 'agent/input/promoted', version: 1, inputId: 'input-A' }, { type: 'user/message', text: 'hello' })).toEqual({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
    expect(await readFile(join(root, `${id}.jsonl`))).toEqual(before)
    expect((await backend.read(id)).events.slice(7).map(event => event.type)).toEqual(['agent/input/promoted', 'turn/start', 'user/message'])
  } finally { await coordinator.close() }
})

it('retries only backend-proven absent source settlement explicitly with one capture and one final installation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-absent-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  let conversions = 0
  const retained = source.tools.captureResult({ type: 'tool/result', callId: 'real', name: 'read', output: { toJSON() { conversions++; return { z: 1, a: 2 } } } })
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await native.open(...args)
    if (String(args[0]) !== join(root, `${id}.jsonl`) || args[1] !== 'r+') return handle
    return new Proxy(handle, { get(target, name) {
      if (name === 'write') return async () => ({ bytesWritten: 0 })
      const value = Reflect.get(target, name)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  try {
    expect((await retained.admit()).kind).toBe('absent')
    expect((await retained.admit()).kind).toBe('absent')
    expect(document.view.events).toEqual([])
    action.stop()
    vi.mocked(open).mockImplementation(native.open)
    const [a, b] = await Promise.all([retained.retryAbsent(), retained.retryAbsent()])
    expect(a).toMatchObject({ kind: 'committed', seqs: [0] }); expect(b).toEqual(a)
    expect(conversions).toBe(1)
    expect(document.view.events).toEqual([{ type: 'tool/result', callId: 'real', name: 'read', output: { z: 1, a: 2 }, seq: 0 }])
    expect((await backend.read(id)).events).toHaveLength(1)
    await coordinator.close()
    await expect(retained.retryAbsent()).rejects.toMatchObject({ code: 'FACT_CLOSED' })
  } finally { vi.mocked(open).mockImplementation(native.open); await coordinator.close().catch(() => {}) }
})

it('rejects a structural fake owner callback even for an identical empty document prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-scope-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  try {
    const before = await readFile(join(root, `${id}.jsonl`))
    await expect(backend.readJournalPrefix!(id, { owner: { sessionId: id, incarnation: 'pretend' }, assertHeld() {} })).rejects.toThrow(/owner|scope/i)
    expect(await readFile(join(root, `${id}.jsonl`))).toEqual(before)
  } finally { await coordinator.close() }
})

it('keeps actual asynchronous Inbox admission private until receipt and claims steer atomically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-inbox-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  try {
    const inbox = new core.AsyncInbox(document.view, () => document.inputs)
    expect(await inbox.admit({ inputId: 'steer', text: 'hello', delivery: 'steer', intent: 'user' })).toBe(0)
    expect(inbox.pending().map(input => input.inputId)).toEqual(['steer'])
    await inbox.claimAtStepBoundary(document.inputs)
    expect(inbox.pending()).toEqual([])
    expect((await backend.read(id)).events.map(event => event.type)).toEqual(['agent/input/admitted', 'agent/input/promoted', 'user/message'])
  } finally { await coordinator.close() }
})

it('counts 64 issued groups, retains required ticket65 through failed close, and drains it after exact reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-ticket65-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  let requiredFlight: Promise<core.FactOutcome>
  const source = document.beginAction().registerSettlementSource(async () => {
    const outcome = await requiredFlight
    if (outcome.kind !== 'committed') throw new core.FactRecoveryRequiredError()
  })
  let captures = 0
  const retained = source.tools.captureResult({ type: 'tool/result', callId: 'real', name: 'read', output: { toJSON() { captures++; return { content: 'completed' } } } })
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const syncing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await native.open(...args)
    if (String(args[0]) !== join(root, `${id}.jsonl`) || args[1] !== 'r+') return handle
    return new Proxy(handle, { get(target, name) {
      if (name === 'sync') return async () => { syncing.resolve(); await release.promise; throw new Error('controlled sync uncertainty') }
      if (name === 'truncate') return async () => { throw new Error('controlled rollback failure') }
      const value = Reflect.get(target, name)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  try {
    const admitted = Array.from({ length: 64 }, () => document.metadata.admit({ type: 'plan/mode', mode: 'on' }))
    await syncing.promise
    requiredFlight = retained.admit()
    let returned = false
    void requiredFlight.then(() => { returned = true })
    await Promise.resolve(); await Promise.resolve()
    expect(returned).toBe(false)
    const closing = expect(document.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    release.resolve()
    const original = await Promise.all(admitted)
    await closing
    expect(await requiredFlight).toEqual({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    expect(document.view.events).toEqual([])
    expect(coordinator.ownerOf(id)).toBe(true)
    vi.mocked(open).mockImplementation(native.open)
    const first = original[0]!
    if (first.kind !== 'unknown') throw new Error('Expected issued frame uncertainty')
    expect((await document.reconcile(first.key)).kind).toBe('committed')
    requiredFlight = retained.admit()
    expect(await requiredFlight).toMatchObject({ kind: 'committed', seqs: [64] })
    await document.close()
    expect(captures).toBe(1)
    expect((await backend.read(id)).events.filter(event => event.type === 'tool/result')).toHaveLength(1)
  } finally { release.resolve(); vi.mocked(open).mockImplementation(native.open); await coordinator.close().catch(() => {}) }
})

it('retains a source-local capture failure while saving unrelated real settlements and refusing new work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-source-fault-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction()
  let invalid!: core.CapturedSettlementFact
  const failed = action.registerSettlementSource(async () => { core.committedFactSeqs(await invalid.admit()) })
  let valid!: core.CapturedSettlementFact
  const real = action.registerSettlementSource(async () => { core.committedFactSeqs(await valid.admit()) })
  let captures = 0
  const output = { toJSON() { captures++; throw new Error('source cannot be lowered') } }
  try {
    valid = real.tools.captureResult({ type: 'tool/result', callId: 'valid', name: 'read', output: { content: 'completed independently' } })
    invalid = failed.tools.captureResult({ type: 'tool/result', callId: 'invalid', name: 'read', output })
    expect(await invalid.admit()).toEqual({ kind: 'not-issued', code: 'FACT_CAPTURE_FAILED' })
    expect(await action.facts.metadata.admit({ type: 'plan/mode', mode: 'on' })).toEqual({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    expect(await valid.admit()).toMatchObject({ kind: 'committed', seqs: [0] })
    expect(() => document.beginAction()).toThrow(core.FactRecoveryRequiredError)
    await expect(document.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(coordinator.ownerOf(id)).toBe(true)
    expect(captures).toBe(1)
    expect((await backend.read(id)).events).toEqual([{ type: 'tool/result', callId: 'valid', name: 'read', output: { content: 'completed independently' }, seq: 0 }])
  } finally { await coordinator.close().catch(() => {}) }
})

it('freezes required allocation for issued unknown despite a separate source fault, then permits only real settlement after reconcile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-source-unknown-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction()
  let invalid!: core.CapturedSettlementFact
  const failed = action.registerSettlementSource(async () => { core.committedFactSeqs(await invalid.admit()) })
  const real = action.registerSettlementSource(async () => {})
  const actual = backend.appendOwnedBatch!
  let writes = 0
  backend.appendOwnedBatch = async (...args) => { writes++; await actual(...args); return { kind: 'unknown', key: args[3].key } }
  try {
    const valid = real.tools.captureResult({ type: 'tool/result', callId: 'valid', name: 'read', output: 'already completed' })
    const issued = await action.facts.metadata.admit({ type: 'plan/mode', mode: 'on' })
    expect(issued.kind).toBe('unknown')
    invalid = failed.tools.captureResult({ type: 'tool/result', callId: 'invalid', name: 'read', output: { toJSON() { throw new Error('cannot lower') } } })
    expect(await valid.admit()).toEqual({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    expect(writes).toBe(1)
    if (issued.kind !== 'unknown') throw new Error('Expected issued uncertainty')
    expect(await document.reconcile(issued.key)).toMatchObject({ kind: 'committed', seqs: [0] })
    backend.appendOwnedBatch = actual
    expect(await valid.admit()).toMatchObject({ kind: 'committed', seqs: [1] })
    expect(await action.facts.metadata.admit({ type: 'plan/mode', mode: 'off' })).toEqual({ kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' })
    expect(() => document.beginAction()).toThrow(core.FactRecoveryRequiredError)
    await expect(document.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect((await backend.read(id)).events.map(event => event.type)).toEqual(['plan/mode', 'tool/result'])
  } finally { await coordinator.close().catch(() => {}) }
})

it('latches a registered source finalization failure before capture and still drains a distinct real result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-finalize-fault-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction()
  const failed = action.registerSettlementSource(async () => { throw new core.FactRecoveryRequiredError() })
  let handle!: core.CapturedSettlementFact
  const other = action.registerSettlementSource(async () => { core.committedFactSeqs(await handle.admit()) })
  try {
    handle = other.tools.captureResult({ type: 'tool/result', callId: 'other', name: 'read', output: 'real result' })
    failed.requireRecovery()
    expect(() => action.assertOpen()).toThrow(core.FactRecoveryRequiredError)
    await expect(document.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect((await backend.read(id)).events).toEqual([{ type: 'tool/result', callId: 'other', name: 'read', output: 'real result', seq: 0 }])
    expect(coordinator.ownerOf(id)).toBe(true)
  } finally { await coordinator.close().catch(() => {}) }
})

it('preserves image intake validation and computes source summaries before encoding a managed input-start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-images-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  try {
    const before = await readFile(join(root, `${id}.jsonl`))
    expect(await document.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'invalid', text: 'photo', delivery: 'queue', intent: 'user', images: [{ mediaType: 'image/png', dataBase64: 'not base64' }] })).toEqual({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
    expect(await readFile(join(root, `${id}.jsonl`))).toEqual(before)
    expect(await document.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'photo', text: 'inspect', delivery: 'queue', intent: 'user', images: [{ mediaType: 'image/png', dataBase64: 'AQID', name: 'photo.png', width: 3, height: 1 }] })).toMatchObject({ kind: 'committed', seqs: [0] })
    expect(await document.inputs.start({ type: 'agent/input/promoted', version: 1, inputId: 'photo' }, { type: 'user/message', text: 'inspect', imageInputId: 'photo' })).toMatchObject({ kind: 'committed', seqs: [1, 2, 3] })
    expect((await backend.read(id)).events.at(-1)).toEqual({ type: 'user/message', text: 'inspect', imageInputId: 'photo', seq: 3, imageSummaries: [{ mediaType: 'image/png', name: 'photo.png', width: 3, height: 1, bytes: 3 }] })
  } finally { await coordinator.close().catch(() => {}) }
})

it('keeps committed facts committed when an observer and its diagnostic reporter throw, without logging the observer body', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-observer-'))
  const backend = createJsonlBackend(root), diagnostics: unknown[] = []
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true }, reportBackgroundFailure(error) { diagnostics.push(error); throw new Error('reporter unavailable') } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const off = core.subscribe(document.view, () => { throw new Error('private observer body sentinel') })
  try {
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'committed', seqs: [0] })
    await expect(document.drain()).resolves.toBeUndefined()
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toMatchObject({ code: 'FACT_OBSERVER_FAILED' })
    expect(String(diagnostics[0])).not.toContain('private observer body sentinel')
    expect((await backend.read(id)).events).toEqual([{ type: 'plan/mode', mode: 'on', seq: 0 }])
  } finally { off(); await coordinator.close().catch(() => {}) }
})

it('keeps malformed receipts unknown through reconcile and owns immutable receipt, key and actual seq aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-receipt-shape-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const actual = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  let backendReceipt: core.FactReceipt | undefined
  backend.appendOwnedBatch = async (...args) => {
    const result = await actual(...args)
    if (result.kind !== 'committed') return result
    return { kind: 'committed', receipt: { key: result.receipt.key } } as any
  }
  backend.reconcileOwnedBatch = async (...args) => {
    const result = await reconcile(...args)
    if (result.kind !== 'committed') return result
    return { kind: 'committed', receipt: { key: result.receipt.key } } as any
  }
  try {
    const outcome = await document.metadata.admit({ type: 'plan/mode', mode: 'on' })
    if (outcome.kind !== 'unknown') throw new Error('Expected unknown receipt')
    expect(document.view.events).toEqual([])
    expect(await document.reconcile(outcome.key)).toMatchObject({ kind: 'unknown', key: outcome.key })
    expect(document.view.events).toEqual([])
    backend.reconcileOwnedBatch = async (...args) => {
      const result = await reconcile(...args)
      if (result.kind === 'committed') backendReceipt = result.receipt
      return result
    }
    const committed = await document.reconcile(outcome.key)
    if (committed.kind !== 'committed') throw new Error('Expected scoped receipt')
    expect(committed.seqs).toEqual([0])
    expect(committed.receipt).not.toBe(backendReceipt)
    expect(() => { (committed.receipt.owner as any).incarnation = 'changed' }).toThrow()
    expect(() => { (committed.receipt.key as any).firstSeq = 99 }).toThrow()
    expect(() => { (committed.seqs as any).push(99) }).toThrow()
    expect(() => { (outcome.key as any).batchDigest = 'changed' }).toThrow()
    expect(document.view.events).toEqual([{ type: 'plan/mode', mode: 'on', seq: 0 }])
  } finally { await coordinator.close().catch(() => {}) }
})

it('refuses an otherwise matching receipt when the backend never crossed the final issuance fence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-unissued-receipt-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (_id, owner, _prefix, batch) => ({ kind: 'committed', receipt: { owner: owner.owner, key: batch.key, lastSeq: batch.key.firstSeq + batch.key.count - 1, prefixDigest: core.factPrefixDigest(batch.key.previousPrefixDigest, batch.key.batchDigest) } })
  try {
    const outcome = await document.metadata.admit({ type: 'plan/mode', mode: 'on' })
    expect(outcome.kind).toBe('unknown')
    expect(document.view.events).toEqual([])
    expect((await backend.read(id)).events).toEqual([])
    if (outcome.kind !== 'unknown') throw new Error('Expected unknown unissued evidence')
    expect((await document.reconcile(outcome.key)).kind).toBe('absent')
    backend.appendOwnedBatch = actual
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'off' })).toMatchObject({ kind: 'committed', seqs: [0] })
  } finally { await coordinator.close().catch(() => {}) }
})

it('returns the exact active managed view from legacy load APIs without a second repair or writable mirror', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-load-alias-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const repair = vi.spyOn(backend, 'repair'), actual = backend.appendOwnedBatch!
  try {
    await document.metadata.admit({ type: 'plan/mode', mode: 'on' })
    expect((await coordinator.load(id)).session).toBe(document.view)
    expect((await coordinator.loadOwned(id)).session).toBe(document.view)
    expect(repair).not.toHaveBeenCalled()
    backend.appendOwnedBatch = async (...args) => { await actual(...args); return { kind: 'unknown', key: args[3].key } }
    const outcome = await document.metadata.admit({ type: 'plan/mode', mode: 'off' })
    await expect(coordinator.load(id)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    await expect(coordinator.loadOwned(id)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(repair).not.toHaveBeenCalled()
    if (outcome.kind !== 'unknown') throw new Error('Expected uncertainty')
    await document.reconcile(outcome.key)
  } finally { await coordinator.close().catch(() => {}) }
})

it('refuses a detached mutable readiness alias instead of upgrading it into a writable facade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-ready-alias-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), alias = { formatVersion: 5, events: [] }
  try {
    const before = await readFile(join(root, `${id}.jsonl`))
    await expect(ownedContextReadiness(coordinator, id, alias)()).rejects.toMatchObject({ code: 'FACT_OWNER_UNSUPPORTED' })
    expect(alias.formatVersion).toBe(5)
    expect(await readFile(join(root, `${id}.jsonl`))).toEqual(before)
    const document = await coordinator.openManagedDocument(id)
    await expect(ownedContextReadiness(coordinator, id, document.view)()).resolves.toBeUndefined()
  } finally { await coordinator.close().catch(() => {}) }
})

it('publishes a structural fork only after its fresh scoped seed receipt without copying the parent framing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-fork-receipt-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), parent = await coordinator.openManagedDocument(id)
  await parent.inputs.start(undefined, { type: 'user/message', text: 'inherited work' })
  await parent.agent.lifecycle({ type: 'turn/end' })
  const sourceFrames = (await readFile(join(root, `${id}.jsonl`), 'utf8')).trimEnd().split('\n').slice(1).map(line => JSON.parse(line))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), actual = backend.appendOwnedBatch!
  let seedReceiptOwner: string | undefined, seedKey: core.BatchKey | undefined, returned = false
  backend.appendOwnedBatch = async (...args) => {
    if (args[0] !== id) { entered.resolve(); await release.promise }
    const result = await actual(...args)
    if (args[0] !== id && result.kind === 'committed') { seedReceiptOwner = result.receipt.owner.sessionId; seedKey = result.receipt.key }
    return result
  }
  const forking = forkSession(coordinator, id).then(result => { returned = true; return result })
  try {
    await Promise.race([entered.promise, forking])
    expect(returned).toBe(false)
    release.resolve()
    const fork = await forking
    expect(seedReceiptOwner).toBe(fork.sessionId)
    expect(seedKey?.firstSeq).toBe(0)
    expect(sourceFrames.some(frame => frame.batchId === seedKey?.batchId)).toBe(false)
    const bytes = (await readFile(join(root, `${fork.sessionId}.jsonl`), 'utf8')).trimEnd().split('\n')
    expect(JSON.parse(bytes[0]!).journal).toMatchObject({ legacyBodyBytes: 0, legacyEventCount: 0, separatorBytes: 0 })
    expect(bytes).toHaveLength(2)
    expect((await coordinator.openManagedDocument(fork.sessionId)).view.events).toEqual((await backend.read(fork.sessionId)).events)
  } finally { release.resolve(); await coordinator.close().catch(() => {}) }
})

it('drains an already-captured required fact before releasing its source and refuses the stale handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-source-close-fence-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  const retained = source.tools.captureResult({ type: 'tool/result', callId: 'real', name: 'read', output: 'completed' })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), actual = backend.appendOwnedBatch!
  let attempts = 0
  backend.appendOwnedBatch = async (...args) => { attempts++; entered.resolve(); await release.promise; return actual(...args) }
  try {
    const saving = retained.admit()
    await entered.promise
    let closed = false
    const closing = source.close().then(() => { closed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(closed).toBe(false)
    release.resolve()
    expect(await saving).toMatchObject({ kind: 'committed', seqs: [0] })
    await closing
    expect(document.view.events).toEqual([{ type: 'tool/result', callId: 'real', name: 'read', output: 'completed', seq: 0 }])
    expect((await backend.read(id)).events).toEqual(document.view.events)
    await expect(retained.admit()).rejects.toMatchObject({ code: 'FACT_CLOSED' })
    expect(attempts).toBe(1)
  } finally { release.resolve(); action.finish(); await coordinator.close().catch(() => {}) }
})

it('keeps a successful fsync committed when file close cleanup fails, with no rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-known-sync-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  let syncs = 0, truncates = 0, closes = 0
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await native.open(...args)
    if (String(args[0]) !== join(root, `${id}.jsonl`) || args[1] !== 'r+') return handle
    return new Proxy(handle, { get(target, name) {
      if (name === 'sync') return async () => { syncs++; await target.sync() }
      if (name === 'truncate') return async (length: number) => { truncates++; await target.truncate(length) }
      if (name === 'close') return async () => { closes++; await target.close(); throw new Error('controlled cleanup failure after known sync') }
      const value = Reflect.get(target, name)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  try {
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'committed', seqs: [0] })
    expect([syncs, truncates, closes]).toEqual([1, 0, 1])
    expect(document.view.events).toEqual([{ type: 'plan/mode', mode: 'on', seq: 0 }])
    vi.mocked(open).mockImplementation(native.open)
    await document.close(); await coordinator.releaseOwnership(id)
    expect((await coordinator.openManagedDocument(id)).view.events).toEqual([{ type: 'plan/mode', mode: 'on', seq: 0 }])
  } finally { vi.mocked(open).mockImplementation(native.open); await coordinator.close().catch(() => {}) }
})

it('rejects cross-document and old-incarnation actual owner contexts despite identical empty prefixes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-real-owner-scope-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const a = (await coordinator.create()).id, b = (await coordinator.create()).id
  const left = await coordinator.openManagedDocument(a), right = await coordinator.openManagedDocument(b)
  const actualAppend = backend.appendOwnedBatch!
  let context: Parameters<typeof actualAppend>[1] | undefined
  backend.appendOwnedBatch = async (...args) => { context = args[1]; return actualAppend(...args) }
  const before = await readFile(join(root, `${b}.jsonl`))
  try {
    // Capture the actual branded context while its original operation owns it.
    await left.metadata.admit({ type: 'plan/mode', mode: 'on' })
    await expect(backend.readJournalPrefix!(b, context!)).rejects.toThrow('FACT_OWNER_UNSUPPORTED')
    expect(right.view.events).toEqual([])
    expect(await readFile(join(root, `${b}.jsonl`))).toEqual(before)
    await left.close(); await coordinator.releaseOwnership(a)
    const reopened = await coordinator.openManagedDocument(a)
    expect(reopened.view).not.toBe(left.view)
    await expect(backend.readJournalPrefix!(a, context!)).rejects.toMatchObject({ code: 'FACT_CLOSED' })
    expect(reopened.view.events).toHaveLength(1)
  } finally { await coordinator.close().catch(() => {}) }
})

it('preserves body-relative committed prefix addressing across a longer header rewrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-header-boundary-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  try {
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'committed', seqs: [0] })
    const before = await readFile(join(root, `${id}.jsonl`), 'utf8')
    await coordinator.updateMeta(id, { title: 'longer header metadata '.repeat(100) })
    const rewritten = await readFile(join(root, `${id}.jsonl`), 'utf8')
    expect(rewritten.indexOf('\n')).toBeGreaterThan(before.indexOf('\n'))
    expect(rewritten.slice(rewritten.indexOf('\n') + 1)).toBe(before.slice(before.indexOf('\n') + 1))
    expect(await document.metadata.admit({ type: 'plan/mode', mode: 'off' })).toMatchObject({ kind: 'committed', seqs: [1] })
    expect((await backend.read(id)).events).toEqual([{ type: 'plan/mode', mode: 'on', seq: 0 }, { type: 'plan/mode', mode: 'off', seq: 1 }])
  } finally { await coordinator.close().catch(() => {}) }
})

it('rejects invalid typed structural references with zero backend writes while preserving literal argument refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-typed-ref-zero-write-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  let writes = 0
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => { writes++; return actual(...args) }
  try {
    await document.agent.lifecycle({ type: 'turn/start' })
    writes = 0
    const before = await readFile(join(root, `${id}.jsonl`))
    const refs = [
      { kind: 'prior', seq: 0, expectedType: 'tool/call' },
      { kind: 'group', position: 0, expectedType: 'tool/call' },
      { kind: 'prior', seq: 999, expectedType: 'tool/call' },
      { kind: 'prior', seq: 0, expectedType: 'code/call' },
    ]
    for (const ref of refs) expect(await Reflect.apply(document.tools.dispatch, undefined, ['missing', ref])).toEqual({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
    expect(writes).toBe(0)
    expect(await readFile(join(root, `${id}.jsonl`))).toEqual(before)
    const args = { $ref: { kind: 'group', position: 999, expectedType: 'tool/call' }, z: 7, a: 2 }
    expect(await document.tools.call({ type: 'tool/call', callId: 'actual', name: 'actual', args })).toMatchObject({ kind: 'committed', seqs: [1] })
    expect(await document.tools.dispatch('actual', { kind: 'prior', seq: 1, expectedType: 'tool/call' })).toMatchObject({ kind: 'committed', seqs: [2] })
    expect((await backend.read(id)).events.find(event => event.type === 'tool/call')).toMatchObject({ args })
  } finally { await coordinator.close().catch(() => {}) }
})
