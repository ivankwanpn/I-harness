# ContextEngine R4B/C — semantic seeds and durable delivery

2026-10-16. Future decisions only; pinned source `292362992f304e6bf7811f22df29608999c59539`. Detailed source inventory and independent oracles are `.tmp/context-redesign-20261015/r4-seed-delivery-preflight.md`, including its narrow in-flight fork addendum. This follows the [framework](../superpowers/specs/2026-10-15-context-engine-framework.md), [F2 reader plan](../superpowers/plans/2026-10-16-context-engine-r3-replacement-readers.md) and [R4A retention decisions](2026-10-16-context-engine-r4-retention-preflight.md). No current F1 work, completion count, product version or release scope changes.

## Separate deliveries, preserve existing safeguards

Ruling: **B semantic export/import** and **C delivery/epoch/restore** are separate reviewable gates after their actual prerequisites. B keeps the existing role/model/tool/instruction and permission-floor behavior; C keeps TaskRegistry, recipient Inbox/executor and their existing serialized work chains. Neither adds another scheduler, generic event bus, raw-history store or capacity policy.

The raw seed compiler already removes context calibration/recovery facts, converts accepted-v2 to structural-v1 and marks inherited provenance as observation. Preserve these as prior correct behavior. F1 supplies real seed/input receipts; F2 supplies safe dependency-complete raw seed/history validation. Those raw seeds deliberately retain consumed proof bodies, so they are not yet the bounded semantic export required for a100MiB parent archive.

## B: one semantic compiler for actual fork consumers

Connect subagent none/all/N, team fresh/fork, persistence completed-prefix forks, SDK/Gateway and cold import to one explicit versioned semantic seed representation. It carries the effective ordered conversation/checkpoint/typed tail, lineage/provenance, grouping and exact R4A artifact dependencies. It does not copy consumed100MiB raw bodies or discard F2 proof records from an otherwise unchanged raw replacement record. Core-session keeps one projector/history semantics; persistence keeps the sole target-coordinate compiler. Raw structural export remains a distinct, honestly larger operation.

Preserve default none and requested N/completed-boundary meaning. None removes parent conversation inheritance, not current required host instructions. Import never creates local human authority, approval, parent action allowance, calibration or a live receipt. Child header seedLength counts actual committed child archive events. Source validity, required artifact grants/pins and seed/input receipts precede child execution. After-create unknown storage/grant disposition leaves an explicit unpublished/blocked child, not an automatically repeated spawn or destructive cleanup.

The target prepares its own complete first request with current role/host instructions, task, schema, media and raw options. Revalidate source/instruction/dependency changes across resolver/grant awaits. Matching labels do not establish native account/route/ownership compatibility; legitimate portable source may downgrade explicitly, while incompatible opaque-only data cannot be invented into a summary. Pure source export/fork inspection does not resolve credentials or call models.

### In-flight parent work is observation, not a child execution obligation

The actual all fork can encounter its own accepted spawn call while that call is dispatched and has no result. Existing source analysis does **not** prove an unmatched call is sent: legacy projection suppresses the whole incomplete step, retaining an audit/unknown exchange with no rendered messages. Existing accepted/no-result seed tests cover coordinate remapping, but do not fully qualify actual spawn/all first preparation. Standalone lineage also needs a direct control because its old header omits parentSession.

Ruling: the semantic seed excludes the **whole** parent in-flight/effect-unknown unit from child wire replay, including all parallel siblings in that unit. Preserve its actual parent-work observation/source refs and unknown state separately from executable/accepted child exchanges. Retain the current input and new delegated task. Do not await the spawn call's own result, split an unsafe unit, synthesize a successful result, or create an invented summary. The omission/disposition is explicit seed metadata; unknown parent work does not become child permission or silently completed history. Compatible completed units retain their real native/media grouping.

Required B control: drive the actual managed and standalone spawn_agent/all path from an accepted, dispatched parent call with no result, including parallel siblings. Inspect the child's actual first prepared request, preserved parent-work observations, inherited instructions and target admission; assert zero parent-call replay and no fabricated result. Also exercise N/completed boundaries, source changes during waits and a100MiB consumed source whose semantic seed size depends on its effective items/dependencies, not the consumed body.

## C: one source journal, stable recipient keys

At the pin, outbox messageId is lost at ParentInputAdmission. Service hashes rendered text for dedupe, CLI creates a fresh input and starts execution inside admit, and the source records woken before invoking a void wake callback. Child followup advances lastInboxSeq before agent.followup; one team-child path lacks messageId dedupe. These are different boundaries and require connected source/receiver changes.

