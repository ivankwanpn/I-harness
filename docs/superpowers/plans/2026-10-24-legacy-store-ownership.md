# Legacy result-store ownership implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan. One implementer owns this connected task; root dispatches its independent review.

**Goal:** Give the actual legacy result store one truthful lifetime and the same physical quota mutation owner as managed results, before semantic fork transfers use it.

**Architecture:** Extract the existing managed mutation queue and lock into a private shared owner. Keep the legacy database under a separate lifetime lease, and route legacy mutations through short owner-issued turns. Preserve original resources and cleanup failures across explicit retries.

**Tech Stack:** TypeScript, Node SQLite, existing `@i-harness/fs-lock`, Vitest; existing Windows/Linux locking implementations only.

**Spec:** `docs/superpowers/specs/2026-10-24-legacy-store-ownership.md`, within `docs/superpowers/specs/2026-10-23-v0.1.13-integrated-delivery.md`.

## Global constraints

- Product remains `0.1.13-rc.1`; Session format remains `12`. No public protocol, artifact/owners format, seed schema, provider behavior, new retention limit or release changes.
- This task repairs existing shipping storage. It is not F1 public fork completion, R4B completion, complete event delivery or the full version gate.
- One writer/runtime per checkout; GPT-6.1 Sol, no recursive agents. Preserve protected untracked fixtures, previous branches and every failed/setup/counterfactual receipt.
- Use one existing result store, one physical quota owner and original cleanup objects. Do not rerun producers or create a second completion/permission registry.
- Callbacks for legacy producer and authorization execute outside mutation locks. Actual retained refs, byte integrity, source policy, query budgets, disabled grants, expiry and canonical owners remain enforced.
- Sequential package-CWD tests use `--maxWorkers=2 --minWorkers=1`. No provider/account or installed-profile operations. Retain fixed-source manifests and raw command exits; no reseed/exemption or fake consumer to pass reachability.
- Pure size-based splitting remains deferred. Introduce cohesive private modules only as required by this behavior.

## Root decisions

- L0-01: immutable construction root/workspace supersedes the old live-relocation getter calibration. This fixes a real mismatch between directory and quota-lock identity. Preserve laziness and producer-once behavior, and document the changed test contract explicitly.
- L0-02: legacy lifetime key is `context-output-legacy:<workspaceId>`, quota key stays `context-output:<workspaceId>`, both via `lockPathFor` on captured resolved root. Lifetime is acquired before a quota turn; no quota-held wait for lifetime. A competing opener fails under existing bounded contention semantics, then can succeed after confirmed retirement.
- L0-03: all data mutations use the same actual shared owner. Turns are checked against that owner's private active-token table, not an arbitrary `assertCurrent` function supplied by a caller. Direct internal ContextStore construction remains usable for path/disk inventory, but cannot open or mutate without the genuine owner/lifetime.
- L0-04: retain the F0 release-debt rule locally. Failed release with raw `held=false` remains unresolved even if a later release is a no-op. A still-held original lease can be explicitly retried. Do not modify low-level fs-lock or call an uncertain release successful.
- L0-05: capture/grant prepare callbacks outside the local serial and shared quota turn. Commit rechecks signal, store identity, lifetime, captured full ref equality/expiry and actual current quota. Generic async authorization remains its existing prepared decision, not a new perpetual permission; later F1 observed policy is a separate requirement.
- L0-06: preserve original work error and cleanup error together. Join the same close attempt, skip only confirmed stages, attempt independent writer cleanup, and retain dependent shared-owner resources until their users settle. No new store around unresolved cleanup.
- L0-07: `cold-lookup-integrity.test.ts` may move its actual deletion-listener call out of the injected rename callback's async context: hold rename, call the real listener from the outer test, then release/join both. Preserve staged/cold refusal and canonical pin/body assertions. Same-owner recursive mutation must still have an explicit rejection control. Attach failure handlers before releasing barriers; preserve the original failed run and warning. Tiny-budget read/search must continue to reject before any lock/root/index filesystem effect.
- L0-08: the executor mixed-quota fixture must issue its original legacy capture while the real managed write is held, verify legacy admission has not begun, then release/join that same write and await the same capture. Its former `await legacy` before releasing the quota-owning write is incompatible with intentional serialization. Preserve the bounded noncompletion evidence, final physical bytes, retention/protected and producer-count assertions; do not replace the request after releasing the barrier. This authorizes only that integration test's scheduling correction, no executor product changes.

