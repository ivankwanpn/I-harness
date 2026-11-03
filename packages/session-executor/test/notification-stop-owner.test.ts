import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { committedFactSeqs, decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { ParentNotificationStoppedError } from '@i-harness/subagent'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import * as assemblyModule from '../src/assembly.ts'
import { createSessionService } from '../src/service.ts'
import { createDurableSessionLoader } from '../src/durable-session.ts'
import { controlledModel } from './controlled-model.ts'

afterEach(() => vi.restoreAllMocks())
const observation = { sessionId: 'parent', text: 'original notification', description: 'owned observation' }
function failureData(value: unknown, depth = 0): unknown {
  if (depth === 8) return { truncated: true }
  if (value === undefined) return { type: 'undefined' }
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Error) return { name: value.name, message: value.message, code: (value as Error & { code?: string }).code,
    cause: 'cause' in value ? failureData(value.cause, depth + 1) : undefined,
    errors: value instanceof AggregateError ? value.errors.slice(0, 20).map(error => failureData(error, depth + 1)) : undefined }
  return String(value)
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nso-')), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' })
  const document = await coordinator.openManagedDocument('parent')
  const captures: { event: unknown; fact: object }[] = [], keys: BatchKey[] = []
  const source = document.registerReceivedInputSource.bind(document)
  document.registerReceivedInputSource = drain => {
    const handle = source(drain), capture = handle.captureCancellation.bind(handle)
    handle.captureCancellation = event => { const fact = capture(event); captures.push({ event, fact }); return fact }
    return handle
  }
  let notify!: NonNullable<assemblyModule.AssemblyOptions['parentNotify']>
  const build = assemblyModule.createSessionAssembly
  vi.spyOn(assemblyModule, 'createSessionAssembly').mockImplementation(options => { notify = options.parentNotify!; return build(options) })
  const model = controlledModel(async function* () { throw Error('Notification must not call the model'); yield { type: 'end' } as const })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model, codeMode: { mode: 'off' } })
  const failures: unknown[] = [], close = service.close.bind(service), closeSession = service.closeSession.bind(service)
  service.close = () => { const promise = close(); void promise.then(() => {}, error => { failures.push(failureData(error)) }); return promise }
  service.closeSession = (...args) => { const promise = closeSession(...args); void promise.then(() => {}, error => { failures.push(failureData(error)) }); return promise }
  const assembly = await service.assemblyFor('parent')
  let disposals = 0, fallbacks = 0
  const dispose = assembly.dispose.bind(assembly), closeDocument = coordinator.closeManagedDocument.bind(coordinator)
  assembly.dispose = () => { disposals++; return dispose() }
  coordinator.closeManagedDocument = (...args) => { fallbacks++; return closeDocument(...args) }
  const cancellations: { receiver: object; args: [string, string?]; promise: Promise<boolean> }[] = []
  const cancel = assembly.inbox.cancel
  assembly.inbox.cancel = function (...args) { const promise = cancel.apply(this, args); cancellations.push({ receiver: this, args, promise }); return promise }
  const evidence = async (name: string, extra: object = {}) => {
    const journal = await readFile(join(root, 'parent.jsonl'), 'utf8')
    await writeFile(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, `${name}.json`), JSON.stringify({ root, journal, failures, cancellations: cancellations.map(({ args, promise, receiver }, index) => ({ args, promiseIdentity: cancellations.findIndex(row => row.promise === promise) + 1, receiverIsOriginal: receiver === assembly.inbox, index })), captures: captures.map(({ event }, index) => ({ event, identity: index + 1 })), disposals, fallbacks, keys, ...extra }, null, 2))
  }
  return { root, backend, coordinator, document, service, assembly, notify, cancellations, captures, keys, evidence, counts: () => ({ disposals, fallbacks }) }
}

it.each(['committed', 'unknown'] as const)('joins both actual default-service Stop callers on the original cancellation promise before reporting Stop (%s)', async report => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), releaseAdmit = Promise.withResolvers<void>()
  const cancelEntered = Promise.withResolvers<void>(), releaseCancel = Promise.withResolvers<void>()
  const admit = f.assembly.inbox.admit.bind(f.assembly.inbox), append = f.backend.appendOwnedBatch!.bind(f.backend)
  f.assembly.inbox.admit = async (...args) => { const value = await admit(...args); entered.resolve(); await releaseAdmit.promise; return value }
  f.backend.appendOwnedBatch = async (...args) => {
    const cancelled = decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/cancelled')
    const result = await append(...args)
    if (cancelled) {
      f.keys.push(args[3].key); cancelEntered.resolve(); await releaseCancel.promise
      if (report === 'unknown') return { kind: 'unknown', key: args[3].key }
    }
    return result
  }
  const pending = f.notify.admit(observation).then(() => ({ stopped: false }), error => ({ stopped: error instanceof ParentNotificationStoppedError, error }))
  try {
    await entered.promise
    f.service.cancelRunning!('parent')
    await cancelEntered.promise
    releaseAdmit.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(f.cancellations).toHaveLength(1)
    let settled = false; void pending.then(() => { settled = true })
    expect(settled).toBe(false)
    releaseCancel.resolve()
    if (report === 'committed') {
      expect(await pending).toMatchObject({ stopped: true })
      await f.service.close()
    } else {
      expect(await pending).toMatchObject({ stopped: false, error: { code: 'FACT_RECOVERY_REQUIRED' } })
      await expect(f.service.close()).rejects.toBeDefined()
      await f.service.close()
    }
    expect(f.keys).toHaveLength(1)
    expect(f.captures).toHaveLength(1)
    expect(f.cancellations[0]!.args[1]).toBe('parent stopped')
    expect(f.document.view.events.filter(event => event.type === 'agent/input/cancelled')).toHaveLength(1)
    await f.evidence(`coalesced-${report}`)
  } finally { releaseAdmit.resolve(); releaseCancel.resolve(); await pending; await f.service.close().catch(() => {}); await f.coordinator.close() }
})

