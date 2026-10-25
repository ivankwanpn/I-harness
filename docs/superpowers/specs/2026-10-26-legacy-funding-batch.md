# Exact same-turn legacy funding specification

Status: **Root-promoted on2026-10-26 after accepted baseline and connected native-contract review.** This is one connected original LP04/LP05/LP07 performance Task3, executed as Task1 of the sibling focused plan. The assigned writer/base/runtime reservation supplies execution scope. Product remains0.1.13-rc.1; use dispatch-current core/session types without changing formats. D1 core/persistence/service/assembly surfaces belong to another owner.

## 1. Source and evidence

Source inspected on MAIN `9726a09bec14f48db8a6f921e6b193707f266c5a`, whose last change is documentation. The accepted product/index baseline is the connected range through `9ef15a8e`, as described by `docs/research/2026-10-26-derived-index-owner-acceptance.md`. Current `fork-transfer.ts:163–191`, `fork-disposition.ts:35–55`, `owner-ledger.ts:160–199`, `store.ts:269–284`, `service.ts:72–74,131–140,195–204`, `workspace-mutation.ts` and `artifact/quota.ts` supply the actual consumer and ownership boundaries. The sibling preflight packet contains the detailed current source call map. This draft supersedes only its proposed interface sketch, not accepted product behavior or prior evidence.

Read `.superpowers/sdd/2026-10-26-retention-funding-baseline/task-1-report.md`. Test-only HOST commit `8f3a3a7b9a72e5ecaaca8e5d5bde20a1dd1d4501` records corrected allocation inventories **61/161/11**, total owner inventories **75/175/35**, for D11/R11, D31/R31 and D1/R101. Allocation is exactly four scans per slot pair, one per distinct ledger and two for original application pending: `4(D+1)+D+2`. Current initial/final confirmation each have their own admission/post-check; page publication and final application publication remain separately counted.

Independent uninstrumented D11/D31 owner observations are1187.832ms/2819.051ms, one sample each. They do not prove exclusive elapsed dominance, statistics, a speedup,101/1001 latency or R6 closure. The initial instrumented attempt failed observer assertions and was corrected under root reservation. The complete1271-file raw source freeze first occurred after that failed attempt and both timing samples, before corrected measurement; earlier binding is BASE Git identities/unchanged tracked source plus recorded measurement hashes, not a pre-first-runtime full raw freeze. Preserve these limits and original failed streams. Final independent baseline review is accepted in docs/research/2026-10-26-retention-funding-baseline-acceptance.md; its3testfiles are integrated in MAIN7372d66c. No measurement rerun is implied by promotion.

The existing LP specification remains binding. Accepted Task1/index ownership/native policy, Task2 expiry, original-file and per-scope status debt, conditional capture G, capture-only `describeFunding`, and SQL-owner mirror retirement remain unchanged. No protected worktree contents were read for this draft.

## 2. Behavior and invariants

Within the already-existing funding `ports.mutate(context, callback)`, finish existing `confirmLegacyIndex` first. Then reconcile only proved committed original ledger storage, describe exact remaining slot/ledger/application payload growth by streaming original pages, admit that finite aggregate from one real physical inventory, execute original guarded native allocations, and require a final real inventory before allowing the existing later owner-addition loop to start.

Only physically present, synced/read-back original files constitute funding. Admission is a short-lived arithmetic proof under the same supported-writer exclusion; it is not reserved bytes, permission, a ledger, a balance or durable state. Unknown writes/sync/close, changed identity/content/phase, lost currentness or quota failure stop further work and retain original effects and debt. No refund, absent-owner repair, producer replay, source re-export or whole-owner rollback follows.

The batch cannot change original target grant semantics: `qualify` still checks actual canonical membership and observed policy; `verifyBody` still reads/hashes original bytes; later per-ref turns requalify, check real revoke/expiry slots, re-read/merge current canonical ledger, run `replace`, read back target membership and update the map. No batch authority is passed to those turns or to applied publication/final proof.