Ruling: new managed task/outbox transitions use the **existing managed parent journal as the durable source of truth**, with TaskRegistry remaining the domain transition owner and its maps/state snapshots becoming derived views. This reuses F1's qualified issuance/receipt/reconciliation boundary rather than qualifying a second independent writable task document. No source transition becomes durable merely by updating a Map and scheduling save. Existing task-doc v1 is validated legacy evidence during migration, never silently treated as an empty registry after corruption. Truly fresh state is distinguished from a missing expected source using parent history/lineage; missing/corrupt known state cannot reset counters and replay work.

Use one stable logical key `(parentSessionId, qualifiedTaskId, resultRevision, deliveryKind)`. qualifiedTaskId includes its actual registry/delegation namespace so local counters cannot collide across restored sources. Keep the key independent of rendered text, target epoch and notification attempt. Trusted call/source origin travels outside model/tool args and must match the actual document/caller; a handler bound to a different session cannot borrow root authority. Preserve existing source-call submit adoption and initial-task versus explicit-followup notification behavior; adding revision support does not invent automatic notifications for every followup.

Recipient admission returns its actual input ID and durable receipt/disposition: admitted, already-admitted/claimed, deferred, incompatible or unavailable/conflict. Source acknowledgement may lag and be repaired by key lookup. Two valid revisions with identical text are two different keys; rerendering the same revision is the same key. Contradictory content under one immutable key is conflict, not adoption based on text equality.

## Five distinct facts and epoch handling

Keep these separate in code and observations:

1. A committed source/result descriptor is available to read.
2. The exact R4A result revision/outcome/ref is durable and authorized for retrieval.
3. The recipient journal admitted that logical delivery and input.
4. A wake hint was requested/scheduled under current owner/Stop/branch/epoch.
5. The recipient atomically claimed the same key/input into a turn/step/message.

Only the recipient's committed claim proves consumption. Model completion is not required to establish claim, and a later failed model request cannot license duplicate delivery. Source outbox observations are not another claim authority. Wake signals are at least once, may be repeated and are not proof of consumption; durable eligible unclaimed receiver state supplies recoverable wake intent. A void callback timestamp cannot strand that state across a crash.

Store spawning branch/delegation, result revision, intended target epoch and disposition. Stop revokes wake/new transport under the old fence while results still settle. Rewind preserves retrieval but may defer/incompatibly classify promotion. A summary rewrite can compatibly rebase a preserved pending suffix only after exact source/ID/protection checks and complete target reassessment. Diagnostic/usage/budget observations do not create another epoch/key/claim. Already-consumed deliveries never become unclaimed because text was hidden by rewind or compaction.

An unconsumed deferred delivery can be adopted only through an explicit audited authorization transition for the **same key**. A generic new human input alone must not replay suppressed results. The executable C plan must connect this transition to a real existing application/command consumer and define how a deferred receiver input is held/reactivated without cancel-and-new-ID duplication; an unused resolve API is not a deliverable. Quiet child/team messages remain quiet until their authorized drive path. lastInboxSeq and process-local notification/controller Maps become derived scheduling caches, never the sole proof that input was consumed.

## Restore and cross-document failure

Source result/outbox and recipient input are separate document commits, not a distributed transaction. Every crash cut reconciles the same stable key: after recipient admission/before source ack, adopt the existing input; after claim/before ack, return already-claimed; after wake-intent/before signal, resend only a currently authorized hint. Unknown source or receiver storage uses its own existing reconcile and cannot trigger another append, task spawn or effect.

Current restore can load a child log that repair closes, then infer completion from turn/end plus the last assistant text. C must use explicit accepted/settled expected-action evidence and the R4A result disposition. Repair closers and failed/unaccepted fragments do not prove task completion. A valid turn belonging to another input/action cannot settle this task. A retained completed result can be retrieved/delivered without a resident Agent; merely finding an archive is not equivalent evidence.

Version the new task/delivery/semantic-seed execution semantics with real incompatible-reader refusal at the actual predecessor versions. Legacy records without epoch/revision/typed-key/claim evidence may remain readable and be explicitly reconciled/deferred; never backfill complete certificates. Imported/forked data cannot inherit source operational claims, spend or permission authority.

Required C oracles include distinct revisionsr1/r2 with text `done`, same-key rerenders, source/recipient crash cuts, Stop before/after admission, rewind before/after claim, summary with concurrent child suffixes, quiet team delivery, missing/corrupt source and cold child inbox cursor races. The literal interrupted source `[semantics0,turn/start1,step/start2,partial assistant3]` remains recovery-required after repair adds closers4/5. A closed orphan-result audit source never certifies completion. Each test independently counts durable admission/claim and actual child/tool execution; physical wake count may exceed1.

B/C are not implemented by this document. R4A retention, F1 receipts, F2 raw readers and F4 attempt grants retain their separate qualification boundaries. Whole event-driven migration and R6 packaged/cold-memory/release evidence remain separate unfinished work.
