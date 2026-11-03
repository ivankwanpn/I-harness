# Code Mode original output owner lifetime — revised spec and plan

Status: same-reviewer scoped design PASS; root approved bounded implementation on 2026-10-28. This combined spec/plan is binding; implement only the task slice released in a root brief.
Design source baseline: frozen MAIN/CURRENT `acf00fcfc71f674498515439fa06f3780db9a4ac`; later checkout HEAD changes are not adopted by this read-only candidate.
Preserved unchanged: `code-output-owner-lifetime-design-20261028.md` (original 164-line candidate).
Review addressed: `code-output-owner-lifetime-design-review-20261028.md`, Important 1–4.

## Evidence, ruling and exclusions

The new timing diagnostic has independent scoped PASS for its evidence; its runtime remains genuine cleanup FAIL.
Under the declared real delivery gates, original artifact uncertainty caused a real registry batch hold; normal nested-result subscription refresh closed the first source; the resumed original guest's later registration was refused before capture; actual retirement.complete preceded checkpoint abort; batch/document/coordinator close failed.
No second output/store/terminal/tool-result/ready exists in that frozen run. Earlier immediate-checkpoint-abort controls remain valid counterexamples.
Historical output.ts:353 flags, uncontrolled frequency, and historical causation remain unclaimed. Failed roots and CURRENT's uncommitted probe/evidence remain untouched.
Recommend one original source per actual cell admission, a non-retiring verified checkpoint, and a terminal-enqueue seal.
Retaining the source without releasing its resolved transient hold strands optional store; re-registering remains correctly fenced by optional authorization.
Mount-source/error-code fallback changes ownership; speculative sources, required CodeStore, counter clearing, foreign-hold release and guest/tool replay are rejected.
Required child-source ownership would need new parent/child authority, transitive lifetime, accepted-membership proof and identical hold-release rules; there is no demonstrated per-output independence requirement justifying it.

## Frozen public port and registered owner shapes

In `packages/core-session/src/managed/ports.ts`:
```ts
export type SettlementOwnerCut = Readonly<{
  revision: number; pending: number; recoveryPending: number; failed: boolean;
}>;
export type SettlementOwnerProgress =
  { kind: 'advanced' } | { kind: 'blocked'; reason: unknown };
export interface SettlementCheckpointOwner {
  readCut(): SettlementOwnerCut;
  settle(): Promise<SettlementOwnerProgress>;
  isCurrent(cut: SettlementOwnerCut): boolean;
}
// Added to SettlementFacts<Outcome>:
checkpoint(): Promise<{ kind: 'settled' } | { kind: 'progress' }>;
// Replaces only this ManagedAction method signature:
registerSettlementSource(
  drain: () => Promise<void>,
  reconcilePending?: () => Promise<void>,
  checkpointOwner?: SettlementCheckpointOwner,
): SettlementFacts<Outcome>;
```
The optional third argument is an original owner's registered continuation descriptor, not a supplied ready value or observer certificate.
All three functions are bound at original registration; no later checkpoint arguments can replace them or nominate another owner.
`readCut`/`isCurrent` are synchronous checks without I/O, mutation, producer calls or UI access. Cuts/results grant no capture/registration authority.
There is no new per-capture guard, binder, required-authorization field, child-source API or receipt eligibility surface.
Invalid captures remain tracked failed original obligations and quarantine that owner; no unguarded fallback is allowed.
Sources without this descriptor implement checkpoint as `assertHeld(); return Promise.reject(unsupported)` with `code:'FACT_OWNER_UNSUPPORTED'`.
`packages/core-agent/src/agent/settlement-source.ts` implements that explicit rejection using its existing `assertOpen`; never call parent.checkpoint or manufacture checkpoint authority through delegation.
Managed/memory source binding stays in the existing constructors; delegated binding is not original checkpoint ownership.

## Verified cut and source queue (Important 1)

