# Exact same-turn legacy funding implementation plan

> **For agentic workers:** one root-assigned implementer executes Task1 in its reserved worktree, with root-assigned independent review. This is the original performance plan's Task3, kept as one connected Store consumer. No recursive agents or competing shared-file writers. Checkpoints are stages, not isolated helper deliverables.

**Goal:** replace D-dependent original funding inventories with one exact pre-admission and one actual final verification inside the existing protected funding turn, preserving real file/native/policy and unknown-effect semantics.

**Architecture:** ContextStore owns a private batch lifetime bound to its creating exclusive lease, original WorkspaceMutationTurn and current IndexUse. Two bounded original-page streams describe prepared native phases and perform original allocations; actual files remain the only capacity evidence. Later owner application/publication is unchanged.

**Tech stack:** existing TypeScript, Node fs/bigint identity, original fs-lock/gate, actual SQLite lifecycle and package-CWD Vitest. No new dependency, schema, quota, public API, native policy or format change.

**Spec:** `../specs/2026-10-26-legacy-funding-batch.md` in full; original `docs/superpowers/specs/2026-10-25-legacy-retention-performance.md` LP01–09; accepted derived-index owner/native policy.

## Global constraints and source handoff

- Draft inspection source MAIN9726a09b, accepted product/index through9ef15a8e and baseline observer integrated7372d66c. Root has promoted the exact contract including FG01–05. The dispatch brief/SDD ledger supplies frozen execution BASE and sole writer/runtime. No unspecified measurement, external operation or release is authorized.
- Preserve0.1.13-rc.1 and dispatch-current Session/core interfaces; no version allocation. D1 core/persistence/service/assembly and F1 public caller surfaces are excluded.
- No service-lifetime free-space/permission cache, second ledger, reservation balance, caller-supplied permission boolean, hidden reserve, weaker integrity, total-ref cap or widened budget.
- Success allocation-batch inventory count=2; failure/reconciliation scans are separate and uncapped by that oracle. Original per-file checks, writes/sync/readback/close remain real.
- Bounded11/31 controls first; D1/R101 is a repeated-row control, not101 distinct refs.101/1001 performance only under later root reservation; no10001 execution.
- Sole writer/runtime, sequential commands, package CWD `packages/context-output`, `--maxWorkers=2 --minWorkers=1`; root assigns isolated fixture/config/evidence roots. No user profile/provider/auth/release work.
- Preserve every actual failed setup/observer/test/cleanup stream and source provenance. No pass claim without actual fixed-source output and independent complete-range review.

## Exact file map and interfaces

Create product `packages/context-output/src/legacy/funding-batch.ts`; modify only `src/store.ts`, `src/legacy/{fork-transfer,fork-disposition,owner-ledger}.ts`. New module owns private runtime scopes/transcript/arithmetic and original application-pending helper. Store owns orchestration and actual owner identity; existing helpers own their native protocols. No opportunistic decomposition.

Create bounded ordinary `packages/context-output/test/legacy-funding-batch.test.ts` for actual connected batch/refusal/failure controls. Modify existing `test/{legacy-owner-ledger,legacy-fork-disposition,legacy-fork-close,legacy-fork}.test.ts` only for relevant cuts; `test/helpers/legacy-performance-probe.ts` only if corrected observer needs a narrow forwarding extension. Preserve old broad `legacy-fork-performance.test.ts` assertions and counters; do not treat its broad marker as the new oracle. Reuse baseline test-only measurement modules after root-approved integration/cherry-pick of8f3a3a7b; do not read protected worktree content or reconstruct an unreviewed observer from memory.

Optional test helper creation is limited to `test/helpers/legacy-funding-observer.ts`: factor corrected baseline wrappers without changing original promise/handle/error behavior and labels. This exact helper path is reserved by this draft if root promotes it. No product telemetry or extra observer FS queries.

All private signatures are exactly spec§3, including `LegacyFundingBatchOwner.run/enter/assertAllocation/issued/finish`, Store `fundLegacyBatch(turn,lease,use,quota,root,groupCount,guard,qualify)`, `describeSlotFunding/fundSlotsInBatch`, `OwnerLedger.prepareTransferFunding/fundInBatch`, and `describeApplicationFunding/fundApplicationInBatch`. Do not invent later task interfaces. Helpers return `FundingDescription` from their actual immediate pre-effect state; all ordered summaries use `FundingPassSummary`.

## Task 1: Connect bounded aggregate funding to the original Store owner

