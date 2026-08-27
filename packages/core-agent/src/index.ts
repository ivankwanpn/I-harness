import { createCompactionEngine, type CompactionConfig, type CompactionResult } from "@i-harness/compaction"
import type { PluginContext } from "@i-harness/core-plugin"
import type { Session } from "@i-harness/core-session"
import { append, deriveMessages } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient, LLMRequest } from "@i-harness/llm-seam"
import { assertMessagesFromLog } from "@i-harness/llm-seam"
import { checkBudget } from "@i-harness/token-meter"

export {
  executeToolCalls,
  TOOL_ABORTED_BEFORE_DISPATCH,
  type BatchCall,
  type ExecuteToolCallsOptions,
} from "./execute-tool-calls.ts"
import { executeToolCalls, type BatchCall } from "./execute-tool-calls.ts"

// M20 budget/overflow control (absorb codex token-budget): `contextWindow` is
// the absolute context window; the agent budget is `contextWindow *
// reserveRatio` (default 0.9). Overflow at a step boundary triggers the
// three-layer ladder: layer 1 compact (M11 summary) → layer 2 pure reset
// (compaction.resetWindow, only when enabled) → layer 3 `prompt_too_long`
// fail-closed throw.
export interface AgentBudgetConfig {
  contextWindow: number // REQUIRED: total window the budget is computed against
  reserveRatio?: number // default 0.9; budget = contextWindow * reserveRatio
  resetWindow?: boolean // default true (allow layer 2 pure reset; false → straight to fail-closed)
  resetRetainLast?: number // default 20 (resetWindow keeps the last N events)
}

export interface AgentConfig {
  systemPrompt: string
  maxTurns?: number
  signal?: AbortSignal
  compact?: CompactionConfig // M11: enable context-pressure auto-compaction (requires contextWindow)
  budget?: AgentBudgetConfig // M20: absolute context budget + overflow ladder (requires contextWindow)
  maxParallelToolCalls?: number // M13: bound on concurrent tool bodies per step (default 10; 1 = serial)
  // NOTE: `model?: string` from the task brief collides with `AgentDeps.model`
  // (the ModelClient) under `AgentDeps & AgentConfig`, so the string selector
  // is dropped for M1 — the ModelClient IS the model configuration and the
  // `model` field of `LLMRequest` is not populated by the loop.
}

export interface AgentDeps {
  session: Session
  tools: ToolRegistry
  model: ModelClient
  // M19 (Ruling 24): the executing session's id, seeded onto every prepared
  // ToolExec so tool bodies can attribute the caller (agent-team resolves
  // team-tool callers from it). Additive: absent → ToolExec.sessionId stays
  // undefined (pre-M19 behavior).
  sessionId?: string
}

export interface AgentResult {
  finalText: string
  turns: number
  reasoning: string[]
}

export interface Agent {
  run(task: string, signal?: AbortSignal): Promise<AgentResult>
  followup(message: string, signal?: AbortSignal): Promise<AgentResult>
  // M11: explicit manual compaction. Optional because a registry may hold
  // agents that were never configured with a compact seam (no engine). With no
  // compact config, `createAgent` still returns a `compact` that no-ops.
  compact?(): Promise<CompactionResult>
}

