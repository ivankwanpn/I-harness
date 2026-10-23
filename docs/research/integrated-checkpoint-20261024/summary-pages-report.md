# Task 3 / IC-C — hard-pressure complete groups and recorded-source pages

Status: implemented and verified; ready for root's independent review/integration. This is not whole-version completion.

- BASE: `807d2cc082632544034aa13bbd8a75d2b952fcf0`
- HEAD: `97cdda489394cbac61300e4d744db79579174bc2`
- Owned range: `807d2cc082632544034aa13bbd8a75d2b952fcf0..97cdda489394cbac61300e4d744db79579174bc2`
- Branch: `codex/context-summary-pages-20261024`
- Runtime/worktree: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main`
- Commit: `fix(context): page complete selected sources under hard pressure`
- Working tree after commit: only untracked `.task3-evidence/`; all 15 owned source/test files committed. No MAIN runtime, merge, push, release, version, retention threshold, or model-window change.

## Behavior and scope

C3 preserves ordinary latest-exchange retention. The one reduction driver first tries ordinary eligible runs, keeping the existing tried set. Only a currently prepared baseline with `capacityFit === 'no'` can select retained complete, unprotected tail groups. The replacement must still pass actual full-request preparation, measured progress, source-current proof, and existing publication. Manual, automatic, and recovery paths use that same driver. No-op summaries never publish.

C4R keeps fitting full-source requests and existing partitioning between separable groups. One oversized indivisible group uses an immutable ordered segment representation in the existing summary loop. The shared encoder enumerates visible reasoning, assistant/user/tool/content-part text, canonical call arguments, and indivisible media, preserving native semantic order checks. Each text fragment identifies the original group/item/message/field/part/call, exact UTF-8 range, total length, and SHA256. Empty ordinary segments have explicit zero-length markers. Lone UTF-16 surrogates that cannot be represented faithfully as UTF-8 are explicitly refused rather than silently replaced.

Pages are neutral user data, with explicit partial-scalar/non-executable framing. The original closure/coverage/provenance metadata remains recorded data. Image descriptors stay intact with identity and association metadata; no binary slicing or text substitution. The ledger validates the page digest, exact original segment/range order, contiguous offsets, manifest coordinates, and media occurrence before advancing. No whole-group result is returned until the last segment is covered. The final page checkpoint is the final summary; there is no merge call.

Initial text packing is at most 65,536 bytes, preferring segment boundaries. Each actual candidate includes its checkpoint, directive, inherited system/tools, and metadata and is assessed through `prepareSummary`. A page with unavailable final capacity cannot send. At most two measured local sizing corrections are allowed; `ReductionAttempts.summarySizingCorrections` preserves that allowance across stale rebuilds. Page malformed-output retries share one corrective round across pages. All sends retain the original shared call/action/deadline machinery, at most eight calls, and three stale rebuilds. Provider-backed page acceptance requires the existing physical accepted-piece observation; neutral custom clients are explicitly local evidence only.

Owned product files are context-engine `reduction/{run,selection,contracts,source}.ts`, compaction `summary/{source,generate,pages}.ts`, and `prepared-summary.ts`. No other product owners changed. Tests are in those packages and the qualified Gateway fixture.

## Additional currentness-owner authorization

Root explicitly authorized the narrow extension to `context-engine/src/reduction/source.ts` after new paging negatives exposed a pre-existing gap. The prior guard compared owner/branch/epoch/surface and selected groups, but ignored current typed rules, pending admissions, and unresolved work outside the selection. Seven new unit cases first failed causally; actual rule/human changes during paging could otherwise complete a replacement.

The existing owner now compares:

- Typed current-floor source identity and semantic digest, including same-text replacement at a new source identity.
- Pending input IDs and non-item-owned protection source refs, including promotion/re-admission changes.
- Unsettled delegation IDs and authoritative unresolved call/effect facts.
- Active protected inputs with admission evidence, including admitted inputs already consumed into their mirror.

It deliberately does not compare global semantic revision, archive length, or protection revision. Item-owned protection refs are handled by selected-group checks; ordinary compatible retained suffixes remain reusable. All five existing `ownership-order.test.ts` cases pass, including legacy user-message suffix reuse and current full-request remeasurement. Actual pending-human and runtime-rule changes invalidate every first-page attempt and exhaust the existing three stale rebuilds after four calls, preserving originals/current inputs and publishing no replacement. No core-session owner changed.

## Causal Gateway evidence

The immutable donor remains byte-identical:

`C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main/packages/desktop-gateway/test/repeated-growth-diagnosis.test.ts`

SHA256 `9fb750a75ec847dc97dd95d16e7ec7668b65d919bcb8208805f9a34fb93cec68`.

Its qualified copy is `packages/desktop-gateway/test/context-summary-growth.test.ts`. Before product edits, the original parallel24 diagnostic reproduced actual refusal on BASE: 24 original reads/results, zero replacements, one main request, and a `prompt_too_long` error reporting 411,070 input / 20,000 output reserve. The historical refusal assertions passed; this records the causal failure rather than claiming success. Raw baseline is retained under `.task3-evidence/baseline/parallel24/` with `baseline-vitest.json`.

The strengthened variant replaces eight middle CJK characters per file with an eight-character unique CJK/fullwidth fact. Every file remains exactly 6,000 JavaScript code units and 16,800 UTF-8 bytes, safely below unchanged inline/spill thresholds. The task explicitly requests every fact. The response generator extracts facts only from the current received wire request plus its incoming previous checkpoint; the independent accumulated receiver ledger is used only for assertions, never replies.

Final Gateway run: 3/3 passed, no watchdog. Every original read executes once; cold original envelopes equal warm originals; no prune/result-ref manufacture. Both 24 cases complete the task and cold follow-up with one committed replacement each. All 24 middle facts occur exactly in the final checkpoint, initial final answer, and cold final answer.

| Final oracle | Original reads/results | Replacements | Physical summary calls | Summary preparations | Cold follow-up |
|---|---:|---:|---:|---:|---|
| Original parallel24 shape | 24 | 1 | 8 | 9 | complete |
| Middle-fact parallel24 shape | 24 | 1 | 8 | 9 | complete, all 24 facts |
| Repeated60 | 60 | 20 | 20 across distinct reductions | 20 | complete, all 60 completed reads visible |

For each 24 case, preparation 1 is the refused full summary: 454,987 actual JSON body bytes, 412,183 projected-heuristic input, 100,000 window. The remaining eight are admitted page candidates; there are zero local sizing corrections, zero malformed retries, and no additional merge call. These are nine preparations, not nine physical calls.

Independent raw-wire reconstruction verifies 50 ordered segments and **407,568 UTF-8 source bytes**: 403,200 original result-content bytes, 816 result JSON framing bytes, 518 canonical call-argument bytes, and 3,034 visible reasoning/assistant bytes. Source digest/group coverage stay identical across pages; the eventual replacement coverage equals the original manifest coverage. Ranges, hashes, complete text, call IDs/names, neutral coordinates, and source order are checked independently of product projection helpers. The first resumed main request is rejected by the receiver unless all expected segments have arrived.

Middle24 final page measurements:

| Page | Source text bytes | Actual request body bytes | Projected-heuristic input | Actual output cap |
|---|---:|---:|---:|---:|
| 1 | 54,054 | 143,654 | 79,934 | 4,096 |
| 2 | 50,502 | 119,875 | 70,893 | 4,096 |
| 3 | 50,502 | 119,923 | 70,957 | 4,096 |
| 4 | 50,502 | 119,976 | 71,023 | 4,096 |
| 5 | 50,502 | 120,025 | 71,088 | 4,096 |
| 6 | 50,502 | 120,073 | 71,152 | 4,096 |
| 7 | 50,502 | 120,121 | 71,216 | 4,096 |
| 8 | 50,502 | 120,169 | 71,280 | 4,096 |

The historical donor used a blanket 10,000-token safety addition for both main and summary. Existing product policy already uses main 10% and summary 5% (`admission/prepared.ts`); the qualified oracle now checks those purpose-specific margins. No product margin, cap policy, or window changed. The first development run's seven fragment-filled pages completed but failed that historical blanket-margin assertion; its failed receipt remains under `.task3-evidence/first/`. Boundary-preferred packing is the final eight-page implementation.

### Historical 29 versus current 20 compactions

The final 60-read run completed in about 107.7 seconds with 20 replacements; this does not claim historical 29 was preserved. One controlled exact-BASE source comparison with the same qualified fixture also completed 60 reads and cold follow-up with **20 replacements/20 summary calls** (about 101.0 seconds). All modified product files were temporarily loaded from exact BASE by `git show`, then restored byte-for-byte before further work. The baseline60 command, source file list/backup, and raw receipts are retained. The count difference therefore predates IC-C at the accepted IC-A/R5 base; no policy was changed to manufacture a count. The final regression additionally asserts all 60 completed reads on every cold main request, original effects once, retained envelopes equal, actual fit, and both task completions.

## Verification

All runtime commands ran from the owning package CWD, sequentially, `--maxWorkers=2 --minWorkers=1`. No root broad discovery, real provider/profile, or live user rules were used. Gateway runtime used synthetic HOME/USERPROFILE/IH_CONFIG_DIR plus an actual legacy `node:fs.existsSync` candidate guard for AGENTS.md/CLAUDE.md before user-home instruction reads.

- Compaction full suite: **246 passed, 0 failed** (`final-compaction.json` / `.log`). Includes 25 page controls, original native/image/stream/physical-budget gates, and unknown publication reconciliation after pages.
- Context-engine full suite: **90 passed, 0 failed** (`final-context-engine.json` / `.log`). Includes hard-pressure/no-op/protected-tail and ten source-current cases.
- Gateway qualified original24/middle24/repeated60: **3 passed, 0 failed** (`final-gateway-vitest.json` / `.log`). Raw requests, frames, events, and receiver/preparation receipts per oracle under `final-gateway/`.
- Unchanged retained-source boundary gates `core-session/test/{semantic-seed,semantic-seed-payload}.test.ts`: **13 passed, 0 failed**. Includes consumed 100MiB body/hidden-envelope traps and artifact-ref/media projected-source preservation (`retained-source-boundaries.json` / `.log`). These remain projection boundary evidence, not a new streaming/memory claim.
- `pnpm exec tsc --noEmit` from compaction, context-engine, and desktop-gateway: implementer tool transcript records all **exit 0**. No `final-types-*.log` files were actually retained; the original report incorrectly claimed they existed. See task-3-typecheck-evidence-correction.md for the exact evidence limit. No log files were regenerated.
- `git diff --check` and staged diff check: exit 0.

Negative controls cover missing/duplicate/out-of-order/range/digest/text/manifest corruption; explicit empty/emoji/control-character boundaries and large canonical arguments; opaque-only/native-order gates; exact media preservation with declared local cost and indivisible over-cost refusal; malformed retry range reuse; confirmed overflow spending failed usage/call/sizing allowances; invocation-wide two-correction allowance surviving source rebuild; eight-call exhaustion without replacement; deliberately omitted middle-fact fragment without replacement; Stop/currentness invalidation; and unknown final publication issuing/reconciling once without repeating original tool work. Provider-backed output without physical confirmation cannot certify a page.

## Runtime/source binding and evidence locations

Evidence root: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main/.task3-evidence/` (intentionally untracked, retained for review).

