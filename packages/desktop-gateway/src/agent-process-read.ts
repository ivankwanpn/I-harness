import { createFixedFactSelection, type SavedFactEvidence } from './saved-fact-selection.ts'
import { createHash } from 'node:crypto'
import type { SessionView } from '@i-harness/core-session'
import type { SessionCoordinator, SessionMeta, ProcessReadInitial, ProcessReadUpdate } from '@i-harness/session-persistence'
import type { SessionService, ResultPageQuery, ResultPageResult, ResultReadScopeResolver } from '@i-harness/session-executor'
import { buildObservedSavedProcessIndex, createFixedSavedSelections, type SavedProcessSelector } from './saved-process-index.ts'
import type { SessionManagementFence } from './session-management-fence.ts'
import { originalManagedExecutionFor, originalManagedRuntimeFor, type OriginalManagedRuntime } from '../../session-executor/src/host-managed-execution.ts'

export interface AgentProcessReadContext {
  index: ReturnType<typeof buildObservedSavedProcessIndex>
  session: SessionView
  document: unknown
  managedProcesses?(): { background: ReturnType<OriginalManagedRuntime['processes']>; tasks(): ReturnType<SessionService['tasks']> } | undefined
  selectJobs(selectors: readonly SavedProcessSelector[]): void
  selectTerminal(id: string, evidence: readonly SavedFactEvidence[]): void
  checkpoint(): Promise<void>
  assertCurrent(): void
  page(query: ResultPageQuery): Promise<ResultPageResult>
}
export type AgentProcessReadRunner = <T>(id: string, work: (context: AgentProcessReadContext) => Promise<T>) => Promise<T>
/** Whole request lives inside the genuine original observation and host fence. */
export function createAgentProcessReadRunner(options: {
  coordinator: SessionCoordinator; service: SessionService
  isConversation(id: string, meta: SessionMeta): Promise<boolean>; fence: SessionManagementFence
  resultReadScopeFor?: ResultReadScopeResolver
  readResultPage?: (id: string, query: ResultPageQuery) => Promise<ResultPageResult>
}): AgentProcessReadRunner {
  return <T>(id: string, work: (context: AgentProcessReadContext) => Promise<T>) => options.fence.run(id, async () => {
    const { coordinator, service, fence } = options
    if (!coordinator.withProcessReadObservation || !options.resultReadScopeFor) throw Object.assign(new Error('Process observation unsupported'), { code: 'observation-unsupported' })
    // Let an already-admitted mount establish its owner before taking a read witness.
    // A failed warmup still allows the normal, independently verified cold read.
    const mounting = service.pendingAssemblyMount(id)
    if (mounting) await mounting.catch(() => {})
    let assembly = service.liveAssembly(id)
    const execution = originalManagedExecutionFor(service, id)
    const cold = !mounting && !assembly && !execution
    // A private attachment can precede its runtime. Use only the runtime that
    // existed at the start of this observation and let a later read see a mount.
    const runtime = execution && !assembly ? originalManagedRuntimeFor(service, id) : undefined
    if (runtime && runtime.execution !== execution) throw new Error('Process read owner changed')
    const ownerChanged = new Error('Process read owner changed')
    let beganWork = false, computed = false, publishing = false, originalRefusal: Error | undefined
    let getter: Awaited<ReturnType<ResultReadScopeResolver>>, revision: string | undefined, established = false
    const assertScope = () => {
      if (established && getter?.().revision !== revision) throw new Error('Process project scope changed')
    }
    const synchronous = () => {
      fence.assertOpen(id)
      if (service.liveAssembly(id) !== assembly || originalManagedExecutionFor(service, id) !== execution) throw ownerChanged
      runtime?.assertCurrent()
      assertScope()
    }
    async function policy() {
      synchronous(); const { meta } = await coordinator.profile(id); synchronous()
      const visible = await options.isConversation(id, meta); synchronous()
      if (meta.archived || !visible) throw new Error('Conversation unavailable')
      const current = await options.resultReadScopeFor!(id); synchronous()
      if (!established) { getter = current; revision = current?.().revision; established = true }
      else if (!!current !== !!getter || current?.().revision !== revision) throw new Error('Process project scope changed')
      synchronous()
    }
    const bindingKey = `desktop-session-project-${createHash('sha256').update(id).digest('hex')}`
    const readRefusal = (error: unknown) => {
      if (error instanceof Error && (error.message === 'PROCESS_READ_UNAVAILABLE' || (error as { code?: string }).code === 'FACT_RECOVERY_REQUIRED')) originalRefusal = error
    }
    async function readOnce(): Promise<T> {
      await policy()
      const delivered: Extract<ProcessReadUpdate, { kind: 'suffix' }>[] = []
      const facts: ReturnType<typeof createFixedFactSelection>[] = []
      const checks: ReturnType<typeof createFixedSavedSelections>[] = []
      let context!: AgentProcessReadContext, opened = false
      const apply = (update: ProcessReadUpdate) => { if (update.kind === 'suffix') { delivered.push(update); for (const selected of checks) selected.append(update.from, update.events); for (const selected of facts) selected.append(update.from, update.events) } }
      try {
        return await coordinator.withProcessReadObservation!(id, { documentKeys: [id, bindingKey] }, async observation => {
          opened = true
          const initial: ProcessReadInitial = observation.initial
          const document = initial.documents.get(id)
          const assert = () => {
            synchronous()
            try { observation.assertCurrent() } catch (error) { readRefusal(error); throw error }
            for (const selected of checks) selected.assertCurrent()
            for (const selected of facts) selected.assertCurrent()
          }
          const checkpoint = async () => {
            synchronous()
            let update: ProcessReadUpdate
            try { update = await observation.check() } catch (error) { readRefusal(error); throw error }
            apply(update); assert(); await policy(); assert()
          }
          const index = buildObservedSavedProcessIndex(initial, id)
          context = { index, session: initial.session, document: document?.kind === 'present' ? document.value : undefined,
            managedProcesses() {
              if (!runtime) return undefined
              assert()
              const background = runtime.processes()
              assert()
              return { background, tasks() { assert(); const tasks = service.tasks(id); assert(); return tasks } }
            },
            selectJobs(selectors) {
              if (!selectors.length) return
              const selected = createFixedSavedSelections(initial, id, selectors, index)
              for (const update of delivered) selected.append(update.from, update.events)
              checks.push(selected)
              assert()
            },
            selectTerminal(terminalId, evidence) { const selected = createFixedFactSelection(initial.session, evidence, id, terminalId); for (const update of delivered) selected.append(update.from, update.events); facts.push(selected); assert() },
            assertCurrent: assert, checkpoint,
            async page(query) { await checkpoint(); if (!options.readResultPage) throw new Error('Process result reader unavailable'); const page = await options.readResultPage(id, query); await checkpoint(); return page },
          }
          await checkpoint()
          beganWork = true
          const candidate = await work(context)
          computed = true
          return candidate
        }, async (candidate, observation, last) => {
          publishing = true
          apply(last); context.assertCurrent(); await policy(); observation.assertCurrent(); context.assertCurrent(); return candidate
        })
      } catch (error) {
        if (!opened || computed && !publishing) readRefusal(error)
        throw error
      }
    }
    try { return await readOnce() }
    catch (error) {
      if (!cold || !established || publishing || beganWork && !computed || (error !== ownerChanged && (originalRefusal === undefined || error !== originalRefusal))) throw error
      fence.assertOpen(id)
      if (originalManagedExecutionFor(service, id)) throw error
      let next = service.liveAssembly(id)
      if (!next) {
        const warm = service.pendingAssemblyMount(id)
        if (!warm) throw error
        assertScope()
        try { next = await warm } catch { throw error }
      }
      fence.assertOpen(id); assertScope()
      if (service.liveAssembly(id) !== next || originalManagedExecutionFor(service, id)) throw error
      // The failed cold witness is already retired. Only this exact new warm
      // owner gets a fresh observation under the original admitted scope.
      assembly = next
      return readOnce()
    }
  })
}