Each original source owns active/close state, a short settlement-stage queue, capture revision C, hold epoch H, and its registered descriptor.
Increment C for every valid/invalid retained capture, special capture constructor, pending insertion/removal and terminal-disposition transition; no constructor may bypass the common tracker.
Increment H on every holdRecovery call, even when already held. Sticky requireRecovery/quarantine is distinct and never released by checkpoint.
The Code Mode output-owner revision R increments synchronously on output enrollment before any await/capture; prepare/capture/callback state changes; callback success/failure; owned-record settlement/removal; and terminal-enqueue seal.
Store enrollment is a separate optional-action obligation in the global queue, not an output-source obligation that must settle before releasing that output source's hold.
`pending` counts that source's unresolved output-owner records and callback failures, including prepare-only records; no native-capture inference is used.
`recoveryPending` counts original output obligations that actually acquired/renewed this source's transient hold: unknown preparation/artifact, fact disposition or local installation. Add the exact record before holdRecovery; remove only after its original disposition AND callbacks settle.
Later unattempted enrollment stays pending but does not invent a storage failure/hold reason. A new actual uncertainty adds its own record/renews H; invalid capture/callback failure sets failed/sticky permanently.
`isCurrent(cut)` requires exact R and all four cut fields still equal; failure is represented by the boolean independently of the raw reason.

Checkpoint installs its in-flight latch before running any registered function or observer; concurrent checkpoints coalesce only with that checkpoint, never with a close waiting on lifecycle.
For descriptor-enabled sources each verification pass snapshots `{ownerCut:readCut(), C, H,nativePendingSnapshot}` before its first await, then runs reconcilePending and owner.settle BEFORE any native auto-drain.
Owner settlement returns blocked for an ordinary unresolved queue prerequisite, retaining that exact reason; it throws only sticky callback/invalid-source failure. Neither result permits a native auto-drain to issue later candidates.
If the original cut/C/H changed, begin the next explicit pass without native auto-drain. A still-current empty owner cut may auto-drain its fixed original nativePendingSnapshot; new captures stay outside that snapshot.
With pending>0, no native auto-drain is permitted; the only possible success is the explicit hold-progress case below, requiring native pending already empty.
The final synchronous tail asserts actual lifetime, owner.isCurrent(ownerCut), unchanged C/H, failed=false and empty native pending. `{kind:'settled'}` additionally requires pending=0 and recoveryPending=0.
`{kind:'progress'}` requires pending>0, recoveryPending=0 and an ACTUAL still-held transient epoch H to release. It releases only this resolved source epoch while retaining later owner records/source identity; it grants no ready/terminal/optional certificate.
If no actual owned hold can be released, pending work returns FACT_RECOVERY_REQUIRED; never spin a no-op progress result. Sticky failure never releases a hold.
Progress during a pass, including expected preparation/capture/install, invalidates that pass. It is not silently acknowledged as the original cut.
Checkpoint permits at most two explicit verification passes: normal work settles in pass1 and a fresh unchanged empty cut verifies in pass2; further mutation returns FACT_RECOVERY_REQUIRED without releasing the hold.
Any sticky failure returns recovery immediately and retains original reason/captures; blocked work remains original-owned. No pass retries a failed callback or retention invocation.
Aggregate/cleanup construction uses explicit failure flags and raw error arrays, including thrown undefined/null/false/0/''; absence of a truthy reason never acknowledges settlement.
Late prepare-only enrollment, real capture, seal, or repeated hold during any awaited stage therefore invalidates the old cut even if native pending ends empty.
A later original checkpoint may settle/verify that same enrolled work. No pending clearing, source replacement, producer replay or global optional authorization is involved.
Release callback in `managed-document.ts` removes only recoveryHolds[source] and capacity.releaseOptional(source); sourceDrains, other holds, document pending, closing, sourceFault and quarantine remain authoritative.

Close coalesces behind its own synchronously installed latch, runs short pre-settlement stages, releases the stage queue, awaits lifecycle drain outside all source/global settlement lanes, then re-enters for final stable verification and inactive/unregister/release.
The verified checkpoint portion may release the source's resolved transient hold while close still waits for the seal; it cannot retire the source early.
Original enrolled captures/checkpoints remain usable during that wait. Failed close is retryable and retains source/owner state and raw errors.
Final close requires the owner seal, empty owned/native pending and an unchanged verified cut; a changed cut returns recovery, never successful retirement.
No close/checkpoint holds its stage lane while waiting on a producer, global drive, terminal receipt, itself, or another source close.
Default sources retain existing close behavior and pre-drain order; only descriptor-enabled source stages use owner-first settlement and fixed-snapshot native auto-drains.

