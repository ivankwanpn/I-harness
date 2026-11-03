import {bindOriginalSpawnRun,bindOriginalSpawnJob,hasRequiredOriginalSpawn} from '../tools/source-run.ts'
import { retainChildResult } from "./result.ts"
import type { PluginContext } from "@i-harness/core-plugin"
import { committedFactSeqs, deriveMessages, type SessionView, type FactOwner } from "@i-harness/core-session"
import { randomUUID } from 'node:crypto'
import type { ManagedDocument } from '@i-harness/session-persistence'
import { estimateContent } from "@i-harness/token-meter"
import { d } from "./diagnostics.ts"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { Agent } from "@i-harness/core-agent"
import type { CodeModeMount } from "@i-harness/code-mode"
import type { ChildAgentEntry } from "../agent-table.ts"
import type { SpawnOptions } from "./types.ts"
import { retainInitialInput } from './initial-input.ts'
import {readOriginalTeamCleanup} from '../team-cleanup.ts'
import type { InitialChildInput } from './generation.ts'

function originalMethod<T extends (...args: any[]) => any>(owner: object | undefined, name: string): T | undefined {
  if (!owner) return undefined
  for (let current: object | null = owner; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor) { if ('value' in descriptor && typeof descriptor.value === 'function') return descriptor.value.bind(owner) as T; break }
  }
  throw new TypeError(`Original child ${name} capability unavailable`)
}

