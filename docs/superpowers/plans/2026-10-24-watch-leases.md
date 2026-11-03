# W1 Host-owned File-watch Leases Implementation Plan

> Root approved this scoped foundation on2026-10-24 under the integrated delivery plan. Use subagent-driven-development with fresh GPT6Astra implementation and independent review, one isolated worktree/writer and no recursive agents. User already authorized sequencing; do not ask for another execution-mode approval.

**Goal:** Establish one explicit host-owned sharing service over the maintained fs-watch backend, with bounded loss signaling and joined cleanup, for instruction I2 and event W2 consumers.
**Architecture:** `createFsWatcher` remains the actual chokidar/legacy-stream owner. A service instance owns one stream drain per identical normalized selection and fans out typed notifications to its leases. No process-global or cross-profile registry, no gateway dependency, no second native watcher implementation.
**Specs:** [integrated master](2026-10-23-v0.1.13-integrated-delivery.md), [event design](../specs/2026-10-13-v0.1.13-event-runtime-design.md), [lifecycle/watch supplement](../../refactoring/v0.1.13-lifecycle-durability-gates.md), [event rebase](../../research/v0.1.13-integrated-20261023/event-rebase.md).
**BASE:** planning read MAIN `41ad97d39fa1f056ef55cd55c7411b501e6ef130`; integrated master is present in the working tree. Root supplies the immutable implementation BASE. Record `git rev-parse HEAD` and diff before editing; do not reuse prior41ad97d3 as an unverified new BASE.

## Scope, real consumers and honest staging

Modify `packages/fs-watch/src/index.ts`; create `packages/fs-watch/src/{types,stream,leases}.ts` only where these responsibilities need separate files. `stream.ts` contains the existing maintained backend, legacy queue and readiness/close fixes; `leases.ts` owns sharing/fanout/retry. `types.ts` contains the contracts below. Index exports the existing public API plus the new service/types; no internal testing exports or new package dependency.
Tests: extend `packages/fs-watch/test/watch.test.ts`; create `packages/fs-watch/test/{stream-lifecycle,leases,lease-windows}.test.ts` and `test/helpers/push-watcher.ts`. Tests may mock the real `chokidar` module or use a package-private constructor seam; do not make public dependency injection a reachability workaround.
No production files outside fs-watch in this first task. Existing real consumer remains `packages/settings/src/observation/watch-settings.ts:createFsWatcher`, via layered-store and gateway trust watcher. Run unchanged settings tests to qualify that actual maintained path. Its current restart/fingerprint owner is not migrated here.
**New shared-service exports are staged**, not user-facing event/I2 completion. Record any new reachability rows with names and owner in the ledger; do not waive/reset the gate, add a fake production call, or claim whole-repo green. Root reserves I2/W2 first real consumer before integrated acceptance. A later settings cutover must remove its competing retry logic; that is not part of W1.

## Closed public contract

```ts
export type FsWatchEvent = { path: string; kind: 'add' | 'change' | 'unlink' }
export interface FsWatcherOptions { roots: string[]; ignore?: string[]; persistent?: boolean }
export interface FsWatcher {
  readonly ready: Promise<void> // NEW additive barrier; current production object supplies it
  readonly events: AsyncIterable<FsWatchEvent> // shared competing queue, NOT broadcast
  close(): Promise<void>
}
export type FsWatchFailureCode =
  | 'FS_WATCH_BACKEND' | 'FS_WATCH_GAP' | 'FS_WATCH_POLLING'
  | 'FS_WATCH_CLOSED' | 'FS_WATCH_CAPACITY' | 'FS_WATCH_CLOSE'
export class FsWatchError extends Error { readonly code: FsWatchFailureCode; constructor(code: FsWatchFailureCode, message: string, options?: ErrorOptions) }
export interface WatchCursor { readonly epoch: number; readonly revision: number }
export type WatchNotification =
  | { readonly kind: 'changed'; readonly cursor: WatchCursor; readonly changes: readonly Readonly<FsWatchEvent>[] }
  | { readonly kind: 'reset'; readonly cursor: WatchCursor; readonly reason: 'initial' | 'overflow' | 'recovered' | 'subscribe' }
  | { readonly kind: 'unavailable'; readonly cursor: WatchCursor; readonly code: FsWatchFailureCode }
export interface WatchLease {
  readonly ready: Promise<WatchCursor>
  subscribe(listener: (event: WatchNotification) => void): () => void
  close(): Promise<void>
}
export interface FsWatchService {
  acquire(options: FsWatcherOptions): WatchLease
  close(): Promise<void>
}
export function createFsWatchService(options?: {
  onObserverError?: (error: unknown) => void
}): FsWatchService
```