it('retains a successful Stop while separate original native disposal debt remains unknown', async () => {
  const f = await fixture(), append = f.backend.appendOwnedBatch!.bind(f.backend), reconcile = f.backend.reconcileOwnedBatch!.bind(f.backend)
  let debtKey: BatchKey | undefined, allow = false
  f.backend.appendOwnedBatch = async (...args) => {
    const outcome = await append(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'subagent/inbox' && event.messageId === 'disposal-debt')) { debtKey = args[3].key; return { kind: 'unknown', key: debtKey } }
    return outcome
  }
  f.backend.reconcileOwnedBatch = async (...args) => debtKey?.batchId === args[3].key.batchId && !allow ? { kind: 'unknown', key: args[3].key } : reconcile(...args)
  try {
    await f.notify.admit(observation)
    f.service.cancelRunning!('parent')
    expect(await f.cancellations[0]!.promise).toBe(true)
    const action = f.document.beginAction()
    let fact: ReturnType<ReturnType<typeof action.registerSettlementSource>['delivery']['capture']>
    const source = action.registerSettlementSource(async () => { committedFactSeqs(await fact.reconcile()) })
    action.finish()
    fact = source.delivery.capture({ type: 'subagent/inbox', messageId: 'disposal-debt', message: 'original audit', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'team.delivery' } })
    expect((await fact.admit()).kind).toBe('unknown')
    await expect(f.service.close()).rejects.toBeDefined()
    expect(f.cancellations).toHaveLength(1); expect(await f.cancellations[0]!.promise).toBe(true)
    expect(f.service.hasAssembly('parent')).toBe(true)
    allow = true
    await f.service.close()
    expect(f.cancellations).toHaveLength(1)
    expect(f.counts().disposals).toBe(2)
    await f.evidence('successful-stop-disposal-debt', { debtKey })
  } finally { allow = true; await f.service.close().catch(() => {}); await f.coordinator.close() }
})

it('joins the original admission before snapshotting a late-created Stop record', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const append = f.backend.appendOwnedBatch!.bind(f.backend)
  f.backend.appendOwnedBatch = async (...args) => {
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/admitted')) { entered.resolve(); await release.promise }
    return append(...args)
  }
  const pending = f.notify.admit(observation).catch(error => error)
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    expect(f.assembly.inbox.pending()).toHaveLength(0)
    closing = f.service.close(); void closing.catch(() => {})
    release.resolve()
    expect(await pending).toBeInstanceOf(ParentNotificationStoppedError)
    await closing
    expect(f.cancellations).toHaveLength(1); expect(f.captures).toHaveLength(1)
    expect(await f.cancellations[0]!.promise).toBe(true)
    expect(f.counts().disposals).toBe(1)
    await f.evidence('late-snapshot')
  } finally { release.resolve(); await pending; await closing?.catch(() => {}); await f.service.close().catch(() => {}); await f.coordinator.close() }
})