Read the full spec and Global constraints/file map above before implementation. Deliver the connected Task1 through checkpoint4; checkpoint5 is a later root reservation, not an implementation prerequisite or granted measurement.

## Checkpoint 0 — source, decision and observer freeze

Consumes accepted source, reviewed baseline8f3a3a7b and root's in-principle spec§6 ruling; produces exact execution manifest/selector population and unchanged corrected observer provenance. No product work before this checkpoint is approved.

- [ ] Root records final baseline independent review and reviews the exact spec against its already-issued in-principle two-pass ruling: late digest mismatch refuses funded success before new owner merge/applied publication; actual partials/debt retained; fresh per-file native checks; every positive primitive charged before issuance; no credit/recycle/unrelated work. No renewed design-choice confirmation is required. Source-level failure to meet this concrete contract returns to root before implementation.
- [ ] Record actual BASE/HEAD and raw hashes of the owned product files, current fixture, affected tests and corrected observer before any runtime. Keep Git-byte/raw/line-ending identities distinct. Verify current product source matches accepted signatures and no source drift from final baseline report. Preserve the report's initial raw-freeze gap rather than calling it fully pre-runtime frozen.
- [ ] Root integrates the reviewed test-only baseline commit through its normal source handoff. Read actual corrected `test/measurement/retention-funding.baseline.ts`, timing module and probe at the assigned checkout. Keep initial observer failure/review reports untouched. A mismatch is a source-handoff finding, not authority to change product policy.
- [ ] Extract/reuse corrected observer labels in the reserved test helper: root/expiry/ledger/application allocation, initial and final index confirmation (including post-check), page/reset/publication, body and final proof. Forward original native promises/handles/errors; preserve fixed original application `confirmAtomicJson` phase so pending opens cannot overwrite publication/final proof. No extra I/O or exclusive-time arithmetic.
- [ ] Write and freeze `test/legacy-funding-batch.test.ts` cases with literal names `aggregate-funding d11-r11`, `aggregate-funding d31-r31`, `aggregate-funding d1-r101`. Each calls original `legacyFixture({distinct, observations, summary:true})` once and original `f.run()` once; assert actual plan/applied counts, selected exact owners, omitted denied, real original body/read/hash and actual live tuples, then original close. Structural assertion:

```ts
expect(observation.allocationInventories).toBe(2)
expect(observation.originalFundingDistinctRefs).toBe(distinct)
expect(observation.bodyReadBytes).toBe(observation.bodyHashBytes)
expect(observation.activeIO).toBe(0)
expect(observation.activeHandles).toBe(0)
```

`observation` is test-only corrected observer output over original operations; define its fields in `legacy-funding-observer.ts` with the exact root-inventory counting predicate already used by baseline. Never set counts in a product helper or mock a successful original owner. Assertions/receipts/teardown are outside owner timing. Retain actual allocation/nonallocation rows in raw receipts rather than only the scalar expectation.

Freeze helper typing as follows; implementation delegates to the corrected wrappers and retains original errors if work fails. Failed receipts use its `finally` snapshot rather than fabricating a successful return.

```ts
export interface FundingObservation {
  allocationInventories: number; originalFundingDistinctRefs: number;
  bodyReadBytes: number; bodyHashBytes: number;
  activeIO: number; activeHandles: number;
}
export function withFundingObservation<T>(work: () => Promise<T>):
  Promise<{ value: T; observation: FundingObservation }>;
```
- [ ] List exact selectors before runtime, then perform one causal RED on unchanged product. Expected failure: actual61/161/11 >2 with correctness assertions and original close retained. The reviewed receipt-only future target already proves the mathematical baseline; fresh RED is only for the frozen candidate test bytes, not extra timing samples. If root chooses receipt-only RED reuse, record that exact ruling and do not mislabel it as execution of new test code.

Future package-CWD commands (not run by this plan):

```powershell
pnpm exec vitest list test/legacy-funding-batch.test.ts -t '^aggregate-funding d(11-r11|31-r31|1-r101)$' --json --maxWorkers=2 --minWorkers=1
pnpm exec vitest run test/legacy-funding-batch.test.ts -t '^aggregate-funding d(11-r11|31-r31|1-r101)$' --maxWorkers=2 --minWorkers=1
```

Record raw stdout/stderr/exit/CWD/env/runtime/hash and all sample counts. Do not run measurement module D101/1001 or a broad scale selector here.

## Checkpoint 1 — original native phase descriptions and unforgeable lifetime