### Task 1: Own the existing legacy database and shared workspace mutations

**Files:**

- Create `packages/context-output/src/workspace-mutation.ts` for the existing quota queue/lease and private turn/debt lifecycle.
- Modify `packages/context-output/src/service.ts`, `store.ts`, `legacy/capture.ts` and `artifact/ownership.ts` for actual consumers.
- Create `packages/context-output/test/legacy-store-ownership.test.ts` and controlled process helper if needed.
- Modify only necessary assertions/awaits in `test/close-ownership.test.ts` and `test/legacy-workspace-timing.test.ts`; preserve their behavioral controls. Other test additions may reside in cohesive ownership/callback files.
- `test/cold-lookup-integrity.test.ts` has the narrow outer-context barrier adjustment in L0-07; its original result/retention assertions remain binding.
- Existing executor tests are integration consumers, not product rewrite targets. No assembly, fork, SDK, Desktop or native-process product changes.

**Private interfaces:**

```ts
interface WorkspaceMutationTurn { assertCurrent(): void }
interface WorkspaceMutationOwner {
  mutate<T>(work: (turn: WorkspaceMutationTurn) => Promise<T>): Promise<T>;
  cleanup<T>(work: (turn: WorkspaceMutationTurn) => Promise<T>): Promise<T>;
  assertTurn(turn: WorkspaceMutationTurn): void;
  join(): Promise<void>;
  close(): Promise<void>;
}
// Private factory, consumed by the actual service:
declare function createWorkspaceMutationOwner(identity: {
  root: string; workspaceId: string;
}): WorkspaceMutationOwner;
// Actual internal ContextStore operations:
// acquireLifetime(signal?: AbortSignal): Promise<void>
// open(turn: WorkspaceMutationTurn, maxDiskBytes: number, signal?: AbortSignal): Promise<void>
// close(): Promise<void>
```

Store receives the exact shared owner through an internal constructor parameter; mutation methods take that owner's turn. A missing owner permits inventory only. `put/addOwners/clear/prune/configureDiskBudget` verify the turn and actual lifetime before effects; private index/remove helpers inherit it. Keep existing public ContextOutputService signatures unchanged.

- [ ] **Step 1 — causal RED controls before product changes.** Use real services/SQLite for two same-workspace instances, and a separate Node child for actual OS contention. Hold the first store, attempt second read/search-triggered open, and record whether index bytes or the first owner's successful read are disturbed. Verify different workspace/root and managed-only second services still work. The expected fixed behavior is conflict before index mutation, then successful cold reopen/read/search after original close.

```ts
const first = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } });
const second = createContextOutputService({ root, workspaceId: 'w', config: { enabled: true } });
const ref = await first.capture({ sessionId: 's', callId: 'c', label: 'saved', text: 'original needle', complete: true });
await expect(second.read({ sessionId: 's' }, { refId: ref!.id })).rejects.toThrow(/lock|conflict/i);
expect((await first.read({ sessionId: 's' }, { refId: ref!.id })).text).toBe('original needle');
await first.close();
expect((await second.read({ sessionId: 's' }, { refId: ref!.id })).text).toBe('original needle');
await second.close();
```

Use bounded watchdogs solely to fail/clean controlled tests, not as passing evidence. Also create RED controls for legacy/managed quota admission overlap and late opening after close. Preserve original output even when one test fails earlier than its final assertion.

- [ ] **Step 2 — implement the real shared owner.** Move the existing artifact local serial/short quota-lock operation into `workspace-mutation.ts`, pass the same instance to artifact ownership and the legacy store. Keep exact callback results; if work and release both fail, preserve both failures. Register debt before rejecting. Subsequent data turns cannot acquire replacement leases while debt remains. Private async-context identity rejects same-owner reentry promptly instead of deadlocking. Expire each token synchronously when its callback ends; `assertTurn` checks real owner/token/lifetime and active lease. Cleanup and join cannot wait on their own serial tail.

