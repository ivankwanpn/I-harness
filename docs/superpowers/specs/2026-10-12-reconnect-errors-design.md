# Model recovery, error popups and diagnostic logs

User requested inspection and implementation of IH automatic reconnection, using
Codex Rust v0.160.0, DSH v0.2.1-alpha.2 and ZCode as references; independent error
popups and logs should draw from the private OpenCode fork 999.0.15. The user
clarified that reference implementations are not presumed correct, and that model
errors should leave the composer and appear in independent floating popups.

## Decisions

- Reuse the clean checkout on a feature branch. Existing dependencies and prior
  release remain available; no reference repository or user profile is modified.
- Enable IH's bounded normal model retry policy for runtime-created provider
  profiles by default: five retries, 500 ms initial exponential delay, 10 s local
  delay cap, 10% jitter. Existing explicit policies, including zero retries, win.
  Low-level provider builders retain their opt-in contract so Desktop attempt
  capture can keep exactly one outer retry layer.
- User follow-up requests an editable retry count. Persist global
  `Settings.modelRetryLimit` as an integer from 0 through 100, default 5; 0 disables
  automatic retries. Settings > General exposes this count and says it applies
  to the next model request. Existing explicit provider-template policies win.
  Gateway routes `desktop/model-retry/state` and `desktop/model-retry/configure`
  return `{ maxRetries: number }`; configure accepts the same field. Desktop
  proxies them as `desktop/global-retry/state` and `desktop/global-retry/configure`
  without needing a selected workspace. Already-open conversations must observe
  the saved value on their next model request.
- User capacity-error follow-up: OpenAI `server_is_overloaded` and the exact
  "Selected model is at capacity" message retry the same model with a fixed
  10-second minimum, without local jitter; longer valid Retry-After advice wins.
  Use the same configured retry budget, never auto-switch models, and expose
  safe retry reason CAPACITY. Policy classification remains SERVER so existing
  custom SERVER retry policies continue to work. Quota/auth errors stay terminal.
- Normalize transient HTTP/transport failures; retry server/429/timeout/network
  failures, not auth, billing/quota, bad arguments, malformed tool arguments,
  context limits, TLS configuration failures or cancellation. Honor valid server
  Retry-After deadlines up to 60 s; a longer requested wait ends recovery rather
  than retrying earlier. Abort cancels both requests and backoff immediately.
- Ordinary stream consumers keep the no-replay-after-output boundary. Core-agent
  explicitly opts into discarding an uncommitted failed attempt: the retry event
  marks its current step failed, preserves raw audit events, clears buffered text,
  reasoning, usage and tool calls, starts a fresh step, then accepts the next
  attempt. Tools are dispatched only after successful stream completion. Never
  restart the whole submitted turn or rerun tools from earlier successful steps.
  Existing duplicate provider call-ID rejection remains fail-closed.
- Recovery stays visible through waiting and the next connection attempt, and
  clears only on real output, completion, cancellation or terminal failure.
- Retry state and terminal errors use bounded structured metadata. No prompts,
  tool arguments, credentials, request headers or raw response bodies belong in
  default diagnostics. Logs, copied details and exported records use the same
  native redaction boundary.
- Final failures produce one persistent, dismissible floating popup per current
  failure, with an explicit details/log action. No focus stealing or layout shift.
  Retried failures that recover do not produce final-error popups. Long model and
  network error text is removed from the composer; local input/draft validation
  keeps its appropriate inline feedback.
- Provide a Settings > Diagnostic Log page and a details dialog from the popup.
  It supports refresh, severity/session filtering, text search, copying safe
  details and exporting a bounded local JSON file. Export requires the native
  save picker, not a renderer-supplied arbitrary destination.
- Native logs persist across restart, cap storage at 5 MiB per file with at most
  three files and seven-day retention, and expose at most 1,000 records per list/
  export (20 MiB aggregate export ceiling). Rotation only touches owned log files.
  Storage errors are reported separately and cannot fail/retry model execution.
- Local gateway process loss is a separate failure domain. Preserve durable input
  admission identities; do not automatically resubmit accepted prompts or start
  duplicate tool jobs. Existing lazy gateway recreation remains intact.

## Shared contracts

`ModelRetryInfo` belongs to core-session and is re-exported by llm-seam:

```ts
interface ModelRetryInfo {
  requestId: string
  phase: "waiting" | "attempting" | "recovered"
  attempt: number // retry number, 1-based
  maxRetries?: number // absent only for an explicitly configured always policy
  delayMs: number
  nextAttemptAt?: number
  code: string
  httpStatus?: number
  providerId?: string
  modelId?: string
  discardOutput?: true
}
```

LLMStreamEvent adds `{ type: "retry"; retry: ModelRetryInfo }`.
LLMRequest adds host-only `retryOutput?: "discard"`; only core-agent sets it.
SessionEvent adds `{ type: "model/retry"; version: 1; ts: number;
retry: ModelRetryInfo; seq?: number }`; it is durable, not model-visible/searchable.
The retry wrapper accepts optional third-argument providerId/modelId metadata.

Native IPC types are owned by `desktop/src/shared/runtime-diagnostics.ts`.
Requests: `desktop/diagnostics/list` with optional workspaceId/sessionId/level;
`desktop/diagnostics/copy` with id; `desktop/diagnostics/export` with the same
optional filters; and `desktop/diagnostics/reveal` without a path argument.
The native service returns a typed list `{ entries, storageError? }`; records have
id, timestamp, level, kind, message, optional workspaceId/sessionId/retry metadata.
DesktopEvent adds `{ kind: "runtime/diagnostic"; entry: RuntimeDiagnosticEntry }`.
The main process observes session retry/status and disconnection events once,
persists sanitized records and forwards sanitized live entries to each window.

## Evidence from references and independent checks

Codex separates connection failures from other retries and honors server deadlines.
DSH records attempt lifecycle and never executes tools from failed attempts.
ZCode retains visible retry state until genuine model progress. The private
OpenCode fork uses persistent toast -> explicitly opened nonfatal details, plus
bounded desktop logs. Its raw log export is not a universal redaction boundary,
so IH must retain its own redactor and limits rather than copying that behavior.

## Required acceptance

Transient failure then success, exhaustion, auth/quota rejection, network-code
normalization, Retry-After, abort while waiting, partial text/reasoning/tool-call
discard, zero failed-attempt tool side effects, no replay of earlier effects,
distinct attempt usage, retry visibility and recovery, single final popup,
background/scope isolation, no old error resurrection, disk failure isolation,
rotation/retention bounds, and identical redaction for store/display/copy/export.
Validate narrow and wide Desktop layouts with actual components and fixture data.
