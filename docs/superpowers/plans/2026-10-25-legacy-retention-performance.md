# Legacy retention performance Implementation Plan

> Use superpowers:subagent-driven-development, with GPT-6.1 Sol workers and isolated worktrees. Root has promoted this packet under the approved continuous program. Implement only the dispatched task; no recursive agents.

**Goal:** make actual long-session legacy retention practical by removing repeated whole-store funding inventories and repeated expiry-authority graph walks while preserving accepted L1 permission, physical funding, unknown-I/O and cleanup semantics.

**Architecture:** keep ContextStore, its existing main SQLite index, and the existing workspace mutation owner as the only storage/quota/authority owners. Reuse checked work only inside one original protected mutation turn and, where source selection is involved, its still-current genuine host witness. Stream bounded metadata; do not add a service-lifetime permission or free-space cache.

**Tech stack:** existing TypeScript/Node filesystem, bigint native identity, SQLite, fs-lock and package-CWD Vitest. No dependency change.

**Spec:** [binding performance design](../specs/2026-10-25-legacy-retention-performance.md), together with the accepted [L1 design](../specs/2026-10-25-legacy-fork-retention.md). Accepted product source is bc83c399; acceptance documentation df378369. General R6 archive/projection work remains.

Status: root-promoted executable packet. The original draft and source-bound measurements remain preserved. LP01..08 freeze the owner scope and checkpoint ceilings; only the current dispatched task may change product code.

## 1. Known measurements and exact cost model

Preserved `task-1/078-distinct-scale.txt` measured actual selected/funded refs, not fake owner ports:

| Distinct refs | Fixture setup | Actual owner/B2 call | Total test case |
| --- | --- | --- | --- |
|101|2.748s|10.755s|13.530s|
|1001|85.100s|487.808s|573.118s|

Later representative101 funding was11.098s. The old10001 repeated-observation case was44.016s with22170 actual file retirements, peak1 pending/live0. These are earlier-source correctness/funding measurements. They predate the new startup/expiry authority preflight and are not timings of integrated MAIN. No ratio here is a CPU attribution or a promised speedup.

Use D=distinct refs, R=observation rows, P=page files, A=applied roots, F=all physical directory entries at the time of inventory, E=expired live refs, B=body bytes verified. Keep D and R separate: the10001 control has one distinct ref and repeated actual source coordinates.

| Current owner path | Repeated work visible in source | Meaning |
| --- | --- | --- |
|`legacy/fork-disposition.ts::fundSlots`|Up to two full `requireSpace` scans per slot, two slots per tuple|Growth of many real expiry files causes O(D) complete store inventories as F itself grows with D.|
|`legacy/owner-ledger.ts::fund`|Another complete `requireSpace` inventory for canonical padding, independent rewrite and journal growth|A second O(D) sequence over a growing tree; actual hardlink proof/fsync/readback is separate required work.|
|`legacy/fork-transfer.ts` funding callback|Exact applied pending bytes admitted again after all refs; source qualification/body checks repeat through phases|The large funding loop already occupies one protected L0 turn, so per-file tree rescans are redundant for supported competing writers.|
|`store.ts::admitLegacyIndex`|`requireSpace` inventories once and `diskBytes` inventories again for the same admission; staged page later calls `diskBytes` again|The same physical snapshot can supply the comparison and SQLite page ceiling while the original turn remains protected.|
|Page staging/publication|Several inventories for each page, normally distinct mutation turns|O(P×F) remains even after the D funding scans are removed; do not claim the entire pipeline becomes linear.|
|Fixture/ordinary capture and grant setup|`captureLegacy` inventories for available bytes, `ContextStore.put` inventories retained bytes after publication, ordinary `addOwners` admits its actual growth|Another growing-tree inventory component in the separately measured85.100s setup. It is outside the487.808s owner span and is not fixed automatically by transfer funding changes.|
|`store.ts::prune` → `expireLegacy` → `validateLegacyAuthority`|A complete original preflight, then a complete A/P/R graph-and-slot scan again for each expired transferred ref|New O(E×R) observation/slot work, plus page/root I/O. This is statically present but has no many-expiring-ref elapsed measurement yet.|
|`store.ts::open`|Original authority graph/slot scan, then canonical manifest/owner/body rebuild|Required cold validation, O(R+P+F+B) visits apart from underlying index work; not E repeated full scans.|
|`qualify`, `canonicalRef`, `verifyBody`, `observedAllowed`|Repeated manifest parsing, full metadata hashing and owner reads; inherited paths also repeatedly load roots/inventory/hint counts|Known repeated work, but its share of487.808s is unmeasured. Fresh canonical membership and current policy remain mandatory.|

