import type { createManagedDocuments } from './managed-documents.ts'
import type { ProcessReadStorage } from './process-read-storage.ts'
import type { ProcessReadInitial, ProcessReadObservation, ProcessReadOptions, ProcessReadUpdate, ProcessReadScopeRunner } from './process-read-owner.ts'
import { createProcessReadVisibility } from './process-read-visibility.ts'

/** Uses only the original ready entry and the backend's metadata/document witness. */
export function createManagedProcessReadOwner(storage: ProcessReadStorage, managed: ReturnType<typeof createManagedDocuments>) {
  return { async run<T, U>(id: string, options: ProcessReadOptions, work: (observation: ProcessReadObservation) => Promise<T>, publish: (candidate: T, observation: ProcessReadObservation, last: ProcessReadUpdate) => Promise<U>, scope: ProcessReadScopeRunner = (_observation, _visibility, run) => run()): Promise<U> {
    const keys = [...new Set(options.documentKeys)].sort()
    if (keys.length > 32 || keys.some(key => typeof key !== 'string')) throw new TypeError('Invalid process read document keys')
    const capture = managed.captureProcessReadById(id, keys)
    let state: 'capturing' | 'active' | 'finishing' | 'verified' | 'failed' | 'retired' = 'capturing', checking = false
    try {
      const auxiliary = await storage.captureManagedAuxiliary(id, keys)
      capture.assertDrained()
      const visibility = createProcessReadVisibility(); visibility.add(capture.initial.events)
      const initial: ProcessReadInitial = Object.freeze({ session: capture.initial, highWater: capture.initial.events.length, documents: auxiliary.documents })
      const take = () => { const update = capture.take(); if (update.kind === 'suffix') visibility.add(update.events); return update }
      const assertCurrent = () => { try { if (state !== 'active' && state !== 'verified') throw new Error('PROCESS_READ_UNAVAILABLE'); capture.assertDrained() } catch (error) { state = 'failed'; throw error } }
      const observation: ProcessReadObservation = Object.freeze({ initial,
        async check() {
          if (this !== observation || state !== 'active' || checking) { state = 'failed'; throw new Error('PROCESS_READ_UNAVAILABLE') }
          checking = true
          try { await auxiliary.check(); if (state !== 'active') throw new Error('PROCESS_READ_UNAVAILABLE'); return take() }
          catch (error) { state = 'failed'; throw error } finally { checking = false }
        },
        assertCurrent() { if (this !== observation) { state = 'failed'; throw new TypeError('Invalid observation receiver') }; assertCurrent() },
      })
      state = 'active'
      const candidate = await scope(observation, visibility, () => work(observation))
      if (state !== 'active' || checking) throw new Error('PROCESS_READ_UNAVAILABLE')
      state = 'finishing'; await auxiliary.finish()
      if (state !== 'finishing') throw new Error('PROCESS_READ_UNAVAILABLE')
      const last = take(); capture.markVerified(); state = 'verified'
      const result = await scope(observation, visibility, () => publish(candidate, observation, last))
      assertCurrent(); return result
    } finally { state = 'retired'; capture.close() }
  } }
}
