import type { ImageInput, Session } from "@i-harness/core-session"
import type { ToolExec, ToolRegistry } from "@i-harness/core-tools"
import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolSchema } from "@i-harness/llm-seam"
import type { SpillStore } from "@i-harness/output-retention"

export interface CodeModeConfig {
  mode?: "off" | "mixed" | "only"
  memoryLimitMb?: number
  cpuTimeMs?: number
  maxActiveCells?: number
  maxPendingCalls?: number
  maxSourceBytes?: number
  maxResultBytes?: number
  maxStoreBytes?: number
  defaultYieldTimeMs?: number
  defaultOutputTokens?: number
}
export interface CodeModeToolDefinition { name: string; description: string; inputSchema: unknown; outputSchema?: unknown }
export type CodeModeOrigin = Pick<ToolExec, "sessionId" | "callId" | "callEventSeq" | "abortSignal">
export interface CodeModeInvocation { cellId: string; invocationId: string; name: string; args: unknown; origin: CodeModeOrigin; signal: AbortSignal }
export type CodeModeItem = { type: "text"; text: string } | { type: "image"; image: ImageInput } | { type: "audio"; audioUrl: string }
export type CodeModeStatus = "running" | "completed" | "failed" | "terminated"
export type CodeModeJsonValue = null | boolean | number | string | CodeModeJsonValue[] | { [key: string]: CodeModeJsonValue }
export type CodeModeStoreEntries = Array<[string, CodeModeJsonValue]>
export interface CodeModeStoreCommit { cellId: string; origin: CodeModeOrigin; writes: CodeModeStoreEntries; signal: AbortSignal }
export interface CodeModeTextRetention { stored: boolean; path?: string; cellId: string; sessionId?: string; admittedBytes: number; omittedBytes: number; complete: boolean; truncated: boolean }
export interface CodeModeObservation { cellId: string; status: CodeModeStatus; items: CodeModeItem[]; text: string; truncated: boolean; textRetention?: CodeModeTextRetention; error?: string; policyRefusal?: true }
export type CodeModeRuntimeEvent =
  | { type: "started"; cellId: string; source: string; origin: CodeModeOrigin }
  | { type: "output"; cellId: string; item: CodeModeItem; origin: CodeModeOrigin }
  | { type: "closed"; cellId: string; status: Exclude<CodeModeStatus, "running">; error?: string; origin: CodeModeOrigin; policyRefusal?: true }
export interface CodeModeRuntimeOptions {
  tools(): CodeModeToolDefinition[]
  invoke(call: CodeModeInvocation): Promise<unknown>
  onEvent?(event: CodeModeRuntimeEvent): void | Promise<void>
  /** Current committed JSON data, replayed again at admission/commit after rewind. */
  restoreStore?(origin: CodeModeOrigin): readonly (readonly [string, CodeModeJsonValue])[]
  /** Serialized after merged-state validation and awaited before success. */
  commitStore?(commit: CodeModeStoreCommit): void | Promise<void>
  /** Optional host store; the default temp store is created only on truncation. */
  spillStore?: SpillStore
  config?: CodeModeConfig
}
export interface CodeModeExecInput { code: string; yield_time_ms?: number; max_output_tokens?: number }
export interface CodeModeWaitInput { cell_id: string; yield_time_ms?: number; max_tokens?: number; terminate?: boolean }
export interface CodeModeRuntime {
  exec(input: CodeModeExecInput, origin?: CodeModeOrigin): Promise<CodeModeObservation>
  wait(input: CodeModeWaitInput, signal?: AbortSignal): Promise<CodeModeObservation>
  /** Owner cancellation does not acquire or consume the output observer. */
  terminate(cellId: string, reason?: string): Promise<void>
  cancel(reason?: string): Promise<void>
  dispose(): Promise<void>
}
export interface CodeModeMount { schemas(): ToolSchema[]; liveCells?(): { id: string; status: "running" }[]; terminateCell?(cellId: string): Promise<void>; cancel(reason?: string): Promise<void>; dispose(): Promise<void> }
export interface CodeModeMountOptions { session: Session; sessionId?: string; config?: CodeModeConfig; spillStore?: SpillStore; flush?(): Promise<void>; maxParallel?: number }
export type CodeModeFactory = (ctx: PluginContext, tools: ToolRegistry, options: CodeModeMountOptions) => CodeModeMount
