# Sandbox Package Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute each task with RED/GREEN evidence, task review and a final integration review.

**Goal:** Add the shared asynchronous launch contract, explicit immutable authority/policy snapshots and owned lease lifecycle needed by the package redesign.

**Architecture:** Add platform-neutral public contracts to `@i-harness/sandbox` while preserving the existing argv provider during migration. `sandbox-policy` builds immutable call snapshots and revalidates them against explicit authority states. A shared lease implementation makes cleanup completion explicit; actual process launch remains backend-owned.

**Tech Stack:** Existing TypeScript, Node crypto/path and Vitest; no dependency additions or native provisioning.

**Spec:** `docs/superpowers/specs/2026-10-07-sandbox-package-redesign-proposal.md`

## Global Constraints

- All development remains in packages, through public exports and `workspace:*` dependencies, without cyclic dependencies or cross-package private `src` imports.
- No accounts, SYSTEM tasks, services, elevation, reference ACL changes, new Low labels or unconfined fallback.
- Preserve existing `SandboxProvider`, mode vocabulary, tool behavior and policy defaults during the foundation migration.
- Host discovery does not constitute native behavior qualification or a security assurance claim.
- A revoked/unavailable authority is a refusal, not an implicit fallback to workspace.
- A settled lease means tree exit, I/O settlement and resource release; a root exit alone is insufficient.
- Production PSEC/default selection changes belong to later native and integration plans, using this foundation's exact public API.

## Public interfaces for this phase

Put shared types in `packages/sandbox/src/execution.ts`, exported from the package root.

```ts
export type ExecutionTransport = "pipe" | "pty"
export type ExecutionLifetime = "complete-tree" | "retain-tree"
export type BackendAssurance = "verified" | "experimental" | "unverified"
export type StopReason = "cancelled" | "timeout" | "output-limit" | "authority-revoked" | "shutdown"
export interface ExecutionOwner { sessionId: string; parentSessionId?: string }
export interface BackendProbe {
  id: string
  availability: "available" | "unavailable"
  assurance: BackendAssurance
  features: Readonly<{
    writeIsolation: boolean; readIsolation: boolean; denyPaths: boolean
    pipes: boolean; pty: boolean; retainedTree: boolean
  }>
  detail?: string
}
export interface BackendRequirements {
  writeIsolation: boolean; readIsolation: boolean; denyPaths: boolean
  transport: ExecutionTransport; lifetime: ExecutionLifetime
  minimumAssurance: BackendAssurance
}
export type BackendDecision = { ok: true } | { ok: false; missing: readonly string[] }
export interface ProcessSpec {
  argv: readonly string[]; cwd: string; env: Readonly<Record<string, string>>
  owner: Readonly<ExecutionOwner>; transport: ExecutionTransport
  lifetime: ExecutionLifetime; argumentEncoding: "crt" | "cmd-verbatim"
  pty?: Readonly<{ cols: number; rows: number }>
}
export type AuthorityState =
  | { kind: "unbound"; revision: string; workspaceRoot: string }
  | { kind: "bound"; revision: string; primaryRoot: string; roots: readonly string[]; references: readonly string[] }
  | { kind: "revoked" | "unavailable"; revision: string; reason: string }
export interface CompiledSandboxPolicy {
  mode: SandboxMode; owner: Readonly<ExecutionOwner>; authorityRevision: string
  authorityKind: "unbound" | "bound"; primaryRoot: string
  readable: "caller"; writeRoots: readonly string[]; referenceRoots: readonly string[]
  fingerprint: string
}
export interface ExecutionReceipt {
  executionId: string; backendId: string; policyFingerprint: string
  owner: Readonly<ExecutionOwner>; assurance: BackendAssurance
}
export interface RootExit { exitCode: number | null; signal?: string }
export type ExecutionSettlement =
  | { kind: "settled"; root: RootExit; treeEmpty: true; ioSettled: true; resourcesReleased: true }
  | { kind: "incomplete"; phase: "tree" | "io" | "release"; detail: string }
export interface ExecutionHandle {
  readonly receipt: ExecutionReceipt
  readonly rootExited: Promise<RootExit>
  readonly settled: Promise<ExecutionSettlement>
  cancel(reason: StopReason): Promise<ExecutionSettlement>
  release(): Promise<ExecutionSettlement>
}
export interface PreparedExecution {
  readonly policy: CompiledSandboxPolicy
  commit(validateAuthority: () => void): Promise<ExecutionHandle>
  rollback(): Promise<void>
}
export interface ExecutionBackend {
  probe(): Promise<BackendProbe>
  prepare(spec: ProcessSpec, policy: CompiledSandboxPolicy, signal?: AbortSignal): Promise<PreparedExecution>
}
```

