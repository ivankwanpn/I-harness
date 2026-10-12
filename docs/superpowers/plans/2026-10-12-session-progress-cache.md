# Session progress and cache continuity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development task by task. Check the ledger; never redispatch a completed task.

**Goal:** Correct settled execution state, bound stalled model requests, and improve Codex subscription continuity without changing other protocol contracts.

**Architecture:** Service-owned lifecycle, one per-attempt progress guard below retry, and subscription-only routing state. Native diagnostics and renderer consume safe lifecycle metadata.

**Tech Stack:** Existing TypeScript packages, React/Electron, Vitest and local HTTP fixtures.

**Spec:** docs/superpowers/specs/2026-10-12-session-progress-cache-design.md

## Global Constraints

- Read the spec; preserve its exact defaults, ownership and protocol boundaries.
- No live provider calls, user profile/session changes, dependencies or additional implementation agents.
- Commit only your assigned task; reports and evidence go in this plan's ignored SDD directory.
- Single retry layer; no replay of tool effects or admitted user turns.
- Parent controller owns task review, integration, GitHub and release.

### Task 1: Service-owned execution settlement

**Files:** session-executor/src/service.ts and exports/tests, sdk/src/server.ts and SDK tests, desktop renderer/app.tsx and focused selection tests as necessary. Do not edit protocol adapters or settings.

**Interfaces:** Produce optional service onExecutionState subscription with sessionId/running/queued/revision and additive SDK notification. Document actual contract in report. Consume existing queue projection and refresh scheduler; preserve backward compatibility with older service mocks/embedders.

- [ ] Read .tmp/investigate-parent-wait.md and reproduce .tmp/investigate-parent-wait-probe.mts in a scoped test; avoid root Vitest matching old worktrees.
- [ ] Write failing regression for internal parent notification submission with delayed stop/flush: final backend queue and renderer state both idle.
- [ ] Implement authoritative notifications after bookkeeping/settlement and at queue transitions, preserving next-running work and safe listener isolation/disposal.
- [ ] Cover queued follow-on work, direct/internal submit, failure, Stop/cancellation, late snapshot ordering and subscription cleanup.
- [ ] Run affected executor/SDK/Desktop tests and typechecks; commit and write task-1-report.md with red/green evidence and interface contract.

### Task 2: Model waiting guard and backend settings

**Files:** llm-seam stream helper/types/tests; provider and provider-runtime wiring; necessary adapter progress/read cleanup sites; core-agent/core-session event handling; settings; desktop-gateway settings routes/tests. Desktop production files are owned by Task3.

**Interfaces:** Preserve Task1 execution settlement; introduce bounded neutral stream activity and host-only deadline policy. New desktop/model-wait/state/configure routes return {firstResponseSeconds,progressSeconds}; distinct from existing retry-count routes. Defaults300/300; zero disables individually; otherwise integer30..3600. Core model/activity events and exported metadata are the Task3 producer contract; document exact fields, phases, timing and clearing rules in report.

- [ ] Write fake-clock tests for no headers/body, heartbeats, real reasoning/tool-fragment progress, Stop, late iterator cleanup, retry/exhaustion and zero/custom settings.
- [ ] Implement per-physical-attempt guard below one retry layer; refresh settings next request and preserve usage/failed-tool safety.
- [ ] Produce safe bounded phase/progress metadata including quiet-wait activity after15seconds. No payloads, per-token persistence or heartbeat deadline resets.
- [ ] Add backend settings persistence/routes with validation and next-request refresh independent of explicit retry policies.
- [ ] Test actual local HTTP cancellation/timeout; compare other protocol request payloads; run affected backend suites/typechecks. Commit/report including exact consumer contract.

### Task 3: Waiting feedback, native diagnostics and General settings

**Files:** desktop native/shared diagnostics/bridge/global-provider-settings/IPC, renderer RuntimeFeedback and General settings, localization and focused tests.

