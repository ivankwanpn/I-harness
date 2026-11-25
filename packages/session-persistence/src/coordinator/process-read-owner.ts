import { freezeJsonData, type SessionEvent, type SessionEventView, type SessionView } from '@i-harness/core-session'
import { buildSession, guardIgnorable, preflightDecodedFactHistory, preflightSessionFormat } from '../format/validation.ts'
import { recognizesOriginalDecodedProcessHistory } from '../archive-read-internal.ts'
import type { createProcessReadLatches } from './process-read-latches.ts'
import type { ProcessReadStorage } from './process-read-storage.ts'
import type { ObservedDocument, PersistenceBackend, SessionMeta } from './types.ts'
import { createProcessReadVisibility } from './process-read-visibility.ts'

export interface ProcessReadOptions { readonly documentKeys: readonly string[] }
export interface ProcessReadInitial { readonly session: SessionView; readonly highWater: number; readonly documents: ReadonlyMap<string, ObservedDocument> }
export type ProcessReadUpdate = { readonly kind: 'unchanged'; readonly highWater: number } | { readonly kind: 'suffix'; readonly from: number; readonly to: number; readonly events: readonly SessionEventView[] }
export interface ProcessReadObservation { readonly initial: ProcessReadInitial; check(): Promise<ProcessReadUpdate>; assertCurrent(): void }
export interface ProcessReadScopeControl { assertExit(): void; assertPageAdmission(): void }
export type ProcessReadVisibility = Pick<ReturnType<typeof createProcessReadVisibility>, 'contains'>
export type ProcessReadScopeRunner = <T>(observation: ProcessReadObservation, visibility: ProcessReadVisibility, run: () => Promise<T>, control: ProcessReadScopeControl) => Promise<T>

function prepareColdTranscript(initial: SessionView, decodedByOriginal: boolean) {
  const events = initial.events as SessionEvent[], meta = initial.header as SessionMeta | undefined
  if (decodedByOriginal) preflightDecodedFactHistory(initial.formatVersion, events)
  else preflightSessionFormat(initial.formatVersion, events, meta)
  if (guardIgnorable(events).length !== events.length) throw new Error('PROCESS_READ_UNAVAILABLE')
  const session = freezeJsonData(buildSession(meta, events))
  const visibility = createProcessReadVisibility()
  visibility.add(session.events)
  return { session, visibility: Object.freeze({ contains: visibility.contains }) }
}

/** Internal lifecycle; the composition owner is solely responsible for run. */
export function createColdProcessReadOwner(storage: ProcessReadStorage, latches: ReturnType<typeof createProcessReadLatches>, backend?: PersistenceBackend) {
  // The backend owns the lifetime of its bounded immutable key. Prepared
  // data carries neither a latch nor any request's document or artifact scope.
  const preparedTranscripts = new WeakMap<SessionView, ReturnType<typeof prepareColdTranscript>>()
  return { async run<T, U>(id: string, options: ProcessReadOptions, work: (observation: ProcessReadObservation) => Promise<T>, publish: (candidate: T, observation: ProcessReadObservation, last: ProcessReadUpdate) => Promise<U>, scope: ProcessReadScopeRunner = (_observation, _visibility, run) => run()): Promise<U> {
    const keys = [...new Set(options.documentKeys)].sort()
    if (keys.length > 32 || keys.some(key => typeof key !== 'string')) throw new TypeError('Invalid process read document keys')
    const latch = latches.capture({ sessionId: id, documentKeys: keys, mode: 'cold' })
    let state: 'capturing' | 'active' | 'finishing' | 'verified' | 'failed' | 'retired' = 'capturing', checking = false
    try {
      const raw = await storage.capture(id, keys)
      latch.assertCurrent()
      const source = raw.initial
      const reusable = raw.reusableInitial === true && Object.isFrozen(source) && Object.isFrozen(source.events)
      const cached = reusable ? preparedTranscripts.get(source) : undefined
      const prepared = cached ?? prepareColdTranscript(source, backend !== undefined && recognizesOriginalDecodedProcessHistory(backend, id, source))
      const { session, visibility } = prepared, highWater = session.events.length
      const initial: ProcessReadInitial = Object.freeze({ session, highWater, documents: raw.documents })
      const assertCurrent = () => {
        try { if (state !== 'active' && state !== 'verified') throw new Error('PROCESS_READ_UNAVAILABLE'); latch.assertCurrent() }
        catch (error) { state = 'failed'; throw error }
      }
      const observation: ProcessReadObservation = Object.freeze({ initial,
        async check() {
          if (this !== observation || state !== 'active' || checking) { state = 'failed'; throw new Error('PROCESS_READ_UNAVAILABLE') }
          checking = true
          try { assertCurrent(); await raw.check(); assertCurrent(); return Object.freeze({ kind: 'unchanged' as const, highWater }) }
          catch (error) { state = 'failed'; throw error } finally { checking = false }
        },
        assertCurrent() { if (this !== observation) { state = 'failed'; throw new TypeError('Invalid observation receiver') }; assertCurrent() },
      })
      const control: ProcessReadScopeControl = Object.freeze({
        assertExit() { assertCurrent(); if (checking) { state = 'failed'; throw new Error('PROCESS_READ_UNAVAILABLE') } },
        assertPageAdmission() { if (state !== 'active' || checking) { state = 'failed'; throw new Error('PROCESS_READ_UNAVAILABLE') }; assertCurrent() },
      })
      state = 'active'
      const candidate = await scope(observation, visibility, () => work(observation), control)
      assertCurrent(); if (checking) throw new Error('PROCESS_READ_UNAVAILABLE')
      state = 'finishing'; await raw.finish()
      if (state !== 'finishing') throw new Error('PROCESS_READ_UNAVAILABLE')
      latch.assertCurrent(); latch.markVerified(); state = 'verified'
      const last: ProcessReadUpdate = Object.freeze({ kind: 'unchanged', highWater })
      const result = await scope(observation, visibility, () => publish(candidate, observation, last), control)
      assertCurrent()
      if (reusable && !cached) preparedTranscripts.set(source, prepared)
      return result
    } finally { state = 'retired'; latch.retire() }
  } }
}