`FsWatcher.ready` becomes required on actual created objects. Existing supplemental mocks declaring `FsWatcher` in settings tests need an additive resolved/held ready field if their TypeScript checks require it; root may authorize that test-only compatibility edit, never a production consumer rewrite. Alternative optional-ready public contract is rejected: the service must have a real readiness guarantee, not infer readiness from first delta.
`WatchNotification.changed` contains **full ordered change records**, not paths alone. Never fabricate `change` for reset/unavailable and never stat a path to guess a lost kind. Types and runtime objects are readonly/copied per notification; callbacks cannot mutate another lease's view. Cursor is observation-only, no durable/replay/source-policy authority.

## Exact lifecycle and boundedness

| Boundary | Frozen rule |
|---|---|
| Host ownership | Every `createFsWatchService()` owns a private Map. Equivalent selections share only within that instance. A service reference is an explicit host capability; it grants no new file/root authorization. Callers pass already authorized selections. Closing one service cannot affect another. |
| Sharing key | Resolve roots against cwd captured at acquire, normalize separator spelling, deduplicate and sort exact strings; ignore segments deduplicated/sorted; include persistent effective boolean. Copy options. No realpath, broad parent-root merging, case-fold, symlink expansion or cross-key subset sharing. False-negative sharing is safe; conflating different scopes is not. |
| Capacity | At most128 active/closing keys per service,64 leases/key,16 listeners/lease,256 roots/acquire,256 custom ignore segments. Reject invalid/empty roots and overcapacity with FS_WATCH_CAPACITY before creating native work. No silent eviction. Options counts are resource caps, not instruction candidate policy. |
| Source startup | Install native callbacks immediately; queue source events in observed order while baseline is unresolved. `ready` resolves only after chokidar ready AND baseline/classification backlog is drained into the bounded queue. It is not a filesystem transaction or proof that no future event is in flight. Missing explicit files remain watchable; initial existing echoes remain suppressed. |
| Startup ambiguity | Existing header wrongly calls async baselineWalk synchronous. Correct that claim. Preserve characterized missing-file/create/delete/recreate behavior; if observed source ordering proves a classification gap (for example conflicting queued add/unlink/re-add), emit FS_WATCH_GAP rather than silently discard the transition. Mere lack of an atomic construction-time snapshot is not a reason to fail every healthy startup. The legacy stream remains characterized best-effort deltas before ready, with no lossless construction-time history claim; the new lease contract is initial ready/reset plus consumer resnapshot. I2/W2 must migrate actual consumers to that contract before full-event release acceptance. In particular held baseline + conflicting add/unlink/re-add must fail or preserve true ordered deltas, never erase them. No timestamps/stat loops to invent certainty. Service reset/recovery is the reconciliation route; consumers still read initial state. |
| Ready failures | Backend/polling/gap before ready rejects ready and pending reads with the same typed cause. Closing before ready rejects ready with FS_WATCH_CLOSED and ends pending reads cleanly. Internally observe rejected readiness promises to avoid unhandled rejection for legacy users that only iterate; the exposed Promise still rejects to awaiters. |
| No stabilization polling | Set chokidar awaitWriteFinish:false and usePolling:false; inspect installed dependency's effective option behavior. Detect environment-forced polling before native open and refuse FS_WATCH_POLLING; do not mutate global environment or vendor source. Document actual platform/backend. One-shot quiet-window batching is allowed, repeated stat-size checks are not. |
| Legacy quiet window | Keep100ms event quiet window; cap a continuous burst at1000ms to prevent starvation. One timer per watcher targets min(last event+100ms,first pending event+1000ms). Preserve ordered add/change/unlink transitions; only consecutive identical path+kind records may coalesce. Do not infer add/change from current existence. Quiet means no observed event for100ms, **not certified write completion**. Relevant settings truncate→write30ms control must still emit once and load final content. |
| Legacy buffer | Pending pre-ready/raw/quiet/iterator records combined <=4096 records AND <=1MiB UTF8 path+kind bytes. Count records awaiting async baseline decisions too, not just final queue. At most64 pending next() calls. Overflow ends with FS_WATCH_GAP (or FS_WATCH_CAPACITY for excessive waits), drops undelivered tail, rejects all pending readers, and makes every iterator's next reject its terminal cause once then return done. No false clean EOF for a gap. |
| Legacy close | Explicit close synchronously fences new events/reads, clears queued tail and timers, wakes **all** pending readers done, then awaits backend close and startup jobs. Concurrent close calls return the identical in-flight Promise; successful close is cached. Failure rejects and retains unfinished cleanup; a later close retries only those resources, never reopens. No early success from the old closed boolean. |
| Service readiness | Lease ready resolves on that entry's first healthy source-ready barrier, after initial reset is scheduled, returning its cursor. It rejects on first startup failure or lease/service close before ready; recovery never rewrites a settled Promise. A pre-ready failed lease can remain subscribed for later recovered reset, or be closed. |
| Epoch/revision | Entry starts epoch1/revision0; every published changed/reset/unavailable increments revision. Each actual backend replacement increments epoch and resets revision0. Counter overflow is FS_WATCH_CAPACITY, never wrap. A late old-generation callback/ready/close cannot publish into its replacement. Epoch is local to this entry/service, not globally comparable or persistent. |
| Subscribe | Throws FS_WATCH_CLOSED after lease fence. Register first; schedule one targeted state event in a microtask: reset(reason subscribe) if healthy, unavailable if failed, or await initial ready/failure. That subscriber receives initialization before later changed notifications. Initial lease-ready reset reason initial is distinct from subsequent subscription snapshot. No replay promise and no lost subscribe/ready race. |
| Service batch | One drain per source. Service fanout uses at most256 change records AND64KiB UTF8 bytes per pending batch. At overflow replace the undelivered batch with exactly one reset(reason overflow); further deltas before that reset is sent are covered by reset. Subsequent deltas are a fresh batch. Never restart a healthy backend for fanout overflow. No per-subscriber history backlog. |
| Fanout | Synchronous callbacks over snapshotted listeners, invoked from scheduled drain; no awaits on returned values. Catch each exception, report once to onObserverError, continue other listeners. If reporter throws, swallow that observer-only failure. Reentrant release/unsubscribe prevents later callback to retired lease; acquire/subscribe during fanout starts with its own state event. Async listener work belongs to consumer dirty/rebuild logic. |
| Backend error/gap | Entry immediately fences old-source publication, publishes unavailable once for that failed generation, clears pending changed batch and joins old backend. Unexpected clean source end is FS_WATCH_BACKEND. Retry transient backend/gap/close failures only, at500ms,1s,2s,4s,8s,16s,30s capped. FS_WATCH_POLLING and invalid/capacity configuration are terminal unavailable until the host closes/reacquires under corrected configuration; they do not retry. One unref timer/entry, reset delay after healthy ready. Retain original error code; do not deliver deltas while unreliable. Gap recovery reopens then publishes reset(reason recovered), requiring consumer resnapshot. |
| Failed cleanup | A failed old-source close retains that source and blocks replacement. Error-only retry attempts cleanup first; no overlapping old/new native owner. Native cleanup failure remains visible FS_WATCH_CLOSE. No retry survives zero leases/service close. |
| Lease close | Immediately detach listener set and decrement refcount once. Nonlast lease close resolves after its own queued dispatch is fenced; it does not close shared native owner. Last lease awaits backend+drain+startup cleanup. Concurrent calls share Promise; late callbacks cannot resurrect closed lease. |
| Acquire during last close | Keep closing entry/tombstone in key map. New lease may be allocated but its backend start waits successful prior cleanup. Failed cleanup is unavailable; never overlap native handles to make acquire appear successful. |
| Service close | Synchronously reject acquire/subscribe, retire all leases and cancel retry timers; join all entry cleanup using allSettled. Return shared in-flight Promise; report AggregateError if any cleanup failed. Later close retries retained failed cleanup only. Success means map empty, no timer/native handle/pending dispatch. |

