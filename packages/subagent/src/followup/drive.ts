import { captureChildResult } from "../child/result.ts"
import { isNondurableSession, type SessionEventView } from "@i-harness/core-session"
import type { AgentRegistry } from "@i-harness/core-agent"
import type { AgentTable, ChildAgentEntry } from "../agent-table.ts"
import type { JobRegistry } from "../jobs.ts"
import { beginFollowupExecution, type FollowupGeneration, type FollowupGenerationIntent } from './generation.ts'
import type { ResidentInboxActivation } from './activation.ts'

// Drain all unconsumed durable inbox events as serialized turns on the child.
// Turns are chained through entry.followupChain (one at a time, per child), a
// fresh AbortController is minted per turn so interrupt_agent targets the
// current turn, and each turn re-opens the entry's job (running -> completed /
// killed / error) so wait_agent/job_output observe the followup lifecycle.
// Exported for the agent-team scheduler (M19 Ruling 28): the team wakeup
// policy is the SAME serialized drain, shared instead of vendored.
export interface FollowupDeps {
  activation?: ResidentInboxActivation
  captureGeneration?: (entry: ChildAgentEntry, input: Extract<SessionEventView, { type: 'subagent/inbox' }>) => FollowupGenerationIntent
  results?: import("../task/result.ts").TaskResultStore
  agents: AgentRegistry
  table: AgentTable
  jobs: JobRegistry
  // M23 (Minor 4): optional lazy rebuild — called when the resident agent is
  // missing (e.g. a restored entry after resume) so the wakeup drive recovers
  // it instead of silently no-oping. Backward-compatible: absent (the default,
  // e.g. the agent-team scheduler without the seam) keeps the old no-op.
  rebuild?: (entry: ChildAgentEntry, controller: AbortController, executionCurrent?: () => boolean) => Promise<boolean>
  openGeneration?: (entry: ChildAgentEntry, input: Extract<SessionEventView, { type: 'subagent/inbox' }>, controller: AbortController, originalIntent?: FollowupGenerationIntent, executionCurrent?: () => boolean) => Promise<FollowupGeneration>
}
export function driveFollowups(deps: FollowupDeps, entry: ChildAgentEntry, sessionId: string, signal?: AbortSignal): Promise<void> {
  const prev = entry.followupChain ?? Promise.resolve()
  // Install an observed full-drive handle before any scheduled callback runs.
  const raw = Promise.withResolvers<void>()
  void raw.promise.catch(() => {})
  const activation = deps.activation, captureGeneration = deps.captureGeneration?.bind(deps), openGeneration = deps.openGeneration?.bind(deps), rebuild = deps.rebuild?.bind(deps)
  const activationCurrent = activation?.current.bind(activation), waitActivation = activation?.wait.bind(activation)
  const next = prev.then(async () => {
    if (signal?.aborted || entry.closing || deps.table.get(entry.path) !== entry) return
    const pending = entry.session.events.filter(
      (e): e is Extract<SessionEventView, { type: "subagent/inbox" }> =>
        e.type === "subagent/inbox" && (e.seq ?? 0) > (entry.lastInboxSeq ?? -1),
    )
    for (const ev of pending) {
      if (signal?.aborted || entry.closing || deps.table.get(entry.path) !== entry) return // closed/replaced mid-drain → stop
      const intent = captureGeneration?.(entry, ev)
      const execution = beginFollowupExecution(intent, raw.promise)
      const view = entry.session, pendingStop = entry.controller.signal
      let owner = entry.factOwner
      let controller: AbortController | undefined, selectedAgent: ReturnType<AgentRegistry['get']>
      let returned = false, dispatched = false, priorSettled = false
      let resultStore = deps.results, generation: FollowupGeneration | undefined
      let outcome: { occurred: false } | { occurred: true; value: unknown } = { occurred: false }
      const identityCurrent = () => {
        // Legacy nondurable embedders acquire their first FactOwner during
        // rebuild. Actual assembly restores already carry their exact owner.
        if (!activation && !owner) owner = entry.factOwner
        return !signal?.aborted && !entry.closing && deps.table.get(entry.path) === entry && entry.session === view && entry.factOwner === owner && (!owner || owner.view === view)
      }
      const executionCurrent = () => identityCurrent() && activationCurrent?.() !== false
        && view.events.some(event => event.type === 'subagent/inbox' && event.seq === ev.seq && event.messageId === ev.messageId)
        && (dispatched ? entry.lastInboxSeq === (ev.seq ?? 0) : (entry.lastInboxSeq ?? -1) < (ev.seq ?? 0))
        && (!controller || entry.controller === controller && !controller.signal.aborted)
        && (!selectedAgent || deps.agents.get(sessionId) === selectedAgent)
      const cancel = () => controller?.abort(signal?.reason)
      try {
        const replacement = new AbortController()
        const off = deps.table.subscribe(() => { if (!identityCurrent()) replacement.abort() })
        try {
          if (!identityCurrent()) return
          const gateSignal = signal ? AbortSignal.any([signal, replacement.signal]) : replacement.signal
          if (waitActivation && !await waitActivation(gateSignal, pendingStop)) return
        } finally { off() }
        if (!executionCurrent()) return
        const previous = entry.resultCapture
        if (execution) await execution.settlePrevious(previous)
        else await previous?.settle()
        priorSettled = true
        if (!executionCurrent()) return
        // Errors belong to the previous turn; this run gets its own visible
        // start stamp while its retained generation clock stays original.
        controller = new AbortController()
        signal?.addEventListener('abort', cancel, { once: true })
        if (signal?.aborted) cancel()
        if (!identityCurrent() || activationCurrent?.() === false || controller.signal.aborted) return
        deps.table.update(entry.path, entry, { error: undefined, finalText: undefined, result: undefined, publication: undefined, savedObservation: undefined, status: "running", startedAt: Date.now(), controller,
          ...(entry.retention !== undefined || entry.retentionError !== undefined ? { retention: undefined, retentionError: undefined } : {}),
        })
        if (!executionCurrent()) return
        if (entry.jobId) deps.jobs.updateJob(entry.jobId, { status: "running", output: "" })
        if (!executionCurrent()) return
        if (resultStore?.forSource) {
          execution?.admitSource()
          const source = resultStore
          resultStore = await (execution ? execution.invoke(() => source.forSource!(undefined, executionCurrent)) : source.forSource!(undefined, executionCurrent))
          if (execution) execution.source = resultStore
        }
        if (!executionCurrent()) return
        if (!isNondurableSession(entry.session) && !openGeneration) throw Object.assign(new Error('Managed child wake requires its generation owner'), { code: 'GENERATION_UNSUPPORTED' })
        if (openGeneration) generation = await openGeneration(entry, ev, controller, intent, executionCurrent)
        if (!executionCurrent()) return
        selectedAgent = deps.agents.get(sessionId)
        if (!selectedAgent && rebuild && await rebuild(entry, controller, executionCurrent)) selectedAgent = deps.agents.get(sessionId)
        if (!executionCurrent()) return
        if (!selectedAgent) { deps.table.update(entry.path, entry, { status: 'waiting' }); return }
        // Rebuild publishes a waiting resident. This same already-open inbox
        // execution now owns the running fence; its original clock is retained.
        if (entry.status !== 'running') deps.table.update(entry.path, entry, { status: 'running' })
        if (!executionCurrent()) return
        dispatched = true
        entry.lastInboxSeq = ev.seq ?? 0
        const followup = () => selectedAgent!.followup(ev.message, controller!.signal, generation?.options ?? { provenance: ev.provenance ?? { kind: "inherited", authority: "observation", scope: "turn", producer: "subagent.inbox", ...(entry.session.header?.parentSession ? { originSessionId: entry.session.header.parentSession } : {}) } })
        const result = await (execution ? execution.invoke(followup) : followup())
        // Clear a stale error (e.g. "aborted" from an earlier interrupted
        // turn) once a followup succeeds — otherwise a misleading error would
        // persist into the M6 snapshot.
        returned = true
        const capture = resultStore ? captureChildResult(resultStore, entry, { resultText: result.finalText }, "completed") : undefined
        if (capture) execution?.retainResult(capture)
        const publish = (projection?: import("../task/result.ts").TaskResultProjection) => {
          deps.table.update(entry.path, entry, { error: undefined, status: "waiting", finalText: projection ? projection.resultText : result.finalText, ...(projection ? { result: projection.result } : {}) })
          if (entry.jobId) deps.jobs.updateJob(entry.jobId, { status: "completed", output: projection ? projection.resultText ?? "" : result.finalText, ...(projection ? { result: projection.result } : {}) })
        }
        publish(capture?.projection())
        if (capture) publish(await (execution ? execution.settleResult() : capture.settle()))
      } catch (err) {
        outcome = { occurred: true, value: err }
        if (!priorSettled) throw err
        if (!dispatched && !executionCurrent()) throw err
        if (returned) throw err
        const aborted = controller?.signal.aborted ?? pendingStop.aborted
        const error = aborted ? "aborted" : (err instanceof Error ? err.message : String(err))
        const capture = resultStore ? captureChildResult(resultStore, entry, { error }, aborted ? "cancelled" : "error", dispatched ? "dispatched" : "not-dispatched") : undefined
        if (capture) execution?.retainResult(capture)
        const publish = (projection?: import("../task/result.ts").TaskResultProjection) => {
          deps.table.update(entry.path, entry, { status: "waiting", error: projection ? projection.error : error, ...(projection ? { result: projection.result } : {}) })
          if (entry.jobId) deps.jobs.updateJob(entry.jobId, { status: aborted ? "killed" : "error", output: projection ? projection.error ?? "" : error, ...(projection ? { result: projection.result } : {}) })
        }
        publish(capture?.projection())
        if (capture) publish(await (execution ? execution.settleResult() : capture.settle()))
      } finally {
        execution?.exitBody(outcome)
        signal?.removeEventListener('abort', cancel)
        try {
          const results = await Promise.allSettled([generation ? generation.close() : execution?.close(), execution?.preparationCleanup()])
          const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
          if (failures.length === 1) throw failures[0]
          if (failures.length) throw new AggregateError(failures, 'Original producer cleanup failed')
        }
        catch (cleanup) {
          if (outcome.occurred) throw new AggregateError([outcome.value, cleanup], 'Original inbox body and generation cleanup failed', { cause: outcome.value })
          throw cleanup
        }
      }
    }
  })
  void next.then(raw.resolve, raw.reject)
  // Defensive hardening: the body fully try/catches, but a future throwing
  // statement before the try must not reject the chain and silently kill all
  // later followups for this child.
  entry.followupChain = raw.promise.catch(() => {})
  return raw.promise
}
