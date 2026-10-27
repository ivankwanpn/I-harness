import { expect, vi } from 'vitest'
import { appendFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNondurableFactOwner, createSession, decodeFactBatch, type FactOwner, type ManagedAction, type ProducerFactOutcome, type SettlementFacts, type SettlementCheckpointOwner, type CapturedActionFact, type CodeSettlementFact, type SessionEvent } from '@i-harness/core-session'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createCodeModeEventFacts } from '../src/event-facts.ts'

export const output = (cellId: string, preview = cellId): CodeSettlementFact => ({ type: 'code/output', cellId, envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'not-dispatched' }, preview, media: [], retention: { kind: 'unavailable', reason: 'quota' } } })
export async function fixture(mode: 'native' | 'memory') {
  const root = await mkdtemp(join(tmpdir(), 'ih-cell-owner-'))
  const backend = mode === 'native' ? createJsonlBackend(root) : undefined
  const issues: { events: unknown[]; key: unknown; bytesHex: string; outcome?: unknown }[] = []
  if (backend) {
    const append = backend.appendOwnedBatch!.bind(backend)
    backend.appendOwnedBatch = async (...args) => {
      const entry = { events: [...decodeFactBatch(args[3].bytes).events], key: args[3].key, bytesHex: Buffer.from(args[3].bytes).toString('hex'), outcome: undefined as unknown }
      issues.push(entry); const result = await append(...args); entry.outcome = result; return result
    }
  }
  const coordinator = backend && createSessionCoordinator(backend, { lock: { enabled: true } })
  const document = coordinator ? await coordinator.openManagedDocument((await coordinator.create()).id) : undefined
  const owner: FactOwner = document ?? createNondurableFactOwner(createSession())
  const trace: unknown[] = []
  const ids = new WeakMap<object, number>()
  let nextIdentity = 0
  const identity = (value: object) => { if (!ids.has(value)) ids.set(value, ++nextIdentity); return ids.get(value)! }
  const note = (kind: string, values: object = {}) => trace.push({ ordinal: trace.length, kind, ...values })
  const sources: { action: ManagedAction<ProducerFactOutcome>; source: SettlementFacts<ProducerFactOutcome>; descriptor?: SettlementCheckpointOwner; captures: CapturedActionFact<ProducerFactOutcome>[]; lifecycleEntered: Promise<void> }[] = []
  const stores: { capture: CapturedActionFact<ProducerFactOutcome>; outcomes: ProducerFactOutcome[] }[] = []
  const begin = owner.beginAction.bind(owner)
  vi.spyOn(owner, 'beginAction').mockImplementation(signal => {
    const action = begin(signal), register = action.registerSettlementSource.bind(action)
    vi.spyOn(action, 'registerSettlementSource').mockImplementation((...args) => {
      const lifecycleEntered = Promise.withResolvers<void>(), originalDrain = args[0]
      // Observe actual lifecycle entry after invoking the real original drain;
      // return that exact promise, with no simulated seal or completion flag.
      const source = register(() => {
        const result = originalDrain()
        note('lifecycle-entered', { source: identity(source) }); lifecycleEntered.resolve()
        return result
      }, args[1], args[2])
      const entry = { action, source, descriptor: args[2], captures: [] as CapturedActionFact<ProducerFactOutcome>[], lifecycleEntered: lifecycleEntered.promise }
      sources.push(entry)
      note('register', { action: identity(action), source: identity(source), owner: action.owner, descriptor: args[2] && identity(args[2]), cut: args[2]?.readCut() })
      const capture = source.code.capture.bind(source.code)
      const instrumentCapture = <T extends CapturedActionFact<ProducerFactOutcome>>(fact: T, event: unknown): T => {
        entry.captures.push(fact)
        note('capture', { source: identity(source), capture: identity(fact), event })
        const observed: CapturedActionFact<ProducerFactOutcome> = fact
        for (const method of ['admit', 'reconcile'] as const) {
          const original = observed[method].bind(observed)
          vi.spyOn(observed, method).mockImplementation(async () => { const outcome = await original(); note('capture-disposition', { capture: identity(fact), method, outcome }); return outcome })
        }
        return fact
      }
      vi.spyOn(source.code, 'capture').mockImplementation(event => instrumentCapture(capture(event), event))
      const captureReference = source.retention.capture.bind(source.retention)
      vi.spyOn(source.retention, 'capture').mockImplementation(event => instrumentCapture(captureReference(event), event))
      const instrument = <T>(method: string, original: () => Promise<T>) => async () => {
          note(method + '-start', { source: identity(source), cut: entry.descriptor?.readCut() })
          try { const result = await original(); note(method + '-success', { source: identity(source), result, cut: entry.descriptor?.readCut() }); return result }
          catch (error) { note(method + '-blocked', { source: identity(source), code: (error as { code?: string })?.code, cut: entry.descriptor?.readCut() }); throw error }
      }
      const checkpoint = source.checkpoint.bind(source), close = source.close.bind(source)
      vi.spyOn(source, 'checkpoint').mockImplementation(instrument('checkpoint', checkpoint))
      vi.spyOn(source, 'close').mockImplementation(instrument('close', close))
      const hold = source.holdRecovery.bind(source)
      vi.spyOn(source, 'holdRecovery').mockImplementation(() => { note('hold', { source: identity(source), cut: entry.descriptor?.readCut() }); hold() })
      return source
    })
    const captureStore = action.captureCodeStore.bind(action)
    vi.spyOn(action, 'captureCodeStore').mockImplementation(event => {
      const capture = captureStore(event), entry = { capture, outcomes: [] as ProducerFactOutcome[] }; stores.push(entry)
      for (const method of ['admit', 'reconcile'] as const) {
        const original = capture[method].bind(capture)
        vi.spyOn(capture, method).mockImplementation(async () => { const result = await original(); entry.outcomes.push(result); note('store-disposition', { action: identity(action), capture: identity(capture), method, outcome: result }); return result })
      }
      return capture
    })
    return action
  })
  const live = new Set<string>()
  let drains = 0
  const facts = createCodeModeEventFacts(owner, async () => {
    drains++
    for (const id of [...live]) { live.delete(id); await facts.required({ type: 'code/cell', cellId: id, state: 'terminated' }) }
  })
  const admit = async (id: string) => { await facts.optional({ type: 'code/cell', cellId: id, state: 'started' }); live.add(id) }
  const terminal = (id: string, onCommit?: () => void) => { live.delete(id); return facts.required({ type: 'code/cell', cellId: id, state: 'completed' }, onCommit) }
  const save = async (phase: string, negative?: boolean) => {
    if (process.env.IH_CELL_OWNER_EVIDENCE_FILE) await appendFile(process.env.IH_CELL_OWNER_EVIDENCE_FILE, JSON.stringify({ test: expect.getState().currentTestName, phase, mode, root, negative, trace, issues, events: owner.view.events, cuts: sources.map(s => s.descriptor?.readCut()), disposition: mode === 'memory' ? 'nondurable-memory-only' : 'owned-native-receipts' }) + '\n')
  }
  const cleanup = async (negative = false) => {
    if (negative) {
      await expect(facts.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      if (document) await expect(document.close()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
      await coordinator?.close().catch(error => note('expected-negative-coordinator-close', { code: error?.code }))
    } else { await facts.close(); await document?.close(); await coordinator?.close() }
    await save('cleanup', negative)
  }
  return { owner, document, backend, facts, sources, stores, issues, admit, terminal, cleanup, live, root, trace, note, save, get drains() { return drains } }
}

/** The original native bytes are actually appended/synced. Withhold only the
 * acknowledgement, including real exact-key reconciliation acknowledgements,
 * until the test releases delivery. No append/producer is replayed. */
export async function unknownMountReceipt(kind: 'reference' | 'terminal' | 'required') {
  const f = await fixture('native'); await f.admit('A')
  if (kind === 'terminal') await f.admit('B')
  const backend = f.backend!, append = backend.appendOwnedBatch!.bind(backend), reconcile = backend.reconcileOwnedBatch!.bind(backend)
  let unresolved = true, batch: Parameters<typeof append>[3] | undefined
  let receipt: Extract<Awaited<ReturnType<typeof append>>, { kind: 'committed' }>['receipt'] | undefined
  const target = (event: SessionEvent) => kind === 'reference' ? event.type === 'context/result-ref'
    : kind === 'terminal' ? event.type === 'code/cell' && event.cellId === 'B' && event.state === 'completed'
      : event.type === 'code/output' && event.cellId === 'mount-required'
  backend.appendOwnedBatch = async (...args) => {
    const result = await append(...args)
    if (decodeFactBatch(args[3].bytes).events.some(target)) {
      expect(batch).toBeUndefined(); batch = args[3]
      expect(result.kind).toBe('committed')
      if (result.kind !== 'committed') throw new Error('Original native fixture append did not commit')
      receipt = result.receipt
      f.note('mount-original-lost-ack', { key: batch.key, bytesHex: Buffer.from(batch.bytes).toString('hex'), originalReceipt: receipt })
      return { kind: 'unknown', key: batch.key }
    }
    return result
  }
  backend.reconcileOwnedBatch = async (...args) => {
    expect(args[3]).toBe(batch)
    const result = await reconcile(...args)
    expect(result).toMatchObject({ kind: 'committed', receipt })
    const delivered = unresolved ? { kind: 'unknown' as const, key: args[3].key } : result
    f.note('mount-original-reconcile', { key: args[3].key, bytesHex: Buffer.from(args[3].bytes).toString('hex'), native: result, delivered })
    return delivered
  }
  return { ...f, kind, releaseReceipt() { unresolved = false },
    get batch() { return batch! }, get receipt() { return receipt! },
    start(onCommit?: () => void) {
      if (kind === 'terminal') return f.terminal('B', onCommit)
      if (kind === 'required') return f.facts.required(output('mount-required', 'original mount π'), onCommit)
      return f.facts.captureReference({ id: 'original-ref', workspaceId: 'workspace', sessionId: 'session', callId: 'original-call', label: 'original π', revision: 'original-revision', bytes: 12, originalBytes: 12, complete: true, expiresAt: 9999999999999 })()
    },
  }
}