Success allocation inventories are exactly two normal scans, independent of D: pre-admission and final verification. Current index confirmation's two scans and other nonallocation scans are additional. Failure/reconciliation scans have no two-scan ceiling. Original per-file native, prefix, size, readback, fsync and retirement work remains real and may repeat. No public API, cache, SQL schema, native resource policy, quota, owner map or WorkspaceMutationOwner API changes.

## 3. Owned paths and private interfaces

One writer owns this complete connected delta. Exact product paths:

| Path under `packages/context-output/` | Responsibility |
|---|---|
| `src/legacy/funding-batch.ts` — new | Cohesive private batch lifetime/provenance, bounded phase descriptions/rolling transcript/safe arithmetic, exact original application-pending helper. No policy callback, permission cache or filesystem inventory implementation. |
| `src/store.ts` | Instantiate one private batch owner tied to this Store; narrow `fundLegacyBatch` consumer and ledger preparation/execution seams. Keep capture/expiry/index/status code unchanged. |
| `src/legacy/fork-transfer.ts` | Replace only current funding callback body with the Store consumer, passing the existing `check`/`qualify` closures. Keep all surrounding original publication and later owner application code. |
| `src/legacy/fork-disposition.ts` | Factor common original native slot inspection/allocation; add batch-only describe/execute entrypoints. Ordinary `fundSlots` retains its own admissions. |
| `src/legacy/owner-ledger.ts` | Factor original transfer-funding phase inspection and committed-only preparation beside `fund`; add batch-only execution. Keep prospective capture `describeFunding` contract unchanged; reuse original `recover/replace` implementations. |

No planned edits to `artifact/quota.ts`, `artifact/io.ts`, `workspace-mutation.ts`, `legacy/use-gate.ts`, `legacy/index-lifecycle.ts`, `legacy/observed-read.ts`, `service.ts`, public `index.ts/types.ts/tools.ts`, core, persistence, executor or assembly. Read these to preserve contracts. Any discovered prerequisite outside the map returns to root with the causal source; do not silently expand scope.

Concrete TypeScript names to freeze at promotion (internal source imports only; no package export):

```ts
// funding-batch.ts; brand symbols and runtime registries are module-private.
export interface FundingBatchScope { readonly [batchBrand]: never }
export interface FundingAllocation { readonly [allocationBrand]: never }
export type FundingFile =
  | { readonly kind: 'absent' }
  | { readonly kind: 'file'; readonly dev: string; readonly ino: string;
      readonly links: string; readonly size: number; readonly content: string };
export interface FundingDescription {
  readonly key: string; readonly phase: string;
  readonly additionalBytes: number; readonly transcript: string;
  readonly primitives: readonly { readonly key: string; readonly peakGrowth: number }[];
}
export interface FundingPassSummary {
  readonly entries: number; readonly distinctRefs: number;
  readonly additionalBytes: number; readonly digest: string;
}
export interface FundingBatchContext {
  readonly turn: WorkspaceMutationTurn; readonly lease: LegacyUseLease;
  readonly use: IndexUse; readonly quota: number; readonly guard: () => void;
}
export class LegacyFundingBatchOwner {
  constructor(directory: string,
    assertContext: (context: FundingBatchContext) => void,
    assertRetirement: (context: FundingBatchContext) => void,
    inventory: () => Promise<number>, joinFiles: () => Promise<void>);
  run(context: FundingBatchContext,
    describe: () => Promise<FundingPassSummary>,
    allocate: (scope: FundingBatchScope) => Promise<FundingPassSummary>): Promise<void>;
  // Called only by original helpers immediately around one local allocation.
  enter(scope: FundingBatchScope, description: FundingDescription): FundingAllocation;
  assertAllocation(allocation: FundingAllocation, key: string): void;
  issued(allocation: FundingAllocation, primitiveKey: string, peakGrowth: number): void;
  finish(allocation: FundingAllocation): void;
}

// Store; derives directory/root slot/application paths from the actual root.
fundLegacyBatch(turn: WorkspaceMutationTurn, lease: LegacyUseLease,
  use: IndexUse, quota: number, root: LegacyRoot, groupCount: number,
  guard: () => void, qualify: (row: LegacyRow) => Promise<void>): Promise<void>;

// fork-disposition.ts; original fundSlots signature remains unchanged.
describeSlotFunding(directory: string, base: string, tuple: Terminal,
  guard: () => void, retire?: RetireFile): Promise<FundingDescription>;
fundSlotsInBatch(owner: LegacyFundingBatchOwner, scope: FundingBatchScope,
  directory: string, base: string, tuple: Terminal,
  guard: () => void, retire?: RetireFile): Promise<FundingDescription>;

// OwnerLedger; next is derived by Store from freshly read canonical owners.
prepareTransferFunding(path: string, next: ReadonlySet<string>,
  operation: string, current: () => void): Promise<FundingDescription>;
fundInBatch(owner: LegacyFundingBatchOwner, scope: FundingBatchScope,
  path: string, next: ReadonlySet<string>, operation: string,
  current: () => void): Promise<FundingDescription>;

// funding-batch.ts; exact bytes passed from appliedFor(root), max65536.
describeApplicationFunding(directory: string, final: string, bytes: Buffer,
  guard: () => void, retire?: RetireFile): Promise<FundingDescription>;
fundApplicationInBatch(owner: LegacyFundingBatchOwner, scope: FundingBatchScope,
  directory: string, final: string, bytes: Buffer,
  guard: () => void, retire?: RetireFile): Promise<FundingDescription>;
```

