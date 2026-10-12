# Session settlement, model progress and Responses cache continuity

The user approved implementing the preceding investigation recommendations.
This is a coordinated change to existing interfaces, with three separately
reviewed deliverables. Continue through routine design choices without another
approval gate. Base: v0.1.10 / 82588add.

## Boundaries

- Preserve running user sessions and saved provider/role settings during testing.
  Use local fixtures, fake transports and temporary profiles; no live inference.
- Reuse the clean checkout on codex/session-progress-cache. No implementation on
  main. No dependencies or broad unrelated restructuring.
- Preserve the one model retry layer, failed-attempt audit/discard and tool safety.
  Never repeat accepted turns or already-executed tool effects.
- No duplicate child usage collector. Evidence shows current child accounting
  works. Role configuration and historical records remain unchanged.
- Common Responses event/usage parsing stays common. Codex subscription-specific
  routing headers and opaque server state stay within the subscription branch.
  Other protocols retain their payload, cache configuration and token semantics.
- Request metadata and diagnostic events never include prompts, tool arguments,
  credentials, opaque routing tokens or raw response bodies.

## 1. Authoritative settlement

Session service owns queue/execution lifecycle notifications for every submit,
including internal parent-notification wakes. Emit final authoritative state only
after lane settlement, stop hooks, persistence and queue bookkeeping. SDK forwards
this as an additive execution-state notification; Desktop schedules an
authoritative refresh and rejects stale snapshots using its existing sequencing.
Do not equate a durable turn/end event with a settled executor. Preserve failure
and cancellation notification behavior and cleanup of listeners on disposal.

Proposed service subscription: optional onExecutionState(listener) -> unsubscribe;
event contains sessionId, running, queued and monotonic revision. Exact naming can
follow repository conventions, but the implementer must document the final
contract before the next task. No historical durable event for ephemeral queue
state, and no polling loop as the primary fix.

## 2. Bounded model waiting and observable progress

Add a shared host-side, per-physical-attempt stream guard below the existing retry
layer. Default first-response and semantic-progress deadlines are each 300 seconds.
Global settings expose seconds: 0 disables that deadline, otherwise integer
30..3600. Changes apply to the next model request, including existing conversations;
an in-flight attempt retains its captured policy. Raw low-level builders should
retain opt-in behavior; runtime-created profiles enable the defaults.

Model reasoning/text and nonempty tool-argument progress count as progress;
heartbeat bytes, repeated empty/status events and usage-only updates do not.
Adapters may publish a bounded neutral activity event for partial tool arguments
without leaking payload or changing tool execution. Public request JSON must not
contain host-only policy/context fields. Abort stops parked reads and backoff;
timeouts become structured TIMEOUT failures handled by the existing budget.
If an HTTP response has already established a terminal status and its error body
stalls, retain a bounded internal terminal-status hint: a body-read deadline must
not convert known authentication/quota/invalid requests into retryable TIMEOUT.
Keep normal full-body classification (including HTTP400 context overflow) intact;
the hint is only a fallback when that read cannot finish. User cancellation wins
over the hint, and HTTP408/429 do not receive terminal fallback hints.
Iterator cleanup must not await a permanently parked noncooperative generator;
observe late settlements and avoid unhandled rejections or overlapping effects.

Expose sanitized phase, request identity and progress timing through core session
events/native diagnostics. A quiet request can show a small waiting state after
15 seconds, without stealing focus or moving the composer. Keep retry status
authoritative. Stop/cancel/recovery/terminal settlement clear active waiting state.
Do not mistake long, genuinely progressing reasoning for a stalled request.
Settings and help text explain both deadlines and zero disabling.

## 3. Subscription affinity and stable semantic context

Add neutral host request scope (session and user-turn identity) where necessary.
Core creates a stable turn identity for all model steps and retries in that turn;
new turns and separate child sessions are distinct. This metadata is never copied
onto unrelated protocol request bodies.

For the official Codex subscription endpoint, follow the supplied native Codex
v0.160.0 reference for session-id/thread-id headers and response x-codex-turn-state
capture/replay. Scope opaque sticky values to account + session + turn; never reuse
across accounts/turns/children, persist or log them. Bound memory and value size,
reject invalid header values and retain redirect restrictions. Preserve explicit
cache settings. The public Responses API and other adapters receive no subscription
headers or private options. Missing prompt_cache_key alone is not a GPT-6 caching
root cause; do not promise a cache percentage or copy unsupported public API cache
options into subscription requests.

Stabilize semantic Todo context: remove the revision-only prefix difference when
the actual Todo list is identical. Keep the authoritative list, explicit clearing,
survival across compaction, instruction role and real updates intact. Do not move
dynamic content between instruction priority levels in this release. Keep retained
output references correct; do not strip useful context merely to inflate cache hits.

## 4. Follow-up: discoverable role selection

The user additionally requested comparison with the private OpenCode fork because
IH repeatedly chooses general. The audit confirms IH omits available role names
and selection examples from model-facing spawn metadata; omitted agent_type falls
back to general. The fork exposes current identifiers and selection guidance.

Expose a deterministic live RoleRegistry catalog at the spawn tool-definition
boundary, with practical guidance: explore for bounded read-only code lookup,
research for cross-source analysis, worker for implementation/testing, general for
mixed work not matching a narrower capability. Describe actual registered roles,
not settings-only model keys; identify the approval guardian reviewer distinctly.
Prompt new model calls to choose agent_type explicitly. Preserve existing omitted
role -> general compatibility instead of adding an unrelated validation framework
or breaking saved Code Mode callers. Runtime role/tool/model restrictions remain
authoritative. No forced round-robin selection or user model-setting changes.

Verify actual model-facing direct, tool-search and Code Mode metadata, refresh
after role registry changes, stable output for unchanged roles, and explicit role
dispatch to configured models. Synthetic contract tests establish discoverability,
not a promise that live models always select the ideal role.

## Acceptance and delivery

Reproduce the stale-running probe before fixing it; cover delayed stop hook/flush,
internal wakes, queued next work, error, cancellation and disposal. Use fake-clock
and real local HTTP tests for no headers, quiet body, heartbeat-only stream, partial
tool JSON, progressing reasoning, Stop and timeout retry/exhaustion. Confirm no
failed-attempt tool effect and no duplicate attempt usage.

Compare actual requests across Responses public/subscription, compatible,
Anthropic, Gemini and Bedrock: only intended subscription headers and neutral
internal events may differ. Compare identical Todo writes versus real changes.
Run affected suites, full Desktop and appropriate broader gates, independent
reviews, production build and actual-component visual QA. Revisit the independently
reported CLI redaction fixture and Windows job-cancel fixture failures with focused
reproductions, fixing test contracts without weakening secret/cancellation checks.
Then follow the established GitHub PR/merge/release process for v0.1.11, with
packaged local smoke tests and uploaded asset size/digest verification.