### Task 1: Maintained backend, shared leases and real source qualification

- [ ] **1. Record existing owner baseline.** Read current index, installed chokidar5 option handling and settings watch tests; record exact package lock/version/source and native backend. Run unchanged fs-watch/settings tests and types before edits; retain failures with source. Do not run whole-repo verification for this slice.
- [ ] **2. Add causal legacy RED before public lease scaffolding.** In stream-lifecycle.test.ts hold actual mocked chokidar close; issue two next() calls and two closes. Assert both readers settle and closeB stays pending with closeA; current finish-one-waiter/early-return fails. Force backend error before ready and after two readers, assert both reject. Burst beyond caps must fail visibly, not hang/grow indefinitely. Existing API imports must work; missing new symbols are not the causal RED.
- [ ] **3. Repair maintained stream.** Implement readiness/error/queue/quiet/close rules above in stream.ts, preserving existing exports via index. Backend event→classification→queue order must be explicit; no detached unbounded baseline.then callbacks. Keep legacy add/change/unlink behavior; add meaningful gap oracles. Verify existing watch tests plus new lifecycle suite before lease service.
- [ ] **4. Add lease contract RED/GREEN.** In leases.test.ts use a held source fixture through the same backend construction seam. Test identical selections share one owner; different selections/services do not; full change kinds reach two leases; mutable options/events cannot cross-contaminate; exact capacity/overflow; subscribe/readiness races; observer error/reentrant close; stale generation; close failure blocks reopen; recovered reset; concurrent last-close+new-acquire. Implement only the service in leases.ts, no watcher factory duplication.
- [ ] **5. Exercise true Windows backend.** lease-windows.test.ts uses mkdtemp and actual chokidar/fs APIs, no mocked event delivery for success paths. Register listeners before awaiting ready; use event promises with one-shot watchdogs. Perform writes after readiness and during startup; missing explicit file/ignored-parent creation, delete/recreate, atomic replace, truncate→write, rapid many-file burst, two leases/same root and separate-service control. Verify eventual consumer snapshot after reset, not one native event per OS write.
- [ ] **6. Real recovery control.** Create real watcher/temp directory, then induce backend failure via the actual FSWatcher error callback seam while retaining real filesystem/backend behavior. Mutate files during held close/outage; permit replacement; recovered reset leads to real read of changed/deleted/recreated files. Label this hybrid fault injection, not spontaneous Windows OS error proof. Injected PushWatcher cases supplement real controls. A watcher directory removal is a real unlink, not invented backend error.
- [ ] **7. Idle/no-polling controls.** After real ready and quiet flush, inspect active timers/observed backend options and instrument the existing dependency boundary to count scheduled recurrent stat probes. Fake-time10min on deterministic backend must produce zero healthy retry/reopen/baseline/stat/status work; separate100ms quiet/1000ms burst/error-backoff controls. Real Windows quiet interval reports observed activity only; do not call source inspection or fake clocks ETW/CPU evidence. No CHOKIDAR_USEPOLLING environment change in main test process; exercise forced option in an isolated child with inherited environment restored by process exit.
- [ ] **8. Verify current real production path.** Run unchanged settings watch/watch-events/layering tests, preserving one truncate→write callback, actual layered-store update, missing ignored directory, disabled watch and child-process exit with persistent:false. Only supplement required mock ready field; do not weaken expected changed paths or mock away fs-watch. If new quiet semantics expose a genuine settings defect, report exact cause to root for a bounded consumer correction instead of broadening W1 unilaterally.
- [ ] **9. Review and handoff.** Run focused gates below once final files are stable, record current public exports and exact new staged reachability rows. Root/fresh reviewer checks loss/error/close authority and real Windows evidence. After self-review commit only implementation-owned paths for fresh root review; no publication. Hand I2/W2 the frozen public types plus staged-consumer obligation.

