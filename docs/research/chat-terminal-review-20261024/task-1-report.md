# Task 1 implementation report — Chat streamed terminal errors

Status: scoped implementation committed; ready for root independent review. Product work stopped. This repairs explicit Chat terminal-error acceptance and failed-attempt usage accounting. It does **not** complete all R5 continuation: an additional real partial-output automatic-retry defect remains below. No publication, push, merge, tag, release, dependency reinstall, gate reseed or exemption.

- Sole writer/runtime checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`
- Branch: `codex/chat-stream-terminal-20261023`
- Exact BASE: `fc71742db138c1018994edf94e954fdc3bff5f58`
- Exact HEAD: `3422c5627056a0e17db63c614d95d9f4917b4e3f`
- Exact range: `fc71742db138c1018994edf94e954fdc3bff5f58..3422c5627056a0e17db63c614d95d9f4917b4e3f`
- Commit: `3422c5627056a0e17db63c614d95d9f4917b4e3f fix(chat): reject streamed terminal errors and retain failed usage`
- 12 explicitly staged files, 504 insertions / 56 deletions. Worktree clean after commit. Product `0.1.13-rc.1` and Session11 untouched.
- MAIN was only read for the task brief, execution constraints and normative plan/C03. This report is the only MAIN write. No MAIN product/test runtime was used; no recursive agents.

## Changes and recognized carrier rules

`stream/fold.ts` detects explicit errors at its existing shared `handleFrame`, before choices, reasoning or tool accumulation. `stream/decode.ts` continues to own extraction/dispatch for read-loop and residual input; there is no additional parser/transport framework. The cohesive seam helper `provider-error/chat-stream.ts` is actually consumed by Chat and reuses the existing `retryErrorCode`, `isModelCapacityError`, canonical-code set and `providerFailureFacts` taxonomy/redaction.

Recognized carriers and controls:

| Carrier | Behavior |
| --- | --- |
| Ordinary JSON object with non-null own `error` | Terminal error. Recognized diagnostic object is classified; otherwise explicitly unknown/malformed. |
| SSE `event: error` with nested `error` object | Terminal error through the same fold handler. |
| SSE `event: error` with flat diagnostic | Normalized to the explicit error carrier, then the same fold handler. |
| `error: null` in an ordinary object | Optional no-error value; ordinary content/usage remains valid. |
| Named error with `null`, `{}`, or nested `error: null`; ordinary error with `{}`, empty string, false, array | Honest `MALFORMED_RESPONSE`, never clean completion. |
| Explicit diagnostic with unrecognized private code/type/message | `UNKNOWN`, canonical payload-free message. |
| Comments, metadata/keepalive objects, absent error, empty ordinary data | Ignored/handled normally; no invented provider failure. |
| Invalid JSON or non-object ordinary JSON | `SSEParseError` / `MALFORMED_RESPONSE`; no raw chunk in error text. |
| Flat JSON `type: error` without the SSE event or an `error` field | No newly invented dialect. Only the documented carriers above are recognized. |

The parser accepts LF, CRLF, CR and joined multi-line `data:` fields. Every byte split of the multi-frame text/error/forbidden-output fixture is tested for all three line endings, including split UTF-8. CR ends its line immediately; the optional next LF is suppressed, so an open connection ending in CRCR cannot defer an error forever. EOF flushes the UTF-8 decoder and residual frame. An explicit error also takes precedence over a JSON `type` resembling the DONE sentinel.

No normal end, later-frame content or final tool flush occurs after the terminal error. Already emitted partial text/tool calls remain audit observations, never accepted effects. The owned reader is canceled in `finally` without awaiting producer cooperation, then unlocked; this covers terminal error, parsing error, DONE and consumer return. Existing isolation tests that explicitly required no cancellation were updated to require cancellation for a still-open owned body; already-errored read/abort bodies do not invoke the underlying cancel hook again. The actual aborted read still throws its original error. The real localhost capacity test leaves its HTTP response open and observes connection close before stopping the retry wait.

Primary protocol evidence inspected on 2026-10-23:

- [openai-node streaming implementation](https://raw.githubusercontent.com/openai/openai-node/master/src/core/streaming.ts), `Stream.fromSSEResponse`: named SSE error envelopes/flat diagnostics and top-level `data.error` are explicit failure carriers; HTTP failure status is not invented there.
- [WHATWG SSE parsing](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream): CRLF/LF/CR line endings and joined data lines.
- Local current reproduction source: `docs/research/2026-10-18-context-engine-r5-chat-error-evidence.md`, used only as a historical fixture reference. Fresh RED/GREEN below replaces any reliance on its archived run.

Classification controls retain context-limit only for precise context diagnostics, with distinct schema/message-order/unsupported-parameter reasons, AUTH, QUOTA, RATE_LIMIT and SERVER. Stream errors carry **no fabricated httpStatus**. Capacity recognized by the existing message/code matching remains SERVER with `capacityLimited`; the existing retry owner advertises `CAPACITY` and exactly 10,000 ms. Tests stop at that waiting event; no ten-second test sleep. Classification reads bounded message/code strings and emits canonical, allowlisted diagnostic facts only; raw payload/body/credential strings are not retained in the error/cause or telemetry.

## C03 usage cooperation and limitations

Fresh connected evidence exposed usage loss after the decoder fix, and root authorized three existing owner files in normative C03 before they were edited:

1. `llm-seam/src/retry/execution.ts` publishes pending usage from a failed physical attempt before its existing retry-waiting or terminal failure boundary. Usage does not set `produced` or change the discard/retry policy. Existing cancellation, generation and execution-control failure checks stay in place.
2. `core-agent/src/agent/model-step.ts` reports that attempt before retry resets its identity/state. It clears the usage accumulator before reporting so reporting/retention failure cannot cause duplicate reporting in the outer failure path.
3. `core-agent/src/agent/response.ts` reports remaining failed usage in the existing stream-failure catch, without calling accepted calibration. The existing outer catch preserves the original failure as cause if reporting also throws.

Usage in an error-bearing frame is emitted **before** the error, with no same-frame choices/tool success. Prior valid usage is retained. Connected tests prove separate failed and successful reports (12 input/3 output versus 30 input/4 output), and capture the live logical step attempt ID and physical reservation ID at emission to show the first report still belongs to the failed attempt, before the next attempt identity. Exhaustion preserves two failed usage reports; normal accepted-tool + final-text control emits two ordinary reports and two accepted samples. Failed attempts have no `context/usage` sample and no `model/exchange-accepted`.

The retry event contract is unchanged. A custom `Telemetry.emit` throwing while the step handles a retry-waiting event returns that observer failure; the original provider Error is not carried by the preexisting retry event and cannot be recovered at that owner. Root explicitly ruled against adding error fields solely for this case. The regression proves one report, one send, no effect/acceptance/calibration. Standard `createTelemetry` isolates sink errors; a separate test proves the original terminal provider failure survives, another sink receives the report, and the same Agent subsequently progresses. Terminal usage-report failure retains original provider cause through `AggregateError`. This is a documented contract limit, not a claim of universal error-cause preservation.

## Actual localhost / managed-runtime evidence

The final connected fixture uses real `createProviderRuntime` → existing built-in Chat/retry/wait client → real global HTTP fetch to `127.0.0.1` → real Agent/SessionService → durable JSONL coordinator/fact ports/tool dispatcher. Settings are written only in a fresh controlled short `IH_CONFIG_DIR`; authentication input is a bounded in-memory synthetic `CredentialStore`, never host credentials. Provider runtime creates the genuine execution identity used by acceptance/calibration. There is no injected ModelClient, fetch override, synthetic confirmation or fact-seed shortcut in these controls.

The four failure + follow-up rows cover before-output + DONE, text/fully parsed tool + DONE, text/tool + EOF, and text/tool + residual (no final blank separator). Each verifies:

- Failed submit rejects, exactly one server request and one physical reservation (ordinal1), with `failed` settlement.
- Zero executed tool counter, zero `tool/dispatch`, zero accepted exchange, zero successful usage anchor; partial cases do record the received tool call and a failed step.
- Exactly one failed-attempt billing report; error telemetry contains no private fixture diagnostic text.
- A new valid submit on the **same session and same assembly** succeeds. Total wire requests become2, settlements become `[failed, completed]`, exactly one accepted exchange/sample exists, effect counter remains0, and the second actual request contains neither `failed-call` nor unaccepted partial text.

Additional final controls:

- Pre-output SERVER error retries once under configured `maxRetries:1`: two actual sends, ordinals `[1,2]`, settlements `[failed,completed]`, one waiting event, one accepted exchange/sample, separately attributed usage.
- Repeated SERVER failures exhaust maxRetries1: exactly two physical sends, `[failed,failed]`, two billing observations, no acceptance/sample.
- Existing action cap1 with and without partial text/tool: only one wire send, first attempt remains `failed`, second send is denied by `GENERATION_EXHAUSTED`; no effect/sample/acceptance. This does not mint allowance for a failed physical attempt.
- Genuine Stop during real capacity waiting: open error response connection closes; waiting carries 10,000 ms; Stop rejects with one wire send and no accepted exchange.
- Positive accepted-tool control: same registered effect counter actually increments once through real dispatch, then a final response succeeds; two accepted exchanges/samples and two distinct usage observations. Thus no-effect assertions are not vacuous because a tool was unavailable.

The test workspaces are cleaned after each control. The retained raw evidence consists of Vitest/tsc outputs, command/UTC/exit sidecars and source/commit manifests, not retained full request bodies or response payload dumps.

## Concrete remaining R5 continuation defect — automatic partial-output retry

An exploratory positive continuation assertion was added after the required pre-output retry control. It failed in the real provider-runtime/localhost pipeline: with `retryOutput: discard` and allowance for one retry, partial text + a complete tool call + SERVER error reaches `CONTEXT_INPUT_STALE: Candidate changed before execution confirmation` before the retry's second HTTP send. Raw failure remains in `final-connected.log` (11 new tests, one failed; 13/14 including adjacent controls passed).

This is **not intended successful recovery**: discard explicitly permits retry. No production admission/execution change was made, per root ruling. The added exploratory assertion was converted into an explicitly limited safety/follow-up control; no preexisting continuation assertion was weakened. It asserts one actual wire send, two reservations with settlements `[failed,unsent]`, no effect/acceptance/anchor, first failed usage retained, and a new submit on the same assembly succeeds with total wire count2. The first physical send remains charged; the second reservation was actually never issued.

Observed path: `retry/execution.ts` emits the retry-waiting event after forwarding failed usage; `model-step.ts` records audit text, fails/closes the old step and opens the retry step; the retained prepared candidate invokes `execution.ts`'s `confirm`, whose `current()` guard rejects before transport issue. `admission.ts` supplied that freshness predicate through `sameRequestCandidate` in `request-snapshot.ts` (model/binding, semantic/protection, branch/context and surface revisions). The failing stack identifies `execution.ts:40` → `response.ts` confirmation callback → prepared payload/execution → HTTP terminal. The exact changed coordinate has **not** been instrumented/isolated in this task; do not infer a specific revision cause from the stack alone. Root carries automatic partial-discard retry continuity into the next R5 owner task. Ordinary new-submit continuation is proven; automatic partial retry is not repaired.

## Qualification, source binding and raw evidence

Evidence root: `C:/ih-r5-evidence-20261023`. Every named `.log` has its same-prefix `.meta.txt` containing literal command, UTC start/end, package cwd, controlled `IH_CONFIG_DIR`, and exit. Suites were sequential with `--maxWorkers=2 --minWorkers=1`. Broad package test filters explicitly exclude `**/.tmp/**`, `**/build/**`, `**/dist/**`; no monorepo suite was run.

| Final supported check | UTC start–end on 2026-10-23 | Result / raw log |
| --- | --- | --- |
| Full Chat package | 15:36:22–15:36:26 | 195/195, 10 files, exit0; `final-chat.log` |
| Full llm-seam package | 15:36:26–15:36:32 | 158/158, 19 files, exit0; `final-seam.log` |
| Agent usage/failure/context/protocol/calibration | 15:38:06–15:38:11 | 65/65, 5 files, exit0; `final-agent-supported.log` |
| New connected + existing context recovery/bookkeeping | 15:40:04–15:40:18 | 14/14, 3 files (11 new controls), exit0; `connected-qualified.log` |
| Chat typecheck | 15:40:53–15:40:56 | exit0; `final-chat-types.log` |
| seam typecheck | 15:40:56–15:40:59 | exit0; `final-seam-types.log` |
| Agent typecheck | 15:40:59–15:41:04 | exit0; `final-agent-types.log` |
| executor typecheck | 15:41:04–15:41:13 | exit0; `final-executor-types.log` |

Commands (run in the corresponding real package cwd):

```text
pnpm exec vitest run test/ --exclude **/.tmp/** --exclude **/build/** --exclude **/dist/** --maxWorkers=2 --minWorkers=1
pnpm exec vitest run test/provider-usage.test.ts test/failed-turn-finalization.test.ts test/context-usage.test.ts test/protocol-recovery.test.ts test/execution-calibration.test.ts --maxWorkers=2 --minWorkers=1
pnpm exec vitest run test/chat-stream-terminal-error.test.ts test/context-recovery.test.ts test/bookkeeping-generation.test.ts --maxWorkers=2 --minWorkers=1
pnpm exec tsc --noEmit
```

Fresh RED and intermediate evidence retained, not overwritten:

- `adapter-red.log`, 15:22:34–15:22:40, exit1: 26 failed/4 passed; valid error DONE/EOF/residual and other missing terminal behavior, distinct from malformed JSON control.
- `connected-red.log`, 15:23:50–15:23:58, exit1: all7 initial real-localhost/durable-Service cases failed against original production source. These initial controls used the actual built-in adapter directly; later final controls strengthen composition through provider runtime.
- `adapter-green-1.log`: initial 30 adapter controls green after decoder/helper implementation.
- `connected-green-1.log`: 3 retry/F4 controls passed, four failure+follow-up rows failed specifically on missing failed usage.
- `usage-red.log`, 15:26:41–15:26:49, exit1: six billing assertions failed (including retry success/exhaustion); Stop and cap safety passed. This preceded C03 owner edits.
- `open-cr-red.log`: one bounded timeout on CR-only open failure; fixed immediate CR handling. `done-precedence-red.log`: one explicit error erroneously treated as DONE; fixed fold precedence. Final37 adapter tests include both.
- `usage-green.log`: billing checks passed but success calibration assertions failed because the initial direct adapter fixture lacked classified execution identity. The fixture was strengthened to real provider runtime; `runtime-green.log`, 15:30:06–15:30:15, all9 then-current connected tests passed. No calibration product rule was weakened.
- `owner-focused.log`: one test-source syntax error, corrected; `owner-focused-2.log`: 18/18. `executor-types-1.log`: missing defaultModel / version narrowing in new tests, corrected; `executor-types-2.log`: exit0.
- `stable-chat.log`: three obsolete no-cancel cleanup assertions failed, corrected to required owned cleanup; final195 green.
- `final-agent.log`: six existing fallback-client retry failures, discussed below. `final-connected.log`: additional partial-discard retry defect above. Both remain explicit limitations, not silently omitted failures.

`final-source-before.json` (12 files, SHA256 `f450f130a0244f05bca97e7630a65e8c0c77b03c77ac4bbb5085858016b15043`) pins the full source before final package qualification. Only the new connected **test** subsequently changed to retain the discovered automatic-partial-retry defect as a safety/follow-up control; `qualification-test-only-change.json` records that sole difference. Its final connected suite was rerun after the edit. All production and other tested files remain byte-identical to the initial final manifest.

`qualified-source.json` and `qualified-source-after.json` pin the final corpus; the latter SHA256 is `9345f05795a43928e5247a033923d19ad5b27879d8aed361a76b2884a9099aa4`. `commit-binding.json` (12 entries; SHA256 `743b9dcfe3338b98ad9a6504e8e7729f117fb40c45f0a1e2c2c17d5ed4c788d2`) records raw file SHA256, qualified Git blob and actual HEAD blob for every owned file. Every qualified blob equals the committed blob. `commit-binding.meta.txt` records full BASE/HEAD/range and clean status at 15:42:12Z. `git diff --check` passed before staging and after commit. Git emitted only expected LF→CRLF checkout warnings for the three new files; committed blob matching is explicit.

`evidence-index.json` indexes66 logs/sidecars/manifests/scripts with size and SHA256 (index SHA256 `02695daeb1a5124424a9058e2fd28e04c36fcb9e694b7b7aca0a5ec9c93bf9b8`). No minified manifest was printed. `qualify*.ps1` record sequential commands; no baseline was changed to exempt these failures.

## Existing fallback failures and bounded comparison

`core-agent/test/model-recovery.test.ts` was an additional regression probe and remains unchanged. Six failures occur on changed source: stale prepared admission in timeout/discarded/duplicate-ID retries and one actual call versus expected2 in exhaust/exhaustion/cancel-retry. Five other selected Agent files passed (65 tests), plus3 tests in this file passed.

The comparison is **exact-BASE three-owner comparison in an otherwise modified checkout**, not a clean-BASE whole-worktree reproduction. The three changed owner files (`model-step.ts`, `response.ts`, `retry/execution.ts`) were byte-backed up, restored from exact BASE, and that one test file was run. `baseline-owner-identity.json` records each restored Git blob equal to its BASE blob; `baseline-model-recovery.log` records the identical six failure names/messages and3 passes. Original edited bytes were restored in `finally`, and the full qualification source manifest was verified equal before resuming checks.

Why this is bounded relevant evidence: this file creates raw scripted `ModelClient`s and existing waiting/retry wrappers, entering `prepared/fallback.ts`; it never invokes Chat's adapter, decoder/fold or new stream-error helper. The seam index additionally exports the helper, but no tested path calls it. It is not a claim that all broader BASE behavior is reproduced. Its old usage assertion also expects only successful-attempt usage; because earlier stale admission fails first, that later expectation was not reached, and it was deliberately not rewritten as unrelated fixture cleanup. Independent review should assess this known uncovered expectation/fixture debt.

Historical fourHTTP400s remain unclassified. Whole-program semantic-fork/SQLite parameter3/eight staged audit NEW obligations, repeated-compaction/single-large-group/child fan-in/cold-recovery matrices and native semantic caller cutover were not run or claimed repaired. Native evidence optimization stays unpromoted. Root independent review and the remaining automatic-partial-retry continuation task are still required.

## Fix round1 — review I1 correction (2026-10-24 local / 2026-10-23 UTC)

Independent review did not accept the first implementation: I1 correctly identified that Stop and generation/execution-control throws bypassed the pending usage flush, and the Agent aborted before accepting usage. This addendum supersedes the earlier delivery status: the correction is now committed and ready for the **same independent reviewer** to recheck; acceptance is not claimed here. Product work stopped again.

- Reviewed BASE: `3422c5627056a0e17db63c614d95d9f4917b4e3f`
- Fix HEAD: `bf3dac6b906b25993d59f6944cfafa15c0c42661`
- Exact fix range: `3422c5627056a0e17db63c614d95d9f4917b4e3f..bf3dac6b906b25993d59f6944cfafa15c0c42661`
- Cumulative task range: `fc71742db138c1018994edf94e954fdc3bff5f58..bf3dac6b906b25993d59f6944cfafa15c0c42661`
- Commit: `bf3dac6b906b25993d59f6944cfafa15c0c42661 fix(accounting): retain observed usage through Stop and control failures`
- Same checkout/branch; five explicitly staged files, 181 insertions /22 deletions; clean status after commit. Only **two production owners** changed: `llm-seam/src/retry/execution.ts` and `core-agent/src/agent/model-step.ts`. Other changes are their existing focused tests and the existing connected test file. No decoder/classifier, service, admission, execution-owner, version or Session-format changes. No MAIN runtime/product changes, publication or recursive agents.

### Verified cause and narrow correction

The retry owner now records a received usage event before its signal check, drains pending observations before **all** failure exits (including genuine Stop and branded generation/execution controls), and uses `splice(0)` so a Stop during success-usage delivery cannot publish the same counters a second time. The original Stop reason or control-error object is still thrown; retry classification, allowance, deadline, physical reservation and discard decisions remain with their existing owners. Usage does not become executable output.

The step owner now handles only `usage` as an observational accumulation before the abort/publication guards. It does not accept completion, publish reasoning, record a tool call or execute any effect in that branch. Every other event still passes the abort guard, now using `AbortSignal.throwIfAborted()` to retain the original reason instead of manufacturing `Error('agent aborted')`. The existing response catch reports the original attempt's accumulated usage exactly once; no new registry, fact kind, calibration path or accounting owner was added.

Two additional Stop edges were tested: Stop while buffered success usage is delivered must not leak `end` or duplicate usage; Stop while a retry's `recovered` notification is delivered must not leak the pending text event. The latter had a fresh RED showing actual forbidden text after Stop, and a final signal recheck immediately before ordinary event delivery closes it. These remain narrow cancellation guards within the same retry owner, not automatic partial-retry recovery changes.

### Fresh RED/GREEN and connected behavior

Evidence root: `C:/ih-r5-fix1-20261023`. Original reviewer probe semantics were reproduced in a committed seam test: source yields input12/output3, aborts with the exact controlled Error, and throws it. The other two cases use `generationError('GENERATION_CLOSED')` (the real branded constructor) and `preparedExecution(...).confirm()` whose real `validateBeforeTransport` callback throws and is registered by the execution-control WeakSet. The latter explicitly asserts `isExecutionControlError(original)`. These are **focused seam/Agent controls**, not claimed physical-provider integrations; they prove the real bypass branches preserve counters and exact original error identity without retrying.

Fresh retained RED:

- `red-retry.log`: four failures /13 passes — lost Stop/generation/execution usage and clean completion leaking when Stop occurs during success-usage delivery.
- `red-agent.log`: three failures /7 passes — missing Stop/generation usage and manufactured `agent aborted` replacing the original reason.
- `red-connected.log`: one failure /11 passes — actual localhost Stop produced no billing report; the original run-signal error, one wire send, no effect/acceptance/sample and response close assertions already passed.
- `transition-red.log`: one failure /17 passes — recovered-transition Stop leaked a pending text event.
- `executor-types-pre.log`: two test-only annotation errors (`this` on the delegated reader spy and the intentionally untyped plugin payload), corrected before final qualification.

The new connected control keeps the **real provider-runtime → built-in Chat/wait/retry → localhost → managed Service** path. It writes only a usage frame, then deliberately keeps HTTP open with no next content/error/end. Test-only spies delegate to the real Chat usage mapper and real `ReadableStreamDefaultReader.read`; they establish a barrier at the next read after actual usage mapping, so Stop occurs while the retry owner is awaiting the next provider frame. There is no fetch override, mock ModelClient, fabricated mapper/read result, fake execution confirmation or timer sleep. The spies are restored in cleanup.

After genuine caller Stop, the actual HTTP response closes and the control verifies:

- Exactly one request, one physical reservation, conservative settlement `unknown` for the interrupted issued stream; no extra send/retry/allowance.
- Exactly one billing report `{inputTokens:12,inputTokenSemantics:'includes-cache',outputTokens:3}` on the original logical attempt and physical reservation IDs.
- The returned error is the **same object as the actual Agent run signal's reason** captured through the existing `agent/pre-step` hook. The Service's preexisting external-caller signal normalization is unchanged; no claim is made that a custom external caller reason is preserved through that earlier service boundary.
- Zero tool calls/dispatch/effects, zero accepted exchange and zero successful calibration before follow-up.
- A new valid submit on the same session and same assembly succeeds, makes total requests2 and reports its own usage separately; exactly one accepted exchange exists afterward and effects remain0.

Focused Agent tests also prove the original Stop remains the AggregateError cause when the one usage-report attempt itself fails, with both original and observation errors retained and no double report/acceptance. A raw-client control settles usage after abort but refuses subsequent text/tool/end with the original reason. Existing normal success, terminal-error-with-usage, retry/exhausted usage, cap and same-runtime follow-up controls all pass again.

### Final bounded qualification and immutable binding

All commands ran sequentially from the real package cwd with fresh short `IH_CONFIG_DIR` roots and `--maxWorkers=2 --minWorkers=1`. Only explicit affected files were selected. Full195/158 suites, the unrelated six fallback failures and broad whole-program gates were **not rerun** in this correction.

| Check | UTC start–end, 2026-10-23 | Result |
| --- | --- | --- |
| retrying-client, recovery, waiting-guard, execution-receipt | 16:02:42–16:02:46 | 44/44, exit0; `final-retry.log` |
| provider-usage, failed-turn-finalization, context-usage | 16:02:46–16:02:49 | 23/23, exit0; `final-agent.log` |
| actual Chat stream terminal-error connected controls | 16:02:49–16:02:59 | 12/12, exit0; `final-connected.log` |
| llm-seam typecheck | 16:02:59–16:03:01 | exit0; `final-seam-types.log` |
| core-agent typecheck | 16:03:01–16:03:07 | exit0; `final-agent-types.log` |
| session-executor typecheck | 16:03:07–16:03:16 | exit0; `final-executor-types.log` |

Exact commands and their UTC/cwd/env/exit sidecars are retained next to each raw log, and in `qualify.ps1`:

```text
pnpm exec vitest run test/retrying-client.test.ts test/recovery.test.ts test/waiting-guard.test.ts test/execution-receipt.test.ts --maxWorkers=2 --minWorkers=1
pnpm exec vitest run test/provider-usage.test.ts test/failed-turn-finalization.test.ts test/context-usage.test.ts --maxWorkers=2 --minWorkers=1
pnpm exec vitest run test/chat-stream-terminal-error.test.ts --maxWorkers=2 --minWorkers=1
pnpm exec tsc --noEmit
```

`source-before.json` was captured at16:02:42Z before final qualification. It and `source-after.json` are byte-identical, each SHA256 `9152a7baba27f16f4fcd8130ea81c47646cdafb7eb72cf3e92661c3660b530f6`; all five owned source SHA256/Git blobs match. `commit-binding.json` records each qualified blob equal to actual fix HEAD blob, SHA256 `020c60ab2397ca5b0034812bbbb41db10950e8aa72a3ce5aedde33e361168355`. `commit-binding.meta.txt` records the exact fix range and clean status at16:04:00Z. `git diff --check` passed before staging; only the already documented Windows LF→CRLF checkout warning appeared.

`evidence-index.json` contains35 evidence entries with size/SHA256; index SHA256 `c1e22ba4a6e299f9282967d4c29a88c895770fbf7d47bf7219421002b97a0e95`. Raw logs and manifests are retained; no minified manifest dump was printed.

The automatic partial-discard retry `CONTEXT_INPUT_STALE` defect, minorM1's unreachable old successful-only billing assertion, six existing fallback failures, historical four400 attribution and all broader R5/native-cutover limits remain unchanged. This correction addresses I1 for re-review; it does not claim those continuation obligations are complete.