## One global original-owner queue (Important 2)

`event-facts.ts` owns one append-only ordinal queue Q for original output, optional store, retention-reference and terminal records; each ordinal is assigned synchronously at enrollment.
Internal `PumpResult = {kind:'idle'} | {kind:'blocked'; reason:unknown} | {kind:'close-cell'; record:Pending; cell:CellFacts}`; these are private control results, not supplied settlement certificates.
The head is the earliest record whose original fact disposition AND all required local callbacks have not settled. Failures remain at their original ordinal.
Use one short owner-pump latch installed before any preparation/callback; reentrant requests append behind it, never start another pump.
The pump processes only a fixed prefix watermark of Q; later enrollment stays retained for a subsequent pass. It never awaits source checkpoint/close/global refresh or lifecycle joins.
Every direct cell reconcilePending/owner.settle/lifecycle settlement callback requests this SAME prefix pump. It may advance earlier original records; if the earlier boundary is unknown/failed it returns recovery before touching B.
Only Q's head may prepare, issue/reconcile a capture or install/cancel/settle its callbacks. Per-cell serialization alone is explicitly insufficient.
Terminal heads are barriers: the pump returns a `close-cell` instruction to the outer drive and yields its lane; callbacks encountering that barrier never await its source close.
`owner.settle` returns advanced when target output obligations empty; otherwise returns blocked with the actual earlier unresolved/barrier reason while retaining them. It never closes the barrier source itself.
Cell reconcilePending/owner.settle/lifecycle settlement return immediately if their target output obligations are empty; otherwise stop the prefix pump as soon as those obligations empty, BEFORE attempting a later optional store. This is essential to release the output hold that fenced an early store attempt.
For opted-in cell sources, reconcilePending is omitted; owner.settle owns all output preparation/reconciliation. Lifecycle drain awaits seal and calls the same owner pump; a still-blocked seal/prefix rejects honestly, outside any source stage lane.
Outer `refresh`/drive holds no owner-pump lane while awaiting head.source.checkpoint or terminal.cellSource.close; after success it re-enters the pump to continue the original prefix.
On progress it resumes Q's head without claiming source readiness: the released old hold can now permit an earlier same-capture optional store; then later output settles on the retained original source.
At a terminal barrier, close sees that its own outputs are already settled and its synchronous seal is set; after close fulfills, the outer drive captures/installs that terminal on the mount source.
Cell source lifecycle drain awaits only its seal outside the lane, then requests the same original prefix settlement; it never waits for terminal installation.
Root error-path ruling2026-10-28: successful lifecycle exit still requires that real seal. If the same retained cell becomes irreversibly failed while close is already waiting, its original sticky-failure signal must wake/reject that wait with the retained raw failure; it must not invent a seal/terminal/readiness or release the source/action/record. Register the original wait/failed-state observation without a missed wake and before callbacks can reenter. Ordinary unresolved/recovery-required work is not a sticky failure signal. Seal/failure races still pass through the final failed/cut verification; a later seal cannot clear sticky debt. This is a bounded failure exit outside all lanes, with no timeout polling, new public port or alternate owner.
Mount lifecycle drain runs eligible prerequisites, invokes existing drainProducers cancellation/join outside lanes, then drives newly enqueued original terminals. It does not await an unsealed cell close before initiating cancellation.
The existing mount source remains an ordinary unsupported-checkpoint source with its original close algorithm; its captures are now allocated only at Q head, so its native pre-drain cannot introduce a later candidate ahead of Q.
Concurrent actual document.close can enter every source, but none has a separate ordering authority. A later source returns recovery while an earlier unknown/install failure owns Q's head.