export async function publishChild(
  opts: SpawnOptions, childCtx: PluginContext, childSession: SessionView, factOwner: FactOwner, document: ManagedDocument | undefined,
  sessionId: string | undefined, childPath: string, childReg: ToolRegistry,
  codeModeMount: CodeModeMount | undefined, controller: AbortController, agent: Agent, modelLabel: string | undefined,
  initial?: InitialChildInput,
  selectedModel: () => import('@i-harness/llm-seam').ModelClient = () => opts.parentModel,
  instruction?: import('./instruction-context.ts').ChildInstructionContext,
  retireInstruction?: () => void,
  onEntryPublished?: (entry: ChildAgentEntry) => void,
  assertSetupLive?: () => void,
  original?: { unmount(): void; revokeDocument?(): void; closeDocument?(): Promise<void>; closeInitial?(): Promise<void>; cancelMount?(reason?: string): Promise<void>; disposeMount?(): Promise<void> },
): Promise<{ path: string; jobId: string; sessionId?: string; modelLabel?: string }> {
  const cancelMount = original?.cancelMount ?? originalMethod<(reason?: string) => Promise<void>>(codeModeMount, 'cancel')
  const disposeMount = original?.disposeMount ?? originalMethod<() => Promise<void>>(codeModeMount, 'dispose')
  const revokeDocument = original?.revokeDocument ?? originalMethod<() => void>(document, 'revokeNewWork')
  const closeDocument = original?.closeDocument ?? originalMethod<() => Promise<void>>(document, 'close')
  const closeInitial = original?.closeInitial ?? originalMethod<() => Promise<void>>(initial, 'close')
  const unmountContext = original?.unmount ?? originalMethod<() => void>(childCtx.scope, 'unmount')!
  const inputId = initial?.inputId ?? randomUUID(), admission = initial ? undefined : factOwner.beginAction(controller.signal)
  let initialOutcome:import('@i-harness/core-session').ProducerFactOutcome
  try {
    initialOutcome=initial?.outcome ?? await admission!.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId, text: opts.message, delivery: 'queue', intent: 'user', provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'subagent.initial', ...(opts.childSessions?.parentSessionId ? { originSessionId: opts.childSessions.parentSessionId } : {}) } })
    committedFactSeqs(initialOutcome)
  } finally { admission?.finish() }
  opts.validateBeforeLaunch?.()
  opts.retainPublication?.({kind:'agent',value:agent})
  if (sessionId !== undefined) opts.agents.register(sessionId, agent)
  const { id: jobId } = opts.jobs.registerJob("root", "subagent", opts.taskName, undefined, undefined, opts.childStart?.kind==='committed-child-birth'||opts.childStart?.kind==='committed-team-child-birth'?()=>controller.abort():undefined,
    { agentPath: childPath, ...(sessionId !== undefined ? { sessionId } : {}) },registration=>{bindOriginalSpawnJob(opts.onPublished,registration);opts.retainPublication?.({kind:'job',value:registration})})
  let resultLifetime = true
  let initialClosed = false, initialFlight: Promise<void> | undefined
  const settleInitial = () => {
    if (initialClosed) return Promise.resolve()
    if (initialFlight) return initialFlight
    const pending = Promise.resolve().then(() => closeInitial?.()).then(() => { initialClosed = true })
    initialFlight = pending; void pending.catch(() => { if (initialFlight === pending) initialFlight = undefined }); return pending
  }
  let disposal: Promise<void> | undefined, mountCancelled = false, mountDisposed = false, chainSettled = false, instructionClosed = false, documentClosed = false, contextClosed = false
  const entry: ChildAgentEntry = {
    resultLifetime: () => resultLifetime,
    path: childPath,
    status: "running",
    // W11: the initial run starts HERE — one of the two sites that write
    // `status: "running"` and therefore one of the two that must stamp it (see
    // ChildAgentEntry.startedAt; the other is driveFollowups).
    startedAt: Date.now(),
    session: childSession,
    factOwner,
    executionModel: selectedModel,
    controller,
    mailbox: [],
    jobId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    roleName: opts.role.name,
    toolRegistry: childReg,
    factoryTools: [...(codeModeMount ? ["code_exec", "code_wait"] : []), "get_context_remaining"].flatMap((name) => { const tool = childReg.get(name); return tool ? [tool] : [] }),
    ...(modelLabel !== undefined ? { modelLabel } : {}),
    // Serialization: seed the followup chain with the initial run so a
    // followup_task fired mid-run waits for turn 1 to finish (dsh's
    // queue-then-run semantics) instead of running two runTurns concurrently
    // on the same session. The rejection is swallowed so a failed initial run
    // cannot reject the chain and silently kill all later followups.
    followupChain: undefined,
    unmount: () => unmountContext(),
    ...(codeModeMount ? { cancel: (reason?: string) => cancelMount!(reason) } : {}),
    dispose: () => {
      if (disposal) return disposal
      const teamCleanup=readOriginalTeamCleanup(opts.table,childPath,entry)
      if(teamCleanup)teamCleanup.markClosing();else opts.table.update(childPath, entry, { closing: true })
      let retirementFailure: unknown, retirementFailed = false
      try { retireInstruction?.(); instruction?.retire() } catch (error) { retirementFailure = error; retirementFailed = true }
      revokeDocument?.()
      entry.controller.abort()
      controller.abort()
      const pending = (async () => {
        const failures: unknown[] = retirementFailed ? [retirementFailure] : []
        if (!mountCancelled) try { await cancelMount?.("Subagent closed"); mountCancelled = true } catch (error) { failures.push(error) }
        if (!mountDisposed) try { await disposeMount?.(); mountDisposed = true } catch (error) { failures.push(error) }
        if (!chainSettled) { await entry.followupChain?.catch(() => {}); chainSettled = true }
        if (failures.length) throw new AggregateError(failures, 'Original child producer cleanup incomplete')
        await settleInitial()
        if (!instructionClosed) { await instruction?.close(); instructionClosed = true }
        resultLifetime = false
        if (!documentClosed) { await closeDocument?.(); documentClosed = true }
        if (!contextClosed) { await unmountContext(); contextClosed = true }
      })()
      disposal = pending; void pending.catch(() => { if (disposal === pending) disposal = undefined }); return pending
    },
  }
  retainInitialInput(entry,inputId,initialOutcome)
  const publication=Object.freeze({path:childPath,jobId,sessionId,...(modelLabel!==undefined?{modelLabel}:{})})
  const runGate=Promise.withResolvers<void>()
  // Defer transport until the entry and its retained lifecycle are published.
  const initialRun = runGate.promise.then(() => { controller.signal.throwIfAborted();assertSetupLive?.(); return agent.runAdmitted!(opts.message, controller.signal, undefined, inputId, initial?.generation && initial.delegatedOrigin
    ? { provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'subagent.initial', ...(opts.childSessions?.parentSessionId ? { originSessionId: opts.childSessions.parentSessionId } : {}) }, generation: initial.generation, delegatedOrigin: initial.delegatedOrigin } : undefined) })

  const completion = initialRun.then(
    async (result) => {
      // The turn is done, but the child is KEPT alive (waiting) so a later
      // followup can re-drive the same agent (M9 spec §2.2). A stale error
      // from an earlier interrupted attempt is cleared on success.
      const settled = await opts.onSettled?.({ finalText: result.finalText, aborted: false })
      if(!hasRequiredOriginalSpawn(opts.onPublished))await retainChildResult(opts, entry, { resultText: result.finalText }, "completed", settled)
    },
    async (err) => {
      const aborted = controller.signal.aborted
      // An interrupted turn leaves the child ALIVE (waiting) so followups still work.
      const settled = await opts.onSettled?.({ error: err instanceof Error ? err.message : String(err), aborted })
      const error = opts.results ? (err instanceof Error ? err.message : String(err)) : aborted ? "aborted" : (err instanceof Error ? err.message : String(err))
      if(!hasRequiredOriginalSpawn(opts.onPublished))await retainChildResult(opts, entry, { error }, aborted ? "cancelled" : "error", settled)
    },
  )
  entry.followupChain = completion.finally(settleInitial)
  void entry.followupChain.catch(() => {})
  try {
    opts.retainPublication?.({kind:'run',value:entry.followupChain})
    opts.retainPublication?.({kind:'entry',value:entry})
    bindOriginalSpawnRun(opts.onPublished,entry,initialRun,opts.table)
    opts.validateBeforeLaunch?.()
    if((opts.childStart?.kind==='committed-child-birth'||opts.childStart?.kind==='committed-team-child-birth')&&opts.table.get(childPath))throw Error('Original child publication path occupied')
    opts.table.add(childPath, entry)
    onEntryPublished?.(entry)
    opts.onEntryPublished?.(entry,publication)
    opts.onPublished?.(publication)
    controller.signal.throwIfAborted();assertSetupLive?.();runGate.resolve()
  }catch(cause){runGate.reject(cause);throw cause}

  return { path: childPath, jobId, sessionId, ...(modelLabel !== undefined ? { modelLabel } : {}) }
}

export function warnInheritedSeed(childSession: SessionView, contextWindow: number | undefined): void {
  // Advisory legacy history estimate only. The owned prepared budget measures
  // the complete child request and fails closed if compaction cannot make it fit.
  if (contextWindow !== undefined) {
    const seedTokens = estimateContent(deriveMessages(childSession))
    if (seedTokens >= contextWindow) {
      d.warn(
        `[subagent] the inherited seed has a heuristic history estimate of ${seedTokens} tokens against a ${contextWindow}-token window: ` +
          `the owned budget measures the full prepared request; if compaction/summarisation cannot make an indivisible region fit, ` +
          `the turn fails closed and preserves the inherited history`,
      )
    }
  }
}