`IndexUse` is the actual current lifecycle type, not a copied facade. `Terminal` is the existing tuple union in fork-disposition; it may be exported only from that private module for helper typing, not publicly. `groupCount` is current `facts.groupCount` (a number). Description `transcript` is a canonical fixed-field encoded record as specified below, not arbitrary JSON from caller data. Each description has at most three positive-growth primitive records (slot pair two, ledger three, application one); zero-growth alias proof/sync steps use fixed zero records. Helpers create descriptions from real originals. No caller-supplied `confirmed`, `skipQuota`, `admitted`, available-byte value or replaceable requireSpace callback exists.

Runtime scope provenance is mandatory, not the brand alone: each Store retains its own `LegacyFundingBatchOwner`; module-private WeakMaps bind scope/allocation to that exact owner instance, resolved directory, actual context objects and active async run. `run` rejects nesting/reentry and records one live scope; every helper checks the expected owner plus scope membership. `enter` is only legal during effect stage and creates one current single-use allocation bound to exact key/description; no overlapping allocation. All checks call the Store-provided assertion: `this.assertTurn(turn)`, `this.assertLease(lease,'exclusive')`, `use.assertCurrent()`, same native generation/use identity, then original guard. It uses the original locks, not a second gate. Registry creation is private to Store composition; transfer/caller receives no scope or owner. Ordinary helpers cannot select the batch branch. Forged objects, foreign Store/owner, reused/finished allocation tokens, overlapping current allocations, expired scope, callback escape and stale turn/lease/use reject before native mutation. Store drives root, strictly increasing original first-ordinal expiry/ledger phases, then application using bounded scalar stage/ordinal state; duplicate/out-of-order dispatch refuses before that dispatch's mutator. Store still validates original rows against legacyHint/legacyFirst and full EOF/counts. Do not retain a Set/Map of every prior key; full two-pass identity equality remains the ordered-digest EOF gate.

Store keeps a private WeakMap from each actual IndexUse returned by this Store's indexUse(lease) to its exact creating lease. Register only after this.index.use(lease) returns the genuine object. Before preparation, admission and effect require that exact Store-issued use/lease association, then invoke its original assertCurrent for native generation/currentness. Bind the registered use, lease and turn to the active scope and repeat checks at allocation boundaries. A callable structural lookalike, foreign Store use or genuine use paired with another lease is insufficient. No native lifecycle API, SQL action, confirmation boolean or transferable authority is added.

After any thrown failure or callback return, invalidate scope and allocation synchronously in `finally` before returning/rethrowing. Issued native work still settles or records original cleanup debt. No capability lives across retry, configure/clear/store retirement/replacement, or into later merge.

## 4. Streaming phases and arithmetic

The Store performs two complete original-page streams inside the original funding turn, both with `walkPages(directory,root,guard,groupCount,retireLegacyFile)`. Every row must equal its current `legacyHint`, ordinal/EOF/counts match, and `legacyFirst` chooses exact distinct-ref effects. No SQL statement/cursor crosses async work. Keep one page/current row, one original owner's existing Set and bounded per-entry description at a time; no D-sized descriptors, native handles, row/owner maps or new persisted scratch. Scalars, two hash states, root/application bytes and one local slot pair are the new retained state.

