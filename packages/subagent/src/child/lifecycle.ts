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

export async function publishChild(
  opts: SpawnOptions, childCtx: PluginContext, childSession: SessionView, factOwner: FactOwner, document: ManagedDocument | undefined,
  sessionId: string | undefined, childPath: string, childReg: ToolRegistry,
  codeModeMount: CodeModeMount | undefined, controller: AbortController, agent: Agent, modelLabel: string | undefined,
): Promise<{ path: string; jobId: string; sessionId?: string; modelLabel?: string }> {
  const inputId = randomUUID(), admission = factOwner.beginAction(controller.signal)
  let initialOutcome:import('@i-harness/core-session').ProducerFactOutcome
  try {
    initialOutcome=await admission.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId, text: opts.message, delivery: 'queue', intent: 'user', provenance: { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'subagent.initial', ...(opts.childSessions?.parentSessionId ? { originSessionId: opts.childSessions.parentSessionId } : {}) } })
    committedFactSeqs(initialOutcome)
  } finally { admission.finish() }
  opts.validateBeforeLaunch?.()
  if (sessionId !== undefined) opts.agents.register(sessionId, agent)
  const { id: jobId } = opts.jobs.registerJob("root", "subagent", opts.taskName, undefined, undefined, undefined,
    { agentPath: childPath, ...(sessionId !== undefined ? { sessionId } : {}) })
  const entry: ChildAgentEntry = {
    path: childPath,
    status: "running",
    // W11: the initial run starts HERE — one of the two sites that write
    // `status: "running"` and therefore one of the two that must stamp it (see
    // ChildAgentEntry.startedAt; the other is driveFollowups).
    startedAt: Date.now(),
    session: childSession,
    factOwner,
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
    unmount: () => childCtx.scope.unmount(),
    ...(codeModeMount ? { cancel: (reason?: string) => codeModeMount.cancel(reason) } : {}),
    dispose: async () => {
      opts.table.update(childPath, entry, { closing: true })
      document?.revokeNewWork()
      entry.controller.abort()
      controller.abort()
      await codeModeMount?.cancel("Subagent closed")
      await codeModeMount?.dispose()
      await entry.followupChain?.catch(() => {})
      await document?.close()
      await childCtx.scope.unmount()
    },
  }
  retainInitialInput(entry,inputId,initialOutcome)
  opts.table.add(childPath, entry)
  opts.onPublished?.({ path: childPath, jobId, sessionId, ...(modelLabel !== undefined ? { modelLabel } : {}) })
  // Defer transport until the entry and its retained lifecycle are published.
  const initialRun = Promise.resolve().then(() => agent.runAdmitted!(opts.message, controller.signal, undefined, inputId))

  const completion = initialRun.then(
    async (result) => {
      // The turn is done, but the child is KEPT alive (waiting) so a later
      // followup can re-drive the same agent (M9 spec §2.2). A stale error
      // from an earlier interrupted attempt is cleared on success.
      opts.table.update(childPath, entry, { status: "waiting", error: undefined, finalText: result.finalText })
      opts.jobs.updateJob(jobId, { status: "completed", output: result.finalText })
      await opts.onSettled?.({ finalText: result.finalText, aborted: false })
    },
    async (err) => {
      const aborted = controller.signal.aborted
      // An interrupted turn leaves the child ALIVE (waiting) so followups still work.
      opts.table.update(childPath, entry, { status: "waiting", error: aborted ? "aborted" : (err instanceof Error ? err.message : String(err)) })
      opts.jobs.updateJob(jobId, { status: aborted ? "killed" : "error", output: aborted ? "aborted" : (err instanceof Error ? err.message : String(err)) })
      await opts.onSettled?.({ error: err instanceof Error ? err.message : String(err), aborted })
    },
  )
  entry.followupChain = completion
  void completion.catch(() => {})

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
