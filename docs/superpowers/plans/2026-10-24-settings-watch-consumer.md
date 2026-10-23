# W2 Settings Watch Consumer Implementation Plan

> Root-approved packet under the integrated v0.1.13 plan. One fresh GPT6Astra implementer owns Tasks1–3 in an isolated worktree, followed by independent review. User authorization covers continuous work; no recursive agents or execution-mode question. Other W2 resources remain separate.

**Goal:** Move settings observation onto one W1 lease owner and preserve source attribution, recovery, and joined cleanup.
**Architecture:** The settings adapter borrows an injected `FsWatchService` or owns one default service, acquires one exact-file lease, and reconciles content on resets. Layered storage owns serialized document reads/publication and attributes notifications using the source bytes actually read.
**Tech Stack:** TypeScript, Node >=22.18, pnpm >=10, existing `@i-harness/fs-watch` / chokidar 5, Vitest.
**Spec:** [integrated delivery Task6/W2](2026-10-23-v0.1.13-integrated-delivery.md) and [shared watcher recovery](2026-10-24-watch-root-replacement.md); the scoped causal evidence and all requirements are recorded below.

## Evidence and scope
- Source inspected: `f89d49a5e09b34205359f5686110e6b03154eef8`; probe before/after HEAD, dirty-status and four SHA256 records match exactly.
- Probe artifacts alongside this packet: `settings-watch-probe.test.ts`, `settings-watch-probe.config.ts`, `settings-watch-probe-command.txt`, `settings-watch-probe-{before,after}.txt`, `settings-watch-probe-raw.log`.
- One actual probe passed: native ready 1792785220597; mkdir 0911; actual stream `FS_WATCH_GAP` 0914; actual close complete 0915; actual `setTimeout(...,60000)` 0915, stack `watch-settings.ts:52,118`; write done 0919; no callback by 1792785221924. Test 1.347s; runner 1.66s; cleanup fulfilled; exit 0.
- Wrapper delegates to actual `createFsWatcher`; it records and rethrows actual iterator failure and forwards actual timers unchanged. No injected GAP, fake clock, live profile, 60s wait, suite rerun, or patched product. MAIN runtime explicitly released after this probe.
- Native handler hash `7b132a2ab051eef27c52983c9c7686cf9b4c66f4ade07de8c82c3f07c06803c1`; no dependency install or patch edit by this task.
- This packet covers settings adapter/store lifetime only. Resources, MCP behavior, Git observers, host policy polling, model/action work, whole-W2 qualification and event-release claims remain outside. IC-B consumes this surface only after promotion, implementation and review.

## Root-approved decisions
1. Keep `intervalMs?: number` and `watchIntervalMs?: number | false` source-compatible but mark numeric values deprecated and ignored. `false` still acquires nothing; every numeric value means enabled. W1 alone owns retry: 500ms exponential backoff capped at 30000ms, reset on healthy recovery; terminal failures remain terminal.
2. This intentionally changes error recovery timing for existing numeric callers (e.g. 10, 100, 60000), never healthy cadence. Repository production caller supplies no number; numeric uses are tests/library API. Do not add a retry-policy option to W1 or retain a private settings retry timer.
3. Coverage status is an observation fact, never valid-policy authority. Keep strict saved-policy validation in IC-B; `SettingsStore.load()` currently tolerates missing/corrupt inputs into defaults and must not become IC-B's fresh-policy read.
4. Correct layered attribution to all actually changed sources in a successful read, preserving existing effective-state conflate. Existing queue test's single queued-path label can conceal a second source read: strengthen it to expect both changed sources, rather than preserving that ambiguity.
5. Change layered unreadable-file handling from silent omission to rejected read with last successfully published state retained; only ENOENT/ENOTDIR mean absent. Malformed document remains a rejected read. This is an intentional narrow behavior correction; single-store tolerant loading is unchanged.

