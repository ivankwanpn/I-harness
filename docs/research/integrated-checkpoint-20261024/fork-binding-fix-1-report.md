# F0 fix round 1 — connected owner correction report

Status: correction committed; source writes stopped for the same reviewer's fresh connected review. This report supplements the original Task 1 report without editing it or its evidence.

Native checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`

Branch: `codex/fork-binding-observation-20261024`

Original BASE: `ca81bdd2ec944105b9fd62534a932336e587179e`

Reviewed NeedsFixes HEAD / correction parent: `ab314b81e70a75c884fa4edf572db567f638357e`

Corrected HEAD: `187eea5545f5ab462e210e168e2db6cb9af1deb9`

Appended commit: `fix(persistence): fence bootstrap and harden observation capture`

The correction changes only `coordinator/binding-observation.ts`, the coordinator facade `src/index.ts`, and the existing `test/binding-observation.test.ts`: 252 additions / 34 deletions. The complete F0 BASE..HEAD remains the same eleven-path owner scope. No amend, recursive agents, remote action, live provider/account, schema/version change, F1 product edits, or native backend implementation change occurred. The four protected retirement directories were not opened, run, edited, staged or removed.

The root review, evidence audit, original owner ledger and root correction instructions were read. The additional capture ruling F0-R1-04 is included.

## Corrections

**I1 — bootstrap/resume metadata admission.** Both facade entry points now participate in Documents' pending session mutation admission before the original bootstrap owner runs or enters its operation lane. An outside callback call synchronously revokes intersecting observations and joins their full lifetimes. Bootstrap-first work marks the ID pending before its first await, so a later intersecting observation immediately refuses conflict instead of waiting on a held bootstrap lane.

The exception is derived only from the current observation callback stack and its exact captured original target invocation. That scope stays current while the original target bootstrap or resume runs; a different invocation or an observed existing identity is refused from inside that callback. Other scopes are not exempted. There is no second bootstrap registry, bootstrap flight cache, schema, or caller-supplied bypass. The original managed/bootstrap registry, request comparison, issuance, journal and recovery remain the owners. Separate retirement admission markers preserve refusal of a later adopter during explicit retirement without rejecting reentry into the original bootstrap flight.

**F0-R1-04 — all original data captured before the added wait.** The existing `captureBootstrapRequest` and `captureBootstrapInvocation` functions synchronously capture the complete request, invocation and optional resume payload before admission joins. The resulting captured values are passed to the original owner. Caller mutation of metadata, lineage, seed, target, operation ID or session ID while the join is held cannot redirect work to another unrevoked observed identity. Malformed/accessor request refusal remains with the original owner without executing those getters.

The first full JSONL run exposed a related capture-timing regression in target preparation. The correction now uses the existing `captureBootstrapTargetPreparationPort` utility to capture preparation presence/absence and method references before the new wait. Other guards forward to the original receiver; live Stop and source checks remain live. All existing preparation capture, method receiver, absence, malformed-port and Stop tests remain unchanged and pass. The facade's `openManagedDocument` admission refusal now returns a rejected Promise, matching its declared API and preserving the pending-bootstrap refusal controls.

**I2 — bounded indexed capture.** The request and supplied ID array reject proxies before prototype/descriptor inspection. The supplied array must have the ordinary Array prototype. Its own length and each enumerable numeric own data descriptor are checked, then copied by numeric index; the caller's iterator is never consulted. Sparse/accessor/extra fields are refused, and the captured count is checked again against 64 before any native acquisition. IDs still undergo safe, distinct and target-exclusion checks.

**I3 — signal brand and lifetime.** The module captures the standard AbortSignal aborted getter and EventTarget listener methods. Brand validation and every later aborted-state check use that getter. Listener installation/removal use the captured methods with the genuine receiver, ignoring instance overrides. Installation is inside the acquired scope's settled lifetime after cleanup is assigned. Removal is part of disposal: even a throw there is collected while all document leases and pins are attempted; completion settles with cleanup debt rather than remaining pending. This retains the existing same-capability disposal retry behavior. Tests force instance method/accessor overrides, not a genuine native EventTarget or kernel syscall failure.

## Causal evidence and controls

All evidence for this round is under `evidence/fix-round-1/`; the original subtree is read-only.

`all-findings-red-corrected` ran with product source still at `ab314b81...`: 12 failures, one preexisting index-accessor control passing, 32 older tests skipped. It reaches these actual behavioral failures:

- Valid external JSONL existing-empty ancestor bootstrap leaves the observation guard current; pending bootstrap makes an observer wait on the bootstrap lane; original resume after an unknown header response also leaves its observation current.
- An Array subclass's unchecked iterator yields 65 IDs and reaches unavailable instead of input refusal; changed-prototype and proxy arrays are accepted. The ordinary numeric accessor control was already refused.
- Genuine signal add overrides strand close, remove overrides reject the observation after acquisition, an aborted getter override executes, and a shadowed false value lets a genuinely pre-aborted signal run.

The source-paired `i1-green`, `i2-green` and `i3-green` receipts pass their relevant controls. `all-controls-green` passes 81 affected owner tests (47 observation controls plus ownership/managed/strict document tests).

Additional I1 controls preserve the actual original existing-empty target's shared bootstrap flight and same-owner recovery after an actual header write whose response is replaced with unknown. Target profiling stays absent and target ownership remains live after observation cleanup.

F0-R1-04 adds two held-admission controls, bootstrap and resume with optional payload. They use a genuine nonempty semantic source, two disjoint real observations and a valid second existing-empty identity. While the first observation keeps admission waiting, the caller mutates invocation/session/operation, metadata, lineage, target and seed toward that second identity. The fixed code returns the original invocation's receipt, original metadata/seed and cold semantic messages; the second observed file remains byte-identical and current.

`r1-04-counterfactual-red` is explicitly a temporary source-cut experiment, not an ab314 failure claim. It keeps the admission fence but forwards uncaptured request/resume arguments after the wait. Both tests fail with actual ready receipts for `other-ancestor` / `mutated-operation`. The original helper bytes were restored in a finally block, and `r1-04-restored-green` passes both unchanged controls. The source-cut and restored sources/manifests are retained. The new observation file totals 49 passing controls in the final full run.

I3 override controls emit wrapper-local records in stdout for add/remove methods and accessors plus the aborted accessor: override calls 0, callback calls 1, final native-wrapper live count 0, close result `closed`. They also perform a subsequent metadata mutation and ordinary close/reopen drainage. Separate controls verify native pre-abort refusal before acquisition and actual active abort revocation despite shadowed methods/getter. These are local counters over actual native acquisitions; they are not an OS-wide handle census or proof of a forced kernel CloseHandle failure.

## Preserved failures and corrections

- `all-findings-red` is the first 12-failure run. Its bootstrap-first fixture waited indefinitely for an observation queued behind its own paused lane, and the resume fixture's small incomplete header did not reach observation callback entry. Test/hook timeouts are retained. The corrected bootstrap-first test uses a bounded race and always releases the paused original operation. The unknown-response fixture uses a valid large title so actual JSONL's supported header-only profile path can capture the pending ancestor's metadata; it explicitly verifies that profile before starting the observation. No product change separates these two RED runs.
- `final-types-1` and `final-types-2` retain TS descriptor-array inference errors and the Array subclass generator return-type error. Corrections are type-only (`supplied as object` for descriptors; explicit undefined generator return), with no oracle weakening.
- `full-jsonl` retains 259 passes / 5 failures: the four preparation capture timing controls and the pending-loader synchronous refusal. Its hook timeout follows the synchronous refusal preventing the test's release call. The original tests were not edited. `bootstrap-interface-green` then passes all 58 original bootstrap physical tests after the helper/facade correction.
- `r1-04-capture-green` is a failed fixture receipt despite its name: both cases omitted the actual session header when deriving cold bootstrap messages, producing `Invalid semantic seed`. The corrected fixture passes `cold.meta`; the product source does not change in that pair.
- Earlier full persistence receipts show 242 passes and the same original F1 RED before the two additional held-admission tests. They are retained alongside the final 244-pass receipt.

## Final source-bound validation

Every new test/type gate has `command.json` recording the exact executable, argv, package CWD, UTC start/end, process exit status/signal and explicit test worker values. The runner uses direct argument arrays, snapshots all eleven owner files before launch, and keeps raw stdout/stderr separately. Vitest runs were sequential; the two independent typechecks ran in parallel. No old receipt was rewritten to fill historical gaps.

| Final gate | Result |
| --- | --- |
| `handoff-persistence` | 244 passed / 1 unchanged original F1 RED; 31 files passed / 1 failed; exit 1 |
| `handoff-jsonl` | 264 passed; 21 files passed; exit 0 |
| `handoff-types-1` | persistence `exec tsc --noEmit`; exit 0 |
| `handoff-types-2` | JSONL `exec tsc --noEmit`; exit 0 |
| `handoff-diff-check.exit` | 0; stderr only Windows line-ending conversion warnings |

The persistence failure is still `semantic-fork-baseline.test.ts:40`, exposing `CONSUMED-PROOF-ONLY`. Its oracle, fork.ts, seed.ts, the core-session tree and fs-lock tree are unchanged against original BASE; `f1-paths-unchanged.patch` is empty. No BASE rerun, oracle edit or waiver was added. JSONL's expected injected journal-close diagnostic remains visible in stderr.

`final-gate-source-comparison.json` verifies all four final gate manifests match the current physical bytes. `committed-source/manifest.json` records physical hashes, canonical Git-blob hashes and explicit CRLF-to-LF comparison for all eleven files at corrected HEAD. Every physical file equals its final-gate copy, and LF-normalized bytes equal the committed Git blob; this is not a claim of raw physical/Git byte equality where Windows line endings differ. `fix-range.patch/stat` covers the appended correction; `full-base-head.patch/stat` covers the connected eleven-file F0 range.

`original-preservation-after.json` independently rechecks all 295 original evidence entries for byte count/SHA256, verifies the original report and manifest hashes, and finds no extra old-subtree files. Original report SHA256 remains `8d494615dd60f67a1af065ae593f64bf114567abbd8b0897713500e78370d6d1`; original manifest SHA256 remains `18ab5f97557fd54c72f1e9b205fbd45c684111c4bcbaa6b92a29072bfdd0637a`. The original audit's historical command/source/environment limitations remain unchanged. The new receipts attest this runner's launches and current source binding, not a full dependency/runtime snapshot, independent authorship, or a signed trust anchor.

## Handoff boundary

Source writes are stopped at `187eea5545f5ab462e210e168e2db6cb9af1deb9` for the same reviewer's fresh full `ca81bdd2..187eea55` connected owner review. The packet is not owner-approved or shipping-complete merely because the correction checks pass.

F1 still requires the actual production acquireCliForkTransfer caller, stdio request, nonempty catalog/member transfer, cold ordinary target read, original-invocation adoption and final vertical-range reachability. This round's semantic seed has an empty external dependency closure. No fake production caller, reachability waiver, native backend rewrite, decomposition or version/storage-format change was introduced.