Repeated full inventories establish an O(D×F), hence potentially quadratic in growing-D fixtures, work component independently of timing attribution. Expiry's E×R component is a separate new problem. Native fsync, durable ledger replacement, per-page immutable confirmation, metadata hash bytes, SQLite growth/journal and existing B2 payload validation compilation still cost real time after these repetitions are removed.

## Global constraints

- Preserve Product0.1.13-rc.1, Session12, SemanticSeedV1, all accepted legacy record/body/owner-array formats and actual B2 facts/receipt ownership. No public fork rollout in this packet.
- Use the actual existing `physicalBytes` implementation, including 32-slot tree-wide listing/stat bound, reliable bigint device/inode alias deduplication, conservative per-path accounting for unknown identity, symlink refusal, safe overflow and joining already-started I/O. Do not maintain an alternate durable reserve counter or redefine storage as a logical estimate.
- Preserve actual owned-path, native opened-file/path identity, link count, full metadata/body integrity, expected prior ledger and exact immutable/torn-slot checks. A shared admission cannot manufacture confirmation of any file.
- Preserve two physically present funded ledger inodes across canonical rename, exact fixed-slot capacity and journal/application funding before the first target owner addition. Quota refusal must still precede a new target grant.
- Preserve actual local/anchor visibility, source policy/equality, target scope/READY identity, source document/view/currentness and exact expiry. Never use a preflight result as read permission or as a substitute for per-row live policy callbacks.
- No unbounded array of rows/descriptors/roots, second seed cache, uncharged SQLite TEMP spill, total-ref cap, smaller source metadata cap, fresh quota requirement for already-funded terminal cleanup, or synthetic successful port.
- Ordinary point lookup remains read-only and does not resolve host policy or rebuild inside itself. Host observation acquisition remains outside ContextOutput jobs/quota turns; pure synchronous host guard callbacks may run inside the existing protected owner work.
- Instrumentation is a task/test control over actual existing I/O and phase boundaries, not unsolicited product telemetry, a new public diagnostics API, extra accounting scans, per-row logging, or a producer/model/tool run.

## 3. Selected approach and rejected shortcuts

Implement three coherent tasks: causal counters and admission deduplication; one-turn streamed expiry sweep; one-turn aggregate funding admission. Each has its own bounded correctness/performance gate. This removes the large known repeated components without changing the wider page publication/host topology.

Do not keep a service-wide `diskBytes` memo, a session-ID/digest-only permission memo, or a reusable startup validation boolean. Both native storage and policy can change between turns. Do not expand one L0 lock across the entire B2 operation merely to make a cache survive: existing page phases and target owner turns intentionally allow other work between them. Do not parallelize hundreds of slot/ledger writes; bounded independent reads may be profiled later, but original resource retirement and exact durable order must remain inspectable.

## 4. Safe reuse scope and invalidation

### Physical admission reuse

The current `WorkspaceMutationOwner.mutate(work)` obtains the actual workspace lock, gives an opaque `WorkspaceMutationTurn`, and rejects stale/foreign/reentrant turns through `assertTurn`. A private funding callback can therefore perform these actions under one existing turn:

1. Finish only already-committed original storage recovery through the existing ledger recovery protocol before taking the admission inventory; this may safely restore an already-funded predecessor or reclaim verified whitespace, but cannot install an absent owner. If recovery is unknown, stop. Then stream the actual confirmed pages and current canonical files to calculate safe-integer **aggregate additional physical bytes** for the exact original funding work: remaining root/expiry slot prefixes, canonical whitespace growth, independent rewrite capacity, fixed intent journal, and exact applied pending prefix.
2. Call the existing full physical inventory once and compare actual total plus exact aggregate growth to the real quota. Include the actual index/journal occupancy at that point. No other supported managed/legacy writer can consume capacity while this original turn remains active.
3. Stream the same original candidates again, perform their real allocations, sync/readback, identity/prefix checks and source guards, then perform a final real inventory before returning successful funded status. Only real files constitute funding.