## Task 1 — Lease adapter, exact baseline, bounded reconciliation
**Files:** Modify `packages/settings/src/observation/watch-settings.ts`, `packages/settings/src/index.ts`, `packages/settings/src/storage/contracts.ts`; create `packages/settings/src/observation/source-stamp.ts`; test `packages/settings/test/watch-events.test.ts` and new `watch-lease.test.ts`.
**Interfaces to freeze:** Import `FsWatchService`, `WatchCursor`, `FsWatchFailureCode` by package name; export the adapter types from settings index.
```ts
type SettingsSourceStamp = { kind: "present"; sha256: string } | { kind: "missing" }
  | { kind: "unreadable"; code: string };
type SettingsWatchState = { kind: "starting" } | { kind: "covered"; cursor: WatchCursor }
  | { kind: "unavailable"; code: FsWatchFailureCode; cursor?: WatchCursor } | { kind: "closed" };
type SettingsWatchError = { phase: "read" | "consumer" | "close"; error: unknown; path?: string };
interface SettingsWatchOptions {
  /** @deprecated W1 owns retry timing; numeric values are ignored. */ intervalMs?: number;
  service?: FsWatchService; baseline?: ReadonlyMap<string, SettingsSourceStamp>;
  onError?: (failure: SettingsWatchError) => void;
}
interface SettingsWatchHandle {
  readonly ready: Promise<WatchCursor>;
  getState(): SettingsWatchState;
  subscribeState(cb: (state: SettingsWatchState) => void): () => void;
  dispose(): void; close(): Promise<void>;
}
// Retain original spelling in onChange; normalized absolute paths are internal selection keys.
function watchSettings(paths: string | string[], onChange: (path: string) => void | Promise<void>,
  opts?: SettingsWatchOptions): SettingsWatchHandle;
// source-stamp.ts: stampBytes(bytes: Uint8Array): SettingsSourceStamp;
// readSourceStamp(path: string): Promise<SettingsSourceStamp>; readSourceStampSync(path: string): SettingsSourceStamp.
```
- [ ] First add deterministic injectable-service tests with a controlled lease, never mock the new production consumer into using raw streams. Assert acquire count=1, roots exactly selected files, persistent=false, subscribe occurs before awaiting ready, and no adapter setTimeout/setInterval.
- [ ] Replace the existing watch-events.test.ts raw createFsWatcher mock/helper with the controlled lease across its retained scenarios. Synchronous acquire rejection becomes unavailable plus rejected ready, with no local retry; retain an owned service for close. Empty selection constructs no service and rejects ready with FS_WATCH_CAPACITY (new ready-only behavior; dispose stays harmless).
- [ ] Implement `opts.service ?? createFsWatchService()` and one `acquire({ roots: absoluteFiles, persistent:false })`; delete manual ignored-ancestor roots, DEFAULT_IGNORE imports, retry/start logic and raw iterator ownership.
- [ ] Build baseline before acquire: supplied stamps must cover each selected absolute path; fill missing entries with one synchronous byte read. Standalone watcher captures its construction baseline this way; layered store supplies the exact bytes it loaded, avoiding a second baseline that could hide a startup change.
- [ ] Use SHA256 of exact bytes, not stat tuples or reserialized JSON. Distinguish missing from unreadable codes; do not turn permission/I/O errors into missing. Hash reads supply observation evidence, not successful parsing or validated policy.
- [ ] Subscribe immediately. Every reset (`initial`, `recovered`, `overflow`, `subscribe`) enqueues all selected keys for a fresh content snapshot; compare each key with its baseline and notify only differences. Native changed batches enqueue only matching selected keys and require a notification even if digest repeats, allowing a failed reload to retry on a new observable event.
- [ ] A single tracked reconciliation loop swaps its pending key set before awaiting I/O; events arriving during reads enter the next set, including the same path. Preserve a per-key force flag for changed events. Read only selected paths; never an event-derived filesystem scope. No periodic stat/read/retry.
- [ ] Snapshot each file independently; report unreadable transition via onError and invalidation, continue other paths, retain last observed stamp including unreadable. Recovery to readable/missing is another invalidation. Missing→missing initial reset is quiet.
- [ ] `ready` mirrors the lease's first readiness attempt (attach rejection handler immediately); it is not reset after a first failure. Keep subscription alive after rejection: recovered reset updates coverage and reconciles normally. Coverage can be covered while a consumer read is invalid/unreadable.
- [ ] `getState()` returns a defensive snapshot; subscribeState synchronously replays current state, then transitions. Check disposal/unsubscribe before each listener; isolate each sync throw and rejected returned callback promise. Return callback type void but defensively observe thenables at runtime.
- [ ] onError receives read/consumer/close failures; retain original error for diagnostics. If no hook, emit only a constant safe phase-specific diagnostic once per failed operation; never stringify arbitrary error objects/messages, settings bytes, secret-bearing callback errors or accessor properties. Hook throws get the same safe diagnostic once, never recursively passed back. Add a sentinel-secret non-serialization control. No detached rejected promises, watcher restart for consumer exceptions, or dropped second path. Observe rejected onError promises without recursive reporting or secret-bearing fallback text.
- [ ] Track all returned onChange/status promises without blocking subsequent path dispatch. `dispose()` fences first, unsubscribes and initiates close with rejection reporting. `close()` shares one in-flight attempt, joins reconciliation, callback promises, lease.close and owned-service.close using allSettled; aggregate cleanup failures and retain handles for retry. Never close a borrowed service.
- [ ] Closed state is readable via getState; no callbacks, including status/error hooks, after synchronous dispose. Cleanup errors after dispose still reject close and may use diagnostic warning; do not turn disposed callbacks back on. Successful close is memoized; failed attempts clear only the promise, not ownership references.
- [ ] Test initial ready rejection→later recovered reset, overflow content reconciliation, two paths with first consumer throwing/rejecting, borrowed owner remaining alive, held reads/callback promises joined, failed close retained/retried, and no callbacks after dispose. A callback may request close synchronously or after an await: do not join that calling callback into its own close promise; document this self-close exception while joining other accepted callbacks and native resources. Prove no self-wait deadlock or newly admitted work.