Pass1: root-slot description; for each distinct ref re-read canonical commitment and actual ledger, derive current next owner Set, **prepare only proved committed storage**, then describe expiry pair and prepared ledger; finally describe application pending. Preparation is per ref before its description; all such preparation completes before aggregate inventory/admission. Per-ref names and original independent/nonalias native checks ensure a later ref's proved cleanup cannot mutate an earlier description's files; foreign cross-ref aliasing refuses. It may finish existing committed restoration/reclamation and therefore change actual occupancy; the pre-inventory occurs afterwards. It never performs missing reserve allocation or an absent owner addition. A preparation failure ends the batch before new allocation. Source/target guards remain current at every existing boundary; no permission result is cached.

No new allocation before T0 means no positive accounted payload-byte growth. Original page/plan/application confirmations may acquire handles and fsync verified existing bytes in either stream; proved committed recovery may rename existing inodes, shrink them and overwrite an existing fixed-capacity journal. Preserve these native operations, refusal outcomes and Store retirement debt. Neither preparation nor policy lookup invokes missing-file allocation, index preparation or owner replacement. T0 follows settled committed recovery and required retirement joins.

Pass2: root actual funding; for each distinct ref retain the existing placement `qualify(row); verifyBody(tuple); expiry fund; owner fund`. That is inside exactly the existing funding mutation callback; this design does not move policy callbacks into a new lock/native transaction or into later merge. Each helper freshly describes/validates its actual immediate pre-effect state, hashes that description, then allocates using original native checks. Existing body verification happens once per distinct ref in this effect pass; Pass1 adds no full body read or new host policy callback. Application pending is funded last. Re-read current owners to derive next; no first-pass Set survives.

For every entry, transcript fields are domain version, ordered key/type, root binding/plan/operation/full commitment as applicable, phase, actual file presence/native dev+ino+nlink/size, exact prefix or canonical owner digest/count/encoded bytes, original intent prior/next/operation/capacity, reserve/journal/predecessor state, and calculated growth. Canonical encoding uses explicit field order and UTF-8 byte lengths. Numeric encoding preserves each original field's validated domain and value. Byte sizes, capacities, counts, ordinals, growth, quotas and arithmetic intermediates use nonnegative safe integers, with positive quota as specified. Native dev/ino/nlink retain original bigint validation and decimal encoding. Commitment metadata, especially expiresAt, retains fork-codec validation: finite0≤expiresAt≤Number.MAX_SAFE_INTEGER, including exact fractional values and the existing JSON/commitment treatment of numeric zero. Do not round, truncate, apply Number.isSafeInteger to expiresAt, or introduce blanket metadata normalization/rejection. One file content digest is streamed over bytes already required by its native phase check, not accepted in place of those bytes. Pending application records include exact final/pending path derivation and expected bytes digest. Hash input uses length framing and a fixed `ih.legacy-funding.batch.v1` domain; keys/entry order are root, alternating expiry/ledger by first ordinal, application. The rolling hash is an operation-local drift detector, not authority or a new persisted index.

Safe arithmetic matches `requireSpace`: integer quota≥1; each growth and count≥0 safe integer; every intermediate sum≤MAX_SAFE_INTEGER. Let G be Pass1 growth, T0 the actual hardlink-aware pre-inventory. Admit only if safe(T0+G)≤quota, otherwise original `ARTIFACT_QUOTA` error before new allocation. No planned unlink/recovery/refund is subtracted after admission. Root/slot/app capacities are actual bytes, not repeated admission requests; an absent slot contributes capacity once, not twice.

