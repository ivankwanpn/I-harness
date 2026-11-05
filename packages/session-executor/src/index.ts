export {
  createSessionAssembly,
  ModelUnavailableError,
  type AssemblyOptions,
  type ModelPolicy,
  type SessionAssembly,
  type SessionProjectContext,
} from "./assembly.ts"
export { createDurableSessionLoader } from "./durable-session.ts"
export { createUnmanagedTaskChildHost } from './lifecycle/task-child-host.ts'
export type { InstructionReport, InstructionPublication } from './context/instructions/diagnostics.ts'
export { openExecutorDocument } from './lifecycle/managed-document.ts'
export { createTitleGenerationContext } from './lifecycle/title-generation.ts'
export { actionMetadataFacts } from './lifecycle/action-facts.ts'
export { withRewindFacts } from './lifecycle/rewind-facts.ts'
export { createRewindIntentLog, readPendingRewindIntents } from './lifecycle/rewind-intent.ts'
export type { RewindIntentHooks, PendingRewindIntent, RewindIntentV1 } from './lifecycle/rewind-intent.ts'
export {
  createSessionService,
  type SessionModelBindingResult,
  type SessionQueueItem,
  type SessionService,
  type SessionServiceOptions,
  type ManagedRuntimePublication,
  type ManagedRuntimeLifecycle,
} from "./service.ts"
// M49 Task 12: the task projection's summary row type (the @i-harness/subagent
// shape re-exported — the SDK/TUI wire surfaces mirror it structurally).
export type { AgentTaskStatus, AgentTaskView } from "@i-harness/subagent"
// M32 G1 (TEMPORARY): local type re-export — see the declaration in
// @i-harness/core-agent (group-2 reconciles with llm-seam's ReasoningEffort at
// the T2 merge).
export type { ReasoningEffort } from "@i-harness/core-agent"

export { openLiteralInputExecution } from './lifecycle/literal-input.ts'
export { createInstructionEnvironment } from './context/instructions/index.ts'
export type { InstructionEnvironment } from './context/instructions/index.ts'
export { parseResultPageQuery } from '@i-harness/context-output'
export type { ResultReadScope, ResultReadScopeResolver } from './lifecycle/result-store.ts'
export type { ResultPageQuery, ResultPageResult } from '@i-harness/context-output'
export { createCliForkHost } from './lifecycle/fork-handoff.ts'
export { createResultObservationScope, createLegacyReadObservationRunner, legacyObservationFor } from './lifecycle/result-observation.ts'
export type { ResultObservationScope, ResultObservationCapture, ResultSourceObservation } from './lifecycle/result-observation.ts'

export { mountChildShellTools } from './child-shell.ts'
export type { ChildShellMount } from './child-shell.ts'
