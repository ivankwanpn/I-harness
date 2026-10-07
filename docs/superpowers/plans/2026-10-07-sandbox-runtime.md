# Shared sandbox execution runtime

Date: 2026-10-07 (Asia/Hong_Kong).

Approved parent design: `docs/superpowers/specs/2026-10-07-sandbox-package-redesign-proposal.md`. This is the next implementation phase of the already approved redesign. The foundation lease, immutable policy compiler and `exec.launchExecution` are prerequisites. Completing this phase does not complete native confinement or production migration.

Use the existing `codex/sandbox-package-redesign` checkout. Keep cross-package imports public, dependencies `workspace:*`, and platform resources in drivers. Do not introduce accounts, elevated tasks, services, reference ACL changes or a fallback to a weaker driver.

## Public interfaces

Add transport contracts to `@i-harness/sandbox` without removing the foundation lifecycle contract:

```ts
export interface ExecutionOutput {
  channel: "stdout" | "stderr" | "pty"
  data: Uint8Array
}
export interface ExecutionIo {
  /** One consumer, retained before that consumer begins; driver must bound buffering. */
  output: AsyncIterable<ExecutionOutput>
  write(data: Uint8Array): Promise<void>
  endInput(): Promise<void>
  resize?(cols: number, rows: number): Promise<void>
  signal?(signal: "INT" | "TERM" | "KILL"): Promise<void>
}
export interface TransportExecutionHandle extends ExecutionHandle {
  readonly pid: number
  readonly io: ExecutionIo
}
export interface PreparedTransportExecution extends PreparedExecution {
  commit(validateAuthority: () => void): Promise<TransportExecutionHandle>
}
export interface TransportExecutionBackend extends ExecutionBackend {
  prepare(spec: ProcessSpec, policy: CompiledSandboxPolicy, signal?: AbortSignal): Promise<PreparedTransportExecution>
}
```

Keep `launchExecution`'s base public overload and add a transport overload which preserves the refined return type. No assertion may fabricate transport on a base lifecycle handle. These types contain no Node streams, IPty or Win32 HANDLE.

`@i-harness/exec` produces:

```ts
export interface ExecutionLaunch {
  backend: TransportExecutionBackend
  spec: ProcessSpec
  policy: CompiledSandboxPolicy
  requirements: BackendRequirements
  validateAuthority(policy: CompiledSandboxPolicy): void
  signal?: AbortSignal
}
export interface SupervisedExecution {
  readonly id: string
  readonly handle: TransportExecutionHandle
  readonly policy: CompiledSandboxPolicy
}
export interface ExecutionSupervisor {
  launch(request: ExecutionLaunch): Promise<SupervisedExecution>
  list(): readonly SupervisedExecution[]
  cancel(id: string, reason: StopReason): Promise<ExecutionSettlement>
  /** Re-check preparations and active policies; drain invalid ones before returning. */
  reconcile(ownerSessionId: string, validateAuthority: (policy: CompiledSandboxPolicy) => void): Promise<void>
  /** Blocks new admission for this owner until its preparation and execution ownership drains. */
  closeOwner(ownerSessionId: string): Promise<void>
  dispose(): Promise<void>
}
export function createExecutionSupervisor(): ExecutionSupervisor
```

The supervisor owns the actual handles, not output records or UI terminals. It binds a detached frozen snapshot of exact ProcessSpec fields before the first await (argv/environment/owner/PTY included; no executable, cwd or argument rewriting). Spec owner must match policy owner and lineage. Policy is the immutable compiler output, not a refreshed broader policy. It registers pending preparation before the first await. It uses a linked abort controller and `launchExecution`; at every authority fence it checks supervisor/owner admission state as well as the caller's validator. A successful commit is registered before exposure. Validate returned receipt owner/fingerprint/backend ID and unique execution ID; a mismatched committed handle is still owned, cancelled and drained before failure is returned. Promotion does not call launch again or replace the handle, backend, policy or owner. The same handle serves pipe and PTY consumers.

