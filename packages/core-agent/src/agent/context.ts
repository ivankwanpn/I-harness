import { createCompactionEngine, type CompactionConfig } from "@i-harness/compaction"
import { deriveMessages, deriveProjectionRewrite } from "@i-harness/core-session"
import { checkBudget, createContextMeter } from "@i-harness/token-meter"
import { mapModelRequest } from "@i-harness/llm-seam"
import type { AgentBudgetConfig, AgentDeps, AgentConfig, Agent } from "./types.ts"

function validateBudget(budget: AgentBudgetConfig | undefined): void {
  if (budget !== undefined) {
    const { contextWindow, resetRetainLast, overheadTokens, reserveRatio } = budget
    if (!(Number.isFinite(contextWindow) && contextWindow > 0)) {
      throw new Error(`budget.contextWindow must be a finite positive number (got ${contextWindow})`)
    }
    if (reserveRatio !== undefined && !(reserveRatio > 0 && reserveRatio <= 1)) throw new Error(`reserveRatio must be in (0, 1] (got ${reserveRatio})`)
    if (resetRetainLast !== undefined && (!Number.isInteger(resetRetainLast) || resetRetainLast < 0)) {
      throw new Error(`budget.resetRetainLast must be a non-negative integer (got ${resetRetainLast})`)
    }
    // M33 §3.1: fail loud at creation like resetRetainLast — a NaN/negative
    // overhead would silently poison every comparison downstream.
    if (overheadTokens !== undefined && (!Number.isInteger(overheadTokens) || overheadTokens < 0)) {
      throw new Error(`budget.overheadTokens must be a non-negative integer (got ${overheadTokens})`)
    }
  }
}

export function createAgentContext(deps: AgentDeps & AgentConfig) {
  validateBudget(deps.budget)
  const contextMeter = createContextMeter()
  const projectionRevision = (): number => deriveProjectionRewrite(deps.session).markers
    + deps.session.events.filter(event => event.type === "compaction/prune").length
  const currentShape = () => ({
    systemPrompt: typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt,
    tools: deps.modelToolSchemas?.() ?? deps.tools.schemas(),
    reasoningEffort: deps.reasoningEffort,
  })
  const contextEstimate = (overhead = 0) => contextMeter.estimate({ ...currentShape(), messages: deriveMessages(deps.session) }, overhead, projectionRevision())
  // M11: optional compaction seam. No `compact` config → no engine → the agent
  // behaves byte-identically to before this milestone.
  // M5/D2: the agent is the only layer that knows the shape the model sees, so
  // it hands the engine a getter — read at compact time, matching the LAST
  // request rather than whatever was true at construction. Without this the
  // summarizer falls back to its text form and the whole conversation is re-read
  // at full price; with it, the call is a byte-prefix of the main request and the
  // provider's cache serves it.
  function buildCompactor(compact: CompactionConfig | undefined, cap: number | undefined) {
    return compact
    ? createCompactionEngine({
        model: deps.sessionId === undefined ? deps.model : mapModelRequest(deps.model, request => ({ ...request, sessionId: request.sessionId ?? deps.sessionId })),
        config: compact,
        ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
        // M73: compaction builds and sends its OWN model request, so it never
        // met the clamp the session's requests go through — on an anthropic
        // route that left the adapter's 128k fallback unclamped on the call
        // that runs BECAUSE the context is nearly full. The resolved cap is
        // handed down here; the engine clamps it against the window it
        // resolved (compaction's own `contextWindow`, above).
        ...(cap !== undefined ? { maxOutputTokens: cap } : {}),
        ...(deps.modelOverheadTokens ? { overheadTokens: deps.modelOverheadTokens } : {}),
        contextTokens: () => contextEstimate(deps.modelOverheadTokens?.() ?? compact.overheadTokens ?? 0).tokens,
        requestShape: () => ({
          systemPrompt: typeof deps.systemPrompt === "function" ? deps.systemPrompt() : deps.systemPrompt,
          tools: deps.modelToolSchemas?.() ?? deps.tools.schemas(),
        }),
      })
    : undefined
  }
  let compactor = buildCompactor(deps.compact, deps.maxOutputTokens)
  let outputCap = deps.maxOutputTokens
  let compactEnabled = deps.compact?.auto ?? true
  // M20: budget ladder config (`contextWindow`/`resetRetainLast` are validated
  // at creation above); the default matches the engine convention.
  let budgetCfg = deps.budget

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
    const resetAllowed = budgetCfg.resetWindow ?? true
    const resetRetainLast = budgetCfg.resetRetainLast ?? 20
    // M33 §3.1: the host-known charge the session log does not carry (system
    // prompt + tool schemas) is added to EVERY boundary measurement.
    const overhead = deps.modelOverheadTokens?.() ?? budgetCfg.overheadTokens ?? 0
    if (!Number.isInteger(overhead) || overhead < 0) throw new Error("model overhead must be a non-negative integer")
    const check = () => checkBudget(deps.session, budgetCfg!.contextWindow, budgetCfg!.reserveRatio, overhead, contextEstimate(overhead).tokens)
    const before = check()
    if (before.state === "ok") return
    // Layer 1: M11 compact (shadow-projection + summary).
    if (compactor) {
      await compactor.compact(deps.session)
      if (check().state === "ok") return
    }
    // Layer 2: pure reset (absorb codex token-budget) — keep the recent tail.
    if (compactor && resetAllowed) {
      await compactor.resetWindow(deps.session, resetRetainLast)
      if (check().state === "ok") return
    }
    // Layer 3: fail-closed.
    throw new Error(`prompt_too_long: context budget exceeded (${before.tokens} tokens > ${before.budget} budget)`)
  }

  return {
    contextMeter, projectionRevision, contextEstimate, enforceBudget,
    get compactor() { return compactor },
    get compactEnabled() { return compactEnabled },
    get budgetCfg() { return budgetCfg },
    get outputCap() { return outputCap },
    update(config: Parameters<NonNullable<Agent["updateContext"]>>[0]) {
      validateBudget(config.budget)
      contextMeter.invalidate()
      if (config.maxOutputTokens !== undefined && (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 1)) throw new Error("invalid output cap")
      const next = buildCompactor(config.compact, config.maxOutputTokens)
      compactor = next
      budgetCfg = config.budget
      outputCap = config.maxOutputTokens
      compactEnabled = config.compact?.auto ?? true
    },
  }
}
export type AgentContext = ReturnType<typeof createAgentContext>
