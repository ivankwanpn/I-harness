import type { ImageInput, Session } from "@i-harness/core-session"
import type { ToolExec, ToolRegistry } from "@i-harness/core-tools"
import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolSchema } from "@i-harness/llm-seam"

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
export interface CodeModeObservation { cellId: string; status: CodeModeStatus; items: CodeModeItem[]; text: string; truncated: boolean; error?: string; policyRefusal?: true }
export type CodeModeRuntimeEvent =
  | { type: "started"; cellId: string; source: string; origin: CodeModeOrigin }
  | { type: "output"; cellId: string; item: CodeModeItem; origin: CodeModeOrigin }
  | { type: "closed"; cellId: string; status: Exclude<CodeModeStatus, "running">; error?: string; origin: CodeModeOrigin; policyRefusal?: true }
export interface CodeModeRuntimeOptions {
  tools(): CodeModeToolDefinition[]
  invoke(call: CodeModeInvocation): Promise<unknown>
  onEvent?(event: CodeModeRuntimeEvent): void
  config?: CodeModeConfig
}
export interface CodeModeExecInput { code: string; yield_time_ms?: number; max_output_tokens?: number }
export interface CodeModeWaitInput { cell_id: string; yield_time_ms?: number; max_tokens?: number; terminate?: boolean }
export interface CodeModeRuntime {
  exec(input: CodeModeExecInput, origin?: CodeModeOrigin): Promise<CodeModeObservation>
  wait(input: CodeModeWaitInput, signal?: AbortSignal): Promise<CodeModeObservation>
  cancel(reason?: string): Promise<void>
  dispose(): Promise<void>
}
export interface CodeModeMount { schemas(): ToolSchema[]; cancel(reason?: string): Promise<void>; dispose(): Promise<void> }
export interface CodeModeMountOptions { session: Session; sessionId?: string; config?: CodeModeConfig; flush?(): Promise<void>; maxParallel?: number }
export type CodeModeFactory = (ctx: PluginContext, tools: ToolRegistry, options: CodeModeMountOptions) => CodeModeMount