Consumes current original file helpers plus exact interfaces; produces actual bounded descriptions and owner-bound runtime validation. Helpers alone do not deliver Task3 or justify claiming completion.

- [ ] Add `FundingFile/Description/PassSummary/BatchContext` and private branded scope/allocation registries in `funding-batch.ts`. Include the fixed per-entry primitive key/positive-peak records from spec§5's file table in the transcript. Use canonical explicitly ordered, length-framed fields. Safe-sum every intermediate growth/count; bigint identities encode as decimal strings. Retain one entry/two-slot pair; no arrays/maps of refs. Implement assertions by the actual Store callback, not configurable caller success ports.
- [ ] Separate allocation arithmetic from metadata encoding: preserve exact fractional expiresAt and existing zero semantics through transcript, commitment/expiredTuple and later cold read/expiry. Retain the existing named fractional-expiry regression and add a bounded connected batch case. Invalid allocation operands still refuse before positive growth.
- [ ] Implement Store-private single owner construction with exact `assertContext`, `assertRetirement`, inventory and joinFiles callbacks from spec§3. Runtime provenance checks exact Store directory, turn/lease/use object identity, original native generation/currentness, active async run, effect stage, one current allocation/key and no nested run. `finally` invalidates all scope/allocation references before returning/rethrowing. Register only genuine IndexUse objects returned by this Store's indexUse(lease) in a private WeakMap to their creating lease. Require exact Store-issued use/lease association before preparation/admission/effect and invoke original assertCurrent; a forged callable object, foreign Store use or mismatched genuine lease refuses before recovery/mutation. Reused/finished allocation tokens and overlapping allocations refuse immediately; root→strictly increasing original first-ordinal expiry/ledger→application order uses bounded scalar stage/ordinal state, no D-sized seen-key registry. Ordinary calls have no batch parameter/branch selector. Retirement checks active original turn/exclusive lease independently of cancelled source or invalid index generation; this allows original cleanup/read-only inventory, never new allocation.
- [ ] Add causal runtime-token tests using actual owner/gate/Store setup: forged object, forged IndexUse, foreign owner/Store/use, genuine use paired with a different lease, stale actual turn, shared lease, retired use, saved scope/allocation after return and after failure, second enter before finish and repeated finish all reject before native mutator. Do not replace original gate/lock with a test success stub. Test actual existing WorkspaceMutationOwner reentry/consumed debt controls unchanged.
- [ ] Factor slot inspection to check existing ancestors without `ownedMkdir` during description, then actual original slot files/handles, native identity, exact expected prefix and capacity. `describeSlotFunding` adds true missing bytes once per file. Add cases for absent, each generation partial/full, torn/terminal, symlink/hardlink/junction and after-open guard. Existing `fundSlots` still executes its ordinary requireSpace path; `fundSlotsInBatch` requires original scope and preserves actual native protocol/readSlots.
- [ ] Implement `prepareTransferFunding` as the explicit spec§5 branch table. On committed-next call only original `recover`, then re-read; pending-prior exact obligation returns zero only after original native/reserve/operation checks; normal partial pad/rewrite uses actual sizes and `fundingGrowth`; ambiguous/foreign/missing phase refuses. Do not change capture-only `describeFunding` or invent a more permissive recovery path.
- [ ] Preserve normal `OwnerLedger.fund` behavior and factor its native execution into a common internal body. `fundInBatch` re-inspects actual state without recovery after admission, enters original owner-bound allocation, executes common actual body without per-file full inventory, and returns the immediate pre-effect description. A new pending-next in effect pass is drift, not a request to call recover under old admission.
- [ ] Move only original application-pending funding from `fork-transfer.ts` into the new module. Preserve `appliedFor` bytes, exact SHA pending name, actual open/create/read prefix/write/sync/retirement and later final link. Add exact readback on the same original handle. Existing pending/final hardlink coexistence remains legal; no slot-style nlink1 condition. Missing parents are checked without namespace creation before admission. Existing application protocol failure causes preserve original files.

Frozen arithmetic kernel to implement and test (names internal to new module):

```ts
function sum(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || a < 0 || !Number.isSafeInteger(b) || b < 0 || !Number.isSafeInteger(a + b))
    throw Error('Legacy funding allocation overflow')
  return a + b
}
function admit(total: number, growth: number, quota: number): number {
  if (!Number.isSafeInteger(quota) || quota < 1) throw Error('Invalid artifact quota')
  const expected = sum(total, growth)
  if (expected > quota) throw Object.assign(Error('Artifact disk quota exceeded'), { code: 'ARTIFACT_QUOTA' })
  return expected
}
```