Driver output is consumed by the presentation adapter in the later migration. The supervisor never invents a tree/I/O fact. It observes the lease's current settlement, removes an entry only on `kind: settled`, and retains incomplete entries for an explicit cancellation/disposal retry. Attach rejection observers immediately. Dispose/closeOwner/reconcile reject with collected incomplete/error diagnostics instead of acknowledging successful revocation. Concurrent close/dispose share their active attempt; a failed attempt can be retried. New admissions stay blocked after close/dispose failure.

`reconcile` temporarily blocks admission for that owner, aborts preparations whose policy is now invalid and cancels invalid active handles with `authority-revoked`. Compatible active policies continue. Wait for the affected pending preparations (including rollback) and active settlements. Re-open admission only after a successful reconcile; failure remains blocked until a later successful reconcile. A closing/disposed owner cannot be reopened by reconcile. Operations for unrelated owners continue. The validation supplied during reconcile must also replace the stale launch validator for pending prepares before commit.

## Task 1: Platform-neutral workload transport

**Files:** `packages/sandbox/src/execution.ts`, package root exports as needed, `packages/sandbox/test/execution-transport.test.ts`, `packages/exec/src/execution-admission.ts`, `packages/exec/test/execution-contract-consumer.test.ts`.

- [ ] Public consumer RED verifies missing transport exports and transport overload; compile checks both base lifecycle and refined pipe/PTY consumers.
- [ ] Add contracts above. Preserve base consumers and receipt/lease semantics. Refined commit returns the real handle supplied by the backend. Do not cast a base handle into a transport handle.
- [ ] Test that I/O, actual PID, receipt and handle identity survive admission. Abort/revalidation/rollback behavior is identical for both overloads.
- [ ] Sandbox/exec tests and typechecks. Commit assigned files only.

## Task 2: One execution owner and revocation fence

**Files:** Create `packages/exec/src/execution-supervisor.ts` and `test/execution-supervisor.test.ts`; package root export; update `packages/exec/README.md` (create if missing).

- [ ] Deferred-promise RED tests: preparation registered before async work, detached immutable spec (caller mutation during prepare cannot change launch), owner/lineage/receipt validation and mismatched-handle cleanup, one handle through promotion, pipe and PTY in one registry, root exit does not unregister, complete settlement unregisters, incomplete settlement retains ownership and retries.
- [ ] Reconcile during prepare must abort/rollback with no workload marker; after commit must cancel and await tree/I/O/resources before acknowledgement. Test pending commit, compatible policies, unrelated owners, repeated/concurrent close, failed cleanup retry and disposal failure with admissions remaining blocked.
- [ ] A late successful commit while cancellation is pending is still owned, canceled and drained before close acknowledges. No orphaned handle from async setup. Real cancellation reasons are preserved.
- [ ] Implement the supervisor in a focused module using only public sandbox APIs and `launchExecution`. No native spawn, taskkill, node-pty, policy recompilation or driver selection here. The existing exec service will migrate in the next production plan.
- [ ] Run focused RED/GREEN, exec/sandbox tests and affected typechecks; independent task review and whole-phase review. Document ownership and native limits without claiming actual confinement.

## Required subsequent phases

1. Implement and qualify the independent Windows helper/driver package against these transport and lifecycle contracts. Its own Job controls Windows trees, including explicit unrestricted launches; selecting PSEC is an explicit experimental choice, never a default security claim or fallback.
2. Provide local/POSIX and explicit legacy driver composition with honest capabilities, then migrate pipe/stream/background and PTY services to this supervisor. Preserve exact command binding, output limits, owner lineage and per-call approval.
3. Add versioned project authority producers and asynchronous revocation/mode acknowledgements. Fix the confirmed revoked-project `undefined` fallback in FS, approval and execution consumers. Session disposal awaits the same supervisor.
4. Wire helper artifacts into CLI/Desktop build verification and run real Bash/Node, readonly references, workspace writes, cancellation/descendant retention, PTY and stale-authority gates. Do not change defaults until supported behavior and assurance are recorded.

Ruling: qualify a concrete native driver before replacing live Windows launches — the old code must not be replaced with fake tree observations. Cost is a short additive runtime phase before migration, rather than an incomplete platform adapter in production.