Pass2 maintains only monotonically accumulated **re-described issued growth** X and entry/ref counts to check that described execution has not exceeded the frozen G before issuing the next entry. X never decreases or returns credit, is never queried by other operations and never admits a new batch; it is not a mutable free/reserved balance. `enter` validates sum(primitive.peakGrowth)=entry.additionalBytes, safe-adds that complete freshly described local maximum before its first mutator and refuses if X>G. `issued` checks the current allocation/key, fixed primitive record and requested positive peak≤that record before every native request; the primitive is charged once at enter, with no credit/recycle and no double charge for its create+fill/chunks. Each helper verifies the actual immediately opened size/identity matches the local description before growing it: a smaller replacement/changed size cannot silently increase pad growth. A repeated request can only continue that same capped original file/handle protocol. These checks also cover **zero-growth overwrites/syncs**, not only extending writes: revalidate actual owned path and opened native resource against that local phase before touching existing journal/rewrite/application bytes. For a newly created file, keep its actual acquired native identity in this one bounded local entry, and compare later reopen/readback against that identity; absence is not proof that any later inode is its output. Original legitimate predecessor alias transitions use original native pair proof. Discard local produced identities after the entry; no D-sized identity table is created. On failure X is discarded; actual retained bytes are inventoried, not inferred from X. Execute each phase's original zero-growth protocol. Normal slot/ledger/application checks and syncs cannot be skipped. This adds no writes/syncs to the pending-prior early-return branch: retain its exact native/reserve/operation checks and return, leaving replace decisive later.

At complete effect EOF, require Pass2 counts, total G and transcript digest equal Pass1. Join actual local file retirements. Then obtain T1 using actual `physicalBytes`; require **T1=T0+G and T1≤quota**, with safe arithmetic. No canonical target addition is allowed before this full gate. Since preparation/reclamation is complete before T0 and effect pass only allocates exact original capacities (temporary predecessor links preserve reliable aliases), ordinary success has this exact payload delta. Unexpected occupancy increase or decrease refuses, even if still under quota. Index confirmation has already settled; no index writer runs between T0 and T1 under this turn.

## 5. Original phase semantics

| Allocation | Pass1/Pass2 rules and actual growth |
|---|---|
| Root/expiry slot pair | Existing ancestors checked without creating namespace during description; missing ancestors imply missing slots. Each existing slot must pass original owned path, regular single-link/nonzero inode, opened-handle identity, size≤capacity and exact expected live/zero prefix. Full terminal/torn inactive content refuses; never reset a revoked tuple. Delta=sum(capacity-size), absent size0. Pair is a fixed two-record description. Execution retains exclusive create, original per-open identity checks, actual writes/fsync/retirement and final actual `readSlots==='live'`. Missing directory creation happens only after admission through original `ownedMkdir`. |
| Normal ledger, absent/idle intent | Retain `ownedPath`, actual nonempty canonical owners and identity/capacity, no unresolved `.previous`, canonical independent native identity. Existing rewrite must be independent/nonalias and not larger than capacity accepted by actual padding; journal must parse/validate original fixed capacity if present. C=max(canonicalCapacity,nextEncodedBytes). Delta=(C-canonicalCapacity)+max(0,C-rewriteSize)+(journalAbsent?JOURNAL_CAPACITY:0). Execution retains real link/predecessor proof/unlink, canonical pad, independent rewrite pad, original readback, journal pad/write/sync/readback. |
| Pending intent, canonical=prior | Preserve current `fund` branch: require exact prior/next/operation, actual rewrite capacity≥intent.capacity, actual independent rewrite, and predecessorPair or independent canonical as appropriate. This is already-funded original obligation: delta0, no missing allocation, no rewrite/canonical owner change. If any required original is missing/conflicting, refuse; do not finish it speculatively. Existing `replace` later remains decisive. |
| Pending intent, canonical=next | Only original `recover(path)` may restore already-funded predecessor→rewrite and reclaim verified canonical whitespace/reserve, then clear idle intent. Re-read/describe normal phase after completion before T0. Pending operation can be an earlier committed operation, as current `fund` allows; the new requested next Set is freshly derived afterwards. Failure retains original recovery phase/debt. No recovery after admission: Pass2 finding pending-next instead of the prepared normal state is phase drift and stops, not an excuse to recover using old G. |
| Unknown ledger phase | Neither prior nor next, different pending-prior operation/next, foreign alias/predecessor, malformed intent, missing reserve or ambiguous native state refuses. A partial normal pad/rewrite with no intent is described from actual verified file sizes/native identities; already-retained bytes are charged by T0 and only exact missing capacity contributes to G. Preserve current prefix/format rules; do not pretend uncommitted scratch bytes are canonical owner data. |
| Original application pending | Bytes=Buffer.from(JSON.stringify(appliedFor(root))); pending path is original final+SHA256(bytes)+`.pending`. Describe exact actual pending prefix/size and regular opened file with owned ancestors, retain original resource/native facts; missing→delta bytes.length, partial→delta bytes.length-size. Final applied file does not erase the original pending obligation or grant assumed alias savings. Existing pending may legitimately alias final after publication; do not impose slot/ledger nlink1 on this phase. Execution retains actual open/create, exact prefix/read, write, fsync/retirement, and adds full exact readback on the original handle before confirmed funded success. Final publication/link remains existing later code. |