All product native output/reference/terminal capture allocation and first issue occur only at Q head, after prior preparation/fact/install boundaries; store's optional handle may be captured early, but its first attempt also uses Q.
For opted-in sources, EVERY checkpoint/close native auto-drain follows successful unchanged-empty registered owner settlement; none runs first or after owner recovery.
Concrete pre-captured/not-issued B control: B is retained in original Q behind unknown A. B's owner callback returns recovery before native auto-drain, so B's existing handle remains unissued without a binder.
Late captures after that callback cannot enter its frozen auto-drain snapshot; enrollment/capture revisions invalidate the cut and require a new original owner pass.
The monotonic queue cannot insert a new candidate ahead of an already-issued head: a real unknown receipt retains its original head ordinal until reconciled/installed.
Already-issued unknown receipts therefore reconcile on their exact original handles/keys even when later candidate membership changes; they are never converted to not-issued or blocked by a new-candidate certificate.
Native records may observe cached committed handles after owner settlement; passive observe still never allocates or issues. Existing non-checkpoint source behavior is unchanged.
CaptureReference freezes/enrolls its original DTO first; captures lazily at Q head and its returned continuation requests the same original drive rather than directly bypassing Q.
Required cross-cell cycle control: Q=[B.output0(recovered holder), A.store(not-issued under B hold), B.output1(enrolled)]. B's fresh stable progress cut proves only its actual hold-causing output0 settled, releases that old H without claiming output1 ready; A's same capture commits, then output1 settles. A new output1 uncertainty renews H and prevents stale release.

## Original cell and callback state (Important 4)

Map actual cellId to `{action,source,outputs,recoveryRecords:Set<Pending>,R,seal,terminal,failed}`; never derive authority from the string without its original retained entry. readCut uses this exact source-bound entry and its actual sets, not event counts or a reconstructed owner.
Admission order: beginAction(signal) → register one actual cell source and descriptor → retain map entry → issue original started fact; no first-await enrollment gap.
Failed admission enqueues/seals its own truthful interrupted terminal. Restart interruption with no actual cell entry stays on mount source and creates no fictitious source.
requiredPrepared checks unsealed membership, enrolls exact original record/increments R before await, then requests drive; it never registers a replacement source.
The cell descriptor's output pending excludes optional store; all direct settlement references Q. Settled cannot succeed with prepare-only output; progress retains it pending and requires actual hold-causing obligations resolved. Failed callbacks permit neither result.
Terminal DTO is frozen/enrolled and seals/increments R synchronously. Already enrolled output may finish after seal; new output enrollment is refused.
Finish action/delete map entry only after terminal fact and EVERY terminal callback succeed. A failed callback leaves the actual terminal/entry owned and sticky.

`output-facts.ts` MUST change: create/decorate the retained invocation promise and set invoked=true BEFORE evaluating retainText.
Resolve/reject that same promise from the one original call, catching synchronous throws without truthiness checks; synchronous reentry sees invoked=true and the same retained promise.
A rejected promise or synchronous throw remains the same retained failure; preparation never calls retainText again. Only its explicitly registered original resume handle may revisit a retryable recovery-required disposition.
Retain exact original operation/ref/bytes/capture; an ordinary original rejection is not relabelled as a resumable success.
Each onCommit/onCancelled/onSettled has `{state:'unstarted'|'running'|'succeeded'|'failed',reason:unknown}`; transition to running BEFORE invocation.
Failure sets state=failed and stores the exact raw reason, calls sticky owner recovery, and leaves its original Q record pending. No truthiness-based failure detection.
Successful callback transitions once; running reentry cannot invoke it again or delete the record. Remove only after fact/cancellation plus all applicable callbacks succeed.
In particular, cancellation never deletes a store record before onCancelled; failure retains that once-owned cancellation obligation and blocks clean close.
No callback retry, counter reset or false observer.ready can substitute for original installation/cancellation.

## Normal store, Stop, memory and compatibility (Important 3)