The reused item is the fixed admission proof for this finite protected operation, not a mutable free-byte balance. Do not install a separate debit/credit accounting system. The two metadata passes retain one root/page frontier, one current canonical ledger/commitment and scalar totals. Their producer is the already confirmed page graph; it is not a new capture, B1 export, payload compile or source reconstruction. Private helpers must receive the same original turn through ContextStore-owned closures; no caller-shaped admission token is accepted.

Hardlinks need precise treatment: a predecessor alias adds no payload when reliable identity proves the already-counted inode; its independent rewrite file does. A final immutable link to an exact pending inode is not a second payload copy when actual identity is reliable. Unknown identity remains conservatively counted exactly as physicalBytes does, and setup that requires reliable tracked-ledger identity still refuses. Never subtract an intended reclaimed file or assume a rename released capacity.

### Authority reuse for expiry

A completed, read-only full original-authority preflight may support subsequent expiry processing **only while the same ContextStore incarnation, original turn and explicit cleanup operation remain active**. It says the original binding/root/application/page graph was validated; it is not permission to read, grant, recreate owners or publish missing records.

The sweep may monotonically write exact live→expired terminal slots and remove already-expired canonical data. Those are expected effects of this same operation and do not invalidate immutable graph identity. It must still validate each actual slot/native file and current canonical commitment before its own terminal/deletion effect. Root revocation remains terminal/live acknowledgement metadata for GC, never a substitute for current read permission. Time crossing expiry requires an actual current `Date.now()` comparison; no captured time extends retention.

Destroy all reusable state on callback return, turn release/loss, store replacement/close, currentness failure, unknown I/O/readback, unexpected file/identity/content change, or an operation that changes the expected immutable namespace. Do not carry it from startup into later prune, across clear/configure/document-deletion transitions, across retries/new scopes, or between separate target owner additions. A new turn starts from real current originals and a new inventory/preflight.

### Partial allocation, unknown effects and retry

An exception after create/pad/write/link/rename might leave more real bytes than the caller observed. Stop issuing new funding/grant work; invalidate the operation's admission immediately, preserve the exact original files/intent/slot prefix and join original acquired resources. Do not refund a planned byte count, roll back a whole owner array, delete an unknown original, mark a slot funded from intended size, or hide cleanup behind the swallowed serial tail.

A later authorized original attempt performs a new actual inventory and inspects every retained prefix/inode/intent according to existing continuation rules. It funds only the remaining verified delta; prior retained bytes are already charged. If an unknown operation is confirmed within the same turn, any continued admission requires a fresh actual inventory and recalculated remaining work, not revival of the invalidated proof. Fresh source authority is still required for grant continuation. Passive reconciliation may acknowledge an already-landed application but cannot allocate its missing funding or application.

## Task 1: Actual-I/O controls and duplicate snapshot removal

**Files:** modify `packages/context-output/src/store.ts` only to remove duplicate admission inventory; add `packages/context-output/test/legacy-fork-performance.test.ts` and a focused test helper `test/helpers/legacy-performance-probe.ts`. Reuse existing fixture and native syscall interception patterns. No public telemetry.

**Interfaces:** retain `physicalBytes(root):Promise<number>` and `WorkspaceMutationOwner` public signatures. In `admitLegacyIndex`, obtain one actual `total`, enforce the same overflow/quota predicate as requireSpace for `index + 32768 + growth`, and derive the existing SQLite page ceiling from that identical total. Do not call requireSpace and diskBytes independently for the same snapshot. A tiny private pure predicate shared by requireSpace and this caller is acceptable if it avoids duplicate arithmetic and does not become a second inventory implementation.

- [ ] Add actual-I/O counters for full inventory starts, readdir/lstat entries, opened/read/sync/closed page/slot/ledger files, body/hash bytes, SQLite page admissions, and active/peak original resources. Separate fixture setup from transfer owner, graph publication, funding, owner application, final proof, startup and expiry sweep. Capture counters by scoped wrappers returning original promises; no synthetic event or extra filesystem query for instrumentation.
- [ ] Use actual11/31/101 distinct-ref fixtures and a repeated-row fixture with one ref and101 rows. Record existing counts as a causal baseline; elapsed samples are separate and are not hard correctness assertions. Preserve raw command/cwd/source/env/exit/counters.
- [ ] Add a causal assertion that one `admitLegacyIndex` operation uses one full physical snapshot for its predicate and ceiling. Verify the current code violates it, then remove only that duplicate scan.
- [ ] Retain quota-shortage/raised-budget, corrupt-index, journal-headroom and actual hardlink/dedup controls. If arithmetic would overflow or page headroom cannot fit, refuse before growth as today.
- [ ] Run focused ContextOutput quota/index/performance controls, source/test types, and the affected package fast gate once. Report product spans and assertion/instrumentation time separately. Commit this self-contained task only after its raw evidence is fixed-source and reviewed.