it('retains continued unknown under the original source until explicit recovery and releases acknowledged disposal once', async () => {
  const f = await fixture(), append = f.backend.appendOwnedBatch!.bind(f.backend), reconcile = f.backend.reconcileOwnedBatch!.bind(f.backend)
  let key: BatchKey | undefined, allow = false, writes = 0
  const reconciliationKeys: BatchKey[] = []
  f.backend.appendOwnedBatch = async (...args) => {
    const outcome = await append(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/cancelled')) { writes++; key = args[3].key; return { kind: 'unknown', key } }
    return outcome
  }
  f.backend.reconcileOwnedBatch = async (...args) => {
    if (key?.batchId === args[3].key.batchId) { reconciliationKeys.push(args[3].key); if (!allow) return { kind: 'unknown', key: args[3].key } }
    return reconcile(...args)
  }
  try {
    await f.notify.admit(observation)
    await expect(f.service.close()).rejects.toBeDefined()
    expect(f.service.hasAssembly('parent')).toBe(true)
    expect(f.counts().disposals).toBe(1)
    expect(f.captures).toHaveLength(1)
    allow = true
    // This close reports its original Stop rejection even though its separate
    // source/disposal phase recovers the original issued batch successfully.
    await expect(f.service.close()).rejects.toBeDefined()
    expect(f.service.hasAssembly('parent')).toBe(false)
    expect(f.counts().disposals).toBe(2)
    const acknowledged = f.counts()
    await expect(f.service.close()).resolves.toBeUndefined()
    expect(f.counts()).toEqual(acknowledged)
    expect(writes).toBe(1)
    expect(reconciliationKeys.length).toBeGreaterThan(0)
    for (const actual of reconciliationKeys) expect(actual).toEqual(key)
    await f.evidence('continued-unknown', { key, writes, reconciliationKeys })
  } finally { allow = true; await f.service.close().catch(() => {}); await f.service.close().catch(() => {}); await f.coordinator.close() }
})

it('keeps an old acknowledged Stop owner separate from an equal-ID replacement assembly', async () => {
  const f = await fixture(), append = f.backend.appendOwnedBatch!.bind(f.backend)
  let writes = 0
  f.backend.appendOwnedBatch = async (...args) => {
    const result = await append(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/cancelled')) { writes++; f.keys.push(args[3].key); return { kind: 'unknown', key: args[3].key } }
    return result
  }
  try {
    await f.notify.admit(observation)
    const input = f.assembly.inbox.pending()[0]!
    await expect(f.service.closeSession('parent')).rejects.toBeDefined()
    const replacement = await f.service.assemblyFor('parent')
    expect(replacement).not.toBe(f.assembly); expect(replacement.factOwner).not.toBe(f.assembly.factOwner)
    const newCancels: Promise<boolean>[] = [], cancel = replacement.inbox.cancel.bind(replacement.inbox)
    replacement.inbox.cancel = (...args) => { const pending = cancel(...args); newCancels.push(pending); return pending }
    await replacement.inbox.admit({ inputId: input.inputId + '-replacement', text: 'replacement', intent: 'system', delivery: 'steer', provenance: input.provenance })
    await expect(f.service.closeSession('parent')).rejects.toBeDefined()
    expect(await f.cancellations.at(-1)!.promise).toBe(false)
    expect(newCancels).toHaveLength(1)
    expect(newCancels[0]).not.toBe(f.cancellations.at(-1)!.promise)
    expect(f.counts().disposals).toBe(1)
    await f.service.closeSession('parent')
    expect(newCancels).toHaveLength(2); expect(await newCancels[1]).toBe(false)
    expect(writes).toBe(2)
    await f.evidence('equal-id-replacement', { writes })
  } finally { await f.service.closeSession('parent').catch(() => {}); await f.service.close().catch(() => {}); await f.coordinator.close() }
})

it.each(['all', 'session'] as const)('retains unknown Stop through actual disposal then retries old owner without repeating disposal (%s)', async mode => {
  const f = await fixture(), append = f.backend.appendOwnedBatch!.bind(f.backend)
  let unknownKey: BatchKey | undefined, writes = 0
  f.backend.appendOwnedBatch = async (...args) => {
    const result = await append(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/cancelled')) { writes++; unknownKey = args[3].key; f.keys.push(unknownKey); return { kind: 'unknown', key: unknownKey } }
    return result
  }
  const close = () => mode === 'all' ? f.service.close() : f.service.closeSession('parent')
  try {
    await f.notify.admit(observation)
    // close's original cancellation caller sees unknown; native source disposal
    // reconciles that same issued key successfully, independently of its error.
    await expect(close()).rejects.toBeDefined()
    expect(unknownKey).toBeDefined()
    expect(f.service.hasAssembly('parent')).toBe(false)
    const afterFirst = f.counts()
    expect(afterFirst.disposals).toBe(1)
    await expect(close()).resolves.toBeUndefined()
    expect(f.counts()).toEqual(afterFirst)
    expect(f.cancellations.at(-1)!.receiver).toBe(f.assembly.inbox)
    expect(await f.cancellations.at(-1)!.promise).toBe(false)
    expect(writes).toBe(1)
    expect(f.document.view.events.filter(event => event.type === 'agent/input/cancelled')).toHaveLength(1)
    await f.evidence(`old-owner-${mode}`, { unknownKey, writes })
  } finally { await close().catch(() => {}); await f.service.close().catch(() => {}); await f.coordinator.close() }
})

it('preserves strict different-reason rejection while the original received cancellation is pending', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const append = f.backend.appendOwnedBatch!.bind(f.backend)
  f.backend.appendOwnedBatch = async (...args) => {
    const result = await append(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/cancelled')) { entered.resolve(); await release.promise }
    return result
  }
  try {
    await f.notify.admit(observation)
    const id = f.assembly.inbox.pending()[0]!.inputId
    const first = f.assembly.inbox.cancel(id, 'original reason')
    await entered.promise
    await expect(f.assembly.inbox.cancel(id, 'different reason')).rejects.toMatchObject({ code: 'FACT_INVALID_GROUP' })
    release.resolve(); expect(await first).toBe(true)
    await f.evidence('strict-equality')
  } finally { release.resolve(); await f.service.close().catch(() => {}); await f.coordinator.close() }
})