Original store stays action.captureCodeStore, enrolled in Q with its same original handle before first attempt.
Output committed callback may resume completion and capture/attempt store before output checkpoint releases its own hold: retain actual not-issued, then checkpoint release schedules original drive to reconcile THAT SAME capture to commit without Stop.
Do not add an extra store cancellation, new group/key, mandatory authority or delayed artificial first attempt to evade this race.
Independent batch hold still fences that capture; original Stop cancels the same never-issued capture once with no store key/receipt/install. Preserve issued-unknown/absent Stop behavior and already-committed stores.
Memory uses the identical Q/cut/owner-first native-snapshot/callback semantics with memory-committed disposition, no durable receipt claim.
Memory recovery state `{holds:Set<object>, sticky:boolean}` is session-shared in nondurable.ts and consulted by every optional begin/assert/admit/dispatch/received-input path; a second owner for the same Session cannot evade sticky failure.
Track every valid/invalid/special memory capture. requireRecovery sets shared sticky; checkpoint releases only its own transient hold, never shared sticky.
For the same optional CodeStore handle, guard/hold refusal occurs before memoizing an issued memory operation and returns not-issued; later reconcile may install once after release, or cancel once after original Stop. Cached installed outcomes cannot be lost/replayed.
Runtime output/retirement counters and original callbacks retain authority; actual module completion ends worker lifetime. Registry/batch alone take/finalize retained results and release their hold; no live-continuation guard changes.
Queries, UI certificates, surface-state reads and capture.observe remain passive; subscriptions may request only the registered original drive, never confer source authority.

Audit registration adapters with `git grep registerSettlementSource`: preserve receiver, all three arguments, exact returned source and original callback identity.
Required explicit forwarding edits include session-executor tests ingress-generation-close, input-promotion-generation, team-construction-cleanup; core-agent retained-batch-continuation/unstarted-call-settlement/agent-invocation/context-effect-freshness wrappers and agent-team lifecycle wrappers where they wrap ManagedAction registration.
Narrow one-argument registerFactSource APIs that intentionally create ordinary sources stay ordinary unsupported-checkpoint sources; never forward parent checkpoint.
Direct event-facts test producers must truthfully enqueue original cancellation/terminal/seal, including admitted/no-output cells; no-op drainProducers cannot leave a live cell and await facts.close forever.

## Bounded implementation tasks (root releases one reviewed slice at a time)

1. **Core cut, owner-first drain, parity and delegated unsupported port.**
   Modify core-session `managed/{ports,memory-source,memory-capture,nondurable}.ts`; persistence `coordinator/{settlement-source,source-facts,managed-document}.ts`; core-agent `agent/settlement-source.ts`; export new port types through existing exports. Existing native settlement-fact issuance/reconciliation semantics remain unchanged.
   Add persistence `test/settlement-source-checkpoint.test.ts`, core-session `test/memory-source-checkpoint.test.ts`; extend core-agent `test/memory-source-delegation.test.ts` and relevant recovery-settlement controls.
   RED/GREEN: original same-source use after checkpoint; foreign hold intact; sticky shared-session refusal; unsupported delegation calls parent checkpoint zero times; exact native receipt/key vs memory disposition; invalid/special captures tracked.
   Gate every awaited stage: late prepare-only enrollment after owner settle/before native post-drain; real capture; repeated hold while already held; seal. Old pass must invalidate; only an explicit fresh stable pass may return settled or proof-bounded progress/release. Neither can report readiness for late pending work.
   Close waiting on seal must permit later checkpoint progress; callbacks can reenter only after latches exist. Unresolved/falsey failures retain ownership and reject honestly.

