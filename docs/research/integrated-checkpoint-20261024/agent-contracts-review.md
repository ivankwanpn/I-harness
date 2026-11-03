# P3 independent spec and quality review

**Decision: approved for the bounded test-only packet at `f5bf396e0dfff53115c3adf51ef1db8c93bd5751`.** No Critical, Important, or Minor actionable finding was identified in the reviewed range. The approval is limited to the three tests and their stated current contracts; it is not whole-Agent, release, live-provider, or future P2 integration approval.

Reviewer: fresh independent GPT-6.1 Sol reviewer, 2026-10-24. Review range: `07ac8fc9fa0997798e488040966605a1fcb8f0f4..f5bf396e0dfff53115c3adf51ef1db8c93bd5751`. Runtime/source checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`, branch `codex/agent-contract-regressions-20261024`.

## Scope and method

Read the promoted `docs/superpowers/plans/2026-10-24-agent-contract-regressions.md`, this packet's review brief, handoff, task report, full diff, all three final physical test sources, the preserved baseline and failed-iteration evidence, final combined/type evidence, same-name comparison, and source/Git binding. Cross-checked the tested behavior against actual admission, request preparation/fallback and HTTP terminal, reasoning/model-step/response, context/capacity, execution, Session nondurable action/source, conversation outcome, and reduction grouping/currentness/selection implementations.

The saved `review-full.diff` exactly matches the native committed range when regenerated with `git diff --unified=12` (normalizing CRLF only). The complete committed scope is three test files, 209 additions / 60 deletions. No product file, shared helper, timeout, skip, fabricated model metadata, or broad cancellation matcher was added. Native HEAD and branch match the report, and native `git status --short` is empty.

This review used read-only source/Git inspection and receipt/hash checks. No suite was rerun and no new runtime probe was needed: source inspection and retained evidence resolved the questions in scope. The only written artifact is this review report.

## Spec review

### Deep neutral and prepared HTTP requests

`packages/core-agent/test/deep-context-request.test.ts:11-65` retains all four depth/schema combinations (2000/6000, shallow/deep), walks the complete nested argument and applicable schema/result chains to the exact leaf, and completes two calls in the same session. Replacing caller-signal object equality is justified by the actual action/prepared signal composition. The replacement is stronger behavior coverage: the provider observes a real non-aborted signal, aborts the caller on the third invocation, observes the exact caller reason on the owned signal, and yields a deliberately late tool call. The outer test requires that exact rejection object, all three generator finalizers, zero tool execution/dispatch, and no added tool call. An already-stopped followup must leave both send count and the entire event array unchanged.

The neutral snapshot assertions correctly retain `neutral-only`, `admission: unavailable`, unknown cap support and unknown-components confidence. Actual custom-client preparation explicitly lacks protocol/cap authority; calling that path `fit` would have overstated its evidence. The final assertions preserve compatibility without inventing a model capacity domain.

`deep-context-request.test.ts:68-124` uses the real Anthropic prepared adapter, HTTP body serialization/measurement, request control and response reader, with global fetch stubbed in-process. It explicitly binds the selected controlled URL, walks depth-6000 serialized input, checks exact `max_tokens: 2048`, and compares observed HTTP bytes against the actual body passed to fetch. It then checks two successful same-session calls, a third cancelled call with exact composed-signal reason and rejection identity, all three fetch invocations settled, zero dispatch/effects, and no extra send/events after Stop.

The HTTP fit qualification is truthful and sufficiently explicit: configured-budget pressure has `basis: legacy-shared-assumption`, `hardFits: true`, and `targetReady: true`, while admission stays unavailable and the observation remains compatibility/capacity-unknown. This proves configured heuristic fit and applied output cap through the real adapter path under stub fetch. It does **not** prove verified provider capacity or a real network exchange. The historical test title remains unchanged for the required full-name comparison and must continue to be read with that limit.

### Reasoning streaming and cancellation

`packages/core-agent/test/reasoning-streaming.test.ts:21-56` derives the initial coordinate from the provider's actual entry boundary and the original `step/start` sequence. It independently expects `${stepStart}:0`, verifies immediate first publication before the held provider completes, checks the second delta after the 50 ms batch boundary with exact offset/order and unchanged identity/coordinate, and checks canonical full text plus transient-only storage and zero timers. This replaces the obsolete literal event index without substituting the observed output as its own expected coordinate.

`reasoning-streaming.test.ts:82-119` preserves the exact custom AbortError reason on both rejection and composed provider signal, clears timers, compares all observed progress after advancing time, retains the full original reasoning prefix, and verifies a distinct retry stream with offset zero. The unchanged adjacent-block/tool-round/followup case checks six distinct canonical identities and equality with the transient identities; the usage case retains the uninterrupted canonical block assertion.

`reasoning-streaming.test.ts:122-163` handles the run rejection immediately, holds and eventually releases the provider in `finally`, checks exact default AbortError reason identity, requires no publication while stopped, injects late provider reasoning, requires the original full prefix only, verifies the generator settled, and checks no late progress/timers after settlement. Exact reason checks cannot accept an arbitrary save/settlement error. The cancellation expectations are meaningfully stronger than the historical message substring.

### Contradictory effects and freshness

`packages/core-agent/test/context-effect-freshness.test.ts:12-91` now obtains the candidate through actual `createAgentContext`, `createStepInput`, `createRecovery`, and `createAdmission`, using a real NondurableFactOwner action/facts and real settlement-source registration capability. It establishes a closed, unprotected, current reduction group before the contradictory dispatch.

After dispatch, the test requires unresolved exchange / unknown outcome; exact protected item/source identities, including the dispatch source; unchanged item identity; exact dispatch coordinates; changed protection revision with the semantic/branch/epoch/surface coordinates stable; and candidate inequality. Actual Session outcome derivation and unit-state logic support this stronger state. Keeping the original closed expectation would contradict those contracts.

The downstream checks are reached through real implementation boundaries: the admitted prepared request calls the captured `validateBeforeTransport` and must reject `CONTEXT_INPUT_STALE` before the model transport counter increments; actual reduction grouping marks the exchange incomplete/protected; actual `reductionSourceCurrent` refuses the previously selected group; actual run selection returns no replacement candidate. Zero transport and no compaction events are asserted. The reduction coverage is specifically grouping/currentness/selection refusal, not a newly exercised full compaction or summary-model execution. Existing settled-success and pending-to-unknown controls remain intact.

Cleanup closes candidate execution in `finally`, finishes the actual action, joins every registered source with `Promise.allSettled`, and surfaces close failures with `AggregateError`. This is an actual current-API fixture, with no fake FactPorts or probe/fallback for unlanded APIs.

## Evidence and identity review

Independently parsed `baseline-tests.json` and `final-owned-combined-tests.json`, rather than accepting only the report's totals. Both contain 14 assertions; each baseline full name has exactly one exact-case match in final. The five deep, three reasoning, and two freshness failures all become passed; all four original passing controls stay passed. Final JSON has zero failures. No rename, skipped case, or collection/import failure accounts for the result.

The actual baseline raw failures are the five signal-reference failures (including the stubbed HTTP wrapper), three reasoning coordinate/message failures, and two closed-versus-unresolved expectations. The raw failed iterations preserve a premature read of `signal.reason` and the omitted new dispatch source. The additional typecheck failure is the mutable optional candidate's closure narrowing; final code uses stable `admitted` in the stream closure. These are fixture corrections, not new product RED claims. The final combined raw receipt records 14/14 in three files; the final type receipt contains successful `tsc --noEmit` output. The owner report records exit 0 for these source-bound final gates.

Recomputed every physical runtime/copy SHA-256 and all listed evidence receipt hashes from `final-source-git-binding.json`: no mismatch. Independently resolved BASE and HEAD Git blobs and recomputed each runtime file's filtered `git hash-object --path`; each equals the manifest and committed HEAD. The distinction between physical SHA-256 and filtered Git blobs is preserved.

| Test file | Verified runtime/copy SHA-256 | Verified HEAD blob |
|---|---|---|
| `context-effect-freshness.test.ts` | `ba35f960744385bd7bcca80fab546b2a91c1c09089398cd189a17e81c038d1e6` | `f77297d5aa70db03c9695f6a6ccbf3a9e9dd9d99` |
| `deep-context-request.test.ts` | `73b211873b50973b84c837d30ede039160bc3e03f47b7d4eeb7c6238d72d32e0` | `9125d0eb4875f48b3361b9d195cb78fbbfe3e031` |
| `reasoning-streaming.test.ts` | `78422ef30b1ea513b9d1de1aef4196f12053156343225836e8ca0381f28d2ee7` | `5a9b35fe4ac3ce4494a04339c7b91efc47424892` |

## Findings and remaining boundary

- **Critical:** none.
- **Important:** none.
- **Minor:** none.

The known P2 integration obligation is retained, not converted into a defect against this frozen BASE. BASE's actual recovery helper has no `close()` method. When P2 lands, root must name the current inline recovery helper at `context-effect-freshness.test.ts:41`, await its actual close after candidate execution closes and before the retained action/source cleanup, then run the affected freshness/type gate against the real combined code. Current constructor compatibility and real source registration do not prove that future close path. This review neither requires an unlanded API now nor waives that later integration check.

No fix cycle is requested for the reviewed range. If root changes this packet to address a later finding, return those changes to this reviewer with the updated exact range/evidence.
