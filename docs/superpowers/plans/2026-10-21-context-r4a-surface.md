# R4A — Retire inactive registry spill and narrow private package surfaces

Approved for bounded implementation after structural acceptance c1b1a8d7dfcb2bd47fb0413b1a022a18d8d15eeb and the complete amended preflight/source rebase. See [preflight and amendment closure](../../research/context-r4a-surface-preflight-20261021/preflight-review.md) and [accepted-source rebase](../../research/context-r4a-surface-preflight-20261021/accepted-source-rebase.md). Original R4A requires new shipping results to use mandatory owned retention and retire the old optional registry spill path. The unchanged normal graph still reports six unused package exports. This unit addresses their actual ownership/consumer state, never a fake consumer, new audit exemption or baseline reseed.

User authorizes continuous root-led ContextEngine work with GPT6.1Sol writers/reviewers, one product writer and no recursive agents. Product0.1.13-rc.1 / Session10 stay unchanged. No release, live provider/profile/installed-app actions or unrelated broad R5 refactoring.

## Evidence and behavioral boundary

Read the complete surface-retirement-map at [tracked source retirement map](../../research/context-r4a-surface-preflight-20261021/surface-retirement-map.md) and the original R4A full-retention/data/compatibility contracts. At source inspection both core-session/output-retention packages are private. Current shipping assembly already installs mandatory result finalization independently of outputSpill; the option is inert TypeScript plumbing and its mounted-by-default comments are stale. No actual serialized setting or command-line flag reader for this option was found; recheck all maintained sources before retirement.

This is deliberate removal of inactive internal API/plugin code, not a source-equivalent move or a change to the live shell/native compatibility path. If final rebase discovers a real caller, plugin installation path, serialized setting or supported public contract, report to root before removing it. Do not infer inactivity solely from one grep or a tool's unused label.

## Step1 — Narrow unused private barrel names

Retire unused root reexports ExecFrameRecord, JsonStreamOptions, ResultCaptureOptions and ExecFrameCaptureOptions while KEEPING their defining parameter/record types and all actual codec/stream/capture behavior. Localize declarations only after checking cross-module imports. Public codec/factory functions and their inferred parameter/return shapes remain intact; no fake alias or token consumer is needed.

Retire the redundant root validResultEnvelope name while preserving all actual internal validation in validRetainedResultRevision and validateResultFact. Determine the smallest test adaptation through existing real public fact/admission/decoding validation and exact typed envelope branch; do not add another production validation call only to satisfy reachability. The Desktop authority test must keep exact child/teammate read and complete Code values, dispatch/outcome and bounds; a preview or whole-envelope substring is not a replacement oracle. Existing strict malformed-envelope/format controls remain required.

Concrete Gateway migration: use SDK HistoryRange/core-session SessionEvent for the actual RPC history, narrow real tool/result + present envelope + inline retention. A cast alone is not runtime validation. Using the existing public createSession/append/toJSONL/fromJSONL pattern in core-session/test/result-envelope.test.ts, validate the genuine returned matching tool/call and tool/result DTOs/callIds in a test-local session and round-trip the validated selection if claiming cold validation. This is DTO/intake validation of test copies, NOT a complete original child history or a new F1/managed authority proof. Do not treat an arbitrary paginated/hydrated slice as a complete session or strip required witness fields to make a subset pass; use an available complete original child snapshot/header/public codec path if its native/context dependencies require that. Preserve exact complete read/ordinary-Code/team-Code text, textRetention flags/counts and succeeded/dispatched plus serialized bound. No private defining-validator import, fake RetainedResultRevision wrapper, replacement alias/shadow guard or production call just to consume an export. Real history already uses coordinator snapshot fence and transportSessionEvents; keep original malformed/accessor/conflicting/version intake/cold controls.

No new public exports, package version bumps, permissive overloads, second DTO definition or duplicate validator. Describe changes to these private package surfaces honestly instead of claiming every exported name remains unchanged.

## Step2 — Retire the unused registry guard as one responsibility

After confirming the maintained call graph, remove the dead createOutputSpillGuard implementation, OutputSpillGuardConfig, its copied model-visible estimator/fit cascade/exemption helpers, and dead gcSpillStore/createUnifiedSpillStore adapters/reexports. They have no role in decoding historical results. Do not leave the same unreachable plugin under another name, revive the optional fail-open path, or introduce a new cleanup owner to consume it.

Remove inert outputSpill imports/type fields/options/pass-throughs in assembly/service, CLI RunOptions/headless/SDK/ACP and Gateway, with accurate comments for existing mandatory finalization where useful. This is no-op plumbing retirement; do not alter model resolution, permissions, native source capture, saved quota/root/current source, lifecycle/close or standalone nondurable registry semantics. Preserve supported actual settings; no data/session migration is presumed.

Keep the distinct LIVE APIs and data paths:

- createTextRetainer, createSpillStore, spillNotice, SpillStore/SpillStoreOptions used by shell's explicit per-tool retention/spill configuration.
- Exec OutputCollector standalone fallback, existing pre-spilled stdout path reuse/no second copy, stderr-only semantics, native metadata and managed raw-frame capture.
- Historical raw output/outputPaths/spill/notice/code content, literal8/9 decoding and upgrade, legacy context result fields, renderer raw/path presentation and explicit file search/read behavior. Do not rewrite old facts into managed refs, infer completeness, rematerialize old data or delete historical temp files.

Retiring a GC implementation does not authorize running it over real old files. Before ANY baseline old guard/GC test import, isolate subprocess TEMP/TMP as well as IH_CONFIG_DIR under a fresh SHORT task-owned root; old constructors default to tmpdir()/i-harness-spill and may prune there. Prefer explicit fixture spillRoot where the contract permits, and verify actual effective default tmpdir is task-owned. Do not change global machine/user environment or inspect/clean real old spill storage.

Make isolation mechanical: create existing temp/config children of the new task root, pass TEMP/TMP/IH_CONFIG_DIR in the native subprocess launch environment, and run a pre-import assertion with the SAME executable/environment that resolves effective os.tmpdir()/config absolute paths and checks containment under that fresh root. Record those paths/native result before the first old/default-constructor test import; workers/child processes inherit them. A beforeEach is too late (old SDK/ACP test imports index.ts at module load), and workspace mkdtemp alone is insufficient. Explicit GC spill roots are separately checked task-owned. Join started GC and fixture work before validated cleanup; no global user environment edits or real old spill enumeration.

Recheck package dependencies. Remove only truly unused production dependencies, preserving necessary declared test dependencies through normal package/lock changes; no deep cross-package production import to conceal a missing dependency.

Concrete dependency boundary: output-retention still needs core-session/core-tools/context-output/exec for live production/types. core-plugin/diagnostics currently belong to the dead guard and old tests; remove production rows only after final test placement is known, or keep ordinary devDependency where a surviving package-local test needs one. Update normal lock importer rows coherently. Existing core-agent synthetic-retention deep-imports output-retention and output-retention synthetic-bound deep-imports guard-timeout without declared dependencies; do not copy either into production. Prefer actual composition integration in executor tests with its existing declared dependencies, or add correctly scoped test dependency. Test-only access to an established shared fixture is explicitly labeled. Re-run real normal graph/import checks; no baseline/allowlist edits.

## Step3 — Honest test-contract migration

First inventory every affected original test's intent and disposition. Preserve native baseline/setup failures and original source identities. Do not make obsolete expectations green by restoring raw/unbounded shipping output, magic timeout exemptions, 2000byte mandatory caps, hidden disk owners or duplicated raw temp storage.

- Real headless run/service modelBindingFor/modelBuilder/SDK/ACP/Gateway controls must observe actual mandatory finalizer/F1/model/archive behavior, trusted outcome and ordinary64000serialized-byte bound. Complete program values can remain large; they are not model/history payloads. Use a real durable owner when claiming full recoverable body, otherwise assert truthful unsupported/unavailable. Replacing an old option-presence spy with another spy does not prove shipping behavior.
- Synthetic failure/timeout controls retain the original whole reason in a real immutable result when supported, truthful dispatch/execution/completeness and no body/post-hook/model/guest replay. Arbitrary code/error-like payload fields remain data. Preserve actual effect count and native partial metadata. Direct legacy standalone registries without a retention port keep their explicit nondurable contract.
- Old duplicated-estimator/fit/GC/plugin-only tests can retire with the retired implementation. Transfer only still-required obligations not already covered to the real current source owners: quote/NUL/emoji serialized budgets, once-only lowering/callbacks, supported media/order, no-fit truthful unavailability, legacy raw/image projection. Do not retain an unreachable copy solely so its old unit test passes; do not drop live APIs' tests with the plugin.
- Preserve shell/base-retainer/store/native fallback controls: complete fallback stdout file, safe injective labels, original pre-spilled path/no duplicate writes, no optional config/no fabricated notice, stderr-only behavior and stdout/stderr/exit metadata. Real persisted historical data reads remain explicit.
- Validate the retained small Desktop observation via its actual public fact/history path and exact value/outcome instead of the removed root helper. Keep core-session malformed/version/intake behavior qualification at its original owner; no new shadow validator.

Fixtures must use the existing actual owned coordinator/generation/model policy composition. If an old fixture fails before reaching its intended behavior, report/setup-adapt separately and preserve old evidence; do not remove ownership or use an unbranded fake ModelClient to get green.

Required per-case migration inventory, resolved before deletion:

| Existing test | Keep / migrate / retire boundary and setup risk |
| --- | --- |
| apps/cli output-spill-default | Real runHeadless exact small inline plus mandatory large envelope/model/archive; raw output.spill/notice contract retires. Real durable owner before cold full-body claims. |
| apps/cli host-output-spill | Retire outputSpill option-presence assertions. EOF-only SDK/ACP constructor is construction/close coverage, NOT a tool/A9 proof; genuine request/response producer/finalizer flow required for bounded-result claims. |
| executor service-output-spill | Keep BOTH actual modelBindingFor/modelBuilder routes. Remove inert option,2000byte mandatory-cap and absent-option/raw-unbounded expectations. Required-policy mock setup must use existing actual built-in controlled transport or explicitly labeled supported test-mock route; never weaken admission. |
| core-agent synthetic-retention / output-retention synthetic-bound | Move still-needed body failure/full reason/dispatch/effect/post-hook-once obligations to actual existing source/finalizer/durable composition. Retire direct old-cascade/outputPaths expectations. Old image lacks mediaType: use authoritative valid PNG/JPEG fixtures for new media; keep image-like payload data exact, never relax new typed-media validator. |
| executor tool-timeout-exemption | Raw over-cap timeout exemption retires; keep actual timeout verdict/dispatch/effects/partial native metadata/completeness via original owners. Complete program value is distinct from bounded published envelope/model/history. |
| executor tool-result-measure-agreement | Retire duplicated-estimator/old-spill-write oracle. Direct events.push is projector input, NOT persisted decoder evidence. Preserve historical raw/image projection through actual public codec/reader fixture separately from strict new intake; do not reclassify malformed legacy data as valid new media. |
| output-retention spill-guard / site-diagnostics | Explicitly retire every guard-only replacement/read-exemption/magic-name/fit-give-up/TTL-GC/mount-warn case with the deleted responsibility. No fake replacement GC/diagnostic site. Transfer missing live obligations only. |
| output-retention retention/spill-store and shell spill-notice | Keep live retainer/store/safe-label/whole fallback/pre-spilled-no-double-copy/no-config/stderr/exit behavior. These are not dead guard tests. |

Minimum retained-obligation map (record exact current tests/gaps, add only missing discriminators):

- Escaped quote/backslash/NUL/emoji UTF8 final serialized budgets: current capture/preview/projection/intake. Existing output-retention mcp-presentation and core-session json-data cover distinct presentation/source cases; ensure ordinary large result64000final envelope/model branch is actually covered, not just helper budgeting.
- Once-only lowering/source mutation/storage retry: keep output-retention result-capture, core-tools result-finalization and executor retained-result-flow normal/synthetic/Code recovery. Helper counters alone cannot replace scheduler/body/post-hook coverage.
- Supported media/order and error/code lookalike fields: keep executor retained-mcp-result and mcp-presentation; add only a genuinely missing real-source synthetic/timeout-media case with valid ImageInput.
- No fit: known quota/unsupported owner is bounded truthful unavailable while successful lowering retains program value; uncertain storage stays original-handle recovery-required. No arbitrary small cap/fail-open transplant.
- Legacy raw/image/path and literal8/9 decoding/projector/read/renderer responsibilities stay in their real existing owners. No rebuilding historical data or fabricating managed completeness.

Existing executor retained-result-flow/retained-result-host and native outcome/dependency controls supply real producer patterns; reuse them without creating another fixture framework. Source suspicion of obsolete setup/expectations is not a newly reproduced failure; preserve actual baseline results and distinguish setup, deliberate contract retirement and regression.

## Verification, size and final freeze

One writer/runtime gate at a time. Keep surface changes and old-plugin retirement reviewable in separate coherent local commits when practical. Live production behavior must remain equivalent; retired plugin-only semantics are explicitly listed as removed, not silently described as passing. No changes to unrelated task delivery/semantic fork/provider admission/history architecture.

Use current-package test discovery and explicit .tmp/worktree/release/build exclusions, fresh guarded roots, exact native argv/environment/UTC/exits, immutable source per gate and manifests including hidden/untracked fixtures. Original roots remain sealed. Verify the actual collected paths and actual tmp/config isolation before destructive old GC controls.

Run meaningful affected current/compatibility tests and types, normal reachability and dependency/public graph with no exemptions/reseed. The six inherited names must have legitimate recorded dispositions. A newly surfaced finding must be investigated rather than hidden; no product or test-only fake consumer. Preserve full BASE..HEAD scope and relative changes from this unit.

Review maintained product file/function sizes; this unit should mostly remove inactive responsibilities and keep thin existing entries. Tests/scripts are not decomposition targets. Do not grow giant migration helpers or duplicate raw-result ownership.

Final delivery maps old responsibility→retired/retained current owner→real consumer/gate, each test kept/migrated/retired with reason, public surface and dependency delta, original failures, fixed source results and exact source/evidence/copy identities. Freeze for a fresh independent review plus root audit. Only after acceptance freeze final A6 large-data/copied/bundled qualification; no self-acceptance of wholeR4A/R4B–R6/decomposition or release.
