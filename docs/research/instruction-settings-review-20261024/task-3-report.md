# Task 3 — settings policy and explicit legacy import

Status: implemented, scoped gates passed, committed, ready for independent review. This is the settings package seam only; IG management UI/bridge, actual request consumers, and integrated reachability remain open.

## Source and ownership

- Worktree: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main`
- Branch: `codex/instruction-settings-20261024`
- BASE: `bdc1e05c78dee2c6f100feb725e5a9561487a93b`
- HEAD: `fe0174d5f8124d92ba3728c6046d1908844e9079`
- Full review/integration range: `bdc1e05c78dee2c6f100feb725e5a9561487a93b..fe0174d5f8124d92ba3728c6046d1908844e9079`
- Commit: `fe0174d5 feat(settings): persist instruction policy with explicit legacy import`
- Product changes: 13 files, all under `packages/settings`; 930 additions, 233 deletions. Worktree clean after commit. No other package, root manifest, lockfile, watcher implementation, gateway, renderer, assembly, or runtime consumer changed. No merge/push/tag/release.

Read the assigned brief first, then contracts, execution constraints and progress. Followed the approved task and root's subsequent rulings on complete instruction-policy layering, explicit files-mode profile identity, and queued revision guards. No child agents were spawned.

## Implemented behavior

`Settings.instructions` normalizes to `{ enabled: true, maxBytes: 24000 }`. Absent `globalSources` remains structurally absent; explicit `[]` is retained. Invalid persisted globals fail closed to `[]`. Strict section/store mutations reject accessors, invalid candidate paths, duplicate exact paths, more than 256 configured globals, and non-safe/nonintegral/negative budgets. Valid zero and disabled values are retained. The normalizer and effective policy resolver do no filesystem probes.

`resolveInstructionPolicy(saved, configDir?)` uses `resolveHarnessHome`, requires an absolute nonempty effective home, and resolves the native pair only when saved globals are absent. Explicit paths remain exact and gain no siblings. Its returned policy and path list are frozen. `get()`, load/write returns and layered source descriptions are caller-owned snapshots, so drafts cannot mutate saved state. Actual running-service replacement is a future host responsibility after successful saved-policy reads.

The `instructions` section is registered in `SectionName`/`SECTION_SCHEMAS`, strict mutation validation, mutation bases and both stores' persisted revision increments. Built-in stores now serialize load/read, staging, write and publication; failed writes/renames do not publish policy or increment revisions. Ordinary set/reset and migration share that queue. Section edits pass a captured revision through a new optional `set(patch, guard?)` argument; both stores recheck it inside the queue. This prevents a stale edit prepared while an import/reset is committing from overwriting the newly saved policy. Existing unguarded set callers remain compatible, and edits of unaffected sections still succeed.

Explicit import requires a plain request with version 1, absolute owning profile/home/workspace and a 64-hex SHA256. Existing profile bytes are read strictly and hashed. Eligibility requires at least one valid recognized setting; metadata, onboarding/history evidence, empty records, missing/corrupt documents, and invalid-only settings do not qualify. `_instructionsMigration` is strictly validated and malformed/unknown/inconsistent metadata produces typed errors.

Only after eligibility succeeds does preview/import inspect the two supplied legacy directories. It selects the old AGENTS-before-CLAUDE existence winner, including empty files and existing directories/error winners, without reading rule bodies, ancestor rules or imports. Ancestor seeding plus the old home/.claude unshift loop preserves `.claude, home` normally and `home, .claude` when both were already local ancestors. The chosen workspace and exact selected list are recorded once.

Explicit saved globals always prevail. Completed legacy-explicit metadata makes commit replay return saved state without home probes, byte rewrites, or restored deleted paths, including after reset and policy edits. Preview reports such imports as inapplicable. A native marker never causes automatic import; a fresh explicit request with the current digest can transition it while globals remain absent. Reset restores native structural policy while retaining completed historical import metadata.

Metadata and policy are staged together and written by a uniquely named same-directory exclusive temporary file plus rename. The owning temp handle is closed before rename, the original profile digest is rechecked immediately before rename, and only an owned temp is removed on failure. Imported metadata records version, mode, absolute profile identity, preimage hash, exact sources and legacy workspace. Normal load writes nothing. A selected profile's first ordinary durable write records native provenance.

## Layered policy and profile rulings

Root approved complete `instructions` section replacement: the highest present instructions section is normalized as one policy; an absent section inherits from below. Partial enabled/maxBytes within that selected policy keep valid values and default missing values. A higher disabled-only or maxBytes-only policy therefore does not inherit lower imported globals. Removing the higher section restores lower policy. Reset can durably restore native globals without implicitly reimporting lower legacy paths. Generic nested merge behavior is unchanged, including nested keys named instructions.

In roots mode import targets the actual global source. Explicit files mode requires `LayeredStoreOptions.instructionProfilePath`, an absolute host-selected identity naming exactly one configured `label:file` source. Missing, mismatched, relative, duplicate and workspace/project selections reject. Request.profilePath must match the selected source. The option alone does not authorize probing home. Host composition must supply it when using files mode.

Migration patches only that profile's raw document. It does not copy effective workspace overrides into globals, change the master merely because it has priority, or alter a higher explicit policy. Existing comments (including interior comments in noncanonical documents), unknown keys and provenance survive the profile patch. Ordinary workspace/project saves create no profile metadata there and do not write another global file. Arbitrary unselected files-mode documents also receive no native provenance. Reset keeps profile history and replaces the current policy at its ordinary write target.

The effective instructions revision is the sum of source-document instruction counters, so a lower-profile import also invalidates a draft read through a higher master. Other section revisions retain master semantics. The renderer must distinguish the selected profile's raw/saved policy from the effective higher-layer policy (`sources()` versus `get().instructions`) and from resolved native paths (`resolveInstructionPolicy`).

## Dependency setup and verification

Own worktree installed successfully with `pnpm install --offline --frozen-lockfile` (83 workspace projects, 452 reused packages, zero downloads). No dependency versions or lock contents changed. Actual realpath checks of all declared settings dependencies resolve to this worktree's `packages/fs-watch`, `packages/telemetry`, and `packages/harness-home`; no workspace package resolves to another checkout. Third-party content-addressed store reuse only.

All new test homes/profiles are synthetic temporary roots, with `IH_CONFIG_DIR` bound to a test-owned native directory. No real profile, home rule, provider or credentials were inspected. New import tests use real temp files; fault/held-queue cases replace only the relevant fs write/rename boundary. They are hybrid filesystem/failure-injection tests, not a claim of full real watcher qualification. Existing unchanged settings watcher controls were retained in the required suite.

Final stable source commands, run sequentially in the assigned worktree:

1. `pnpm --filter @i-harness/settings exec vitest run test/instructions.test.ts test/settings.test.ts test/sections.test.ts test/layering.test.ts test/watch.test.ts test/watch-events.test.ts --maxWorkers=2 --minWorkers=1` — exit 0, **6 files / 140 tests passed**, including 44 new instruction tests.
2. `pnpm --filter @i-harness/settings typecheck` — exit 0.
3. Declared dependency realpath verification — exit 0, all three packages inside own checkout.
4. `git diff --check` and unchanged root manifest/lock checks — passed.

Source hash inventories were identical before the final suite, after the suite, after typecheck and after commit. No source changes followed the successful final gates. No broad unrelated suite, instruction-owner suite, reachability command or consumer integration test was run; root owns the latter combined gate.

## Durable evidence and causal controls

Evidence directory: `D:/I-harness-main/.superpowers/sdd/2026-10-24-instruction-observation-integration/task-3-evidence/`.

- `setup-offline.log`, `setup-source.txt`: frozen offline setup success and BASE.
- `red.log`, `red-source.txt`: first attempt captured the missing policy behavior; the rename spy setup failed because the native ESM export was not configurable. This setup failure is preserved and is **not** counted as causal proof of the transaction defect.
- `red2.log`, `red2-source.txt`: corrected narrow fs wrapper; three behavioral failures against BASE: instruction policy discarded, single-store premature publication, layered-store premature publication. No missing-export compilation failure was used as the causal RED.
- `dev1.log`, `dev1-types.log`, associated source/receipt files: initial focused 31-test/typecheck success.
- `eligibility-red.log` and source/receipt: three valid recognized-setting fixtures rejected by an overly narrow eligibility list. Replaced that list with recognized normalized leaf eligibility while retaining metadata/onboarding exclusions.
- `dev2.log`, source/receipt: 42 focused controls passed after boundary additions.
- `revision-red.log`, source/receipt: both held-import fixtures demonstrated stale section edits resolving successfully and deleting imported paths; the queued revision check fixes that causal failure.
- `final-suite.log`, `final-types.log`, their command/cwd/exit receipts, and `final-before-hashes.txt`, `final-after-suite-hashes.txt`, `final-after-types-hashes.txt`: final evidence.
- `dependency-resolution.log` and receipt: actual declared workspace resolution.
- `committed-source.txt`, `committed-source.diff`, `committed-hashes.txt`: full BASE..HEAD source identity, owned path list and tested committed bytes.

New controls cover: absence/explicit denial, exact native/custom paths, invalid budgets/globals/accessors, draft isolation, strict section aggregate validation, no normal-load legacy probes, preview read-only/body-read exclusion, valid setting eligibility, corrupt/missing/meta-only/conflicting profiles, legacy ordering including both-local ancestors and empty/error winners, one-time replay, reset and unrelated-save provenance, strict metadata, selected-profile-only layered writes, complete-policy layer overrides/removal/reset, no extra file writes, digest recheck, write/rename failures/temp ownership, serialized import/save/reset, failed-reset recovery, and stale instruction edits with unaffected-section positive controls.

## Public additions and downstream obligations

Public exports: `SettingsInstructions`, `InstructionPolicy`, `normalizeInstructions`, `resolveInstructionPolicy`, `LegacyInstructionImport`, `InstructionMigrationMeta`, `previewLegacyInstructionImport`, `InstructionMigrationError`, and `SettingsRevisionGuard`. `Settings.instructions`, `SectionName: instructions`, `SettingsStore.migrateInstructions`, `LayeredSettingsStore.migrateInstructions`, optional `LayeredStoreOptions.instructionProfilePath`, widened mutation-base names, and optional `set(patch, guard?)` are the added surfaces. The comment-preserving patcher accepts an optional exact top-level replacement list, used for policy/reset persistence. Internal transaction and migration staging helpers are not barrel exports.

IG must implement the actual registered Instructions section and Import legacy instruction sources / Apply import actions, scoped bridge/router handling, same-preview-digest apply, preserved enabled/maxBytes display, effective higher-layer policy display, profile identity selection, and no-model end-to-end controls. The UI must not infer global identity from file order or invoke import on load/watch/startup. No such trigger is claimed here.

IC-B must consume successfully saved effective policy, resolve native paths using the host-selected config home, fence old scope authority, prepare the replacement source view, and publish effective revision only after success. A dirty draft or a failed read/write must not replace a running scope. Actual main/child request composition and pending-write authority remain IC-B/ID/IE work. W2's settings watcher consumer cutover remains untouched. Root must perform combined reachability and record genuine future consumers without fake references/exemptions.

Compatibility/release note obligation: unmarked old profiles now use native globals on normal load until the user explicitly imports legacy sources. Native metadata records a policy decision, not historical age. Higher present instruction sections are complete policy boundaries. These are approved behavioral decisions requiring IG/release explanation.

Limit: the final digest check detects a foreign change before rename but is **not filesystem compare-and-swap**. A foreign writer can still rename after the check; the host must provide exclusive migration ownership. No cross-process lock, arbitrary multi-host guarantee, Linux/macOS qualification, zero-CPU claim, request reachability or full feature completion is asserted. Independent review remains pending.