```ts
const result = owner.mutate(async turn => {
  owner.assertTurn(turn);
  await store.prune(turn);
});
// A captured token outside that callback must fail owner.assertTurn(token).
```

`prune(turn)` is the actual existing store operation with its new private turn argument. Other mutation methods use the same turn convention; this is not a new alternate storage path.

- [ ] **Step 3 — immutable identity and actual store lifetime.** Explicitly read root/workspace once, validate and resolve root, then pass an owned options object without spreading/reinvoking caller identity getters. Preserve the existing callbacks and configuration semantics. Acquire the separate lifetime before any index touch, store the candidate before awaiting acquisition, and share opening. Open/rebuild under the shared turn. Do not install a stale candidate after close. Failed opening uses the same original cleanup; only confirmed disposal permits replacement/retry. Pure unopened `diskBytes` diagnostics stay read-only.

- [ ] **Step 4 — connect every legacy mutation.** Capture admits the whole job and calls the original producer once before acquiring the store/turn; normalize its returned data before commit. Under local serial then shared turn, recheck and prune/recompute physical available budget/put. Grant prepares actual legacy readable/authorize decisions before either mutation lock, then validates the same refs/expiry/lifetime before `addOwners`; mixed managed grants stay outside the legacy turn. Read/search acquire a ready store before policy callbacks and do not hold quota while calling policy. Clear/configure preserve their existing transition fences, join jobs, resolve/open outside quota, then mutate inside the shared turn. Treat only real ENOENT as absent; EACCES/EIO cannot become successful empty clear. No nested getStore or quota reacquisition from a turn.

- [ ] **Step 5 — truthful async close.** Service keeps its synchronous permanent admission fence and one original close flight. Join jobs/transitions/local mutation queue, unsubscribe once, close artifact admissions and attempt all original writer suspensions, close actual legacy DB under cleanup, then retire the shared owner after all dependent users settle. Successful suspensions leave the retained set; failures stay for explicit retry. Database/lifetime release stages retain their original resources and errors. Lifetime release follows confirmed DB and quota-turn disposal, outside quota. Store.close is awaited everywhere. An opening/DB/lease cleanup failure cannot be lost by `finally` or replaced by a fresh candidate. Raw consumed-held-bit release failures stay explicit debt.

- [ ] **Step 6 — close and callback controls.** Real producer and legacy policy callbacks must be able to read/write managed results without deadlock. Test accidental shared-owner reentry and stale/foreign turns, close during acquisition/open/queued mutation, original DB close failure, releasable quota/lifetime failure and consumed-held-bit uncertainty. Concurrent close callers see the same failure; later explicit retry skips completed stages. Preserve RC03 body/leaves/later-SQLite/unsubscribe-once and disabled grant/source-clear read controls. Test managed-only coexistence without opening legacy SQLite.

- [ ] **Step 7 — explicit identity contract migration.** Replace only the old constructor-three-reads/live-relocation calibration with: each identity captured once, held producer creates no storage/lock, caller options mutation leaves original directory/ref/lock identity unchanged, a genuinely new service can use a different workspace. Keep one producer invocation, caller input snapshot, actual live and cold read byte assertions. Record why these assertions changed; they are not an unrelated baseline failure.

- [ ] **Step 8 — fixed-source verification and report.** Run focused RED/GREEN commands from `packages/context-output`, then its complete suite and typecheck sequentially. Run actual executor `result-store-close.test.ts`, `result-reader-close.test.ts`, `mixed-retention-native.test.ts` and `mixed-retention-quota.test.ts`, plus executor/CLI types because close ownership is shared. Reuse unchanged evidence beyond affected owners. Record source manifests before/after final runs, command/cwd/exit/failed names and actual process cleanup. A failed known unrelated test remains failed evidence, never a green suite. Do not build release candidates for this precursor; root owns later F1 packaged integration.

Commands use the checkout's direct Vitest/TypeScript entry when package-manager setup would rewrite dependencies. Equivalent existing Node/pnpm invocations are acceptable only after dependency resolution proves checkout-owned workspace packages. Final report includes full BASE..HEAD, exact product files, retired test contract, raw receipts, failure disposition and remaining F1 obligations. Commit the scoped product/tests; root generates a full-range review package. Do not start legacy transfer schema or public fork callers in this task.
