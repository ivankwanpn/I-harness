import { createFsWatchService, type FsWatchService } from '@i-harness/fs-watch'
import { createInstructionObservationOwner, createObservedInstructionService, type InstructionService } from '@i-harness/instructions'
import type { InstructionEnvironment, SavedInstructionPolicyPort } from './contracts.ts'
import { createSavedInstructionPolicy } from './policy.ts'

function environment(watch: FsWatchService, ownsWatch: boolean, policy: SavedInstructionPolicyPort & { dispose(): void; close(): Promise<void> }): InstructionEnvironment {
  const observation = createInstructionObservationOwner(watch), views = new Set<InstructionService>()
  let closed = false
  const host = {
    create(scope: Parameters<typeof createObservedInstructionService>[0]['scope']) {
      if (closed) throw new Error('Instruction host closed')
      const service = createObservedInstructionService({ scope, observation })
      // Keep the original close capability and retry the same resource.
      const original = service.close.bind(service)
      const wrapped = { ...service, async close() { await original(); views.delete(wrapped) } }
      views.add(wrapped); return wrapped
    },
    async close() {
      closed = true
      const outcomes = await Promise.allSettled([...views].map(view => view.close()))
      const failures = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Instruction views cleanup incomplete')
      await observation.close()
    },
  }
  return { host, policy, dispose() { closed = true; policy.dispose() }, async close() {
    closed = true; policy.dispose()
    const outcomes = await Promise.allSettled([host.close(), policy.close()])
    const failures = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Instruction environment cleanup incomplete')
    if (ownsWatch) await watch.close()
  } }
}
export function createInstructionEnvironment(options: { settingsPath: string; watch?: FsWatchService }): InstructionEnvironment {
  const watch = options.watch ?? createFsWatchService()
  return environment(watch, !options.watch, createSavedInstructionPolicy(options.settingsPath, watch))
}
/** Direct embedders use project sources only; no ambient profile lookup. */
export function createProjectInstructionEnvironment(): InstructionEnvironment {
  const watch = createFsWatchService()
  let closed = false
  const state = Object.freeze({ kind: 'ready' as const, generation: 'project-only', policy: Object.freeze({ enabled: true, maxBytes: 24000, globalSources: Object.freeze([]) }) })
  return environment(watch, true, { current: () => closed ? { kind: 'unavailable', generation: 'closed', reason: 'Instruction environment closed' } : state,
    async ready() { if (closed) throw new Error('Instruction environment closed') }, subscribe: () => () => {}, dispose() { closed = true }, async close() { closed = true } })
}
