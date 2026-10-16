import type { SessionView as Session, SettlementFacts, ProducerFactOutcome, SessionEvent } from "@i-harness/core-session"
import type { RetainedOutcomeSink } from './registry/retained-outcome.ts'

export type ToolExposure = "direct" | "deferred" | "hidden"

export interface Tool<Args = unknown, Output = unknown> {
  name: string
  description: string
  inputSchema: unknown
  outputSchema?: unknown
  execute(args: Args, exec: ToolExec): Promise<Output>
  timeoutMs?: number
  isConcurrencySafe?: boolean
  isReadOnly?: boolean
  getArgv?(args: Args): string[]
  exposure?: ToolExposure
  searchHint?: string
  // spec §3.8: the schema was written by someone else (an MCP server forwards
  // its own verbatim). The ASSERT layer governs this repo's own declarations;
  // a remote server's dialect is not ours to reject. Additive, and read in
  // exactly one place: `register`.
  inputSchemaForeign?: true
  /** Host/tool supplied identity for operations whose complete executable and
   * binding dependencies can be named. Opaque operations remain one-time. */
  approvalIdentity?(args: Args): PreparedToolIdentity | undefined
  /** Presentation of the captured command binding for foreign hook adapters. */
  commandDialect?(args: Args): "posix" | "powershell" | "cmd" | undefined
}

export interface PreparedToolIdentity {
  binding: string
  executablePaths?: readonly string[]
  command?: { text: string; dialect: "posix" | "powershell" | "cmd" }
}

export interface PreparedApprovalInput { tool: Tool; call: ToolCall; sessionId?: string; registry?: ToolRegistry; bindingGeneration?: number; validateBinding?(): boolean }
export interface ApprovalRememberView { available: boolean; candidateId?: string; reason?: string; arguments?: string }
interface PreparedApprovalResult { remembered: boolean; remember: ApprovalRememberView; validate?(): boolean }
export type PreparedApprovalProvider = (input: PreparedApprovalInput) => PreparedApprovalResult
/** Read-only current-policy snapshot, independent of reusable tool evidence. */
export type ApprovalAuthorityProvider = (input: PreparedApprovalInput) => (() => boolean)

export interface ToolExec {
  /** Registry-bound source registration, never model JSON or a write port. */
  retainOutcome?(): RetainedOutcomeSink
  retainResultReference?(event: Extract<SessionEvent, { type: 'context/result-ref' }>): Promise<void>
  /** Actual executing session, supplied by trusted Agent/Code Mode hosts. */
  session?: Session
  /** Trusted broker presentation hint; it never widens tool authority. */
  resultConsumer?: "code"
  abortSignal?: AbortSignal
  // M19 (Ruling 24): caller/session identity for tool executions that carry
  // one — the agent loop seeds it from the executing session id. Additive: a
  // prepared call without it behaves exactly as before. The agent-team
  // scheduler resolves team tool callers from this (a teammate's child-session
  // id → that member; the parent session id → the Lead).
  sessionId?: string
  // M26 (R-D1): the executing tool/call identity — seeded by the M13 scheduler
  // so tool bodies can durably key a submission to the invoking log event.
  callId?: string
  callEventSeq?: number
}

export type ToolDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string }

// spec §2.6: a POLICY refusal — "you may not do this" — as opposed to a tool
// body that tried and failed. Policy refusals stay LOUD (the turn fails); a
// body failure is soft (the failed call gets a result and the turn continues).
//
// Marked structurally so `core-agent` needs no dependency on the mechanism
// that refuses: `hooks` already sits above this package, and importing it from
// `core-agent` would point the dependency backwards.
//
// THE CONVENTION, and its failure mode: a future in-cascade policy that must
// fail the turn carries this marker. One that forgets has a SOFT refusal —
// which is why the convention is named in the spec, not left as a local
// detail. (Contrast: block ②'s INVALID_ARGS is also typed, but its
// disposition is SOFT — an argument violation is the model's mistake and is
// fixable by the model, a veto is not.)
export interface PolicyRefusal {
  readonly policyRefusal: true
}

/** An absent/undefined marker is ordinary. An unreadable marker fails closed:
 *  its getter may be part of a policy refusal, so uncertainty cannot grant
 *  permission to continue the batch. */
export function isPolicyRefusal(err: unknown): err is PolicyRefusal {
  if (typeof err !== "object" || err === null) return false
  try { return (err as { policyRefusal?: unknown }).policyRefusal === true } catch { return true }
}

/** spec §3.7.1: a TYPED disposition. `prepare` throws it; exactly this type is
 *  converted to a soft failure by the scheduler. The vocabulary stays "typed
 *  dispositions", never a list of messages. */
export const INVALID_ARGS = "INVALID_ARGS"
export class ToolArgsError extends Error {
  readonly code = INVALID_ARGS
  constructor(readonly violations: readonly string[]) {
    super(`invalid arguments: ${violations.join("; ")}`)
    this.name = "ToolArgsError"
  }
}

/** A model named a tool absent from this registry. Only the lookup emits this
 * repairable disposition; policy and changed prepared bindings remain refusals. */
export class ToolNotFoundError extends Error {
  constructor(readonly toolName: string) {
    super(`unknown tool: ${toolName}`)
    this.name = "ToolNotFoundError"
  }
}