- `final-before-source.json` and `final-after-source.json`: all 15 owned file raw SHA256s and Git blob hashes, eight own-worktree dependency resolutions, runtime directory, branch/base, Node version, watcher dependency.
- Explicit comparison confirms all source files, dependencies, and runtime HEAD unchanged across the final Gateway run.
- `commit-binding.json`: verifies every final tested Git blob equals HEAD `97cdda489394cbac61300e4d744db79579174bc2`, and every working-file SHA256 still equals the tested after-receipt.
- `baseline/parallel24`, `first/parallel24`, `coverage/{parallel24,middle24}`, `baseline60/repeated60`, `regression60/repeated60`, and `final-gateway/{parallel24,middle24,repeated60}` retain successive causal/raw results, not overwritten.
- `current-floor-red.json` preserves the newly discovered currentness failure before its authorized fix.

The checkout's stale installed watcher link was corrected by its own `pnpm install --offline --frozen-lockfile --filter @i-harness/desktop-gateway... --filter @i-harness/compaction... --filter @i-harness/fs-watch --filter @i-harness/instructions --ignore-scripts`. No dependency version/lockfile/patch source changed. Final patch is exactly 502 bytes, SHA256 `e2afb9471a8a2ae78f929484a87567d98dc48d48d873caa329ffcf14c5dc12f0`; installed handler SHA256 is `7b132a2ab051eef27c52983c9c7686cf9b4c66f4ade07de8c82c3f07c06803c1`.

## Limits and review notes

All-content means selected projected content. The generator has no artifact body reader and adds no retrieval references/tools; artifact-backed results stay projected descriptors/envelopes/media. Original inline history remains host-readable through existing APIs, without claiming automatic model reread. Large inline content that cannot finish in eight pages/calls blocks with no partial replacement. The captured source itself can be large; no R6 streaming/memory bound is claimed.

The receiver's usage is deliberately synthetic and follows IH's heuristic; it is not independent tokenization or real-provider recall evidence. Exact byte receipt and the controlled middle-fact test demonstrate separate properties. Natural-model summary accuracy still needs separate evidence.

One expected old refusal assertion was updated from `fixed-input` to `shrink-limit`: a fixed Responses directive now goes through the bounded two local page-sizing corrections, still with zero transport. Tiny fitting sources retain the old full mode. No remaining test failures are known in the affected qualified gates. Independent root review and integration remain outstanding.