Use original physicalBytes for total; this pure predicate is not another quota source. Test0 growth, exact fit, one below, negative/nonfinite/unsafe operands and overflow before any native growth. Journal capacity formula remains original constant; do not duplicate a guessed6714-byte literal into product code.

## Checkpoint 2 — actual Store/transfer consumer

Consumes native phase helpers and active scope; produces the complete connected batch in the original funding mutation, with later owner turns unchanged.

- [ ] Add Store `fundLegacyBatch` with exact spec signature. Validate turn/exclusive creating lease/current use and root binding/workspace; derive actual transfer directory using the existing invocation/binding derivation. Build one local async iterator that streams original pages, checks every `legacyHint`, ordinal/EOF/counts and `legacyFirst`; no derived hint authorizes a row alone.
- [ ] Implement Pass1 order: root description; each distinct row's actual canonical/ledger next Set and committed-only preparation, expiry description then ledger description; exact app description. Guard around awaited original I/O. No source-policy callback/body hash is newly moved into this description pass. No pre-T0 positive payload growth is allowed, but original page/plan/application confirmations still acquire/retire handles and fsync existing bytes, and proved committed recovery retains original rename/truncate/fixed-journal effects. Do not call missing-file allocation, index preparation or owner replacement; join required retirements before T0. Aggregate G, counts and transcript digest. Discard current Set/description before advancing.
- [ ] Finish preparation across the complete stream, then run one actual `diskBytes`/physicalBytes inventory T0 under the same turn and safe admission. Index confirmation is already complete and remains separately observed. No new index mutation or native statement crosses any awaits in batch.
- [ ] Implement Pass2 order with existing `qualify` and `verifyBody` immediately before expiry/ledger allocation at the same original callback placement. Fresh descriptions precede each local allocation. `enter` checks exact provenance, sum of fixed primitive peaks=entryGrowth and safe X+entryGrowth≤G; no decrement/refund. Before each native request call `issued(allocation,primitiveKey,peakGrowth)`, which validates the capped original primitive; create+fill/chunks are precharged once, not double-counted. Verify actual local owned path/opened identity/size/prefix before every mutator, including zero-growth journal/rewrite/application overwrite or sync, so replacement cannot acquire authority or enlarge a pad beyond its charged primitive. Retain actual newly created inode identities only for this one entry's later reopen/readback; an originally absent name cannot authorize a replacement inode. Keep actual old link/pad/intent/slot/app writes and all final readbacks/retirements. Hash/count exact pre-effect descriptions, including primitive caps, not post-write normalizations.
- [ ] Require full second-stream EOF, digest/count/G equality, all original acquired resources joined and actual final inventory T1 equal expected T0+G and≤quota. A final inventory/digest error exits before the later target owner loop. Do not call merge/replace from a funding finally block.
- [ ] Replace current funding callback body with the consumer, leaving confirmation in place and all surrounding publication/owner-application/final-proof code in its original order:

```ts
await ports.mutate(context, async turn => {
  check(); await store.confirmLegacyIndex(turn, lease, index, root, ports.quota()); check()
  await store.fundLegacyBatch(turn, lease, index, ports.quota(), root, facts.groupCount, check, qualify)
  check()
}); check()
// Existing per-ref qualify/slot checks/merge mutation loop follows unchanged.
```

- [ ] Add batch-local `recoveryIssued`/`allocationIssued` markers before native mutation issuance only for truthful failure ownership/observer boundaries. Preserve existing outer `issued` and blocked result classification. Invalidate scope on failure, retain primary error, join all original acquired file retirements, and attempt fresh failure inventory while original turn remains held. Append cleanup/inventory failures with failuresTogether; never swallow them for the ≤2 success count. Original Store/file/lock debt must remain the cleanup owner after rejection.
- [ ] Run the three exact small GREEN selectors once after connected implementation. Require actual allocation counts2/2/2 plus real owner/file/body/omitted-read assertions. Report nonallocation inventories and two-pass row visits separately; do not demand old whole-owner graph count5 after deliberately adding description traversal.

## Checkpoint 3 — adversarial connected proof

Consumes the actual connected consumer and original syscall interception patterns. Produces causal failure traces binding each spec invariant to original retained files and actual caller outcome. Tests run bounded D=3 or11 unless the case specifically needs31.

Create ordinary cases with these literal selector prefixes in `legacy-funding-batch.test.ts`, grouping only truly parallel scenarios with `it.each`:

| Test prefix | Exact causal action and oracle |
|---|---|
| `funding-quota` | Prepare actual original pages and measured native phases; invoke actual Store batch with exact quota=T0+G or one byte lower under its actual creating gate/turn/current native use. Exact fit has real files; shortage issues no new allocation/grant. Retained partial/independent rewrite/journal/app bytes included. Keep a separate actual B2/public quota-shortage control. Initial index confirmation has independent headroom and may correctly refuse before batch at this quota: do not weaken native policy, mutate service config reentrantly inside the active callback, or claim this Store-boundary case is a full public exact-fit success. Spy only to observe original inventory/growth, never return totals or grant native readiness. |
| `funding-drift` | At first description completion or first/middle/last second-pass boundary, change one actual original identity/prefix/phase/operation, preserving equal growth in at least one case. Native-invalid case stops before that entry; otherwise completed transcript mismatch blocks all new target grants, preserves earlier allocations and failed attempt scope cannot be reused. Increase second-pass required growth above the frozen G at the first entry, and separately above remaining cumulative ceiling at the last entry: the offending allocation must not issue. Drift after local description but before open must fail native/size checks before that file grows. |
| `funding-partial` | Intercept exact original handle.write/sync/close to perform real partial bytes or original sync/close first, then reject with retained exact error. Cover slot, canonical pad, rewrite, journal and application pending. Assert actual retained capacity/bytes and subsequent original-authorized recovery or refusal; no inferred refund from intended growth. |
| `funding-cleanup` | Inject primary allocation failure plus another original handle retirement or reconciliation inventory failure. Assert original primary/cleanup identities in returned aggregate, all independent retirements attempted/joined, original debt retained, later ordinary writer sees actual retained bytes. Count can exceed2 and must remain in failed receipt. |
| `funding-ledger-phase` | Real pending-prior exact operation (zero missing work); committed-next before/after original rename/reclaim; changed operation/next; missing or aliased rewrite; ambiguous predecessor. Cold passive cannot allocate. Original source warm retry recomputes; canonical owner membership never comes from planned state. |
| `funding-revoked` | Terminal/torn root or expiry slot during description/effect, and revoke after batch before later merge. No reset, no phantom grant; later merge retains fresh slot check. Outside symlink/hardlink/junction bytes unchanged. |
| `funding-stop` | Abort/invalidate source/target before admission, after real open, between allocation/syscall completion, during final inventory and before later merge. Register acquired original handle in finally before after-open guard. Stop prevents new work at next boundary, but issued syscalls/close debt remain joined. |
| `funding-external-growth` | Add/remove a real unrelated file after T0. T1 mismatch rejects even if below quota; above-quota rejects. No mocked inventory/no automatic delete. Preserve unrelated bytes and partials; report that no continuous external peak bound was proved. |
| `funding-next-writer` | After partial failed turn run actual unrelated managed allocation under original mutation owner. It uses new physical inventory and can use only actual remaining quota; predecessor/rewrite capacity remains charged. Same original authorized retry recomputes fresh phases/G. |

For each failure fixture assert no new target owner/application completion beyond actual previously committed effects; assert retained original operation/bytes, source-call nonreplay, original resource joins and actual physical occupancy. Separate committed recovery effects, new partial allocation and later owner-application effects in receipts. Do not weaken existing final applied/owner assertions to satisfy counters. A no-op spy/error before syscall is insufficient for partial-write/sync/close-unknown claims.

Existing original controls to retain: huge owner rewrite/full-quota removal, before/after canonical rename, canonical-before-reserve whitespace reclamation, cross-ref/outside aliases and inode accounting; fixed-slot partial/revoked/torn/outside parents/after-open invalidation; original transfer owner/application response loss and cold reads; consumed native close; WorkspaceMutationOwner stale/reentrant/lease debt. Use unchanged controls as regression evidence rather than duplicating their bodies.

Future commands, after exact test discovery confirms bounded names:

```powershell
pnpm exec vitest list test/legacy-funding-batch.test.ts -t '^(aggregate-funding|funding-(quota|drift|partial|cleanup|ledger-phase|revoked|stop|external-growth|next-writer))' --json --maxWorkers=2 --minWorkers=1
pnpm exec vitest run test/legacy-funding-batch.test.ts -t '^(aggregate-funding|funding-(quota|drift|partial|cleanup|ledger-phase|revoked|stop|external-growth|next-writer))' --maxWorkers=2 --minWorkers=1
pnpm exec vitest run test/legacy-owner-ledger.test.ts test/legacy-fork-disposition.test.ts test/legacy-fork-close.test.ts test/workspace-mutation.test.ts --maxWorkers=2 --minWorkers=1
pnpm exec vitest run test/legacy-fork.test.ts -t '^(?!.*10001)' --maxWorkers=2 --minWorkers=1
pnpm typecheck
```