This phase's callable validation callback is the trusted supervisor's authority fence. It is not a serializable authorization secret, and does not assert atomic OS launch. Native suspended creation/final resume fencing is required by later backends. Workload I/O is a transport extension in the next plan, so this base handle does not pretend to expose an existing stream implementation.

## Task 1: Public execution contracts and honest backend negotiation

**Files:** Create `packages/sandbox/src/execution.ts` and `src/backend-requirements.ts`; export them from `src/index.ts`; create `test/backend-requirements.test.ts` and `test/execution-public.test.ts`.

**Produces:** types above and `checkBackendRequirements(probe: BackendProbe, requirements: BackendRequirements): BackendDecision`.

- [ ] Write consumer tests using package-root exports. Include unavailable backend, missing write/read/deny/PTY/retained-tree features, all satisfied, and assurance ranking `verified > experimental > unverified`. Discovery-only/unverified cannot satisfy experimental or verified requirements. Runtime invalid enum/boolean input must refuse rather than accidentally pass.

```ts
expect(checkBackendRequirements({ ...probe, assurance: "unverified" },
  { ...requirements, minimumAssurance: "verified" })).toMatchObject({ ok: false })
expect(checkBackendRequirements(probe, requirements)).toEqual({ ok: true })
```

- [ ] Run focused tests from the sandbox package and confirm RED for missing public function/type export.
- [ ] Implement feature requirements without backend selection or fallback. Return stable missing identifiers: `availability`, `write-isolation`, `read-isolation`, `deny-paths`, `pipe`, `pty`, `retained-tree`, `assurance`, `invalid-contract`. Deduplicate missing identifiers. Guard malformed runtime data; capability probing data is not automatically trusted input.
- [ ] Run all sandbox tests/typecheck, then dependent sandbox-policy/exec typechecks; commit only this task's source/tests.

## Task 2: Immutable explicit authority snapshots

**Files:** Create `packages/sandbox-policy/src/execution-policy.ts`; export from `src/index.ts`; create `test/execution-policy.test.ts`.

**Consumes:** shared authority, owner and compiled policy types. **Produces:**

```ts
export function compileExecutionPolicy(input: {
  mode: SandboxMode; owner: ExecutionOwner; authority: AuthorityState
}): CompiledSandboxPolicy
export function assertExecutionAuthority(
  prepared: CompiledSandboxPolicy, current: CompiledSandboxPolicy
): void
```

- [ ] Write RED tests for revoked and unavailable states; unbound workspace; bound primary root not lost; references always separate from write roots; readonly has no write roots; dangerous-full-access retains explicit mode without claiming restrictions; detached nested arrays/owner; stable fingerprint under root/reference ordering and duplicate entries; different owner/revision/mode/roots/reference changes invalidate authority. Invalid mode, blank revision/session ID, relative/NUL paths and malformed states refuse. Use native-platform absolute fixtures (`resolve(...)`) rather than assuming Unix paths on Windows.

```ts
expect(() => compileExecutionPolicy({ mode: "workspace-write", owner,
  authority: { kind: "revoked", revision: "r2", reason: "removed" } })).toThrow(/revoked/i)
const before = compileExecutionPolicy({ mode: "workspace-write", owner, authority })
expect(() => assertExecutionAuthority(before, { ...before, authorityRevision: "r2" })).toThrow(/authority/i)
```

