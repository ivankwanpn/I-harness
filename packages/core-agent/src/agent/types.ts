import type { CompactionConfig, CompactionResult } from "@i-harness/compaction"
import type { ImageInput, Session } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient, ToolSchema, ReasoningEffort } from "@i-harness/llm-seam"
import type { Telemetry } from "@i-harness/telemetry"

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
  // M33 §3.1: the host-known charge the session log does NOT carry (system
  // prompt + tool schemas) — added to the checkBudget measurement at every
  // boundary. 0 (default) = pre-M33 measurement.
  overheadTokens?: number
}

export interface AgentConfig {
  /** Prompt for every request. A STRING is fixed for the session. A FUNCTION is
   * resolved at the start of each step, for prompts that carry a fact the
   * session can change while the agent runs (the sandbox policy: see
   * session-executor/src/assembly.ts). */
  systemPrompt: string | (() => string)
  maxTurns?: number
  signal?: AbortSignal
  compact?: CompactionConfig // M11: enable context-pressure auto-compaction (requires contextWindow)
  /** Optional live host preference, read at each step; manual compaction is unaffected. */
  autoCompactionEnabled?: () => boolean
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
  /** Optional inference exposure; executable registry authority stays intact. */
  modelToolSchemas?: () => ToolSchema[]
  /** Live price of the same system/tool surface used by modelToolSchemas. */
  modelOverheadTokens?: () => number
  // M19 (Ruling 24): the executing session's id, seeded onto every prepared
  // ToolExec so tool bodies can attribute the caller (agent-team resolves
  // team-tool callers from it). Additive: absent → ToolExec.sessionId stays
  // undefined (pre-M19 behavior).
  sessionId?: string
  /** Explicit child origin; independent of inherited clients or role names. */
  isSubagent?: boolean
  // M25 (Ruling M25-P3): optional independent host telemetry stream — SEPARATE
  // from the session log (events here are never appended to it; the agent and
  // its tools cannot see them). Absent = no events at all (backward compat:
  // every pre-M25 deps object behaves byte-identically).
  telemetry?: Telemetry
  // M70: optional checkpoint capability handed to the tool scheduler — see
  // `ExecuteToolCallsOptions.flush`. The host builds it over its coordinator
  // (`() => coordinator.flush(sessionId)`), so the `tool/dispatch` marker is
  // durable BEFORE the tool body runs; a rejected flush fails the turn closed.
  // Absent → no checkpoint, byte-identical pre-M70 behavior (every existing
  // deps object, subagent hosts included).
  flush?: () => Promise<void>
  // R-A1: optional step-boundary input seam (steer tier). The loop calls it at
  // the START of every step (including the first) so mid-turn steering lands in
  // the log before the model sees this step's messages. The seam itself appends
  // the promoted user/messages to the session (inbox.claimAtStepBoundary).
  // Absent → byte-identical pre-R-A1 behavior.
  stepInputs?: { claimAtStepBoundary(): void }
  // M32 T3: per-session reasoning effort — copied VERBATIM onto every
  // LLMRequest of this agent (the adapter owns the wire translation; see
  // translateReasoning in the llm-* adapters). Absent → the request never
  // carries the field (缺省不發 — the provider's own default applies).
  reasoningEffort?: ReasoningEffort
  /** M72 Ⅱ: the resolved output cap for this session's model (undefined → the
   * adapter sends none). Read at request assembly, clamped there. */
  maxOutputTokens?: number
}

// M32: canonical ReasoningEffort lives in @i-harness/llm-seam (T2) — import
// for local use and re-export (G1 TEMPORARY declaration reconciled at merge).
export type { ReasoningEffort }

export interface AgentResult {
  finalText: string
  turns: number
  reasoning: string[]
}

export interface Agent {
  run(task: string, signal?: AbortSignal, images?: ImageInput[], inputId?: string): Promise<AgentResult>
  followup(message: string, signal?: AbortSignal): Promise<AgentResult>
  // M11: explicit manual compaction. Optional because a registry may hold
  // agents that were never configured with a compact seam (no engine). With no
  // compact config, `createAgent` still returns a `compact` that no-ops.
  // M33 §5: optional `instructions` are threaded to the summarizer (the
  // session-compact command surface).
  compact?(instructions?: string): Promise<CompactionResult>
  updateContext?(config: { budget?: AgentBudgetConfig; compact?: CompactionConfig; maxOutputTokens?: number }): void
}

export interface AgentRegistry {
  register(sessionId: string, agent: Agent): void
  get(sessionId: string): Agent | undefined
  remove(sessionId: string): void
  entries(): Map<string, Agent>
}


export type TurnLifecycle = { turnOpen: boolean; stepOpen: boolean; providerCompleted: boolean; stepFailed: boolean }
