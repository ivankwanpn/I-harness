# Session persistence maintenance map

`src/index.ts` remains the package facade. The package
export path is unchanged; backends and callers use `@i-harness/session-persistence`.
The facade reads the background reporter and batching delay, then initializes
the ownership service. This keeps the original option getter order. Acquisition
retry/deadline options remain lazy reads inside each lease acquisition. Backend
methods remain calls on the live backend object, including reads after awaits.

Current-format durable mutation uses the backend constructor's native ownership
and task-transition composition. The public `createSessionCoordinator(backend)`
selects that immutable, constructor-owned factory. JSONL supplies it directly;
`asSessionCoordinator(createJsonlCommitCoordinator(...))` supplies the commit-log
facade with the same canonical Task codec by default. Callers no longer need a
private Task validator to create, load or run a current-format session.

Use `createReadOnlySessionCoordinator(backend)` for list, profile, snapshot and
document reads without adoption or mutation. Its frozen read facet works while
another coordinator owns the writer and preserves supported legacy files. A
backend without the native factory cannot advertise a writable coordinator;
explicit `lock: { enabled: false }` is rejected for writable construction and
should use the read facet instead. Storage algorithm unit tests may still
instantiate the underlying internal modules with their precise capabilities.

| Module | Responsibility and state authority |
| --- | --- |
| `coordinator/types.ts` | Backend, coordinator, metadata, model selection, options and artifact manifest contracts. |
| `coordinator/ownership.ts` | One held-lease Map, one in-flight acquisition Map and one session-operation Map per coordinator; shared acquire, borrow/release and operation serialization. |
| `coordinator/mutations.ts` | One write-behind Map and one session deletion-admission Set per coordinator; create/append/enqueue/meta mutation and explicit ownership adoption/release. |
| `coordinator/conversation-index.ts` | Derived structural metadata under the existing operation gate; invalidated by recovery, failed/uncertain append, release, deletion and close. No raw archive cache. |
| `coordinator/documents.ts` | One document chain and one deleted-document Set per coordinator; document leases, admission and legacy failure reporting. |
| `coordinator/load.ts` | Snapshot, repairing load and owned recovery, each with its own sequence and header behavior. |
| `coordinator/lifecycle.ts` | Deletion and close ordering through narrow capabilities of the existing state owners. |
| `format/registry.ts` | One module-level upgrade Map and event-type registry, shared by every coordinator; builtin and extension initialization order. |
| `format/validation.ts` | Version gate, migration, ignorable-event gate and lineage-header projection. |

`write-behind.ts` owns batching, timers and retained retry batches. `repair.ts`
owns semantic tail repair. `fork.ts` owns completed-turn selection; `seed.ts` owns shared batch semantics,
image materialization, reference remapping and inherited seed provenance.
`store-root.ts` owns root resolution. These pre-existing modules remain independent.
Small document/lifecycle/validation modules reflect cohesive responsibilities;
the three load algorithms stay together so their differing contracts are visible.

## Ownership and operation ordering

Public writable construction enables the native session ownership lease for
create, append, metadata mutation, adoption and write-behind writes. Enqueue remains
synchronous and acquires ownership only in its later write callback. Concurrent
acquisition shares one promise; a repair that observes an already held or
in-flight acquire never releases that other path's lease. A genuinely borrowed
lease is released around repairing `load`; successful `loadOwned` retains it.

Session mutations and repairing loads share the same per-session operation
chain. Each gate resolves in `finally`, so a failure does not poison the next
operation. Other sessions remain independent. Documents use their own chain and
borrow `doc:<key>` leases. JSONL list, profile and document reads use the original
read owner. Commit-log readers hold shared snapshot-retention leases, allowing
the session writer to continue while protecting the reader's sidecars.

## Legacy generation handoff

The JSONL commit adapter acquires the same original session artifact lease as a
normal JSONL writer. It holds that lease across the legacy read and atomic
commit-generation publication, then releases it through the existing ownership
cleanup. A second migrator reselects the published generation while it owns the
legacy lease. Publication leaves the old physical bytes intact; subsequent
legacy native/public session writes refuse the superseded namespace. Historical
structural reads and legacy document read-through remain available.

The commit facade supports new targets and exact replay of a stored birth.
Replacing an existing empty header is explicitly not issued as unsupported;
nonempty target collisions are refused. This check runs under the same original
legacy exclusion, and neither path shadows the old artifact.

A generic legacy port that supplies only read/list is still readable, but cannot
promise an exclusive migration and therefore refuses a first write with
`LEGACY_MIGRATION_UNSUPPORTED`. The original JSONL adapter supplies the supported
migration scope. Cooperating writers must use the same configured lock root;
uncooperative old binaries that bypass this ownership protocol are outside this
handoff contract. No reread window or in-place overwrite is used as a substitute
for ownership.

## The three load contracts

| Path | Durable behavior | Events and sequences | Header |
| --- | --- | --- | --- |
| `snapshot` | Non-destructive read; no ownership or repair. | Version gate, filter ignorable unknown events, then migration; no semantic tail repair or sequence canonicalization. | The entire backend metadata object when present. |
| `load` | Peek/version gate precedes backend repair; borrows a lease only for repair. Synthetic semantic events remain in memory. | Drops ignorable unknown events before migration and tail repair. Preserves every defined seq; missing seqs use `max(index, maxDefined + 1 + syntheticCount)` to avoid aliases. A repaired result may have non-monotonic seqs. | Only present lineage fields: parent session, seed length, delegation depth and origin. |
| `loadOwned` | Flushes the pending batch, acquires ownership, then peeks/gates/repairs. Persists a changed canonical body through `replaceEvents`, and fails closed if that capability is absent. Releases a newly acquired lease on failure. | Retains ignorable unknown events, migrates and repairs the tail. Every defined seq must equal its position; missing seqs become positional. | The same lineage-only projection as `load`. |

The process-wide format registries remain shared when an event type or upgrade
is registered after coordinators have already been created. A future format or
missing upgrade path is refused before the backend can destructively repair it.

## Deletion, close and legacy documents

Deletion closes session and manifest-document admissions synchronously. It
cancels that session's automatic wait, flushes its existing batch and removes
its write-behind only after success. It then drains the current document chain,
joins the session operation chain, acquires ownership, commits the backend
tombstone and releases ownership in `finally`. Deleted documents cannot reopen.

Native coordinator close fences fresh public IO immediately and joins accepted
operations before backend-owned cleanup releases their resources. Original Task
and revocation continuations keep their own private callbacks during cleanup;
a fully closed coordinator cannot start IO again. Ownership status remains a
memory observation after close, and repeated close can finish retained cleanup.
A callback cannot await the close that is joining that same callback; an
external close still waits for the accepted operation.

This intentionally replaces the former post-close metadata/enqueue behavior.
Standalone write-behind instances still retain their own failed batches for
explicit retry; that does not reopen a retired coordinator.