## Concrete minimum fixtures/assertions

```ts
// Legacy causal RED: mocked underlying close is held; real public factory is used.
const w = createFsWatcher({ roots: [root], persistent: false })
await backendReady()
const iterator = w.events[Symbol.asyncIterator]()
const reads = [iterator.next(), iterator.next()]
const first = w.close(), second = w.close()
expect(second).toBe(first)
expect(await Promise.all(reads)).toEqual([{ done: true, value: undefined }, { done: true, value: undefined }])
expect(closeGate.completed).toBe(false)
closeGate.release(); await Promise.all([first, second])
```

```ts
// Actual lease acceptance uses real temp files; reset consumers resnapshot.
const owner = createFsWatchService()
const a = owner.acquire({ roots: [root], persistent: false })
const b = owner.acquire({ roots: [root], persistent: false })
const left: WatchNotification[] = [], right: WatchNotification[] = []
a.subscribe(event => left.push(event)); b.subscribe(event => right.push(event))
await Promise.all([a.ready, b.ready])
await writeFile(file, 'one')
await bothObserved(file, 'add') // test helper waits on captured listener events, not product status polling
await a.close(); await writeFile(file, 'two'); await rightObserved(file, 'change')
expect(left.filter(event => event.kind === 'changed').flatMap(event => event.changes).filter(change => change.path === file)).toEqual([{path:file,kind:'add'}])
await b.close(); await owner.close()
```