export function createAgent(ctx: PluginContext, deps: AgentDeps & AgentConfig): Agent {
  const maxTurns = deps.maxTurns ?? 20
  const maxParallel = deps.maxParallelToolCalls ?? 10
  if (!Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error(`maxParallelToolCalls must be a positive integer (got ${maxParallel})`)
  }
  // M11: optional compaction seam. No `compact` config → no engine → the agent
  // behaves byte-identically to before this milestone.
  const compactor = deps.compact ? createCompactionEngine({ model: deps.model, config: deps.compact }) : undefined
  const compactEnabled = deps.compact?.auto ?? true
  // M20: budget ladder config. `resetRetainLast` is enforced at call time
  // (resetWindow validation); the default here matches the engine convention.
  const budgetCfg = deps.budget
  const resetAllowed = budgetCfg?.resetWindow ?? true
  const resetRetainLast = budgetCfg?.resetRetainLast ?? 20

  // M20: absolute-budget enforcement, called at every step boundary after
  // maybeCompact (pressure check) and before the model sees the derived
  // surface. Three layers:
  //  1. M11 compact (shadow-projection + summary) — fail-soft, never throws,
  //     falls through to layer 2 when compacted:false or still overflow.
  //  2. pure reset (absorption of codex token-budget) — ONLY when enabled
  //     (`budget.resetWindow !== false`); keeps the last resetRetainLast
  //     events visible, no summary. Fix round 1 (Ruling 4): append-only —
  //     the durable log is never truncated; checkBudget sees the post-reset
  //     surface because activeTokens prices exactly deriveMessages, which
  //     shadows the reset marker's removedSeqs (M11 shadow mechanism).
  //  3. fail-closed: throw `prompt_too_long` — the session cannot be brought
  //     under budget. No budget config → no-op (pre-M20 behavior).
  async function enforceBudget(): Promise<void> {
    if (budgetCfg === undefined) return
    const before = checkBudget(deps.session, budgetCfg.contextWindow, budgetCfg.reserveRatio)
    if (before.state === "ok") return
    // Layer 1: M11 compact (shadow-projection + summary).
    if (compactor) {
      await compactor.compact(deps.session)
      if (checkBudget(deps.session, budgetCfg.contextWindow, budgetCfg.reserveRatio).state === "ok") return
    }
    // Layer 2: pure reset (absorb codex token-budget) — keep the recent tail.
    if (compactor && resetAllowed) {
      await compactor.resetWindow(deps.session, resetRetainLast)
      if (checkBudget(deps.session, budgetCfg.contextWindow, budgetCfg.reserveRatio).state === "ok") return
    }
    // Layer 3: fail-closed.
    throw new Error(`prompt_too_long: context budget exceeded (${before.tokens} tokens > ${before.budget} budget)`)
  }
  // `steps`/`callSeq`/`reasoning` are shared across the agent's lifetime so a
  // followup continues the same step budget, call-id sequence and reasoning
  // trail as the original run.
  let steps = 0
  let callSeq = 0
  const reasoning: string[] = []

  async function runTurn(message: string, signal?: AbortSignal): Promise<AgentResult> {
    const abort = signal ?? deps.signal
    append(deps.session, { type: "turn/start" })
    append(deps.session, { type: "user/message", text: message })

    let needsContinuation = true
    while (needsContinuation) {
      if (abort?.aborted) throw new Error("agent aborted")
      steps += 1
      // Guard against an infinite tool-call loop: throw once steps exceed
      // the configured maximum (default 20).
      if (steps > maxTurns) throw new Error(`maxTurns exceeded: ${maxTurns}`)
      append(deps.session, { type: "step/start" })

      // M11 compaction: pressure check at the step boundary, before the model sees
      // the derived surface. Compaction only ever runs between steps.
      if (compactor && compactEnabled) await compactor.maybeCompact(deps.session)

      // M20 budget enforcement: absolute-budget check (compact→reset→fail-closed)
      // at the same boundary, after the pressure check and before the model sees
      // the surface.
      await enforceBudget()

      await ctx.emit("agent/pre-step", { task: message, session: deps.session })

      const messages = deriveMessages(deps.session)
      // Invariant at the seam (audit F01-3): the model may only ever see
      // messages that come from the session log. This passes trivially here
      // because the loop derives-and-rechecks from the log, but it is the
      // discipline point that keeps external producers honest.
      assertMessagesFromLog(messages, deps.session)

      const request: LLMRequest = {
        messages,
        tools: deps.tools.schemas(),
        systemPrompt: deps.systemPrompt,
      }

      let stepText = ""
      let toolCallsThisStep = 0
      const batch: BatchCall[] = []
      for await (const ev of deps.model.stream(request)) {
        if (abort?.aborted) throw new Error("agent aborted")
        switch (ev.type) {
          case "text/chunk":
            stepText += ev.text
            break
          case "reasoning":
            reasoning.push(ev.text)
            break
          case "tool_call": {
            callSeq += 1
            const callId = `call_${callSeq}`
            append(deps.session, { type: "tool/call", callId, name: ev.call.name, args: ev.call.args })
            // M13: collect the call; execution happens after the stream ends so
            // the step's tool calls can run concurrently (bounded pool).
            batch.push({ callId, name: ev.call.name, args: ev.call.args })
            toolCallsThisStep += 1
            break
          }
          case "error":
            throw new Error(`model stream error: ${ev.error.message}`)
          case "end":
            break
        }
      }

      if (batch.length > 0) {
        // M13: concurrent execution. The scheduler appends tool/result in model
        // order and emits agent/post-tool from its commit lane; it throws
        // "agent aborted" on step abort (draining + synthesizing results for
        // never-started calls) and rethrows the first tool failure.
        await executeToolCalls(ctx, deps.session, deps.tools, batch, { maxParallel, signal: abort, sessionId: deps.sessionId })
      }

      if (stepText) append(deps.session, { type: "assistant/message", text: stepText })
      else if (toolCallsThisStep === 0) append(deps.session, { type: "assistant/message", text: "" })

      append(deps.session, { type: "step/end" })

      // Continuation: after a step with tool calls, run another step so the
      // model can produce its final message. A step without tool calls is a
      // final answer → loop ends (per-turn mock semantics).
      needsContinuation = toolCallsThisStep > 0
    }

    append(deps.session, { type: "turn/end" })
    // M14: content may be a parts array (image-bearing); extract text parts
    // only. The final message is an assistant text message, but be robust.
    const last = deriveMessages(deps.session).at(-1)
    const finalText = typeof last?.content === "string"
      ? last.content
      : Array.isArray(last?.content)
        ? last.content.filter((p) => p.type === "text").map((p) => p.text).join("")
        : ""
    return { finalText, turns: steps, reasoning }
  }

  return {
    run: (task, signal) => runTurn(task, signal),
    followup: (message, signal) => runTurn(message, signal),
    compact: async () => (compactor ? compactor.compact(deps.session) : { compacted: false, shadowedSeqs: [] }),
  }
}

export interface AgentRegistry {
  register(sessionId: string, agent: Agent): void
  get(sessionId: string): Agent | undefined
  remove(sessionId: string): void
  entries(): Map<string, Agent>
}

export function createAgentRegistry(): AgentRegistry {
  const agents = new Map<string, Agent>()
  return {
    register: (sessionId, agent) => {
      agents.set(sessionId, agent)
    },
    get: (sessionId) => agents.get(sessionId),
    remove: (sessionId) => {
      agents.delete(sessionId)
    },
    entries: () => agents,
  }
}