## Task 2 — Layered store baseline and attribution ownership
**Files:** Modify `packages/settings/src/storage/layered-store.ts`, `storage/contracts.ts`, `storage/transaction.ts`; test `packages/settings/test/watch-events.test.ts` and new `watch-baseline.test.ts`.
**Interfaces:** `LayeredStoreOptions.watchService?: FsWatchService`, `onWatchError?: (failure: SettingsWatchError) => void`; store `close(): Promise<void>`; existing load/reloadFromDisk/onChange signatures remain. Add `SettingsWriteQueue.drain(): Promise<void>` returning the current caught tail, without enqueuing another read.
```ts
// New private state lives beside existing rawsByPath/current/queue, not inside normalized Settings:
private sourceStamps = new Map<string, SettingsSourceStamp>(); // committed successful-read bytes
private watcher: SettingsWatchHandle | undefined;
private reloadJob: Promise<void> | undefined;
private closeJob: Promise<void> | undefined;
// Existing reloadPending remains arrival-ordered and deduped; disposed gates all notifications.
```
- [ ] Add a startup-gap regression: hold the first load's read/publication boundary, change B after its bytes were read but before ensureWatcher; initial lease reset must reload B, not emit unchanged A. Add unchanged initial load/reset expectation zero notifications.
- [ ] Refactor read to stage `raws` and byte stamps together from a single read per source, parse and run existing instructionMigrationMeta checks, then atomically commit maps/publish within existing SettingsWriteQueue. Missing stamps enter the map; unreadable/parse errors reject before committing any map. No extra read of disk to reconstruct a baseline later.
- [ ] Pass committed sourceStamps to watchSettings at first ensureWatcher. Preserve startup reconciliation even if watch ready occurs during queued work; do not await adapter callbacks from inside the serialized read that they need to join.
- [ ] Update writeMaster and successful migrateInstructions from the exact serialized bytes passed to writeSettingsDocument; no-op migration uses staged.text. Commit source stamps alongside raws before returning. This keeps already-current self-write echoes silent without inventing filesystem CAS.
- [ ] Replace initiating-path attribution in handleWatchedChange: snapshot committed per-source stamps and effective current before the serialized reload; capture the successful read's committed source differences within that same queue operation, so a queued set cannot contaminate attribution.
- [ ] Keep a private read result (settings + changedSourcePaths + beforeEffective) for watched reload bookkeeping; preserve public reloadFromDisk(): Promise<Settings>. Use a private watched-read method through the same queue rather than mutable "last read" fields. Move held-reload tests to gate the read seam, not override a method the watcher no longer calls.
- [ ] After successful read, if effective Settings differs, emit once for every actually changed source in configured source order; no unchanged A label when only B changed, even if A triggered reload. An effective-equal hidden/comment-only source change remains silent on existing onChange; raw watchSettings invalidation remains available to future IC-B independently.
- [ ] Pending detections each receive a subsequent read after either settle path; do not discard B because A's reload read B too. Source equality suppresses redundant reports. A same-path later write remains pending; failed reads preserve committed baselines and do not wedge or clear other pending paths.
- [ ] Existing [a,queuedSecond] queue test reads both B and C: new expectation is [a,b,c] (configured order), with telemetry paths identical. Preserve its failed middle reload and both arrival orders; add stronger A-event/B-only actual change and B-read-before-later-write cases.
- [ ] Isolate each listener and telemetry emit failure, report through onWatchError, continue remaining listeners/paths, and settle/recheck in finally. Check disposed before each callback and after every awaited reload; no held reload may emit after dispose.
- [ ] dispose fences immediately and starts close without clearing watcher reference. close joins watcher cleanup, active reload and queue drain; discard pending new reloads after fence. Retain failed watcher close for retry. Reject new load/reload/set/reset/migrate calls after disposal, while joining already accepted operations; document this terminal lifecycle behavior.
- [ ] Avoid deadlock: fence/cancel pending watch work before joining, do not place close itself in SettingsWriteQueue, and never wait for close inside a consumer callback it is joining. Test held read, held set, failed close, concurrent close identity, and borrowed service lifetime.

