import type { PluginContext } from "@i-harness/core-plugin"
import { deriveMessages, type createSession } from "@i-harness/core-session"
import { estimateContent } from "@i-harness/token-meter"
import { d } from "./diagnostics.ts"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { Agent } from "@i-harness/core-agent"
import type { CodeModeMount } from "@i-harness/code-mode"
import type { ChildAgentEntry } from "../agent-table.ts"
import type { SpawnOptions } from "./types.ts"

export function publishChild(
  opts: SpawnOptions, childCtx: PluginContext, childSession: ReturnType<typeof createSession>,
  sessionId: string | undefined, childPath: string, childReg: ToolRegistry,
  codeModeMount: CodeModeMount | undefined, controller: AbortController, agent: Agent, modelLabel: string | undefined,
): { path: string; jobId: string; sessionId?: string; modelLabel?: string } {
  if (sessionId !== undefined) opts.agents.register(sessionId, agent)
  const { id: jobId } = opts.jobs.registerJob("root", "subagent", opts.taskName, undefined, undefined, undefined,
    { agentPath: childPath, ...(sessionId !== undefined ? { sessionId } : {}) })
  const initialRun = agent.run(opts.message, controller.signal)
  const entry: ChildAgentEntry = {
    path: childPath,
    status: "running",
    // W11: the initial run starts HERE — one of the two sites that write
    // `status: "running"` and therefore one of the two that must stamp it (see
    // ChildAgentEntry.startedAt; the other is driveFollowups).
    startedAt: Date.now(),
    session: childSession,
    controller,
    mailbox: [],
    jobId,
    ...(sessionId !== undefined ? { sessionId } : {}),
    roleName: opts.role.name,
    toolRegistry: childReg,
    factoryTools: codeModeMount ? ["code_exec", "code_wait"].flatMap((name) => { const tool = childReg.get(name); return tool ? [tool] : [] }) : [],
    ...(modelLabel !== undefined ? { modelLabel } : {}),
    // Serialization: seed the followup chain with the initial run so a
    // followup_task fired mid-run waits for turn 1 to finish (dsh's
    // queue-then-run semantics) instead of running two runTurns concurrently
    // on the same session. The rejection is swallowed so a failed initial run
    // cannot reject the chain and silently kill all later followups.
    followupChain: initialRun.then(() => {}, () => {}),
    unmount: () => childCtx.scope.unmount(),
    ...(codeModeMount ? { cancel: (reason?: string) => codeModeMount.cancel(reason) } : {}),
    dispose: async () => {
      opts.table.update(childPath, entry, { closing: true })
      entry.controller.abort()
      controller.abort()
      await codeModeMount?.cancel("Subagent closed")
      await codeModeMount?.dispose()
      await entry.followupChain?.catch(() => {})
      await childCtx.scope.unmount()
    },
  }
  opts.table.add(childPath, entry)

  initialRun.then(
    (result) => {
      // The turn is done, but the child is KEPT alive (waiting) so a later
      // followup can re-drive the same agent (M9 spec §2.2). A stale error
      // from an earlier interrupted attempt is cleared on success.
      opts.table.update(childPath, entry, { status: "waiting", error: undefined, finalText: result.finalText })
      opts.jobs.updateJob(jobId, { status: "completed", output: result.finalText })
      opts.onSettled?.({ finalText: result.finalText, aborted: false })
    },
    (err) => {
      const aborted = controller.signal.aborted
      // An interrupted turn leaves the child ALIVE (waiting) so followups still work.
      opts.table.update(childPath, entry, { status: "waiting", error: aborted ? "aborted" : (err instanceof Error ? err.message : String(err)) })
      opts.jobs.updateJob(jobId, { status: aborted ? "killed" : "error", output: aborted ? "aborted" : (err instanceof Error ? err.message : String(err)) })
      opts.onSettled?.({ error: err instanceof Error ? err.message : String(err), aborted })
    },
  )

  return { path: childPath, jobId, sessionId, ...(modelLabel !== undefined ? { modelLabel } : {}) }
}