export interface ToolCall {
  name: string
  args: unknown
}

export interface ToolResult {
  name: string
  output: unknown
}

// The codes a SYNTHETIC tool result can carry. They live here, not in
// core-agent, because they describe the shape of a tool result and this package
// owns that contract — and because both core-agent (which writes them) and
// output-retention (which must recognise one to leave it un-bounded) depend on
// this package and NOT on each other.
//
// A refusal and a cancellation are DIFFERENT FACTS and carry different codes:
// a body that tried and failed, a call that never started, a call a sibling
// cancelled, and a started call the ABORT PATH filled are four things, and a
// log that conflates them cannot be read back. (block ①'s §2.3 for the messages;
// this is the same rule for the machine-readable form.)
//
// What TOOL_ABORTED_MID_FLIGHT witnesses, exactly: the abort path writes this
// fill for EVERY started slot that produced no output — including a body that
// had already failed ON ITS OWN before the abort swept the batch (T1's review
// measured that with the boundary test's boomTool: `code: TOOL_ABORTED_MID_FLIGHT`
// carrying the body's own "boom" message). So it means "the abort path wrote
// this verdict", NOT "the abort killed that body" — the message beside it is
// what carries the reason, and it is that body's own.
export const TOOL_FAILED = "TOOL_FAILED"
export const TOOL_ABORTED_BEFORE_DISPATCH = "TOOL_ABORTED_BEFORE_DISPATCH"
export const TOOL_CANCELLED_BY_SIBLING = "TOOL_CANCELLED_BY_SIBLING"
export const TOOL_ABORTED_MID_FLIGHT = "TOOL_ABORTED_MID_FLIGHT"
// The fifth code, and the ONLY one of the five whose verdict CROSSES the
// `tools/execute` cascade: the timeout guard is a cascade handler (the others'
// fills are appended straight to the session and never pass through it), so a
// seam-mounted reader — output-retention's spill guard is one — must be able to
// name it without importing `guard-timeout`. It moved here for exactly that
// reason; `guard-timeout` still exports it (a re-export), so its existing
// importers did not move.
//
// It is a verdict about a call like the other four, but it is NOT shaped like
// them: the timeout guard spreads the tool's PARTIAL output and stamps
// `error`/`code` on top, so this code's result can be arbitrarily large where
// the other four are a message.
export const TOOL_TIMEOUT = "TOOL_TIMEOUT"

export interface PreparedCall {
  call: ToolCall
  tool: Tool
  exec: ToolExec
  /** Every prepared operation retains its exact registry registration. */
  bindingValidation(): boolean
  bindingGeneration?: number
  /** Captured for allow, guardian and opaque one-time approval paths too. */
  authorityValidation?(): boolean
  /** Revalidate live authority and prepared identity immediately before launch. */
  approvalValidation?(): boolean
  commandDialect?: "posix" | "powershell" | "cmd"
}
/** Trusted dispatch metadata. The registry and binding validator are never model JSON. */
export interface ToolDispatchMetadata {
  name: string; args: unknown; exec: ToolExec; tool: Tool
  registry: ToolRegistry; bindingGeneration?: number; validateBinding(): boolean
  commandDialect?: "posix" | "powershell" | "cmd"
}

export interface ToolSchema {
  name: string
  description: string
  inputSchema: unknown
  exposure: ToolExposure
}

export interface SearchableTool {
  name: string
  description: string
  inputSchema: unknown
  searchHint?: string
}

// R-A9: auto-approval guardian surface. The guardian is consulted BEFORE the
// human answerer for `ask` decisions: deny ⇒ fail-closed throw; approve ⇒
// auto-approve (answerer skipped); allow ⇒ human answerer as before. Absent
// service ⇒ behavior byte-identical to pre-R-A9.
export interface GuardianRequest { name: string; reason: string; args: unknown; signal?: AbortSignal }
export interface GuardianVerdict { outcome: "approve" | "allow" | "deny"; rationale: string }
export type ApprovalGuardian = (req: GuardianRequest) => Promise<GuardianVerdict>

export interface ToolRegistry {
  register(tool: Tool): void
  get(name: string): Tool | undefined
  unregister(name: string): void
  schemas(): ToolSchema[]
  prepare(call: ToolCall, signal?: AbortSignal, identity?: { sessionId?: string; session?: Session; callId?: string; callEventSeq?: number; resultConsumer?: "code"; settlementSource?: SettlementFacts<ProducerFactOutcome> }): Promise<PreparedCall>
  dispatch(prepared: PreparedCall): Promise<unknown>
  finalize(prepared: PreparedCall, output: unknown): Promise<ToolResult>
  execute(call: ToolCall, opts?: { signal?: AbortSignal }): Promise<ToolResult>
  genToolCatalog(): ToolSchema[]
  verifyToolCatalog(expected: Tool[], catalog: ToolSchema[]): void
  installSearch(fn: (query: string, opts?: { limit?: number }) => ToolSchema[]): void
  search(query: string, opts?: { limit?: number }): ToolSchema[]
  /** Expose already-bound deferred tools in this registry; hidden tools stay hidden. */
  promote(names: readonly string[]): void
  deferredSearchIndex(): SearchableTool[]
  deferredToolCount(): number
}