Fixture helper names above (`backendReady`, closeGate, bothObserved/rightObserved) are local test definitions in the named test file/helper, not proposed product APIs. Their promises resolve from callbacks and have one watchdog; no interval-based observation. Do not mutate unrelated paths/processes; verify absolute temp root before recursive cleanup on Windows.

## Commands and evidence scope

Run sequentially in implementation worktree:
```text
pnpm --filter @i-harness/fs-watch exec vitest run test/watch.test.ts test/stream-lifecycle.test.ts test/leases.test.ts test/lease-windows.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/fs-watch typecheck
pnpm --filter @i-harness/settings exec vitest run test/watch.test.ts test/watch-events.test.ts test/layering.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/settings typecheck
```
Run `pnpm verify:reachability` (current package.json maps it to `node scripts/audit/check-reachability.mjs --gate`); report exact command/results, no new baseline/exemption. New staged APIs may leave that gate non-green until I2/W2, and are not acceptance of full W1 consumption. Package copying remains existing settings→fs-watch declared dependency; no gateway build/source rewrite is authorized here.

## Root self-review decisions and limits

1. **Accept honest staging:** no settings retry-owner migration in W1; first actual sharing consumer is I2/W2. Root can instead request a separate bounded settings cutover, but should not hide it inside fs-watch foundations.
2. **Native watch cannot promise every write:** startup reset/ready plus consumer dirty/resnapshot is the new reliable invalidation contract. Legacy preserves observed kinds and fails known gaps, never receives reset disguised as change. If legacy startup ambiguity cannot be detected conservatively without making normal startup unusable, stop that substep and give root the exact failing fixture/alternative; do not silently relax the creation contract.
3. **Quiet window is not write-complete:** no stat polling to certify completeness. Consumers retain parsing/rebuild/error reliability; W1 proves the existing short truncate→write behavior, not arbitrary writers' transaction boundaries.
4. **Evidence boundaries:** real Windows success controls, hybrid failure/recovery and fully injected timing/capacity tests are reported separately. No Linux/macOS qualification or zero-CPU claim. No product W1/event/instruction/release acceptance is inferred from this planning draft.


## Root approved rulings W01–W03

W01: sharing stays explicit per service; new exports are staged until I2/W2 realconsumer, recorded reachability debt. No fake calls or covert settings retry-owner cutover. W02: observable gap failures and new ready/reset/resnapshot semantics are the correctness contract. Native events cannot certify an atomic construction-time snapshot; legacy claims are corrected without making every ordinary startup fail/retry forever. Existing characterized creation controls remain; any failing control is reported with concrete cause, not silently weakened. Missing unobservable pre-ready transitions are a legacy limitation to remove from shipping consumers at I2/W2, not proof that full-event delivery is finished. W03: source close joins pending jobs/handles; no overlapping replacement after failed cleanup; sharing and resets never create execution/source authorization. Cost of these staged decisions is explicit later consumer migration and qualification before release, not an additional watcher or model owner.

Self-review: W1 stream/lease modules share one backend; settings remains one legacy caller and is regression-qualified. Instruction IA observes through its injected port; IB/W2 later maps these read-only invalidation events into source dependencies/pending-write reliability. No parallel writer touches fs-watch. Real Windows, injected timing and hybrid failure evidence stay separate; no cross-platform or zero-CPU claim.

W04 implementation finding/ruling: actual chokidar5 onWindows without awaitWriteFinish can report recreation as change thenadd before a laterwrite. The existing watch.test.ts exactone-recreation-delta assumption may be replaced narrowly by bounded event-driven real-content convergence. Retain observed kinds and native trace; do not drop/relabel productevents, hardcodetwoOSdeltas, adddrainsleeps or weakenmissing/subsequent-write convergence. This verifies invalidation/resnapshot rather than oneOSnotification perwrite. Unchangedsettings qualification remainsrequired; actualconsumer regressionsreturntoroot.
