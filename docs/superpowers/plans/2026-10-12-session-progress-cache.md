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

### Task 2: Model waiting guard, safe activity and settings

**Files:** llm-seam stream helper/types/tests; provider and provider-runtime wiring; necessary adapter progress/read cleanup sites; core-agent/core-session event handling; settings; desktop-gateway global settings proxy; desktop native/shared diagnostics and renderer RuntimeFeedback/RetrySettings with tests.

**Interfaces:** Preserve Task1 execution settlement; introduce bounded neutral stream activity and host-only deadline policy. New model wait settings routes return {firstResponseSeconds,progressSeconds}; distinct from existing retry-count routes. Defaults300/300; zero disables individually; otherwise integer30..3600. Native proxy works without selected workspace.

- [ ] Write fake-clock tests for no headers/body, heartbeats, real reasoning/tool-fragment progress, Stop, late iterator cleanup, retry/exhaustion and zero/custom settings.
- [ ] Implement per-physical-attempt guard below one retry layer; refresh settings next request and preserve usage/failed-tool safety.
- [ ] Forward safe phase/progress metadata and show quiet waiting after15seconds, with correct retry/cancel/terminal precedence and session isolation.
- [ ] Add General settings with validation, saved-state/error retention; no provider payload/opaque values in diagnostics.
- [ ] Test actual local HTTP cancellation/timeout; compare other protocol request payloads; run affected suites/typechecks and UI QA. Commit/report.

### Task 3: Codex affinity and stable Todo context

**Files:** core-agent request turn scope and llm-seam host-only types, llm-openai subscription branch/tests, usage-capture metadata stripping as required, todo context renderer/tests and assembly integration tests.

**Interfaces:** Preserve Task2 activity/deadline metadata and Task1 lifecycle. Stable session+turn scope across steps/retries, independent across turns/children. Subscription-only state; no new on-wire fields in other protocols.

- [ ] Read .tmp/investigate-openai-cache.md and native reference source before implementation.
- [ ] Write failing captured-request tests for same-turn affinity/sticky replay, new-turn/account/child isolation, bounded invalid token handling and no public/other-protocol header changes.
- [ ] Implement native-compatible subscription header/state lifecycle; preserve auth, redirect and explicit cache settings. Do not conflate public API controls with subscription contracts.
- [ ] Remove revision-only Todo context churn while preserving list semantics, clearing, compaction and real updates; add regression tests.
- [ ] Run six-protocol payload/cache semantics regressions and relevant core/runtime/usage tests; commit/report. No live cache-hit claims.

### Task 4: Integration and v0.1.11 delivery

- [ ] Independently review complete branch and address evidenced findings.
- [ ] Reproduce and correct the stale CLI redaction expectation and Windows quoting-sensitive cancellation fixture; retain meaningful behavioral assertions.
- [ ] Run relevant full suites, Desktop full suite, typechecks/build and repository verification gates as appropriate; record actual pass/skip/failure counts.
- [ ] Update release docs/version. Push PR, attach, merge after gates; package, local packaged smoke tests, byte/hash checks, upload draft assets then publish latest only after verification.