export function warnInheritedSeed(childSession: ReturnType<typeof createSession>, contextWindow: number | undefined): void {
  // M76 (design §1.3): a seed that already fills the window is VISIBLE, and
  // that is all this is. The seed is not trimmed and a spawn is not refused for
  // being oversized, both by ruling, not by omission: a divisible over-window
  // seed is exactly what the child's own compactor summarises (M75's chained
  // pieces), so trimming would silently discard what a summary keeps — strictly
  // worse, and invisible to the child and to the user alike — while refusing
  // would close the feature's primary use case, a child spawned FROM a large
  // session. What the reader cannot see today is the WASTE and the RISK: the
  // child's first request cannot be built without a summarising pass, and an
  // inherited context that is one indivisible block makes that pass fail soft.
  // After that the ladder's reset is the whole rescue — it drops the context,
  // and only when the log has events beyond the retained tail: with nothing
  // removable it returns `reset: false` (`compaction/src/index.ts:361`) and the
  // ladder fails closed instead. The M74 strict case's six tail turns are that
  // condition (its measured outcome); design §4.4's residual — the indivisible
  // block the chunker cannot split, whose real fix is a cap at the block's
  // SOURCE — is the half this warn can only make visible.
  //
  // The condition is measured, not guessed: `childSession` holds nothing but
  // the seed here (the agent does not exist yet), so this is the seed's own
  // projection priced with `estimateContent(deriveMessages(...))` — the meter's
  // own `activeTokens` expression, the one the engine prices with too. No
  // window → nothing to compare → no line (absent stays absent, the M73 rule
  // above).
  //
  // The BOUNDARY is deliberately NOT the engine's, and the difference is the
  // point. The child's compactor fires at the pressure gate
  // `activeTokens + overheadTokens >= window × thresholdRatio` — 0.8 by default
  // (`compaction/src/index.ts:230`, `compaction/src/config.ts:106`; the child
  // never overrides it — no `thresholdRatio` is passed anywhere in this
  // package) — and the hard budget is `window × reserveRatio` = 0.9
  // (`token-meter/src/budget.ts:14`). This line compares the seed's own
  // projection against the FULL window, so it is strictly NARROWER than either:
  // the band `[0.8·window − overhead, window)` is silent here — a known,
  // deliberate narrowing, not an oversight. MOST of that band is the healthy
  // case: the summariser's single request still fits the window (roughly
  // `seed + directive + overhead < window` — with the M75 case's measured
  // 449-token directive and this role's 256-token overhead, the seed has to
  // stay under `window − 705`). The band's TOP SLIVER does not fit — the
  // summariser's own request is over the window there, which is what M75's
  // chained pieces are for — and at small windows the WHOLE band is at or above
  // that fit bound, because the band's floor `0.8·window − overhead` overtakes
  // the fit bound `window − directive − overhead` below `window = 5 × directive`
  // (the overhead cancels; at this file's 2 000-token test window it is 1 344
  // against 1 295). None of that moves the line, whose subject is the HARD
  // bound — the seed ALONE crossing the window, where the piece path becomes
  // necessary and where an indivisible seed has nothing left but the reset
  // (with a tail beyond it — the M74 strict case) or the fail-closed throw
  // (without one — this file's own warn fixture).
  if (contextWindow !== undefined) {
    const seedTokens = estimateContent(deriveMessages(childSession))
    if (seedTokens >= contextWindow) {
      d.warn(
        `[subagent] the inherited seed prices at ${seedTokens} tokens against a ${contextWindow}-token window: ` +
          `the child summarises its inherited context in pieces before its first request, and if that context ` +
          `is one indivisible block the summariser fails soft — the reset then rescues the turn by dropping it ` +
          `when the log has events beyond the retained tail, and the turn fails closed when it does not`,
      )
    }
  }
}
