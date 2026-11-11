import { createSessionCoordinator as createRawSessionCoordinator, SessionLockUnsupportedError } from '../src/index.ts'
import { expect, it } from 'vitest'
import { createSessionCoordinator, createControlledJsonlBackend as createJsonlBackend, ownedControls } from './helpers/composed.ts'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const terminal = { type: 'context/recovery' as const, version: 1 as const, ownerSessionId: 'owner', recoveryId: 'original', logicalStepSeq: 0, bindingFingerprint: 'a'.repeat(64), rejectedInputFingerprint: 'b'.repeat(64), state: 'blocked' as const, retryConsumed: true }

it('refuses managed activation without actual exclusive ownership and owned batch backend', async () => {
  const backend = { id: 'jsonl', capabilities: { seekableRead: false, rawArtifacts: false } } as any
  expect(()=>createRawSessionCoordinator(backend)).toThrow('original writable coordinator factory')
  const root=await mkdtemp(join(tmpdir(),'ih-managed-capability-'))
  try{
    const native=createJsonlBackend(root)
    expect(()=>createRawSessionCoordinator(native,{lock:{enabled:false}})).toThrow(SessionLockUnsupportedError)
    const partial=createJsonlBackend(root,original=>{original.appendOwnedBatch=undefined})
    expect(()=>createRawSessionCoordinator(partial,{lock:{enabled:true}})).toThrow('Original writable JSONL capability unavailable: appendOwnedBatch')
    expect(await readdir(root)).toEqual([])
  }finally{await rm(root,{recursive:true,force:true})}
})

it('uses the original managed metadata frame for immutable held terminal recovery after Stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-managed-recovery-')), backend = createJsonlBackend(root)
  const store = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await store.create()
  const document = await store.openManagedDocument(id), action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  try {
    const draft = { ...terminal, ownerSessionId: id }, original = source.recovery.capture(draft)
    draft.recoveryId = 'changed'
    action.stop()
    expect(await action.facts.metadata.admit(terminal)).toMatchObject({ kind: 'not-issued', code: 'FACT_CANCELLED' })
    expect(await original.admit()).toMatchObject({ kind: 'committed', receipt: { key: { count: 1 } } })
    expect(document.view.events.at(-1)).toMatchObject({ recoveryId: 'original', state: 'blocked' })
    expect(await source.recovery.capture({ ...terminal, ownerSessionId: id, state: 'resolved' }).admit()).toMatchObject({ kind: 'committed' })
    await source.close()
    expect(() => source.recovery.capture(terminal)).toThrow('closed')
    expect((await backend.read(id)).events.map(item => item.type === 'context/recovery' ? item.state : item.type)).toEqual(['blocked', 'resolved'])
  } finally { action.finish(); await store.close() }
})

it('quarantines invalid managed terminal drafts without invoking executable data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-managed-recovery-invalid-')), backend = createJsonlBackend(root)
  const store = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await store.create()
  const document = await store.openManagedDocument(id), action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  let reads = 0
  const accessor = Object.defineProperty({ ...terminal }, 'reason', { enumerable: true, get() { reads++; return 'unsafe' } })
  for (const draft of [{ ...terminal, state: 'required' }, { ...terminal, state: 'retry-started' }, { ...terminal, type: 'context/budget' }, { ...terminal, seq: 1 }, { ...terminal, ignorable: true }, { ...terminal, envelope: {} }, { ...terminal, extra: true }, accessor, Object.assign(new (class {})(), terminal), new Proxy(terminal, {})]) {
    expect(await source.recovery.capture(draft as never).admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
  }
  expect(reads).toBe(0)
  expect((await backend.read(id)).events).toHaveLength(0)
  expect(() => document.beginAction()).toThrow('reconciliation')
  action.finish()
  await expect(source.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
  await expect(store.close()).rejects.toThrow()
})

it('captures ordinary acceptance bytes once and never issues a canceled original via reconcile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-managed-acceptance-')), backend = createJsonlBackend(root), store = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction()
  try {
    await action.facts.agent.lifecycle({ type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1' })
    await action.facts.agent.lifecycle({ type: 'step/start', actionId: 'action', attemptId: 'attempt' })
    const assistant = { type: 'assistant/message' as const, text: 'original' }, accepted = { type: 'model/exchange-accepted' as const, version: 1 as const, exchangeId: 'original', actionId: 'action', attemptId: 'attempt', stepStartSeq: { kind: 'prior' as const, seq: 1, expectedType: 'step/start' as const }, assistantSeq: { kind: 'group' as const, position: 0, expectedType: 'assistant/message' as const }, callSeqs: [] }
    const original = action.captureModelExchange(assistant, accepted)
    assistant.text = 'changed'; accepted.exchangeId = 'changed'
    expect(await original.admit()).toMatchObject({ kind: 'committed', seqs: [2, 3], receipt: { key: { count: 2 } } })
    expect(document.view.events.at(-1)).toMatchObject({ type: 'model/exchange-accepted', exchangeId: 'original' })
    expect(document.view.events[2]).toMatchObject({ text: 'original' })
    await action.facts.agent.lifecycle({ type: 'step/end' })
    await action.facts.agent.lifecycle({ type: 'step/start', actionId: 'next', attemptId: 'next' })
    const canceled = action.captureModelExchange({ type: 'assistant/message', text: 'never issued' }, { ...accepted, actionId: 'next', attemptId: 'next', exchangeId: 'canceled', stepStartSeq: { kind: 'prior', seq: 5, expectedType: 'step/start' } })
    const append = ownedControls(backend).originalAppend; let writes = 0
    ownedControls(backend).append = async (...args) => { writes++; return append(...args) }
    action.stop()
    expect(await canceled.admit()).toEqual({ kind: 'not-issued', code: 'FACT_CANCELLED' })
    expect(await canceled.reconcile()).toEqual({ kind: 'not-issued', code: 'FACT_CANCELLED' })
    expect(writes).toBe(0)
    expect(await original.reconcile()).toMatchObject({ kind: 'committed', seqs: [2, 3] })
  } finally { action.finish(); await store.close() }
})