Native identity transcript uses actual reliable dev/ino when available; no timestamp identity. Slots and ledgers keep their original reliable identity requirements. Application does not gain a guessed alias optimization: all current files are accounted by original physicalBytes; an unreliable application identity is recorded as unavailable identity and retains conservative path accounting plus actual path/prefix/handle checks. Do not claim this proves immutable identity on a platform that supplies none. Failure cases for changed identity use actual reliable native identities on the qualified host.

Do not alter capture-only `OwnerLedger.describeFunding`. Shared pure `fundingGrowth` and native inspection code may be factored, but the transfer preparation must explicitly implement the branches above. Ordinary `fund`/`fundSlots` still use actual full admission when called without original batch provenance.

### File-by-file positive peak table

This table charges actual positive payload peaks once, not the sum of historical requireSpace arguments. Let s be the verified actual size before this entry, c the original slot capacity, C the ledger capacity max, r the actual rewrite size, J the original fixed journal capacity and a the exact application encoded bytes. Every component/total is safe-integer checked. All preexisting files, unknown siblings, index/journals and managed staging already belong to T0 through actual physicalBytes.

| Original primitive and coexistence | Conservative positive growth charged before issuance | Required before each actual growth |
|---|---:|---|
| Missing slot `.0` or `.1`: exclusive empty create then fill same inode | c, once for create+fill | Actual new handle size0 and original native identity; no second capacity credit. |
| Existing partial slot `.0` or `.1` | c−s | Actual same local native identity/size and exact live/zero prefix; subsequent writes cannot exceed c. Both actual files coexist, so pair=sum of both missing capacities. |
| Canonical ledger pad | C−s | Exact actual canonical owner identity/capacity; pad only trailing whitespace on same original file. No shrink credit. |
| Independent ledger `.rewrite`, absent or partial | C if absent; C−r if partial | Actual independent reliable inode and nonalias; size≤C. Canonical and rewrite coexist, so both pads count. Existing scratch larger than C refuses rather than manufacturing negative growth. |
| `.intent.json` missing, created/padded then rewritten at fixed capacity | J | Exclusive new file then exact fixed-capacity native readback. Intent text/idle changes add0 after pad. Existing valid idle/pending journal contributes0; a malformed/short existing journal is unknown/refused under original readIntent semantics, not repaired by preflight. |
| `.previous` hardlink setup/unlink during normal fund | 0 | Original real canonical link, predecessorPair reliable dev/ino+nlink proof, then original unlink; payload aliases canonical already charged by physicalBytes. Unsupported/unreliable/foreign proof refuses; no guessed zero growth for an independent copy. |
| Pending-prior original funded obligation (canonical/rewrite/journal/predecessor already real) | 0 | Exact current pending-prior/next/operation and original native reserves, no missing allocation; every retained inode already charged in T0. |
| Committed-next restoration/reclaim | Not admitted as effect-stage growth | Only original proved committed cleanup before T0. Coexisting old canonical/rewrite/previous are physically inventoried after actual recovery settles. Never subtract intended later cleanup. |
| Application `.sha.pending`, absent then create/fill | a | Same original pending inode, exact encoded prefix/readback; final `applied.json` may already coexist and remains charged in T0. No assumed reuse of final payload. |
| Existing application pending partial/full | a−s | Actual opened prefix/size/local resource checks. A legitimate pending/final hardlink is not charged as two reliable aliases by physicalBytes; no unlink/link occurs in funding to release or add credit. |
| Original later `applied.json` publication/link and pending retirement | Outside this batch; unchanged later owner | Existing publish admission and physical linking protocol remain separately counted; batch passes no allowance into it. It cannot be silently included as free future work. |

