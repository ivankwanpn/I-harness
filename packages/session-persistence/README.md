# Session persistence maintenance map

`src/index.ts` remains the package facade. The package
export path is unchanged; backends and callers use `@i-harness/session-persistence`.
The facade reads the background reporter and batching delay, then initializes
the ownership service. This keeps the original option getter order. Acquisition
retry/deadline options remain lazy reads inside each lease acquisition. Backend
methods remain calls on the live backend object, including reads after awaits.

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

Locking defaults to disabled. When enabled, create, append, metadata mutation,
adoption and write-behind writes use the session ownership lease. Enqueue remains
synchronous and acquires ownership only in its later write callback. Concurrent
acquisition shares one promise; a repair that observes an already held or
in-flight acquire never releases that other path's lease. A genuinely borrowed
lease is released around repairing `load`; successful `loadOwned` retains it.

Session mutations and repairing loads share the same per-session operation
chain. Each gate resolves in `finally`, so a failure does not poison the next
operation. Other sessions remain independent. Documents use their own chain and
borrow `doc:<key>` leases; list, profile and document reads acquire no lease.

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

Close flushes every current write-behind with `allSettled`, cancels automatic
waits, drains documents, drains the current session operation gates, attempts
every held lease release (including synchronous throws), and clears held leases.
It aggregates exactly the original flush failures. Write-behinds remain available
after close, including retained failed batches for a later enqueue/flush retry.

Legacy `putDocument` reports ordinary write/lease failures and resolves if the
reporter returns normally. The document chain survives those failures. An
injected reporter that throws still rejects the caller, including a report for
a deleted document. Close drains the recovered document chain rather than the
reporter's promise. This package does not provide a strict document commit
receipt or isolate observer failures through this structural decomposition.

## Verification entry points

Run the following suites sequentially from the repository root. Windows
ownership tests use real locks in controlled temporary directories; crash
acceptance tests use local temporary logs and child processes.

```powershell
pnpm --filter @i-harness/session-persistence exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/session-persistence typecheck
pnpm --filter @i-harness/session-executor exec vitest run test/service.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/session-executor typecheck
pnpm --filter @i-harness/session-persistence-jsonl exec vitest run test/delete-owned.test.ts test/meta.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/session-persistence-jsonl typecheck
node scripts/audit/check-reachability.mjs --self-test
node scripts/audit/check-reachability.mjs --gate
```

`coordinator-order.test.ts` pins late registry updates, initialization getters,
late backend method reads and receivers, and reporter exceptions with a surviving
document chain. `ownership.test.ts` covers repair/append serialization, real
lease conflicts, shared acquisition, adoption/borrow behavior and release.
`persistence.test.ts` covers format refusal, event filtering, batching failure
and document writes; `load-gate-coverage.test.ts` reads the authoritative
`format/registry.ts`. JSONL deletion/meta tests cover the durable store boundary.

The current durable header is version 3, with identity migrations from versions 1
and 2. Complete reads validate history before any backend repair; shape-only batch
preflight permits references into an earlier durable batch. The writer stages those
references against one derived prefix index and commits metadata after storage
accepts the append. An uncertain append invalidates the index and the next attempt
rereads actual records, recognizing an already durable identical prefix. Existing
write-behind owns retry retention and scheduling.

Fenced semantic recovery appends truthful results and closers at new coordinates,
including closed accepted tails. It never shifts defined references. JSONL preserves
committed raw lines through fenced repair and preserves unknown metadata/body bytes
through header upgrade. Snapshot remains read-only. Batch seed transformation
restores a sliced-away fence before explicit observations and rejects partial
accepted bundles before child creation; the isolated legacy remapper rejects
explicit acceptance/fence records. Metadata validation is incremental; backend
full-file reads and atomic replacement I/O remain CX1/R6 work.