it('settles only finished original close requests and preserves active, stopped, never-close and received-input producers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-managed-finished-')), backend = createJsonlBackend(root), store = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await store.create(), document = await store.openManagedDocument(id)
  const calls = { eligible: 0, active: 0, stopped: 0, aborted: 0, never: 0, input: 0 }
  const marker = new Error('original producer not yet settled')
  const requested = (name: 'eligible' | 'active' | 'stopped' | 'aborted', signal?: AbortSignal) => {
    const action = document.beginAction(signal), source = action.registerSettlementSource(async () => { if (++calls[name] === 1) throw marker })
    return { action, source }
  }
  const eligible = requested('eligible'), active = requested('active'), stopped = requested('stopped'), controller = new AbortController(), aborted = requested('aborted', controller.signal)
  const neverAction = document.beginAction(), never = neverAction.registerSettlementSource(async () => { calls.never++ })
  document.registerReceivedInputSource(async () => { calls.input++ })
  try {
    for (const entry of [eligible, active, stopped, aborted]) await expect(entry.source.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', errors: [marker] })
    eligible.action.finish(); stopped.action.stop(); controller.abort(); neverAction.finish()
    await document.settleFinishedActions()
    expect(calls).toEqual({ eligible: 2, active: 1, stopped: 1, aborted: 1, never: 0, input: 0 })
    expect(() => eligible.source.assertHeld()).toThrow('closed')
    for (const source of [active.source, stopped.source, aborted.source, never]) source.assertHeld()
    expect(await never.recovery.capture({ ...terminal, ownerSessionId: id }).admit()).toMatchObject({ kind: 'committed' })
    expect(document.view.events.at(-1)).toMatchObject({ type: 'context/recovery', recoveryId: 'original' })
    document.assertReady()
  } finally { for (const entry of [active, stopped, aborted]) entry.action.finish(); await store.close() }
})

it('shares one finite original source attempt, retains actual failures and permits only a later explicit retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-managed-finite-')), backend = createJsonlBackend(root), store = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), marker = new Error('finite original failure')
  let calls = 0
  const source = action.registerSettlementSource(async () => { calls++; if (calls === 2) { entered.resolve(); await release.promise }; if (calls < 3) throw marker })
  try {
    action.finish(); source.holdRecovery()
    await expect(source.close()).rejects.toMatchObject({ errors: [marker] })
    const first = document.settleFinishedActions(), concurrent = document.settleFinishedActions()
    expect(concurrent).toBe(first)
    await entered.promise; expect(calls).toBe(2)
    release.resolve()
    const failure = await first.catch(error => error)
    expect(failure).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', cause: { errors: [{ errors: [marker] }] } })
    expect(calls).toBe(2); expect(() => document.assertReady()).toThrow()
    await document.settleFinishedActions()
    expect(calls).toBe(3); document.assertReady()
    expect(() => source.assertHeld()).toThrow('closed')
  } finally { release.resolve(); await store.close() }
})

it('never retries an absent original required fact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-managed-absent-')), backend = createJsonlBackend(root), store = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction(), source = action.registerSettlementSource(async () => {})
  const append = ownedControls(backend).originalAppend, reconcile = ownedControls(backend).originalReconcile
  let key: import('@i-harness/core-session').BatchKey | undefined, issues = 0, ready = false
  ownedControls(backend).append = async (...args) => { if (!key) { issues++; key = args[3].key; return { kind: 'unknown', key } }; return append(...args) }
  ownedControls(backend).reconcile = (...args) => ready ? reconcile(...args) : Promise.resolve({ kind: 'unknown', key: args[3].key })
  try {
    const fact = source.recovery.capture({ ...terminal, ownerSessionId: id })
    expect(await fact.admit()).toMatchObject({ kind: 'unknown' })
    action.finish(); source.holdRecovery()
    await expect(source.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    ready = true
    await expect(document.settleFinishedActions()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    await expect(document.settleFinishedActions()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(await fact.observe()).toMatchObject({ kind: 'absent', key }); expect(issues).toBe(1)
    expect(() => document.assertReady()).toThrow(); source.assertHeld()
  } finally { await store.close().catch(() => {}) }
})

it('retains a held finished background producer which never requested close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-managed-held-background-')), backend = createJsonlBackend(root), store = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction()
  let calls = 0
  const source = action.registerSettlementSource(async () => { calls++ })
  try {
    action.finish(); source.holdRecovery()
    await expect(document.settleFinishedActions()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(calls).toBe(0); source.assertHeld(); expect(() => document.beginAction()).toThrow()
    await source.close(); document.assertReady(); expect(calls).toBe(1)
  } finally { await store.close() }
})

