import type { CompactionConfig, CompactionResult, CompactionRunOptions } from "@i-harness/compaction"
import type { ImageInput, SessionView as Session, BudgetRead, ContextBindingMetadata, InputProvenance, FactOwner, FactPorts, ProducerFactOutcome, SettlementFacts } from "@i-harness/core-session"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient, ToolSchema, ReasoningEffort } from "@i-harness/llm-seam"
import type { Telemetry } from "@i-harness/telemetry"

// Prepared admission reserves output and headroom under the owned model window.
// Legacy reset fields remain source compatible; admission does not blindly cut history.
export interface AgentBudgetConfig {
  contextWindow: number // REQUIRED: total window the budget is computed against
  reserveRatio?: number // default 0.9; budget = contextWindow * reserveRatio
  resetWindow?: boolean // legacy compatibility only; owned admission preserves history
  resetRetainLast?: number // legacy compatibility only; no automatic tail reset
  /** Legacy estimate compatibility. Actual prepared system/schema components
   * are counted directly and never charged again as an arbitrary overhead. */
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
  factOwner?: FactOwner
  facts?: FactPorts<ProducerFactOutcome>
  sourceFacts?: SettlementFacts<ProducerFactOutcome>
  assertFactOpen?: () => void
  registerFactSource?: (drain: () => Promise<void>) => SettlementFacts<ProducerFactOutcome>
  ensureWritableContext?: () => Promise<void>
  executionIdentity?: () => import("@i-harness/llm-seam").LiveExecutionIdentity | undefined
  /** Pure inherited host descriptor. Each Agent copies its own limits and calibration. */
  bindingForStep?: () => ModelContextBindingDescriptor
  /** Current concrete binding behind a stable host handle. Read only, never resolves a client. */
  modelBindingIdentity?: () => object
  budgetBinding?: import("@i-harness/llm-seam").ModelBudgetBinding | (() => import("@i-harness/llm-seam").ModelBudgetBinding | undefined)
  contextMetadata?: ContextBindingMetadata | (() => ContextBindingMetadata | undefined)
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
  stepInputs?: { claimAtStepBoundary(facts?: import('@i-harness/core-session').InputFacts<ProducerFactOutcome>): void | Promise<void> }
  // M32 T3: per-session reasoning effort — copied VERBATIM onto every
  // LLMRequest of this agent (the adapter owns the wire translation; see
  // translateReasoning in the llm-* adapters). Absent → the request never
  // carries the field (缺省不發 — the provider's own default applies).
  reasoningEffort?: ReasoningEffort
  /** M72 Ⅱ: the resolved output cap for this session's model (undefined → the
   * adapter sends none). Read at request assembly, clamped there. */
  maxOutputTokens?: number
}

export interface ModelContextBindingDescriptor {
  executionIdentity?: import("@i-harness/llm-seam").LiveExecutionIdentity
  identity: object
  budgetBinding?: import("@i-harness/llm-seam").ModelBudgetBinding
  contextMetadata?: ContextBindingMetadata
  contextWindow?: number
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
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
  runAdmitted?: Agent['run']
  contextBudget?(): BudgetRead
  run(task: string, signal?: AbortSignal, images?: ImageInput[], inputId?: string, options?: AgentInputOptions): Promise<AgentResult>
  followup(message: string, signal?: AbortSignal, options?: AgentInputOptions): Promise<AgentResult>
  // M11: explicit manual compaction. Optional because a registry may hold
  // agents that were never configured with a compact seam (no engine). With no
  // compact config, `createAgent` still returns a `compact` that no-ops.
  // M33 §5: optional `instructions` are threaded to the summarizer (the
  // session-compact command surface).
  compact?(instructions?: string, options?: CompactionRunOptions): Promise<CompactionResult>
  updateContext?(config: { budget?: AgentBudgetConfig; compact?: CompactionConfig; maxOutputTokens?: number; contextMetadata?: ContextBindingMetadata; budgetBinding?: import("@i-harness/llm-seam").ModelBudgetBinding }): void
}
export interface AgentInputOptions { provenance: InputProvenance }

export interface AgentRegistry {
  register(sessionId: string, agent: Agent): void
  get(sessionId: string): Agent | undefined
  remove(sessionId: string): void
  entries(): Map<string, Agent>
}


export type TurnLifecycle = {
  turnOpen: boolean; stepOpen: boolean; providerCompleted: boolean; stepFailed: boolean
  stepEnd?: Promise<void>; stepFailure?: Promise<void>; turnEnd?: Promise<void>
}