## Task 2: One preflight plus a streamed expiry sweep

**Files:** `packages/context-output/src/store.ts`, small cohesive `src/legacy/fork-expiry.ts` only if needed to keep the original-file walk separate, `test/legacy-fork-performance.test.ts`, and bounded additions to `test/legacy-fork.test.ts`. Keep actual removal/manifest/maps/SQLite mutations in ContextStore.

**Private operation shape:** replace per-ref full `validateLegacyAuthority(turn,wanted)` with one ContextStore-owned callback scope around full preflight and expiry processing. It consumes the original `turn`, optional pure `checkCurrent` for abortable preflight, and current actual artifacts; it does not expose a reusable permission token. A root-local iterator emits exact committed rows after the global preflight, with existing hash/EOF/slot checks. No map of every row or new persisted membership index is required.

- [ ] Add real E=1/11/31 expired distinct-ref controls with R varied independently, plus repeated observations of one ref. Advance the fixture clock after actual READY and observe actual capture-triggered prune. Before changing code assert that whole original graph walks grow with E under current code.
- [ ] First perform the existing full read-only namespace/binding/root/applied/page/disposition preflight before any canonical deletion. Preserve rejection of corrupt committed authority before pruning. Then traverse committed original rows once more, root by root, under the same turn. For each row, find the current canonical artifact in the existing store map; if already removed, skip the duplicate; if not expired or its full commitment differs, it supplies no deletion authority for that artifact.
- [ ] For each matching actually expired current artifact, perform exact slot/native identity checks, deterministic terminal expiry, original tracked-ledger removal and canonical/index removal. Deleting the artifact removes it from the existing map, so repeated rows/roots do not require a new unbounded dedup cache. At most two complete graph walks per sweep are allowed: preflight and effect traversal, independent of E.
- [ ] After committed-row processing, handle remaining ordinary expired artifacts under existing rules. An artifact with a funded expiry slot but no exact committed-application proof must remain preserved and report unavailable/unknown; no slot-existence shortcut. The operation is not newly atomic across all refs: already confirmed earlier per-ref effects remain original effects if a later tuple refuses, just as existing clear/prune can partially progress. Record that outcome honestly.
- [ ] Use this one sweep in prune and in clear's expired-data path, after clear's required target revocations. Preserve source-clear/target-clear/global-clear semantics, no recursive owner.mutate, funded cleanup at full physical quota, fractional expiry and post-GC historical acknowledgement. Startup still runs its own full validation before tombstone reclamation; it does not reuse a prior operation's authority proof.
- [ ] Retain the plan/page/disposition hot/cold corruption controls and add corruption/foreign-slot/unknown-ledger cuts during the effect traversal. Assert no unproven ref deletion, no new root/application/owner grant, unchanged source hooks, and original handle debt joined. Add a full-budget expiry/clear case proving the sweep allocates no new membership scratch or quota reserve.
- [ ] Oracle: `wholeAuthorityPreflights = 1`, total complete graph walks≤2, row visits≤2R plus bounded root/EOF overhead, and per-ref terminal writes≤1 for this sweep. Slot read/native validation remains real and may occur again locally for the accepted terminal effect; do not eliminate it to satisfy counters. Growing E at fixed R must not multiply full graph visits.

## Task 3: Aggregate exact funding admission in the existing turn

**Files:** `src/legacy/fork-transfer.ts`, `src/legacy/fork-disposition.ts`, `src/legacy/owner-ledger.ts`, narrow private ContextStore funding methods, and `test/legacy-fork-performance.test.ts` plus original ledger/disposition cut controls.

**Interfaces:** keep host-only/public APIs unchanged. Introduce private preflight helpers next to each original allocation helper that inspect its exact existing phase and return a safe-integer growth count. ContextStore owns a `fundLegacyBatch` callback lifetime with the actual turn. A helper may use its ordinary full requireSpace path when called outside this batch. Inside this batch it may omit redundant tree scans only after the real aggregate admission; it still performs real prefix/native identity/currentness/size/readback checks and actual writes. There is no exposed caller-supplied confirmed port, persisted reservation or free-byte counter.