- [ ] Normalize absolute paths through existing package utilities or Node path. These are compiler spellings, not a claim that lexical normalization prevents reparse races. Sort/deduplicate deterministic roots with platform-appropriate case handling; retain primaryRoot separately. Reject any reference overlapping an allowed writable root until the later native policy can implement nested read-only carveouts; do not silently remove a root or broaden access.
- [ ] Build fingerprint from canonical mode, owner, authority kind/revision, primary root, write roots and reference roots using Node SHA-256. Copy/freeze every public nested value; ensure caller mutation cannot change compiled policy. Do not change existing createSandboxPolicy.resolve behavior yet.
- [ ] Authority comparison checks the canonical prepared/current content and recomputed fingerprint, not only a supplied string. No automatic broadening/snapshot refresh inside this assertion.
- [ ] Run policy and sandbox suites/typechecks; commit only task files. Document unsupported overlapping references as an explicit first-phase constraint.

## Task 3: Single-owner asynchronous lease settlement

**Files:** Create `packages/sandbox/src/execution-lease.ts`; export from package root; create `test/execution-lease.test.ts`.

**Consumes:** execution receipt/root exit/stop reason/settlement. **Produces:**

```ts
export function createExecutionLease(input: {
  receipt: ExecutionReceipt; rootExited: Promise<RootExit>
  waitTreeEmpty(): Promise<void>; settleIo(): Promise<void>; releaseResources(): Promise<void>
  terminate(reason: StopReason): Promise<void>
}): ExecutionHandle
```

- [ ] Write RED tests with deferred real promises: root exit alone does not resolve settled; tree must become empty then I/O settles then resources release. Cancel is idempotent, concurrent cancel/release shares a cleanup, terminate failure is recorded and does not skip attempts to settle/release. Native release never begins until tree and I/O settlement are confirmed. Incomplete tree/I/O retains resources for recovery, reports the exact phase and permits a later explicit retry. Successful lease releases once. Receipt and owner cannot be mutated by callers. Attach rejection handlers so an early native failure cannot become an unhandled rejection while waiting for another phase.
- [ ] Implement an explicit per-lease promise/state machine in this focused module. Distinguish normal root exit from cancellation; no kill operation on a naturally completed/settled handle. Preserve first successful termination reason, return deterministic incomplete details, and avoid swallowing errors. No native API, stream collector or job registry belongs here.
- [ ] Run sandbox suite/typecheck and existing exec/terminal tests to catch public export regressions; commit only task files.

## Task 4: Foundation contract integration and package boundary gate

**Files:** Add `packages/exec/test/execution-contract-consumer.test.ts`; update `packages/sandbox/README.md` and `packages/sandbox-policy/README.md` with supported APIs and limits. Create missing READMEs if necessary.

- [ ] Through public package imports only, compose a compiled policy, negotiated fake backend, prepared execution and lease. Revalidate authority after asynchronous preparation; a removed project/revision change calls rollback and never commits. A valid call returns one owned handle, cancellation resolves only after tree/I/O/resources, and promotion keeps that same handle. This is a contract test, not native-enforcement evidence.
- [ ] Add type-level public-consumer compile checks for pipe/PTY and receipts; do not instantiate Win32 types or import any other package's src.
- [ ] Run affected package tests/typechecks and root typecheck. Run package-boundary searches on changed files for cross-package src imports and native API leakage.
- [ ] Independent task reviews and whole-phase review; fix findings. Record exact tests and limitations in the READMEs. Commit task files and finish the foundation ledger.

## Next plans (same authorized redesign)

After this phase's public API is reviewed and stabilized, write the concrete process-supervisor/legacy-driver migration plan against these exact exports, then the terminal/authority commit integration plan, followed by the Windows PSEC native helper/qualification plan. These are separate deliverables under the approved architecture, not optional work. Continue without a repeated generic start approval. No PSEC native success may be inferred from foundation fake-driver tests.