**Interfaces:** Consume reviewed Task2 model/activity contract and desktop/model-wait/state/configure. Native no-workspace proxies desktop/global-model-wait/state/configure return the same seconds fields. Consume Task1 session/execution-state; running:false with queued>0 is a valid handoff, not necessarily the end of pending user work.

- [ ] Write failing tests for quiet waiting after15seconds, genuine progress, retry precedence, cancellation/settlement, stale event/session isolation and settings bounds/persistence/error retention.
- [ ] Sanitize activity once in native. Persist bounded lifecycle/quiet/timeout facts, never every chunk; do not classify informational activity as final errors.
- [ ] Display truthful quiet phase/elapsed progress in independent feedback without focus stealing or composer movement. Preserve existing error/retry/details behavior and new-task draft ownership.
- [ ] Add configurable first-response/progress seconds in General: defaults300/300,0off,otherwiseinteger30..3600. Saved values apply next request; keep draft on save error.
- [ ] Run Desktop affected/full suites, typecheck/build and actual-component420/1280px dark/light QA; commit/report.

### Task 4: Codex affinity and stable Todo context

**Files:** core-agent request turn scope and llm-seam host-only types, llm-openai subscription branch/tests, usage-capture metadata stripping as required, todo context renderer/tests and assembly integration tests.

**Interfaces:** Preserve Task2 activity/deadline metadata, Task3 diagnostic boundary and Task1 lifecycle. Stable session+turn scope across steps/retries, independent across turns/children. Subscription-only state; no new on-wire fields in other protocols.

- [ ] Read .tmp/investigate-openai-cache.md and native reference source before implementation.
- [ ] Write failing captured-request tests for same-turn affinity/sticky replay, new-turn/account/child isolation, bounded invalid token handling and no public/other-protocol header changes.
- [ ] Implement native-compatible subscription header/state lifecycle; preserve auth, redirect and explicit cache settings. Do not conflate public API controls with subscription contracts.
- [ ] Remove revision-only Todo context churn while preserving list semantics, clearing, compaction and real updates; add regression tests.
- [ ] Run six-protocol payload/cache semantics regressions and relevant core/runtime/usage tests; commit/report. No live cache-hit claims.

### Task 5: Discoverable role selection

**Files:** subagent tool metadata/role registry wiring/tests, preset delegation guidance if needed; tool-search/Code Mode integration tests and narrowly necessary metadata refresh paths.

**Interfaces:** Consume live RoleRegistry definitions (not settings-only model keys). Preserve existing runtime omitted agent_type -> general compatibility. Model-facing guidance explicitly requests a role choice; do not introduce a separate generic schema/validation subsystem to force the field.

- [ ] Read role-dispatch-audit.md and exact fork sources cited there. Materialize actual parent requests in direct and Code Mode paths; write failing discovery/refresh tests.
- [ ] Add deterministic live role names/descriptions and practical built-in selection guidance to spawn_agent metadata, with clear approval-reviewer distinction.
- [ ] Refresh metadata/indexes on actual registry change; unchanged catalogs remain byte-stable. Preserve user/plugin roles, permissions and model binding.
- [ ] Test explicit explore/worker model dispatch, role add/remove/restore, direct/search/Code Mode visibility, and legacy omitted-role behavior. No forced distribution or live model requests.
- [ ] Run affected suites/typechecks; commit/report. Parent reviews before integration.

### Task 6: Integration and v0.1.11 delivery

- [ ] Independently review complete branch and address evidenced findings.
- [ ] Reproduce and correct the stale CLI redaction expectation and Windows quoting-sensitive cancellation fixture; retain meaningful behavioral assertions.
- [ ] Run relevant full suites, Desktop full suite, typechecks/build and repository verification gates as appropriate; record actual pass/skip/failure counts.
- [ ] Update release docs/version. Push PR, attach, merge after gates; package, local packaged smoke tests, byte/hash checks, upload draft assets then publish latest only after verification.