- [ ] Add a causal funding-phase inventory-count oracle at D=11/31 using actual selected refs. Current per-slot/per-ledger scans must violate the constant-count target. Separately count per-page staging/publication scans so they cannot disappear into an unlabeled phase.
- [ ] Within the existing funding mutate callback, finish its existing derived-index confirmation first, then stream confirmed pages/current original funding state to calculate remaining exact growth. Include already-partial slot files, padded canonical capacities, rewrite/journal state, hardlink predecessor phases and actual application pending prefix. Validate full commitment consistency and distinct-ref ordering using the original page proof plus existing derived staging; derived counts alone do not authorize a candidate.
- [ ] Admit the aggregate against one fresh hardlink-aware physicalBytes result. Stream the same original pages again, allocate all actual reserves, sync/read back, join retirements, and inventory again before claiming funded success. Normal successful funding target:≤2 full inventories for the allocation batch, plus separately labeled unchanged index admission. Failure reconciliation may require additional fresh scans; report those as failure-path scans, never force them under the success count.
- [ ] Preserve fresh source/target/document guards before/after every existing await and actual per-row visibility/source-policy checks. Only pure unchanged commitment derivation may be reused inside this original witness/turn; no old canonical metadata/owner result crosses to later target publication turns. Keep current canonical ledger merges and real revoke/expiry checks before each owner addition exactly where they guard publication.
- [ ] Retain and extend causal cuts: quota one byte below aggregate; exact full occupancy; first/middle/last partial slot allocation; canonical pad/rewrite/journal failure; original application pending response loss; before/after ledger rename; predecessor capacity held against an actual other managed writer; symlink/junction/hardlink outside byte preservation; source/target invalidation during preflight/allocation; consumed-close debt. Assert no target addition until all real reserves/application pending are confirmed.
- [ ] After partial/unknown failure, add an unrelated actual managed allocation attempt between turns. It must see all retained physical bytes and refuse or use only actual remaining free space. Retry with actual original source authority must recompute from retained files, not from a previous admission proof. Cold passive must not finish missing reserve/application work.
- [ ] Run bounded11/31/101 controls and original quota/ledger/disposition/close/transfer tests. Only after deterministic counters and unknown cuts pass should root reserve the expensive controlled1001 measurement described below.

## 8. Admission, cancellation and close semantics

Actual API constraints matter. `WorkspaceMutationOwner` has no cancellable lock-acquisition argument and does not interrupt an active callback. Its queue tail preserves ordering while swallowing rejection; the original returned operation promise and LeaseRetirement debt remain the outcomes to join. `service.transition` closes admission, aborts owned job controllers, then joins jobs and mutations. `closeLegacyForkTransfer` invalidates the scope and joins its original attempts/file debt. Do not claim a timeout can cancel an already issued rename, fsync, terminal write, committed owner or native cleanup.

- Pure preflight/metadata traversal can check the owned AbortSignal at existing read/page boundaries. Pass capture's owned signal through an optional private prune/preflight guard if adding cancellation there; `open` already receives a signal. Check after awaited acquisition before new work, but register the acquired resource inside guaranteed cleanup first. No polling timer or public cancellation API is needed.
- On cancellation before persistent issue, stop scanning/allocating, join all started reads/handles and report policy/unavailable according to the existing caller. On cancellation after issue, retain the exact original unknown/confirmed phase and its cleanup debt. Do not fabricate rollback or declare a partly landed owner absent.
- For expiry/clear, finish or honestly retire the current original per-ref durable transition; a cooperative abort may prevent starting the next ref. Clear/delete have no caller AbortSignal today and their explicit cleanup obligation is not made cancellable by this packet. Service close waits for their original work; it cannot pretend an aborted job cancels a committed cleanup.
- Current source/target policy remains real even inside a reused admission. It is not cached by event count, ref count, sourceId hash, metadata digest, root digest, clock or plan equality. A root proof only avoids repeating immutable graph work within the protected turn; current permission can still fail.
- Keep original independent retirements attempted/joined on failure, no replacing unresolved handles/scopes and no consumed-fd successful no-op. Measure time to stop **new** work separately from time to finish original syscall/cleanup. Filesystem stall time cannot have a guaranteed wall-clock bound through these APIs.