2. **Global queue, cell source, terminal barrier, original retention/callback latches.**
   Modify code-mode `src/{event-facts,output-facts}.ts`; update `test/output-source-recovery.test.ts`; add `test/cell-output-owner-lifetime.test.ts`; migrate direct facts producers to truthful terminal/seal cleanup, preserving old packet evidence.
   Convert the old closed-first refusal expectation into the retained-original-owner regression after its RED characterization; keep open-backlog and original store-Stop guarantees. Preserve frozen characterization source/evidence as history rather than claiming unchanged expectations pass repaired behavior.
   Named cross-cell RED/GREEN: A prepare unknown → B enrolled → actual concurrent document.close; B has zero capture/receipt/install. Repeat A installation failure and B pre-captured/not-issued; B native drain must defer on original Q eligibility.
   Named no-output close and failed-admission/interrupted controls; terminal waits behind earlier original work, sealed source close never awaits its own terminal receipt, mount cancellation can provide seal.
   Add native/memory late-sticky-failure control: original source.close has genuinely entered its unsealed lifecycle wait, then original preparation/installation/callback sets irreversible failure. The existing close rejects rather than hanging, exact failed record/source/action remain, no synthetic terminal or action.finish occurs, and transient recovery/real-seal/Stop positives remain unchanged.
   Named retention invocation controls: side effect then synchronous throw, rejected original promise, exact throws undefined/null/false/0/''; retainText invoked once under reconciliation and synchronous reentry.
   Parameterize onCommit/onCancelled/onSettled same falsey throws/reentry; counts at most one, failed record persists, source/mount cleanup rejects after failure without deleting obligation.
   Named positive native/memory store race: original output callback triggers original store admission while own hold is still held; assert first not-issued, same capture later commits after checkpoint release, completed terminal, no Stop and no extra store capture.
   Named cross-cell hold-progress test uses the exact B.output0/A.store/B.output1 cycle above in native/memory: old epoch releases only after its original obligations settle; new output1 hold survives; progress retains source/pending and never makes an observer ready.
   Independent outer hold plus original Stop negative: same never-issued capture cancels once, zero issuance/key/receipt/install. Preserve managed-store-stop issued-unknown/absent controls and original committed-store behavior.

3. **Adapters, direct-producer migration and scoped typechecks.**
   Modify exact forwarding wrappers listed above; inspect all grep matches for dropped args, source replacement or unsupported full SettlementFacts constructors; forward tuples with original receiver, not reconstructed source objects.
   Adapter RED/GREEN passes a sentinel descriptor through each changed ManagedAction wrapper and observes exact identity at original registration; unsupported delegated source rejects after actual lifetime assertion.
   Direct producer tests supply their original terminal/cancel behavior before joining close; admitted/no-output test must terminate truthfully within unchanged deadline.
   Run affected core-session, session-persistence, code-mode, core-agent and session-executor typechecks; agent-team typecheck only if its wrappers require edits. No broad unrelated suite.

4. **New actual mounted regression and preserved counterexample.**
   Add session-executor `test/code-output-owner-lifetime.test.ts` from the reviewed timing spec/report after fixture approval; fresh roots only, never edit/reopen the frozen failed diagnostic/root.
   RED frozen base: same genuine gates reach later registration refusal and real close failure. GREEN same original guest/nested body once: later output is captured/installed on original cell source with exact literal bytes/ref/digest and native append receipts.
   Keep actual batch hold and deliver same original registry rejection; actual checkpoint abort/Stop may cancel original never-issued store. Require truthful terminal/tool-result, observer.ready once, worker terminate/join and successful original batch/document/coordinator joins.
   Preserve immediate-rejection counterexample: actual checkpoint abort still prevents later guest output/store; first output recovers and terminated result/joins close. Its zero store capture cannot certify captured-store cancellation.
   Preserve original prepared/action/source/capture/worker identities, original batch-only retained take, once callbacks, zero passive observation failures/overflow and primary/cleanup falsey failure precedence; cleanup rejection fails after evidence save.

5. **Review and integration gate.**
   After each minimal RED/GREEN, run named affected recovery/store/retained-batch controls and checks justified above; no historical diagnostic rerun.
   Use existing direct first-resolved Node/Vitest/TypeScript, package CWD, six fresh distinct required IH roots per invocation, unchanged deadline, no file parallelism/maxWorkers2/minWorkers1; retain exact source hashes/commands/outcomes.
   No install/relink/network, benchmark, protected paths, failed-root repair, broad fixture or product release claim is authorized. Local coherent verified commits are permitted for root-assigned slices; no remote publication.
   Design closures 1–4 and the progress branch have scoped review PASS. Actual owner-first ordering, native/memory normal-store races, unsupported delegation and the new mounted regression still require implementation evidence and code review before acceptance.