Record every command independently; no concurrent suites, hidden retries or scale-name accidents. Any expected failure must be causally bound to actual executed source/test bytes and original native action. Add a focused corrected observer control if its factoring changed helper semantics, using only existing two bounded index/capture-admission cases; do not repeat owner samples just for bookkeeping.

## Checkpoint 4 — fixed-source review and ordinary qualification

- [ ] Self-audit complete BASE..HEAD against every spec section and scope. Verify original capture/index/expiry/status/public paths unchanged; no native SQL policy/schema or WorkspaceMutationOwner change. Check that no success-token/permission boolean or mutable reserved balance escaped, every description is actual original state, and failure cleanup remains outside success count.
- [ ] Freeze candidate raw hashes/manifest before qualification. Run ordinary discovery first; baseline nondefault modules remain excluded and all1001/10001 cases remain out of bounded run. Inspect the actual list, not a guessed number. Preserve runtime/Node/SQLite and isolated IH roots in command records.
- [ ] Run one affected ordinary ContextOutput fast gate and types sequentially on final source:

```powershell
pnpm exec vitest list --exclude test/legacy-fork-scale.test.ts -t '^(?!.*(?:10001|actual101))' --json --maxWorkers=2 --minWorkers=1
pnpm exec vitest run --exclude test/legacy-fork-scale.test.ts -t '^(?!.*(?:10001|actual101))' --maxWorkers=2 --minWorkers=1
pnpm typecheck
```

- [ ] Record causal RED/GREEN/test source identity, scoped manifests, exact inventory decomposition, original retained bytes/native resources and cleanup debt outcomes, qualification exclusions and remaining limits. No summing nested native elapsed spans or subtracting counterMs into a claimed uninstrumented time.
- [ ] FG07 discovery correction: the original legacy-fork-performance file includes an unconditional `actual101` distinct-ref profile. Exclude that name in the ordinary gate as above; retain its file/oracles and all bounded11/31/repeated101/expiry/observer controls. This is not a performance waiver: actual101 requires its separate post-review root reservation under checkpoint5, rather than slipping into an ordinary multi-worktree gate.
- [ ] Root obtains independent complete connected range review for product, tests, drift/arithmetic/provenance and unknown recovery. Review must inspect actual Store caller and later per-ref merge; disconnected helper success is insufficient. Resolve actionable findings with causal tests/review, then root integrates. No automatic PR/push/release or Git mutation is authorized by this draft.

## Checkpoint 5 — optional later root performance reservation

No performance run is granted here. Root may reserve bounded101 only after small controls, ordinary gate and complete-range review. Keep real actual selection/B2 and original generator/payload/body/summary/retention/quota/topology. Independent uninstrumented samples and corrected counted/profile runs have separate reservations and raw source/runtime identities. Prior1187.832/2819.051ms are single observations, not exclusive allocation cost or candidate comparison proof.

LP08 remains fixed:101 owner≤5s;1001 owner≤60s;1001 hot expiry≤30s. Root reserves one final frozen1001 distinct-ref run only after bounded progress warrants it; a matching profile/count run needs its own reservation. No10001, threshold increase, skipped native facts or widened budget. A structural improvement that misses the checkpoint leaves R6 open. Report page O(P×F), canonical/observed/body work, setup/startup/final proof and actual public caller residuals rather than expand this writer's scope.

## Coverage audit and decisions required

Spec§1 provenance/limits→checkpoint0/4; §2 ownership/grant separation→checkpoint2/4; §3 exact paths/types/provenance→checkpoint1/2; §4 arithmetic/two-pass transcript/T1 equality→checkpoint1/2/3; §5 native phase table→checkpoint1/3; §6 drift boundary→root ruling then checkpoint3; §7 partial effects/debt/cancellation→checkpoint2/3; §8 corrected observer/correctness/performance→checkpoint0/3/4/5; §9 source ownership→checkpoint0/4.

Self-review found no planned cross-owner edit or unnamed later interface. Root has accepted the exact phases/signatures/primitive caps after baseline and connected source-contract review, including the constant-space final-digest boundary and transient monotone X check. The SDD ledger freezes FG01–05 and source/runtime reservation. Promotion is not an implementation, performance or completion claim.
