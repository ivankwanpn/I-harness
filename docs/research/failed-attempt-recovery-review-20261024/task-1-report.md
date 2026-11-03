# Failed-attempt recovery — implementation report

Status: implemented, self-reviewed, committed, and ready for the root's fresh independent review. This is scoped recovery qualification, not whole-version/release approval. Backend-proven absent captured operations still require the existing explicit recovery owner; this packet does not invent an automatic reissue path.

## Source and ownership

- BASE: `80ad360f595a3522857fdb5779836591a69bd1cc`.
- HEAD: `24f5794cd9fbc306554628949fbe48ca5b7cf816` (`fix(recovery): settle failed attempts with source-proven audit closure`).
- Full review range: `80ad360f595a3522857fdb5779836591a69bd1cc..24f5794cd9fbc306554628949fbe48ca5b7cf816`.
- Checkout: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main`; branch `codex/failed-attempt-recovery-20261024`; clean after commit.
- Fifteen explicitly staged owned files. Exact BASE/HEAD Git blobs, physical SHA256 and tested-source bindings are in [commit-source-binding.json](evidence/commit-source-binding.json). All fifteen physical files match their committed Git blobs. Fourteen match the final runtime-test physical hashes directly; model-step has only a subsequent `true as const` type correction and indentation. TypeScript 5.9.3 emitted output is byte-identical before/after, recorded in [type-only-binding.json](evidence/type-only-binding.json). The affected Agent/Executor typechecks then passed.
- Local vitest, core-agent, core-session, and llm-seam package resolutions were verified inside this checkout. Existing local dependencies were used without reinstall. No MAIN or sibling-worktree runtime, provider/profile access, release/version/format change, push, or recursive agents.
- Root explicitly extended the brief for a non-durable original retry failure association in llm-seam, the narrow response usage-observer catch, and the corresponding provider-usage assertion. No retry policy, parser, F4/action/deadline allowance, currentness guard, admission, accepted-exchange codec, or seed implementation was changed.

Owned files:

- `packages/core-agent/src/agent/model-step.ts`, `response.ts`; tests `failed-attempt.test.ts`, `model-recovery.test.ts`, `provider-usage.test.ts`.
- `packages/core-session/src/conversation/legacy.ts`, `unit-state.ts`, `history/failed-audit.ts`; test `failed-audit.test.ts`.
- `packages/llm-seam/src/retry/failure.ts`, `retry/execution.ts`, `index.ts`; test `retry-failure.test.ts`.
- `packages/session-executor/test/partial-retry-recovery.test.ts`, `chat-stream-terminal-error.test.ts`.

## Current-BASE RED and causal evidence

Before product edits, actual provider-runtime → built-in Chat HTTP → managed SessionService tests failed for both partial text and partial text+tool with `CONTEXT_INPUT_STALE` at execution confirmation. Reasoning-only already succeeded and is retained as a preservation control. The RED was behavioral, not an import/missing-export failure.

[red-connected-causal.raw.txt](evidence/red-connected-causal.raw.txt) and [its command/source receipt](evidence/red-connected-causal.json) bind the clean product BASE, command, cwd, UTC times, exit1 and tracked owner source hashes. The original [text.json](evidence/text.json), [text-tool.json](evidence/text-tool.json), and [reasoning.json](evidence/reasoning.json) preserve actual comparisons, request bodies and persisted facts. The text/text+tool comparisons have unchanged semantic, branch, context epoch, model, binding and surface identities; only protection changes, beyond the expected archive growth. Failed audit becomes an unresolved zero-message fragment. The text+tool archive has a call and no precise local non-dispatch result.

The first attempted test creation used the Windows Python alias and created no file; `red-connected` therefore records a setup-invalid no-test exit. It is preserved and is not counted as RED. The succeeding Node-created fixtures produced the decisive failures. Initial hash receipts covered tracked owner files; untracked test-driver source capture was added to the runner later. Those initial untracked test bytes are not claimed to have been hashed at that point. Their actual commands, named assertions, wire bodies, comparisons and fact traces remain retained. Later receipts include untracked/new sources and full modified-source snapshots.

## Product behavior

The existing model-step owns one cached failed-settlement promise for the physical attempt. Retry/discard/terminal failure all join it. It snapshots the local unaccepted batch and audit/native content, captures every known local aborted result through the existing settlement tool capability before the first awaited save, flushes reasoning, saves audit, awaits one original non-dispatch result per recorded call, then saves failure and explicit end. It never dispatches that batch. The normal next physical step opens only after successful settlement under the original action and existing retry ordinal. Transient buffers, usage, receipt and ending bits reset only after that settlement succeeds.

Early capture matters: a lost audit acknowledgment previously prevented later local outcomes even being retained. The added continuation RED demonstrated a missing result after reconciliation; the existing source now owns those exact result captures and drains them after the original operation settles. A rejected/unknown settlement promise stays rejected for the live model owner, so reentry cannot allocate another audit/result operation. It also invokes the existing source recovery hold, preventing a later submit from bypassing a retained known-absent operation with a new action. The managed absent-result/audit/end controls caught that extra-send defect before the hold was added.

Retry usage is marked delivered before invoking the observer and its counters are retained internally until committed settlement; the outer failure pass cannot report them twice. Terminal usage-observer failure still awaits local settlement. Error-observer failures preserve the original provider cause as well. No failed attempt enters accepted usage calibration.

The retry wrapper keeps a private WeakMap association from the actual emitted waiting-event object to `{ failure: unknown }`. Only the consumed reader crosses the package boundary. This distinguishes thrown `undefined` from no association. The error is not an enumerable event field and never enters durable `ModelRetryInfo`, telemetry, or the request. Copies/custom events have no association; no error is guessed for them. The association is diagnostic identity only, never evidence for execution/currentness. Actual prepared HTTP tests prove the existing wrappers preserve that event identity; copied-event, once-consumption and non-serialization controls pass.

The structural owner now derives a private failed-audit descriptor from the original full archive. It requires an explicit semantics fence, a unique valid action/attempt-bearing start, one actual failure and one actual end in that physical interval, no acceptance, safely addressable ordered sources, and complete unique ID/name-matching results before failure that prove non-dispatch. Any dispatch address for a call, duplicate/conflicting/late/missing result, unknown/generic outcome, hidden member, unsafe source, ambiguous legacy interval or acceptance prevents qualification. The helper scans original source metadata, before public audit projection drops calls. It does not reinterpret legacy `ended` as explicit end: the derived descriptor records actual failure/end indices separately.

Qualified physical state is `closed` (known terminal completion). The item remains a suppressed `legacy-fragment` with zero model messages, no exchange, no replay/replacement reference and no seed exchange. Existing source consumers were inspected: state protection still independently protects session/current input, pending humans and unsettled delegations; replacements explicitly reject `legacy-fragment`; seed selection requires non-fragment item kind and accepted exchange completion separately. Current source protection is asserted at the real IC-A context snapshot owner, not inferred from projection alone.

## Connected controls and persistence distinctions

The final actual Chat suite includes:

- Text, text+tool and reasoning-only automatic retry: two physical sends, unchanged original payload, one action, distinct step attempts, failed/completed physical settlements, one acceptance/calibration, usage once per physical response, and zero failed-batch effects. Actual reasoning facts are asserted.
- Two consecutive discarded tool/text failures followed by success, with an earlier accepted tool effect exactly once; retry payload stays identical and attempt ordinals remain `[1, 1, 2, 3]` across the first accepted response and next original action.
- Ordinary next submit and actual close/cold reopen follow-up, with failed audit retained but absent from wire.
- Real pending human admission, a new equal-text typed current source (the fixture's current sections are empty), changed tool surface, and changed client binding all stale the candidate. No guard is relaxed.
- Event-barrier-driven genuine Stop during the 10-second capacity wait: one reservation/send, prompt cancellation. Existing allowance-one cases still refuse. A controlled monotonic-clock advance expires the actual original deadline, without sleeps or budget reset.
- A positive accepted-tool dispatcher control demonstrates that the effect counter can increment.
- Actual prepared retry plus throwing usage observer retains the same original provider Error as cause, emits usage once, settles the local call, accepts nothing, and performs no second send. Standard Chat error/cancellation/usage tests remain passing.

Nine managed persistence controls distinguish three outcomes for each result/audit/end save:

1. **Committed but acknowledgment unknown:** no reopen while unknown; one original operation, one failed usage, original provider cause retained. After restoring the real reconciliation path, the original committed operation and captured results settle, the session closes, and cold follow-up succeeds without replay/effects. This is the qualified post-fault recovery path.
2. **Unknown and never written:** the pending original operation prevents a second send/action. When the backend can prove absence, that does not authorize automatic reissuance. The existing source remains recovery-required and close is refused.
3. **Known absent immediately:** the held existing source prevents a fresh action from bypassing its missing audit/result/end. Original results that were captured before an absent audit may still drain. The missing/late evidence remains conservatively unresolved in cold history.

The six final unresolved synthetic journals are copied byte-for-byte with source paths and hashes in [retained-negative/index.json](evidence/retained-negative/index.json). For example, absent audit `sess-mvlcm4s1-787dfi` retains call15, failure18, end19, result21; unknown-audit/then-absence `sess-mvlcm4m9-fts3os` retains call15, failure17, end18, result22. Those results are late, so they cannot qualify as known terminal audit. Missing-result cases lack a result; missing-end cases lack the actual end. A preliminary source-level inference that absent audit would necessarily close the tool unit was withdrawn after this measured order proved otherwise. No rejected-boundary workaround or new capture API was added.

Text-only absent audit has no persisted audit item from which to derive a terminal-audit proof; it must not be described as a proven persisted closure. Live source recovery holds and durable structural classification are separate claims. Broader management of the original captured operation's explicit `retryAbsent` remains a named persistence/recovery-owner obligation. This packet does not claim that permanent absence or an unknown write can always be made recoverable automatically.

## Validation receipts

All qualification commands were sequential with maxWorkers2/minWorkers1. The final runtime commands ran UTC2026-10-23 19:13:00 through19:14:04. Every final command's before/after source hashes matched. [commands-index.json](evidence/commands-index.json) contains exact cwd, command, UTC, exit and mutation comparisons; individual `*.raw.txt` and `*.sources.json` retain raw outputs and modified sources.

| Gate | Result | Receipt |
|---|---|---|
| Entire core-session |558pass,0fail; exit0|`final-session.json`, `final-session-tests.json`|
| Entire core-agent |397pass,35fail/432; exit1; one unhandled rejection|`final-agent.json`, `final-agent-tests.json`|
| Chat terminal + partial retry managed suites |31pass,0fail; exit0|`final-connected.json`, `final-connected-tests.json`|
| Seam retry/failure/policy suites |27pass,0fail; exit0|`final-seam.json`|
| core-session typecheck |exit0|`final-types-session.json`|
| core-agent typecheck |exit0 after literal type correction|`final-types-agent-corrected.json`|
| session-executor typecheck |exit0 after same correction|`final-types-executor-corrected.json`|
| llm-seam typecheck |exit0|`final-types-seam.json`|

The first complete owner gates and intermediate incorrect fixture/type assertions are preserved. In particular the first new current-protection test incorrectly queried history state rather than IC-A snapshot protection; the corrected test uses `captureContextSnapshot`. The absent-audit test now asserts original result ID/name/disposition once plus held audit recovery separately. A failed typecheck caught `isError` widening to boolean after capture extraction; the final type-only literal correction preserves identical emitted runtime bytes. No failed receipt was relabeled a pass.

[Final failure comparison](evidence/failure-comparison-final.json) uses exact file/fullName keys from IC-A's retained immutable baseline population. Zero new final failure names. Six previously failing `model-recovery.test.ts` cases now pass: timeout discard; audit/earlier-effects safe retry; duplicate-ID refusal after discard; exhausted retry closure; exhausted partial audit; cancellation on retry. The other35 Agent failures remain, grouped as agent8, context-recovery8, deep-context-request5, model-policies4, owned-budget3, reasoning-streaming3, context-snapshot2, context-effect-freshness2. The separate semantic-fork baseline failure was not in this packet's owner gate and is not claimed fixed.

The unhandled rejection was not assumed baseline from appearance. A bounded exact-BASE/current comparison ran only the two overlapping-followup tests, on this sole checkout. The script saved all modified tracked production bytes, restored each from exact80ad360f Git blobs, ran fresh Vitest, and restored every original byte in finally before the current selection. Added runtime helpers remained unreachable because their only import/export parents were restored BASE files. [baseline-overlap-binding.json](evidence/baseline-overlap-binding.json), its script, raw logs and before/after maps preserve this proof. Both runs produce the held-final-flush `CONTEXT_STATE_AMBIGUOUS` failure and one `FACT_CANCELLED`→`FACT_CLOSED` rejection from budget/finalization. The fixture rejects its overlapping second run and releases the first in finally, but exits before awaiting that first run, which subsequently reaches its old closed source. This is an unchanged concurrent-owner/fixture-teardown issue, not a repaired case; neither the fixture nor concurrent-owner behavior was changed.

## Changed assertions, self-review, limits

- Successful-only usage expectation in model-recovery now asserts failed100 then successful7. Known local terminal batches now assert precise aborted results, retaining zero-dispatch/effects and no replay.
- The old connected test intentionally expecting stale refusal for partial retry was removed from the old suite and replaced by stronger successful recovery plus real pending-human/current/surface/binding refusal controls in the new suite.
- The provider-usage observer test now asserts the approved AggregateError containing the original provider cause and observer failure; once-only report/send/no-acceptance checks remain.
- Self-review checked source validity, full original call/result/dispatch visibility, failure/end association, deferred original captures, once-only audit/usage, Stop, native audit fields, accepted-effect isolation, source consumer acceptance checks, exact failed-name population and physical/Git binding. No recursive reviewer was used; root supplies independent review.
- All tests use synthetic loopback or existing local fixtures. Native signed continuation cross-product, future IC-B live instruction dependency acknowledgment, IC-C large-result paging/reduction, actual child/caller integration, unified events and whole-version/R6 publication remain separate obligations. No additional format transition, public execution capability or currentness exception was introduced.

## Review fix round1 — R5-R1 and R5-R2

Current status: both requested findings implemented and committed; ready for the same reviewer's exact-range recheck. This section supersedes the original report's HEAD/status for current work, while preserving its historical evidence and limits.

- Fix BASE: `24f5794cd9fbc306554628949fbe48ca5b7cf816`.
- Fix HEAD: `732a5201bdc7f17c60d75df0f9594a59390205a6` (`fix(recovery): retain retry cause before reasoning settlement`).
- Exact fix range: `24f5794cd9fbc306554628949fbe48ca5b7cf816..732a5201bdc7f17c60d75df0f9594a59390205a6`.
- Same isolated current checkout and branch, clean after commit. Four owned files changed: model-step, its failed-attempt tests, failed-audit helper, and connected partial-retry tests. No other checkout, agent, authority, policy, journal or capture API change.

**R5-R1:** The reviewer's pending-reasoning probe identified a real ordering gap: `accept()` flushed pending reasoning before consuming the waiting-event's original provider failure. This fix consumes the genuine association immediately after the authoritative Stop check and before publication checks. Those checks and any applicable preliminary flush preserve that provider cause when they fail. For a retry being settled, pending reasoning is no longer flushed preliminarily: it belongs to the existing cached failed-settlement operation, which reports usage once before its required saves. Final `settle()` joins the same failed-settlement promise when one exists, rather than calling reasoning flush again. This also prevents a synchronous lifecycle throw from initiating another reasoning-save call during outer failure/finalization reentry.

The local regression runs the actual retrying client through model-step with pending reasoning, usage12, then a retryable original provider error. Synchronous reasoning-save throws and rejected save promises preserve the original provider Error as cause and retain the saving Error; the waiting association is consumed once, usage is reported once, send/save counts remain one after repeated fail and settle calls, and no acceptance/tool effect appears. Copied waiting events retain no original association and do not guess a provider error. A Stop that is already active before handling waiting remains the original Stop; usage remains available to the outer failure owner and no new send occurs.

The actual managed Chat persistence matrix now also covers reasoning saves that are committed-but-unacknowledged, unknown/unwritten, and known absent. Before the fix, all three failed the original-cause assertion; afterward, all three preserve original provider identity, one usage report, one original save issuance and one HTTP send. The committed operation genuinely reconciles, preserves the exact original reasoning once, closes, and permits cold follow-up. Unknown/absent cases remain held, with the same explicit-recovery limitations documented above. All twelve save controls additionally assert zero acceptance, dispatch and calibration before recovery.

**R5-R2:** `failedAuditEvidence()` now returns its empty result immediately when the existing structural steps contain no explicit failed/unaccepted candidate. That avoids the extra whole-archive interval/call/result maps in ordinary histories. Candidate histories still run the complete original-source proof, including hidden/late contradictory evidence. No global cache or benchmark was introduced, and no latency improvement is claimed as measured.

### Fix RED/GREEN and source binding

- [round1-red-reasoning.raw.txt](evidence/round1-red-reasoning.raw.txt): four local RED controls at fix BASE. The provider cause was lost for synchronous/rejected saves; copied/Stop cleanup also exposed repeated synchronous save calls.
- [round1-red-managed-reasoning.raw.txt](evidence/round1-red-managed-reasoning.raw.txt): actual Chat baseline selection, three failure-provenance REDs and the already-passing successful reasoning control. The bounded baseline script saved/restored both changed production files in finally, using their exact24f5794c Git bytes. [round1-red-base-binding.json](evidence/round1-red-base-binding.json) records those byte comparisons and the actual product status; no MAIN/sibling runtime was used.
- `round1-green-reasoning-actual` and `round1-green-managed-reasoning` pass their corresponding four-case selections. The earlier misnamed `round1-green-reasoning` remains exit1: an editing script had a syntax error before product mutation, so that command reran unchanged RED source. It is not claimed GREEN.
- The reviewer's original strip-types setup-invalid attempt remains unchanged and correctly classified in [reviewer-reasoning-provenance-probe.md](evidence/reviewer-reasoning-provenance-probe.md).
- [round1-commit-source-binding.json](evidence/round1-commit-source-binding.json) binds all four physical files directly to their final covering test before/after SHA256 maps and BASE/HEAD Git blobs. No post-test type-only exception is needed for this fix.
- [round1-commands-index.json](evidence/round1-commands-index.json) lists exact commands, cwd, UTC, exits and source mutation comparisons. Tests used maxWorkers2/minWorkers1, ran sequentially, and final before/after maps match. No broad owner suite was repeated.

### Affected final checks

| Check | Result |
|---|---|
| failed-attempt + model-recovery + provider-usage + retained-boundaries + reasoning-streaming |38passed,3existing failures/41; exit1|
| failed-audit + conversation-projection + conversation-state |84passed; exit0|
| Chat terminal + partial-retry connected suites |34passed; exit0|
| Strengthened no-acceptance assertion across original save cases |12passed; exit0|
| core-agent, core-session, session-executor typechecks |all exit0|

The three focused Agent failures exactly match the previous retained `reasoning-streaming.test.ts` names and assertions: historical atSeq4 versus actual5, and two old `agent aborted` message expectations versus the actual Stop message. [round1-failure-comparison.json](evidence/round1-failure-comparison.json) contains the exact comparison and zero new failed names. No unhandled rejection occurred in this focused selection. The original35 broader Agent failures, previously reproduced overlapping-run unhandled rejection, explicit `retryAbsent` management, and other version/integration obligations remain visible; these targeted checks do not rerun or waive them.

Self-review confirmed Stop precedes provenance consumption, copied events confer no association, pending reasoning enters the single cached settlement, usage stays once-only, native audit and existing audit/result/end fault cases still pass, and R5-R2 does not bypass full proof for any failed candidate. The same reviewer must assess this exact fix range before root acceptance.