it('joins original finite settlement with host close and permanently fences new work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-managed-close-race-')), backend = createJsonlBackend(root), store = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let calls = 0
  const source = action.registerSettlementSource(async () => { if (++calls === 1) throw new Error('initial close'); entered.resolve(); await release.promise })
  try {
    action.finish(); await expect(source.close()).rejects.toThrow()
    const settlement = document.settleFinishedActions().catch(error => error)
    await entered.promise
    const closing = document.close(); release.resolve()
    expect(await settlement).toMatchObject({ code: 'FACT_CLOSED' }); await closing
    expect(calls).toBe(2)
    expect(() => document.beginAction()).toThrow(); expect(() => document.settleFinishedActions()).toThrow()
  } finally { release.resolve(); await store.close() }
})

it.each(['active', 'never-close', 'same-action-never-close', 'received-input'] as const)('does not reconcile pending %s authority through another original close request', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'ih-managed-unqualified-')), backend = createJsonlBackend(root), store = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await store.create(), document = await store.openManagedDocument(id), action = document.beginAction()
  let eligibleCalls = 0, producerCalls = 0, reconciles = 0
  const eligible = action.registerSettlementSource(async () => { if (++eligibleCalls === 1) throw new Error('original close failed') })
  const other = kind === 'same-action-never-close' ? action : document.beginAction()
  const producer = kind === 'received-input' ? document.registerReceivedInputSource(async () => { producerCalls++ }) : other.registerSettlementSource(async () => { producerCalls++ })
  const append = ownedControls(backend).originalAppend, reconcile = ownedControls(backend).originalReconcile
  let key: import('@i-harness/core-session').BatchKey | undefined
  try {
    await expect(eligible.close()).rejects.toThrow(); action.finish()
    if (kind === 'never-close') other.finish()
    ownedControls(backend).append = async (...args) => { key = args[3].key; return { kind: 'unknown', key } }
    const outcome = 'captureAdmitted' in producer
      ? await producer.captureAdmitted({ type: 'agent/input/admitted', version: 1, inputId: 'original', text: 'original', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } }).admit()
      : await producer.recovery.capture({ ...terminal, ownerSessionId: id }).admit()
    expect(outcome).toMatchObject({ kind: 'unknown' })
    ownedControls(backend).append = append
    ownedControls(backend).reconcile = (...args) => { reconciles++; return reconcile(...args) }
    await expect(document.settleFinishedActions()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(reconciles).toBe(0); expect(producerCalls).toBe(0)
    if ('recovery' in producer) producer.assertHeld()
    expect(await document.reconcile(key!)).toMatchObject({ kind: 'absent' }); expect(reconciles).toBe(1)
  } finally { other.finish(); ownedControls(backend).append = append; await store.close().catch(() => {}) }
})

it('takes one finite eligible snapshot and preserves every original source failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-managed-snapshot-')), backend = createJsonlBackend(root), store = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await store.create(), document = await store.openManagedDocument(id)
  const firstMarker = new Error('first original producer failure'), secondMarker = new Error('second original producer failure')
  let firstCalls = 0, secondCalls = 0, laterCalls = 0
  const firstAction = document.beginAction(), secondAction = document.beginAction()
  const first = firstAction.registerSettlementSource(async () => {
    firstCalls++
    if (firstCalls === 2) {
      const laterAction = document.beginAction(), later = laterAction.registerSettlementSource(async () => { if (++laterCalls === 1) throw new Error('later original request') })
      laterAction.finish(); later.holdRecovery(); await later.close().catch(() => {})
    }
    if (firstCalls < 3) throw firstMarker
  })
  const second = secondAction.registerSettlementSource(async () => { if (++secondCalls < 3) throw secondMarker })
  try {
    firstAction.finish(); secondAction.finish()
    await expect(first.close()).rejects.toThrow(); await expect(second.close()).rejects.toThrow()
    const failure = await document.settleFinishedActions().catch(error => error)
    expect(failure).toMatchObject({ code: 'FACT_RECOVERY_REQUIRED', cause: { errors: [{ errors: [firstMarker] }, { errors: [secondMarker] }] } })
    expect([firstCalls, secondCalls, laterCalls]).toEqual([2, 2, 1])
    await document.settleFinishedActions()
    expect([firstCalls, secondCalls, laterCalls]).toEqual([3, 3, 2]); document.assertReady()
  } finally { await store.close() }
})
