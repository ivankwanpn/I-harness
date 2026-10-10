# WSL2 sandbox experiment implementation plan

> **For agentic workers:** Use subagent-driven-development for isolated worker and controller tasks; the controller owns integration and reviews.

**Goal:** Add and qualify an explicit experimental WSL2/Linux Bash sandbox backend on a separate branch.

**Architecture:** A Windows TypeScript package speaks bounded JSON lines to a captured in-memory Python worker in WSL2. The worker applies Linux bubblewrap/seccomp policy and owns cancellation. The host reuses the existing execution contracts, lease and supervisor.

**Tech Stack:** TypeScript, Python 3 standard library, existing WSL2 Ubuntu, bubblewrap, Vitest, existing IH sandbox/exec packages.

**Spec:** `docs/superpowers/specs/2026-10-08-wsl2-sandbox-experiment-design.md`

## Global constraints

- Explicit experimental construction only; no default backend/UI/release changes.
- Pipes and complete-tree only; RO/WW only; Linux argv; no network; no fallback.
- No installation, WSL machine configuration, external/reference edits or ACL changes.
- Owned filesystem fixtures/evidence stay in this repository; do not clean previous experiments.
- Verify actual namespace/security behavior and lifecycle, not just generated arguments.
- User has approved implementation; proceed through tasks without another approval gate.

## Task 1: Linux worker

**Files:** `packages/sandbox-wsl/worker/runner.py`, `packages/sandbox-wsl/test/worker_test.py`.

**Consumes:** The wire and standard spec/policy contracts defined in the spec.
**Produces:** `hello/probe/prepared/started/output/root/settled/error` frames; strict preparation/commit/cancellation behavior.

- [ ] Add subprocess tests first; a missing worker must fail the expected startup/prepare behavior. Record the RED result.
- [ ] Implement bounded line/nonce validation, isolated bootstrap entry, physical root identities, pinned mount descriptors and RO/WW bubblewrap policy.
- [ ] Implement x86_64 seccomp and interop masking, probe using the same security profile, command I/O, namespace teardown, EOF cancellation and sanitized errors.
- [ ] Run the tests against real Python/bubblewrap in Ubuntu with fixture paths under the owned repository; preserve all artifacts. Exercise write effects, interop/socket denial, path replacement and cancellation.
- [ ] Self-review and send changed-file list, tests and remaining limits; root commits after task review.

Worker test example: start `runner.py` with a supplied nonce and digest, prepare a RO request whose cwd is an owned fixture, assert no marker exists before `commit`, then run `printf OK; touch ./denied` and verify denied writes and a settled frame.

## Task 2: Windows controller and package

**Files:** `packages/sandbox-wsl/package.json`, `tsconfig.json`, `vitest.config.ts`, `src/index.ts`, `src/protocol.ts`, `src/transport.ts`, focused controller tests.

**Consumes:** Task 1 wire protocol, `ProcessSpec`, `CompiledSandboxPolicy`, `createExecutionLease`.
**Produces:** `createWslExecutionBackend({distribution})`, returning a `TransportExecutionBackend` with `dispose()`; no automatic local-backend selection change.

- [ ] Write failing tests for detached inputs, unsupported request refusal, bounded frame parsing, nonce/phase errors and encoded binary output.
- [ ] Implement fixed hidden WSL invocation and in-memory digest-checked bootstrap, actual WSL2 inventory validation and bounded diagnostics.
- [ ] Implement probe/prepare/commit/rollback, output retention/backpressure or cancellation on overflow, and lease hooks that require guest acknowledgement and client closure.
- [ ] Test cancellation before commit, authority-validator failure, transport failure and disposal; avoid a test-only production launcher API.
- [ ] Run controller tests/typecheck and self-review; root commits after task review.

Public construction example:

```ts
const backend = createWslExecutionBackend({ distribution: "Ubuntu" })
const probe = await backend.probe()
// createExecutionSupervisor().launch({ backend, spec, policy,
//   requirements, validateAuthority }) consumes this exact backend.
await backend.dispose()
```

## Task 3: Real qualification, integration and delivery

**Files:** `scripts/qualification/wsl2-sandbox/run.mts`, `packages/sandbox-wsl/README.md`, `docs/audit/2026-10-08-wsl2-sandbox-experiment.md`, workspace lock/link metadata only if required.

**Consumes:** Tasks 1/2 and existing sandbox-policy/execution-supervisor contracts.
**Produces:** A reproducible explicit qualification command with owned raw results and human acceptance report.

- [ ] Run affected baseline contracts before implementation integration and retain results.
- [ ] Use actual compiled RO/WW policy through `createExecutionSupervisor`, fresh repository-local workspace/sibling/reference fixtures and exact Linux env.
- [ ] Verify Bash/pipeline/nested processes, permission effects, encoded output, controlled network/interop denial, root-exit cleanup and cancellation of ordinary/setsid descendants.
- [ ] Verify authority revocation and path identity replacement reject/drain; raw exit without acknowledgement cannot report successful cleanup.
- [ ] Review each task for spec and code quality, then perform independent whole-branch security/lifecycle review. Fix material findings and repeat only their relevant checks.
- [ ] Run affected/full typechecks where feasible, production dependency/reachability gates; record unavailable or out-of-scope checks explicitly.
- [ ] Commit the experiment and report branch, reproducible command, actual outcomes and experimental limits. Keep the branch local unless separately requested to publish.