During the effect pass there is no intended payload reclamation: only exact pads/creation, fixed-size rewrite/sync and reliably verified temporary aliases. Therefore T0+G is the supported-path physical peak bound as well as final expected payload, and each helper's positive primitive is included. No supported allocator can enter through source policy: `qualify` uses current canonical/observed read helpers (loadPlan/page/slot checks), not mutate/prepare-index/capture. Source/target assertion callbacks remain the trusted existing capability checks; reentrant supported mutation is rejected by the original owners. Any discovery of a growing helper or supported write on this call graph invalidates this closed allocation set and returns to root; final inventory cannot excuse it.

## 6. Drift boundary and root ruling

Two constant-space passes cannot retain every first-pass native snapshot for immediate per-row comparison. Root ratifies this tradeoff after exact connected phase/signature review and final baseline review; the following is binding:

1. Fresh local native/phase/prefix checks protect each execution. A local invalid/foreign/revoked state or X>G stops before that entry's new mutator.
2. A still-valid but different first-pass phase/identity/prefix, including same-growth changes, can be detected only when the second ordered digest completes. If earlier allocations occurred, retain them as partial effects, fail the batch before any owner grant, and require a new original-authorized attempt with a new T0/G. No successful funding is inferred from equal totals alone.
3. T1's equality/within-quota gate detects unexpected net unmanaged growth/shrink before grants. Original per-file checks detect observed replacement/redirects. This is not an atomic snapshot against arbitrary external writers, a continuously sampled peak or a promise that outside concurrent growth can never transiently exceed quota. Supported managed writers remain excluded by the original lock.

The monotone X guard is a consistency bound under frozen admission, not a free-byte ledger. Root's ruling permits no credit/recycling, unrelated work, authority after callback/failure or uncharged positive primitive. This design does not promise every first-pass identity mismatch is detected before that entry writes. The exact local file snapshot **does** protect each later growth request against drift after its own immediate re-description. Tests must show same-growth first-pass drift fails final digest, and an unexpectedly larger second-pass entry/cumulative growth exceeding G refuses **before that offending entry's native allocation** while retaining earlier actual partials. No extra pass, D-sized state or reservation balance is silently added.

## 7. Outcomes, partial effects and cleanup

Retain existing transfer `issued`/blocked classification and original scope attempts; published pages may already make the overall operation unknown before funding starts. Separately track batch-local `allocationIssued` monotonically **before** every native creating/growing/replacing/syncing request; this distinguishes read-only preparation refusal from new partial allocation in evidence, but never certifies capacity or replaces the original outcome. Committed-storage recovery effects are separately labeled `recoveryIssued`, not new owner grant. No D-sized runtime diagnostic log is needed; test observers retain detailed original operations.

Every acquired original handle enters a try/finally retirement region before the next after-await guard. Retain Store `retireLegacyFile`/`joinLegacyFiles`, original failuresTogether behavior and original lock LeaseRetirement. Failure must invalidate batch scope before another allocation is admitted, retain primary error, attempt/join every acquired original retirement and collect cleanup errors. `assertRetirement(context)` uses actual `assertRetirementTurn` plus creating exclusive lease; it deliberately does not require the cancelled source guard or an already-invalid IndexUse to permit original retirement/read-only failure inventory. It confers no new allocation authority. Attempt an actual failure-reconciliation inventory under that still-held original turn after joining available work; its own failure is appended, never replaces primary failure or proves zero retained bytes. Do not retry consumed close into successful no-op, delete unknown partial originals, perform target merges in finally, or force cleanup under the success two-scan oracle. No automatic funding retry is introduced.

Stop/currentness failure is cooperative: cease new work at existing checked boundaries; issued syscalls settle or remain honest debt. No new polling, lock cancellation argument, interruptible clear/delete or fake wall-clock bound. Cold passive `reconcile` keeps its original validation-only branch and cannot invoke this batch or allocate missing files. Warm original-source retry recomputes after actual recovery/native inspection/new inventory and cannot reuse old scope/G/X/digests.