## Task 3 — Real filesystem proof, shipping caller, qualification
**Files:** Modify `packages/settings/test/watch.test.ts`, `packages/desktop-gateway/src/host.ts`; add `packages/desktop-gateway/test/settings-watch-close.test.ts`; retain package manifests/dependency identity.
- [ ] Preserve the real missing ignored parent test with intervalMs=60000 and the existing 3-second bound. Await first adapter readiness where relevant; create directory and file for real; recover through W1 reset; require exact selected path once. No timeout increase or mocked topology failure in this proof.
- [ ] Extend real tests: atomic rename replacement, deletion/recreation, ignored-parent delete/recreate, sibling file ignored. Keep persistent:false child-exit proof. Ensure tests close/join before deleting their own synthetic fixture roots.
- [ ] Add reset fixture using equal length bytes and restored mtime; additionally stub equal metadata across different bytes to prove no stat-based comparison. Hash must detect changed content on reset. Do not claim hashes/mtime restoration provide filesystem CAS or a globally atomic multi-file snapshot.
- [ ] Add idle I/O spy test after ready+initial reconciliation: no read/stat, no interval, no adapter retry owner during a bounded idle observation; W1 remains sole native owner. Exercise malformed/unreadable read→new event→successful reload and healthy coverage with invalid bytes separately.
- [ ] At host.ts trustWatcher callback, return the existing refresh promise with its current catch semantics. Fence/dispose the watcher at the existing early shutdown position, but join `trustWatcher.close()` after session-service/plugin cleanup. Actual `mcp.refresh -> plugins.refresh -> service.refreshExtensions` may await creating assemblies, so do not block their shutdown behind an early callback join. Keep shutdownRequested and existing retryable once/cleaned semantics; do not rewrite MCP refresh behavior or add work. Test the real host order with a held refresh that can settle only after dependent service cleanup begins.
- [ ] Host close regression: held watcher close delays host cleanup completion; first close rejection remains retryable via existing cleaned/once logic; no model/provider starts. Keep fixture scope synthetic.
- [ ] No production LayeredSettingsStore owner was found outside settings package; its owner API is the exported store. Desktop gateway uses single SettingsStore at host.ts:136, which has no onChange. Do not invent a layered host owner or add watching to single store in this packet.
- [ ] Maintain package-name imports: settings already declares fs-watch workspace dependency, fs-watch declares chokidar; desktop-gateway declares settings. build-gateway.mjs copies declared dependency trees. No manifest addition, relative sibling import, dependency install, native-patch change or historical release edit is needed.
- [ ] Run each new deterministic test red before implementation, then focused green. After all tasks: `pnpm --filter @i-harness/settings test`, `pnpm --filter @i-harness/settings typecheck`; run affected gateway close test and gateway typecheck. Reuse unchanged W1 69-test/type qualification; rerun that owner only for a changed boundary or a named concrete concern. Root schedules runtime exclusivity and later packaged qualification.
- [ ] Root self-review completed before dispatch: verify all seven brief requirements, <=180-line packet, no numeric retry owner, exact source baselines, truthful availability, retained close failures, changed-path evidence and test semantic changes. Implementation review must precede IC-B adoption; passing this slice is not full W2 or event-release approval.

## Limits and acceptance
- Actual probe proves the present GAP→60000 scheduling cause only; it did not wait for recovery or qualify the replacement design. No product tests beyond that one probe ran in this planning task.
- Readiness plus event-driven resnapshot closes observable startup/gap windows; read hashes are byte identities, not filesystem CAS, writer completion proof, or multi-file transactional snapshots. Mutations wholly hidden between reads may be unobservable by design.
- IC-B must strictly read/validate selected saved policy (distinguish missing valid profile from unreadable/corrupt data), use coverage/invalidation as triggers, and fence its own authority across unavailable/reset/reload. Neither normalized fallback nor watcher covered status grants policy authority.
