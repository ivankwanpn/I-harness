# WSL2 product implementation plan

> **For agentic workers:** Use subagent-driven-development with isolated ownership, task review and final review. User has authorised continuation and Codex-style configuration; execute without another design approval pause.

**Goal:** Make the WSL2 backend usable from the real CLI/Desktop agent workflow with practical preparation, explicit controls and packaged assets.

**Architecture:** Keep sandbox-wsl as the guest execution package; add trusted target routing through existing exec/session composition and expose persistent configuration through the existing gateway/UI. Independently implement real web mode policy and managed runtime assets. Root owns packaging and end-to-end acceptance.

**Tech Stack:** TypeScript, Python standard library, existing WSL2/bubblewrap, existing IH contracts, React and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-wsl2-product-design.md`

## Global constraints

- Branch continues from1c46040e; package architecture; source references remain read-only.
- No fault-triggered fallback, no new model permission parameter, no weakened overlap/revocation/identity checks.
- Three sandbox modes; command networking separate from disabled/cached/indexed/live web policy.
- No automatic apt/sudo/global installation or WSL changes. Controlled managed tool assets only with enabled setting/action.
- Test/cache/settings/build fixtures stay under this repository. Official releases untouched.
- Preserve all old experiment evidence. Do not retry the blocked supplemental mount witness.

## Task 1: Practical WSL engine and discovery

**Own:** packages/sandbox-wsl, except dependency installer files owned by Task5.
**Consumes:** existingProcessSpec/CompiledPolicy plus immutable `{distribution,networkAccess}` options and trusted prepare configuration.
**Produces:** three file modes, explicit network profile, referenceProtection, discovery/path/environment data, practical cancellable preparation and package asset loader contract.

- [x] Record RED for real Desktop project preparation, networking/full mode/reference effects and cancel during slow preparation.
- [x] Optimise bounded safe inventories and explicit larger limits; retain hardlink/mount/ancestry validation; allow internal links only if every link is accounted for.
- [x] Add discovery/probe messages and captured runtime configuration; root-bound background remains complete-tree.
- [x] Separate preparation timing from ten-second write deadlines; cancel/rollback must drain the owned worker.
- [x] Verify real fixture effects and source-project readiness; self-review and report measured bounds/limits.

## Task 2: Trusted execution/shell integration

**Own:** packages/sandbox contracts/tests; packages/exec; packages/sandbox-local; packages/session-executor; packages/shell; apps/cli runtime fields/flags.
**Produces:** executionTarget, referenceProtection, local WSL selection, captured Linux shell/env and CLI flags propagated to main/child/CodeMode.

- [x] Write RED for selection using detached target/spec, Linux env case handling, actual refs through exec service and WSL background lifetime.
- [x] Extend optional target/capability contracts compatibly; host default stays host and native providers unchanged.
- [x] Wire selectedWsl options through assembly/service/CLI; bind shell command target before approval/preparation and provide guest context.
- [x] Make background/promotion use the documented root-bound lifetime only for WSL; exact transport requests remain exact.
- [x] Run actual registered shell/CodeMode/child calls using controlled local provider fixtures; typecheck and report.

## Task 3: Persistent settings, gateway and UI

**Own:** packages/settings; packages/desktop-gateway; Desktop renderer settings/related tests.
**Produces:** backendwsl +wslExecution +webSearchMode schema, persistence/new-assembly callbacks, diagnostics/actions and Codex-style controls.

- [x] Add failing normalisation/migration/configure/UI tests with real stores and bridge state.
- [x] Implement typed defaults, validation and propagation; older config preserves existing webfetch behaviour.
- [x] WSL selectors and dependency/network diagnostics use actual runtime capability data; distinguish saved/new-assembly/active settings.
- [x] Wire web policy/storage/managed-dependency callbacks supplied by Tasks4/5; no fake online/index choice.
- [x] Test Chinese descriptions, unsupported runtime actions and persisted roundtrip; report UI/runtime coverage.

## Task 4: Real four-mode web policy

**Own:** packages/web and only needed provider seam/tests; additional web options in session assembly coordinated with Task2.
**Produces:** scoped bounded persistent web cache/index and callable modes; disabled/cached never fetch live, indexed fetch requires admitted URLs, live follows guarded HTTP.

- [x] RED tests count actual fetch/provider effects for each mode, cache miss/hit and provider-scope changes.
- [x] Implement bounded cache/search-source admission, redirect validation and trust envelope; registration truthfully handles absent providers.
- [x] Pass policy/storage via existing registerWeb seam; configuration capture fences actual calls.
- [x] Test with controlled HTTP/provider fixtures only, no secret/auth reads or model calls; report exact semantics.

## Task 5: Managed runtime and packaged assets

**Own:** dedicated workspace-runtime package or sandbox-wsl dependency module agreed before edits; scripts/runtime-wsl-assets.mjs, CLI/Desktop build/copy verification.
**Produces:** installed-runtime diagnostics, optional pinned Linux Node/npm cache, source-independent worker assets in CLI/Desktop.

- [x] RED for disabled install, digest/path/size rejection, isolated cache selection and missing worker artifact.
- [x] Verify official Node release/digest before pinning; bounded regular-file extraction and atomic owned staging; no global packages/WSL settings.
- [x] Add managed runtime PATH/context and explicit diagnose/install/retry API; preserve caller's cache authority.
- [x] Copy/hash-check assets for CLI/gateway builds; build fresh local candidates and run packaged dependency/WSL calls.

## Task 6: Product qualification and review

**Own:** root qualification scripts/docs/lock metadata and final integration corrections.

- [x] Run actual settings-to-new-assembly CLI/Desktop paths with recorded shell targets and file/network effects.
- [x] Exercise foreground/background/CodeMode/child/revocation and missing runtime; large project preparation measured.
- [x] Run focused/full affected tests, all typechecks, production graph/reachability and source-independent packaged runtime checks.
- [x] Review each task and final branch; repair material findings with targeted RED/GREEN tests.
- [x] Commit reviewed work and deliver candidate, reproducible command and precise supported limits. Publication remains a separate requested action.
