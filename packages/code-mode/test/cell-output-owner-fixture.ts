import { expect, vi } from 'vitest'
import { appendFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNondurableFactOwner, createSession, decodeFactBatch, type FactOwner, type ManagedAction, type ProducerFactOutcome, type SettlementFacts, type SettlementCheckpointOwner, type CapturedActionFact, type CodeSettlementFact } from '@i-harness/core-session'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createCodeModeEventFacts } from '../src/event-facts.ts'

export const output = (cellId: string, preview = cellId): CodeSettlementFact => ({ type: 'code/output', cellId, envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'not-dispatched' }, preview, media: [], retention: { kind: 'unavailable', reason: 'quota' } } })
export async function fixture(mode: 'native' | 'memory') {
  const root = await mkdtemp(join(tmpdir(), 'ih-cell-owner-'))
  const backend = mode === 'native' ? createJsonlBackend(root) : undefined
  const issues: { events: unknown[]; key: unknown; outcome?: unknown }[] = []
  if (backend) {
    const append = backend.appendOwnedBatch!.bind(backend)
    backend.appendOwnedBatch = async (...args) => {
      const entry = { events: [...decodeFactBatch(args[3].bytes).events], key: args[3].key, outcome: undefined as unknown }
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
      vi.spyOn(source.code, 'capture').mockImplementation(event => {
        const fact = capture(event); entry.captures.push(fact)
        note('capture', { source: identity(source), capture: identity(fact), event })
        for (const method of ['admit', 'reconcile'] as const) {
          const original = fact[method].bind(fact)
          vi.spyOn(fact, method).mockImplementation(async () => { const outcome = await original(); note('capture-disposition', { capture: identity(fact), method, outcome }); return outcome })
        }
        return fact
      })
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
  return { owner, document, facts, sources, stores, issues, admit, terminal, cleanup, live, root, trace, note, save, get drains() { return drains } }
}
