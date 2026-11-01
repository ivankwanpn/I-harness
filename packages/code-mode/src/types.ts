import type { ImageInput, ResultEnvelope, SessionView as Session, FactOwner } from "@i-harness/core-session"
import type { ToolExec, ToolRegistry, UserSteerSource } from "@i-harness/core-tools"
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
export type CodeModeOrigin = Pick<ToolExec, "sessionId" | "callId" | "callEventSeq" | "abortSignal"> & { generationLineage?: import('@i-harness/core-tools').CodeGenerationLineage; instructionOrigin?: import('@i-harness/core-tools').InstructionCellOrigin; bindInstructionCell?: (cellId: string) => import('@i-harness/core-tools').InstructionCellOrigin | undefined }
export interface CodeModeInvocation { cellId: string; invocationId: string; name: string; args: unknown; origin: CodeModeOrigin; signal: AbortSignal }
export type CodeModeItem = { type: "text"; text: string } | { type: "image"; image: ImageInput } | { type: "audio"; audioUrl: string }
export type CodeModeStatus = "running" | "completed" | "failed" | "terminated"
export type CodeModeJsonValue = null | boolean | number | string | CodeModeJsonValue[] | { [key: string]: CodeModeJsonValue }
export type CodeModeStoreEntries = Array<[string, CodeModeJsonValue]>
export interface CodeModeStoreCommit { cellId: string; origin: CodeModeOrigin; writes: CodeModeStoreEntries; signal: AbortSignal; committed?(): void; cancelled?(): void; retainOutcome?(): void }
/** Non-durable disposition for emitted text. There is no spill path and no
 * inline giant value: the model keeps its bounded window and this says why the
 * complete text is not retained. */
export type CodeModeTextUnavailable = "no-owner" | "quota" | "encoding" | "storage-refused" | "unsupported-owner" | "capture-canceled" | "storage-unknown"
/** Model/archive descriptor for one consumed output window. The observation's
 * own bounded `text` is the model view; `envelope.preview` stays empty so the
 * same huge text is never carried twice. `envelope.retention` is the exact
 * immutable artifact reference (artifact codec) or an explicit unavailable. */
export interface CodeModeTextRetention { stored: boolean; envelope?: ResultEnvelope; representation?: 'text' | 'code-text-index-v1'; unavailable?: CodeModeTextUnavailable; cellId: string; sessionId?: string; admittedBytes: number; omittedBytes: number; complete: boolean; truncated: boolean }
/** Ordered references to original text facts; media positions remain explicit.
 * This index contains no second copy of the original text/media bodies. */
export interface CodeModeTextIndex { version: 1; kind: 'code-text-index'; items: ({ type: 'text'; envelope: ResultEnvelope } | { type: 'image' | 'audio' })[] }
export type CodeModeTextRetentionResult =
  | { kind: "ready"; envelope: ResultEnvelope }
  | { kind: "unavailable"; reason: Exclude<CodeModeTextUnavailable, "storage-unknown"> }
  | { kind: "recovery-required" }
export interface CodeModeObservation { cellId: string; status: CodeModeStatus; items: CodeModeItem[]; text: string; truncated: boolean; textRetention?: CodeModeTextRetention; error?: string; policyRefusal?: true; instructionReplan?: import('@i-harness/core-tools').InstructionReplanData; yielded?: true; yieldReason?: "user-steer" | "background-event" }
export interface CodeModeObserveOptions {
  backgroundEvent?: UserSteerSource
  userSteer?: UserSteerSource
  retained?: { observed(): void; progress(): void; unavailable(): void; ready(output: CodeModeObservation): void }
}
export type CodeModeRuntimeEvent =
  | { type: "started"; cellId: string; source: string; origin: CodeModeOrigin; instructionInstalled?(): void; instructionAdmissionFailed?(): Promise<void> }
  | { type: "output"; cellId: string; item: CodeModeItem; origin: CodeModeOrigin; committed?(retained?: CodeModeTextRetentionResult): void; retainOutcome?(): void }
  | { type: "closed"; cellId: string; status: Exclude<CodeModeStatus, "running">; error?: string; origin: CodeModeOrigin; policyRefusal?: true; instructionReplan?: import('@i-harness/core-tools').InstructionReplanData; committed?(): void; retainOutcome?(): void }
export interface CodeModeRuntimeOptions {
  tools(): CodeModeToolDefinition[]
  invoke(call: CodeModeInvocation): Promise<unknown>
  drainInstructionCell?(cellId: string): Promise<void>
  onEvent?(event: CodeModeRuntimeEvent): void | Promise<void>
  /** Current committed JSON data, replayed again at admission/commit after rewind. */
  restoreStore?(origin: CodeModeOrigin): readonly (readonly [string, CodeModeJsonValue])[]
  /** Serialized after merged-state validation and awaited before success. */
  commitStore?(commit: CodeModeStoreCommit): void | Promise<void>
  /** Native host capture, before the model observation loses emitted text.
   * The host owns the durable artifact through the existing result store; this
   * port never writes a spill file and never returns the raw text again. */
  retainText?(input: {text:string;cellId:string;origin:CodeModeOrigin;complete:boolean;status:CodeModeStatus;
    index?: CodeModeTextIndex;
    /** Original admitted output source, valid through passive settlement. */
    assertHeld?(): void;
    retainOutcome?(settle:() => Promise<CodeModeTextRetentionResult>):void;
    retentionRecovery?(): void;
  }): Promise<CodeModeTextRetentionResult|undefined>
  retentionRecovery?(): void
  config?: CodeModeConfig
}
export interface CodeModeExecInput { code: string; yield_time_ms?: number; max_output_tokens?: number }
export interface CodeModeWaitInput { cell_id: string; yield_time_ms?: number; max_tokens?: number; terminate?: boolean }
export interface CodeModeRuntime {
  exec(input: CodeModeExecInput, origin?: CodeModeOrigin, observation?: CodeModeObserveOptions): Promise<CodeModeObservation>
  wait(input: CodeModeWaitInput, signal?: AbortSignal, observation?: CodeModeObserveOptions): Promise<CodeModeObservation>
  /** Owner cancellation does not acquire or consume the output observer. */
  terminate(cellId: string, reason?: string): Promise<void>
  cancel(reason?: string): Promise<void>
  dispose(): Promise<void>
  replan(cellId: string, detail: import('@i-harness/core-tools').InstructionReplanData): void
  /** Trusted owner drain for an already captured observation; no guest work. */
  drainRetainedObservations?(): Promise<void>
}
export interface CodeModeMount {
  ready?(): Promise<void>
  onSurfaceChanged?(listener: () => void): () => void
  surfaceState?(): "available" | "unavailable" | "retired"
  schemas(): ToolSchema[]
  liveCells?(): { id: string; status: "running" }[]
  terminateCell?(cellId: string): Promise<void>
  cancel(reason?: string): Promise<void>
  dispose(): Promise<void>
}
export interface CodeModeMountOptions { session: Session; factOwner?: FactOwner; sessionId?: string; config?: CodeModeConfig; retainText?: CodeModeRuntimeOptions['retainText']; finalOutput?: import('./final-output.ts').CodeFinalOutputFactory; flush?(): Promise<void>; maxParallel?: number }
export type CodeModeFactory = (ctx: PluginContext, tools: ToolRegistry, options: CodeModeMountOptions) => CodeModeMount