## 9. Performance and correctness gates

Deterministic work counters are primary causal oracles; controlled elapsed measurements are separate usability evidence. All runtime work below requires a root-selected frozen HEAD, source manifest, one runtime owner and isolated fixture/config/evidence roots. No user profile/session data. This draft executes none of it.

| Control | Required structural outcome | Elapsed reporting |
| --- | --- | --- |
|Funding11/31/101 real refs|Allocation-batch full inventories≤2; real native file checks/allocations/readback grow with distinct work; pages separately labeled|Setup, owner/B2 inclusive, exclusive funding/inventory/native sync and assertion overhead separately.|
|Expiry E=1/11/31, fixed R; then fixed E/vary R|≤2 complete graph walks per sweep; no E multiplier; original terminal/deletion effects≤E|Hot sweep, cold startup+separate sweep, queue wait and cleanup separate.|
|One ref/101 repeated rows|No complete-row cache; row visits stream; duplicate effects remain once|Report metadata/slot visits; do not relabel this as101 distinct refs.|
|Full quota + unknown cuts|No new grant without real capacity; retained files correctly inventoried; other writer cannot consume held predecessor reserve|Fault schedule is correctness evidence, not speed evidence.|
|Stop/close during scan/funding/per-ref cleanup|No new work after next cooperative boundary, all issued work and resources joined, no stale scope reuse|Boundary count plus separate original-syscall/cleanup duration; no fake fixed close timeout.|

After bounded gates, make **one root-reserved1001 distinct-ref run** using the original generator and controlled payload/body sizes, retention, summary, quotas, workspace topology and actual B2 route. Preserve the old measurement without rerunning it merely for ceremony. Run the candidate uninstrumented for elapsed/RSS/heap, then root may authorize a matching counted/profile run if attribution remains unresolved; account for instrumentation overhead.101 may use three independent process samples to expose dispersion. Process-cold is not disk-cold unless OS cache was controlled.

Root-approved controlled checkpoint ceilings (LP08), frozen before any expensive candidate run:101 owner≤5s;1001 owner≤60s;1001-ref hot expiry sweep≤30s on the recorded Windows/Node host and fixed fixture. These are controlled checkpoint values, not achieved results or whole-version acceptance. Do not move them after a miss to declare success. A structural improvement without meeting the approved elapsed budget stays R6-open. Explain remaining time using real phase/CPU/I/O data, not a larger ref cap or weaker checks.

Do not expect the funding-only counter fix to prove whole-pipeline O(D): per-page admission/publication still contributes O(P×F), and inherited observed qualification can repeat page/hint/count work. Ordinary capture/grant fixture setup also retains growing-tree inventory work and must be reported separately; a faster fork does not qualify ordinary long-session tool capture. Label those residuals. If the candidate still misses the approved budget, use the counters to select a separate narrow follow-up (bounded page/index admission batching under an actual turn, turn-local root proof reuse, or ordinary capture/grant admission work) with its own authority/currentness design and review. No automatic expansion into service-wide caches or B1/B2 validation bypass.

## 10. Fixed-source validation and execution handoff

For each task, preserve the failing actual-work oracle before the optimization, focused GREEN, original failure cuts, source hashes, actual command/cwd/env/exit and resource counters. Use package-CWD sequential Vitest with `--maxWorkers=2 --minWorkers=1`. Existing final fast gate form remains `pnpm exec vitest run --exclude test/legacy-fork-scale.test.ts -t '^(?!.*10001)' --maxWorkers=2 --minWorkers=1`; add the new bounded test file to that ordinary gate. Run `pnpm typecheck` in context-output. Run original executor native quota/close consumers only when the changed shared I/O/admission owner or an unresolved regression warrants it; record isolated IH_CONFIG_DIR and existing actual native observer semantics.

Do not rerun10001/1001 scales for each routine code edit. At root-selected final candidate HEAD, qualify only the reserved scale workload and changed causal domains, then independently review the complete performance delta and its invariants. The unchanged session-persistence public semantic-fork baseline remains F1-C debt and cannot be waived into passing by this packet. General R6 archive/projection/>100MiB obligations and real public long-session continuation remain separate release gates.

Root LP01..08 authorize the three-task scope and private same-turn admission/cancellation boundary. Each task receives a separate writer reservation and independent review. No automatic expansion into core-agent/native/public-caller work.
