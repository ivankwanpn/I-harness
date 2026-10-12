# Model recovery and Desktop diagnostics reference audit

This change was requested after Responses requests failed with malformed tool
arguments, HTTP 503 connection termination, and model-capacity errors. The
argument-assembly fixes shipped separately in v0.1.9. This audit covers the
recovery and diagnostic work for v0.1.10.

## Local references inspected

| Reference snapshot | Relevant behavior | IH decision |
| --- | --- | --- |
| `codex-rust-v0.160.0` (`codex-rs/codex-client/src/retry.rs`, `core/src/responses_retry.rs`, `model-provider-info/src`, `codex-api/src/sse/responses_error.rs`) | Separate request/stream policies, abortable recovery, server delay advice, structured overload identity. | One bounded wrapper at the model request boundary; default five retries. No replay of an entire submitted turn. |
| `deepseek-harness-dsh-v0.2.1-alpha.2` (`packages/llm/llm/src/retry-policy.ts`, `packages/llm/llm-retry`) | Five retries, exponential delay, retry lifecycle, failed attempt separation. | Preserve IH usage capture and audit boundaries; only core-agent opts into discarding uncommitted output. |
| `ZCode-main` | Recovery status persists until real output; adapters and core apply different recovery boundaries. | Keep waiting/attempting visible until progress, cancellation or final failure; do not add nested generic retry wrappers. |
| `opencode-fork-private-999.0.15` (`packages/app/src/pages/session.tsx`, `pages/error-tab.tsx`, `packages/session-ui/src/components/session-retry.tsx`, `packages/desktop/src/main/logging.ts`) | Persistent floating error notice, explicit details, retry countdown, native rotated logs. | Independent IH popup plus explicit details and settings Log. Retain IH controls and native IPC ownership. |

Reference trees were read only. Their behavior is evidence for design choices,
not a correctness guarantee. In particular, the OpenCode fork's raw debug export
does not provide a general redaction boundary. IH generates bounded diagnostic
facts in main and uses the same sanitized representation for display, storage,
copy and export. It does not enable raw console, provider-body or network dumps.

## Recovery boundaries

The provider runtime enables normal retry by default, while low-level model
builders preserve their existing opt-in behavior. Desktop physical-attempt usage
capture stays inside exactly one recovery wrapper. Global retry settings refresh
at the next model request, including requests from already-open sessions;
explicit provider-template policies still take precedence.

OpenAI capacity identity receives a ten-second minimum without jitter. Longer
valid server advice is honored within the sixty-second supported window. This
uses the configured budget and same model. Terminal authentication, quota,
invalid-request, malformed-response, TLS and cancellation classifications remain
terminal even under an explicit always policy.

Core-agent marks failed attempts in the raw journal, excludes their output from
the model projection, and never dispatches their buffered tool calls. A retry
does not replay effects committed in earlier successful steps. Cancellation must
cross both structured and legacy message-only status boundaries without becoming
an error popup; actual agent, AbortSignal and timer cancellation forms have
regressions.

Gateway process loss remains separate from model recovery. Accepted input is
not automatically submitted again. Failed durable admission gets its own
diagnostic identity so it cannot steal the running request's retry state.

## Verification and limits

The final backend pass covers 1,508 tests in 184 files across twelve packages,
plus all twelve typechecks. Local HTTP fixtures cover incomplete streams after
text/tool output, normal recovery, capacity delay, cancellation, authentication
failure and exhaustion. Native temporary-directory tests cover bounded storage,
scope/deduplication, persistence, safe copy/export and isolated storage failure.

The release manifest records the final Desktop component, build, package and
asset checks. No real provider account was exercised. A persistent upstream
outage still ends in a final failure after the configured budget; these checks
do not claim that every possible upstream failure can recover.