## 8. Causal controls and qualification

Required ordinary bounded tests on actual B2/legacy fixture, with corrected measurement observer from baseline8f3a3a7b and actual I/O:

- D11/R11 and D31/R31 successful allocation inventories=2, D1/R101=2; initial/final index confirmation, page/reset and application publication remain separate. Show actual distinct slots/ledgers/pending, correct selected owners/read bytes, omitted denial, body hash/read equality, and zero observed active resources after owner/close. Exact all-owner total is reported, not frozen to historical75/175/35 after adding one description pass.
- Quota exactly T0+G admits; one byte below refuses before new allocation or grant, including already-partial prefixes, two real ledger inodes, fixed journal and exact app pending. Invalid/overflow arithmetic refuses before allocation. No allowance increase or assumed reclaim after T0. This is also an actual Store/gate/turn/native phase contract control: current initial index confirmation has its own independent journal-headroom requirement and may legitimately reject a fresh public transfer before batch admission at such a tight quota. Do not bypass/weaken that native gate to force a public exact-fit success; report which actual boundary the case qualifies.
- First-description/read drift at first/middle/last entry: changed original identity, equal-growth prefix/phase and changed operation; test both local immediate refusal and final digest refusal with preserved earlier effects. Equal total/changed transcript must not pass.
- Real first/middle/last partial write, sync-after-bytes failure and original file-close rejection (held/consumed), separately for slot/ledger/application; retained physical bytes stay charged. Primary plus independent cleanup/inventory failures remain observable; no two-scan assertion masks them.
- Terminal/revoked/foreign slot, source/target invalidation and Stop in both passes and after acquisition; no reset/grant and all original acquired resources joined. Native symlink/junction/outside-hardlink controls preserve outside bytes.
- Pending-prior original funded obligation, committed-next recovery cut, missing/foreign reserve, changed operation/prior/next/predecessor. Recovery before T0 may reclaim only original proved whitespace; later new Set derived from actual owners. Passive cold performs no missing work.
- Inject actual unmanaged file growth/shrink after T0 (no mocked inventory) and assert final T1 equality/quota gate blocks grants while retaining both unrelated original bytes and partial batch files. Between failed turns let an unrelated actual managed writer allocate: it sees retained physical bytes/new real inventory; no budget refund or stale admission.
- Full target/application response-loss and later merge currentness/slot revocation controls retain original operation, cold original reads and later per-ref fresh merges. F1 public completion is not claimed.

Plan supplies exact tests/commands and evidence receipt requirements. Run focused bounded GREEN11/31 plus existing affected quota/ledger/disposition/close controls and types before one ordinary fast gate. No101 measurement until root separately reserves it after causal tests/review. Only later root-reserved101/1001 use LP08 ceilings101 owner≤5s,1001 owner≤60s,1001 hot expiry≤30s; no10001. Historical488s is never a post-fix baseline. R6 remains open for residual page O(P×F), canonical/policy/body work, startup/final proof, ordinary capture/grant setup, archive/projection/>100MiB and actual public continuation.

## 9. Root decisions and self-audit

Root completed baseline and concrete native-contract review, checked actual Store.indexUse/native membership and fractional-expiry codec, and ratifies§6 plus the exact closed phase/allocation set. Rulings FG01–05 preserve metadata domains, record original Store-issued use/lease provenance, distinguish zero-growth native work, enforce bounded scalar ordering and preserve partial effects/final-digest limits. The SDD ledger records the execution reservation. This plan is authorized within the already approved integrated version scope; no repeat design-choice confirmation is needed.

Self-audit: actual consumer is the current funding mutation, not a disconnected helper; ordinary helpers retain own admission; all original ledger branches are explicit; preparation precedes physical admission; target merge authority never escapes; first-pass drift and unmanaged growth limits are stated rather than hidden; failure cleanup can exceed success count; existing policy placement/native generation checks remain; capture/index/expiry/status and D1/F1 ownership remain intact. No passing implementation, performance or release claim follows.
