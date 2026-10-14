export { createAgent } from "./agent/create.ts"
export { createAgentRegistry } from "./agent/registry.ts"
export type { AgentBudgetConfig, AgentConfig, AgentDeps, AgentResult, Agent, AgentRegistry, ReasoningEffort, ModelContextBindingDescriptor } from "./agent/types.ts"
export {
  executeToolCalls,
  TOOL_ABORTED_BEFORE_DISPATCH,
  TOOL_CANCELLED_BY_SIBLING,
  TOOL_FAILED,
  type BatchCall,
  type ExecuteToolCallsOptions,
} from "./execute-tool-calls.ts"
export { createSessionExecutor, createSessionExecutorRegistry, mapSubmitToAdmission } from "./executor.ts"
// NOTE: `SessionExecutorFailure` is deliberately NOT re-exported here yet. It is
// the shape a rejection carries (`pendingCount` on the failure), but no
// production consumer narrows on it — only this package's own tests do — and the
// reachability gate is right to call a new public export with no consumer an
// orphan. The same rule this repo applies elsewhere ("a field nothing sets is a
// capability the type advertises and the code does not honour — it lands again
// only with a producer AND a consumer") applies to an export nothing imports.
// Re-export it when a host actually types its rejection against it.
export type { SessionExecutor, SessionExecutorDeps, SessionExecutorRegistry, AgentRunSurface, InputSubmit } from "./executor.ts"
