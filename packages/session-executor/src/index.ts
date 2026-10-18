export {
  createSessionAssembly,
  ModelUnavailableError,
  type AssemblyOptions,
  type ModelPolicy,
  type SessionAssembly,
  type SessionProjectContext,
} from "./assembly.ts"
export { createDurableSessionLoader } from "./durable-session.ts"
export { openExecutorDocument } from './lifecycle/managed-document.ts'
export { createTitleGenerationContext } from './lifecycle/title-generation.ts'
export { actionMetadataFacts } from './lifecycle/action-facts.ts'
export { withRewindFacts } from './lifecycle/rewind-facts.ts'
export {
  createSessionService,
  type SessionModelBindingResult,
  type SessionQueueItem,
  type SessionService,
  type SessionServiceOptions,
} from "./service.ts"
// M49 Task 12: the task projection's summary row type (the @i-harness/subagent
// shape re-exported — the SDK/TUI wire surfaces mirror it structurally).
export type { AgentTaskStatus, AgentTaskView } from "@i-harness/subagent"
// M32 G1 (TEMPORARY): local type re-export — see the declaration in
// @i-harness/core-agent (group-2 reconciles with llm-seam's ReasoningEffort at
// the T2 merge).
export type { ReasoningEffort } from "@i-harness/core-agent"

export { openLiteralInputExecution } from './lifecycle/literal-input.ts'
