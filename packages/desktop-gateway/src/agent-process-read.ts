import { createHash } from 'node:crypto'
import type { SessionView } from '@i-harness/core-session'
import type { SessionCoordinator, SessionMeta, ProcessReadInitial, ProcessReadUpdate } from '@i-harness/session-persistence'
import type { SessionService, ResultPageQuery, ResultPageResult, ResultReadScopeResolver } from '@i-harness/session-executor'
import { buildObservedSavedProcessIndex, createFixedSavedSelection, type FixedSavedSelection } from './saved-process-index.ts'
import type { SessionManagementFence } from './session-management-fence.ts'

export interface AgentProcessReadContext {
  index: ReturnType<typeof buildObservedSavedProcessIndex>
  session: SessionView
  document: unknown
  select(id: string, instanceId?: string): void
  checkpoint(): Promise<void>
  assertCurrent(): void
  page(query: ResultPageQuery): Promise<ResultPageResult>
}
export type AgentProcessReadRunner = <T>(id: string, work: (context: AgentProcessReadContext) => Promise<T>) => Promise<T>
/** Whole request lives inside the genuine original observation and host fence. */
export function createAgentProcessReadRunner(options: {
  coordinator: SessionCoordinator; service: Pick<SessionService, 'liveAssembly'>
  isConversation(id: string, meta: SessionMeta): Promise<boolean>; fence: SessionManagementFence
  resultReadScopeFor?: ResultReadScopeResolver
  readResultPage?: (id: string, query: ResultPageQuery) => Promise<ResultPageResult>
}): AgentProcessReadRunner {
  return (id, work) => options.fence.run(id, async () => {
    const { coordinator, service, fence } = options
    if (!coordinator.withProcessReadObservation || !options.resultReadScopeFor) throw Object.assign(new Error('Process observation unsupported'), { code: 'observation-unsupported' })
    const assembly = service.liveAssembly(id)
    let getter: Awaited<ReturnType<ResultReadScopeResolver>>, revision: string | undefined, established = false
    const synchronous = () => { fence.assertOpen(id); if (service.liveAssembly(id) !== assembly || established && getter?.().revision !== revision) throw new Error('Process read owner changed') }
    async function policy() {
      synchronous(); const { meta } = await coordinator.profile(id); synchronous()
      const visible = await options.isConversation(id, meta); synchronous()
      if (meta.archived || !visible) throw new Error('Conversation unavailable')
      const current = await options.resultReadScopeFor!(id); synchronous()
      if (!established) { getter = current; revision = current?.().revision; established = true }
      else if (!!current !== !!getter || current?.().revision !== revision) throw new Error('Process project scope changed')
      synchronous()
    }
    await policy()
    const delivered: Extract<ProcessReadUpdate, { kind: 'suffix' }>[] = []
    let context!: AgentProcessReadContext, checks: FixedSavedSelection[] = []
    const bindingKey = `desktop-session-project-${createHash('sha256').update(id).digest('hex')}`
    const apply = (update: ProcessReadUpdate) => { if (update.kind === 'suffix') { delivered.push(update); for (const selected of checks) selected.append(update.from, update.events) } }
    return coordinator.withProcessReadObservation(id, { documentKeys: [id, bindingKey] }, async observation => {
      const initial: ProcessReadInitial = observation.initial
      const document = initial.documents.get(id)
      const assert = () => { synchronous(); observation.assertCurrent(); for (const selected of checks) selected.current() }
      const checkpoint = async () => { synchronous(); apply(await observation.check()); assert(); await policy(); assert() }
      const index = buildObservedSavedProcessIndex(initial, id)
      context = { index, session: initial.session, document: document?.kind === 'present' ? document.value : undefined,
        select(jobId, instanceId) { const selected = createFixedSavedSelection(initial, id, jobId, instanceId, index); for (const update of delivered) selected.append(update.from, update.events); checks.push(selected); assert() },
        assertCurrent: assert, checkpoint,
        async page(query) { await checkpoint(); if (!options.readResultPage) throw new Error('Process result reader unavailable'); const page = await options.readResultPage(id, query); await checkpoint(); return page },
      }
      await checkpoint()
      return work(context)
    }, async (candidate, observation, last) => {
      apply(last); context.assertCurrent(); await policy(); observation.assertCurrent(); context.assertCurrent(); return candidate
    })
  })
}
