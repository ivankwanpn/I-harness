> Current execution boundary2026-10-28: the reviewed operation-owner contract separates S0a (existing READY managed-parent observation/confirmation) from S0b (retained issued-write acknowledgment). Only S0a prerequisites are being implemented. The [private original-claim prerequisite](../../research/2026-10-28-task-document-claim-acceptance.md) is integrated; raw backend/lifetime and S0b are not yet accepted. Creation-before-header ownership, S1 and CURRENT14 remain later stages. The historical design below describes the target, not current product support.

> Root promotion2026-10-28: same-reviewer child-binding-format-rereview-20261028.md closes four design findings. Exact original plan SHA256F87649BD1B0B1C6F26F3A864C2524609D28DA44C495360A91BC8F74DF75C61A8; addendum SHA256ED05E599B8FF726366938DCB51AEAE24DE51008878C65ACD84CB2D03437D758D. Root releases only S0 observation/acknowledgment under task-document-s0-brief-20261028.md. CURRENT remains13, task-v3/fresh launch and Session14 activation are disabled. S1 requires complete raw scope/history witness validation; parseHeader/preflight alone cannot certify seed boundary or complete history. The later addendum supersedes original durability/history ambiguities. No deployed Windows/power-loss qualification or release is claimed. Original reviewed design text follows.

# Session14 and original task binding — bounded implementation plan

2026-10-28. **Design only; root and fresh Sol review before any writer.** Root selected normal one-way CURRENT Session14 advancement and a supported-managed-entry/retired-owner boundary. This report specifies that direction, not implementation authority. Fresh launch stays disabled; product version remains0.1.13-rc.1; no release. Read-only source: MAIN `283e96da3cf7311bde3eaad80f9e1b960eb89a58`; HOST `3714bf339ad9e51eedfbed837648017109954e82` only for existing V3 birth validation/header compatibility. No runtime/test/probe/network/dependency/Git/product mutation or protected-directory access occurred. Only this report was written.

Prerequisites retained: `child-binding-boundary-design-20261028.md`; original `child-initial-receipt-design-20261028.md` plus Addendum A. Their warm launch/receipt/currentness contracts are not repeated or implemented here.

## 1. Current decision and invariant

**Use the original task document as the only original-binding/prompt store. Before publishing any durable Session14 header, acknowledge an existing valid task document or initialize and acknowledge an empty task-v2 document at the original `task-${sessionId}` key. Only afterward may the original task owner acknowledge task-v3 containing a child binding. Only after that acknowledgment may a later slice reserve a private child.** No new key, registry, prompt copy, journal event, sentinel or header field is required.

The existing Session format field becomes a compatibility contract, not merely a decoder choice: a14 header promises successful prior task-document initialization. This ordering is the minimal durable distinction between an uninitialized old session and a transitioned session whose task file has been lost. It is not a cross-file transaction: intermediate states are deliberately recoverable or fail closed. Never publish14 first and rely on a process-local flag to initialize the task file later.

All durable Session14 creation and upgrade paths must participate, including ordinary create, managed load, explicit ensureWritableFormat, mutation-triggered upgrade, and new/bootstrap READY paths. Initializing only when `registerSubagent` runs is too late: its parent already passed `openManagedDocument` and writable upgrade. Nondurable memory Sessions have no task-storage invariant; raw low-level backend creation is not supported managed creation authority.

| Parent/storage version | Task document | New supported behavior | Genuine old MAIN283e behavior |
|---|---|---|---|
| <=13 | valid v1/v2 | Preserve contents, confirm storage, then upgrade parent | Existing old operation remains supported before transition |
| <=13 | confirmed absent | Initialize empty v2 under transition owner, acknowledge, then upgrade; legacy ambiguity below applies | Existing old missing-document behavior |
| <=13 | v3 | Refuse inconsistent ordered store; no automatic header repair | Old task parser refusal is insufficient protection |
| 14 | valid v1/v2 | Already initialized; retain literal version on read, no invented binding | Old managed assembly refuses parent before task registration |
| 14 | valid v3 | Strict restore; exact saved binding only, no launch authority | Same preceding parent refusal |
| 14 | absent/unavailable/malformed | Refuse writable open/task allocation; never recreate empty | Parent refusal still applies on genuine entry |
| future | any | Refuse; no task initialization/overwrite | Refuse |

**Legacy limitation:** confirmed absence under <=13 cannot distinguish “never had a task file” from “an old task file was externally lost.” Old formats contain no durable initialization fact, and accepted task save can precede `subagent/start`. An empty parent history therefore cannot prove no task ever existed. This plan preserves old-format absent-document initialization as a declared compatibility policy, not as successful historic task recovery. Known parent subagent/delivery facts with missing task storage must instead surface recovery-required; their presence proves inconsistency, while absence proves nothing. Root must accept this narrow legacy policy or require recovery/user intervention for *every* legacy missing task file. No algorithm using unchanged old bytes can provide a stronger distinction. No new child binding is permitted under <=13, so this ambiguity cannot erase a legitimately created new binding within the ordered protocol.

## 2. Original owners and proposed internal contracts

These APIs are proposals with fixed ownership; names may change together. No DTO is execution authority.

| Module/owner | Required responsibility |
|---|---|
| `subagent/src/task/validation.ts`, new adjacent `storage-contract.ts` | Export one pure task-storage contract: canonical empty v2 data, existing v1/v2/v3 validation, and original key mapping. Reuse publication/result validators. No registry construction, recovery sweep, role resolution, side effects or second persisted state. |
| `session-persistence/src/coordinator/types.ts`, `index.ts` | Accept that pure original task contract as a coordinator capability from the composition host. Persistence must not import subagent and create a package cycle. A durable14 create/upgrade without the capability refuses before mutation; read-only old snapshots can remain supported. |
| `coordinator/documents.ts`, adjacent `task-document-transition.ts` | Single internal transition operation under genuine held session ownership plus original document-key lease. Typed observed read, validate/confirm or initialize, exact acknowledgment. Maintain process-local operation/error/debt, not a new registry. Internal unlocked entry avoids recursively acquiring the already held session operation or reentering public observations. |
| `session-persistence-jsonl/src/index.ts` | Reuse `readDocumentObserved`, which checks root availability, only classifies ENOENT as absent, and propagates parse/non-ENOENT errors. Strengthen the existing document writer's acknowledgment with file sync/rename and qualified directory durability. Add exact existing-document confirmation through the same owner: byte/content equality plus sync under lease, no rewritten legacy snapshot merely to confirm. |
| `coordinator/writable-format.ts`, `load.ts`, `mutations.ts`, `bootstrap.ts` | Call transition before every header14 publication/upgrade, using the same genuine ownership/retirement scope. On existing14 verify the document rather than initialize. Never call public coordinator APIs recursively from an already admitted bootstrap operation. |
| `subagent/src/task/{registry,persistence,records,types}.ts` | Immutable original row/binding capture, exact strict save acknowledgment, version3 restore, and poisoned/unavailable load state. General current task writes require the connected parent owner's lifetime; generic direct writes do not silently mint this authority. |
| `subagent/src/index.ts` | Existing14 restore uses the strict observed/validated owner, not caught `getDocument`. Do not mount a usable task writer on rejected/missing load. Preserve legacy result/notification recovery rules and their provenance. |
| `desktop-gateway/src/host.ts:127` and other actual construction hosts | Supply the original pure task contract at coordinator construction. The scoped MAIN package-source search found this concrete construction site; external/apps hosts must be inventoried before integration rather than assumed configured. |

The capability is configuration dependency injection, not a user-controlled namespace or backend authorization token. It cannot choose an alternate key or arbitrary initial payload. Keep task schema in its existing package; do not copy its row validators into persistence or turn TaskRegistry into a persistence dependency. Missing capability must not quietly use an empty object/default JSON to keep CURRENT14 working.

**Acknowledgment is stronger than today's strict promise.** MAIN JSONL `index.ts:315–328` writes+renames without fsync; Documents strict propagates a specific promise but cannot manufacture durability. Strengthen the one writer rather than add a second physical task writer. Capture exact serialized snapshot before queuing; write complete bytes, sync file, close, rename, then confirm directory persistence under the qualified platform policy. If the supported platform cannot establish the promised boundary, return unsupported/unknown and stop this path. Do not silently adopt the existing best-effort Windows directory-sync catch as a stronger crash guarantee than qualification supports.

Existing-present task bytes must also be confirmed before14 publication: a successful read alone does not acknowledge an old unsynced write. A new internal backend confirmation method should reopen the same file under the document lease, compare expected raw bytes, sync and return committed/unknown/conflict with retained cleanup diagnostics. This is original Documents durability evidence, not a new durable receipt file. For an uncertain original write, same-owner reconciliation uses the retained exact bytes; a different snapshot cannot acknowledge it. Cold recovery with14+valid document can confirm current bytes and restore data, but cannot infer the original launch never ran.

## 3. Initialization and crash recovery protocol

Lock order is original parent session ownership first, then `doc:task-${id}`. Hold the document lease across read/confirmation/initialization and header publication; otherwise a cooperating current writer can invalidate the initialization assertion in the gap. Current task writers must hold the parent lifetime and use the same order. Transition never waits for task producers while holding their document lease: retire/join old producers first, then acquire transition locks. Unknown cleanup retains original handles and blocks onward work.

**Genuine new parent:** obtain the existing creation ownership claim, validate actual session absence/creation admission, and observe the original task key. If absent, create canonical empty v2 and acknowledge it before `backend.create` publishes14. If present, refuse collision; do not adopt an orphan on empty-data equality. An original warm retry may reconcile its retained exact initialization operation and retry exclusive create. A cold orphan task file with no parent is retained for diagnosis, not auto-deleted/adopted; a new separately requested session may receive a different ID, but it is not recovery of the old operation. Backend root creation must precede observed reads for this genuine creation path; an unavailable existing root never becomes “absent.” Parent create acknowledgment itself must be qualified, including sync, before exposing success/task-v3.

**Legacy existing parent:** under ownership, preflight the persisted parent version/history first. Observe task storage strictly. For valid v1/v2 confirm existing bytes without version migration. For confirmed absence apply the expressly bounded legacy policy above, initialize empty v2 and acknowledge. Then the existing original format owner upgrades to14. A failed upgrade leaves a legitimate old-format task document and no new binding; retry rereads/validates under the same rules. No task-v3 write is permitted before14 is durably established.

**Cold14 parent:** read and validate task storage during writable acquisition before exposing a managed document/task registry. Absent, unavailable or malformed is recovery-required. This includes a task file disappearing after a process crash: never silently regenerate it because the parent happens to have no visible start fact. Literal v1/v2 is a valid initialized document; no binding is invented. A genuine first-run parent already has empty v2 because creation ran the protocol, so it is not incorrectly refused.

| Cut/failure state | Allowed recovery / prohibited inference |
|---|---|
| Task init not issued; parent old/absent | Original owner may retry observed absence; no reservation |
| Init temp/rename uncertain; parent old/absent | Keep exact bytes/handles; reconcile same write; no header14 until confirmed |
| Empty v2 committed, parent absent | Warm original creation retry; cold orphan retained/refused, no guessed adoption |
| Empty/existing v1/v2 confirmed, parent still<=13 | Reopen transition; old build may still operate under normal ownership; no binding exists |
| Header upgrade uncertain | Reconcile/read actual header under original owner;14 requires task presence; never “roll back” to13 |
| Header14 committed, task v1/v2 | Normal new restore; original new task may bind; old managed assembly refuses |
| Binding write uncertain | Retain exact snapshot; inspect/confirm before child reservation; later flush is insufficient |
| Binding acknowledged, no child reservation | Exact saved data available; cold does not launch |
| Task file later missing while parent14 | Recovery-required; preserve parent/stages; no new task ID/empty registry |
| Parent header externally downgraded beside task-v3 | Refuse inconsistent store; no automatic repair or downgrade claim |

No multi-file rollback is promised. Orphan temp/task files and failed cleanup handles are evidence/debt, not garbage to delete automatically. Durable deletion remains the original explicit deletion owner, which already inventories the original task key. The protocol guarantees ordering for supported writes, not arbitrary filesystem deletion, partial backups or privileged downgrade.

## 4. Historical13 birth remains historical13

Physical current Session format, original stage header format and semantic seed codec version are separate axes. Session14 must not rewrite a seed-v3 manifest or renumber its pages/groups. HOST3714 `core-session/src/conversation/bootstrap-validation.ts:27–110` validates V3 profile/resultPageCount and record prefixes at physical13; those exact historical cases remain valid. Its `coordinator/bootstrap-header.ts` still explicitly accepts seed-header v1/v2 at the outer parser in the inspected pin. Do not claim this alone supplies approved V3 outer integration: compose with root's separately approved selected-results owner and its exact frozen contracts before integration.

For every completed13 birth, retain the original stage bytes/headerBase/headerBytes, invocation, capture reservation, request/manifest digests, semanticSeed data, seed/completion/initial frame bytes and batch keys. Upgrade only the live session header's physical format through the existing upgrade owner after confirming original frames. Manifest recomputation always uses original stage.headerBase, never the upgraded header. Full-stage incomplete13 births must finish their exact original13 frames through the historical owner before any live header upgrade; reservation-only remains its original refusal/payload contract. Do not materialize a fresh14 stage on retry of an existing13 stage.

Before upgrading any historical completed child to14, apply the same original task-document initialization protocol to that child session's own task key. This document describes tasks *owned by that child*, not the parent task binding. It is an existing recognized key, not a second binding copy. A new14 bootstrap target must initialize its own task document before first14 header issue, after actual target admission. Historical stages remain unchanged. An operation with only a13 reservation/full stage and no completed current target is reconciled by its original birth owner, not generic task initialization guessing that the session is absent.

## 5. Closed source inventory and exact changes

Paths below are relative to `packages/`; inspected MAIN unless HOST explicitly noted. This is the bounded package-source inventory, not certification of all external consumers.

| Existing source | Required14 treatment |
|---|---|
| `core-session/src/events/types.ts:262`; `session-persistence/src/format/{registry,validation}.ts` | CURRENT14; explicit13→14 semantic identity migration; future refusal remains before repair. No event payload migration or product-version change. |
| `core-session/src/serialization/jsonl.ts:14,46–47` | Add14 to framed serialization/parsing/metadata checks. Retain exact13 decoding and body bytes. |
| `core-session/src/conversation/bootstrap-validation.ts:64` (HOST:72); `managed/memory-bootstrap.ts:17` | Permit physical14 while retaining11–13. Memory install support does not require disk task storage. Preserve V3 profile/results/page checks from approved owner. |
| `core-session/src/conversation/delivery.ts:88,99`; `events/conversation.ts:57` | Existing >=13 floor already admits14; retain floor13 and old event validation, not bump to14. |
| `session-persistence-jsonl/src/format.ts:82`; `index.ts:140,180–181,203,257,284` | Add14 to framed header validation, append/read/repair/replace/blank profile. Header parser alone is not authority. |
| `session-persistence-jsonl/src/index.ts:118,130,202,244,269`; `backend/format-upgrade.ts:29,33,45` | Current/future gates follow14; **recognize13 as framed predecessor**, preserve its journal boundaries rather than count frame lines as legacy events. Existing semantic births at13 require preservation before header-only copy. |
| `backend/bootstrap-stage.ts:31`; `backend/fact-journal.ts:20` | Explicit allowed historical11/12/13→current14 header relation; equal original format remains valid. Never arbitrary future/downgrade acceptance or altered birth metadata. |
| `backend/fact-journal.ts:57–69,122` | Historical13 exact original phase issue/reconciliation for incomplete births;14 ordinary owned batches; prefix reader framed14. Do not widen historical lane to arbitrary batches. |
| `coordinator/bootstrap-header.ts:93,126`; backend `bootstrap-header.ts:44` | New original stages may be14; retained original stages use original headerBase. Parse historical11–13 and new14. Existing-empty target recognition adds14 with unchanged exact-empty/admission checks. |
| `coordinator/bootstrap.ts:84,228–232` | Allow completed original13/current14 relation only at READY; confirm original frames, initialize/confirm task document, then upgrade current header. Maintain callback/currentness and cleanup guards. |
| `coordinator/{load,writable-format,mutations,managed-documents}.ts`; `index.ts` | Attach task initialization/verification to all physical create/upgrade/open paths; avoid reentrant session locks; expose actual current view only after checks. Read-only migration to in-memory CURRENT does not imply physical14 initialization. |
| `context-readiness.ts`; `coordinator/conversation-index.ts`; core seed export/retention; persistence `seed.ts`,`fork.ts` | CURRENT-derived behavior needs regression controls for historical13 sources, current14 views and exact selected-result semantics. Do not rewrite historical digest preimages or turn source structural reads into payload access. |
| `subagent/src/task/{types,validation,records,registry,persistence}.ts`; `subagent/src/index.ts` | Original binding immutability, v3 reader/writer, explicit acknowledgment and strict restore failure state; no fresh spawn callsite changes in this unit. |

Extend existing version predicates where present; introduce small cohesive predicates only where duplication must agree. Do not undertake unrelated decomposition. No blanket search/replace13→14:13 event floors, historical fixtures, codec constraints and stage preimages are deliberately retained.

## 6. Writer boundary and staged TDD

Supported transition is only after genuine previous-owner retirement and producer drain. MAIN assembly disposes subagents and joins persistence before document close (`assembly.ts:1805–1882`); Documents and TaskPersistence otherwise have independent caught queues. Failed old saves cannot become positive acknowledgment through flush. Failed drains retain original debt; do not force lock release or migrate in parallel. New task save admission must check the exact parent owner lifetime so delayed callbacks from a retired registry cannot reacquire independent document authority. General auxiliary documents retain their original owners; only the recognized task key receives this task-parent constraint in current code.

Old shipping assembly refuses14 through `assembly.ts:525`→`openExecutorDocument`→`openManagedDocument`→`loadOwned/preflight`, before registration1287 and its task read catches. Genuine direct old TaskRegistry/putDocument can still overwrite the key; preserve that counterexample as an explicit unsupported-access limit, never a passed fence test. No rollback compatibility is claimed. Users opening upgraded writable sessions with an older build must upgrade the executable; normal CURRENT policy advances all writable sessions, not merely spawning parents.

Implement only after review, in these gated units, with failing tests first and no fresh launch enablement:

1. **S0 original storage acknowledgment.** Tests distinguish absent/unavailable root/non-ENOENT/malformed reads; exact initialized bytes; positive real sync/rename; uncertain issue/release and same-snapshot reconciliation. Implement observed task reads and stronger original document acknowledgment. Verify literal v1/v2 read causes no migration write. Reserve native platform durability evidence rather than inventing a mock fsync guarantee.
2. **S1 initialization/transition owner.** Tests for new parent, legacy missing/present, known contradictory legacy history, cold14 missing, orphan task/parent collision and each crash-table cut. Implement pure task contract injection and internal transition lifetime/lock order. Missing host capability refuses. Keep CURRENT13 in released runtime until all14-dependent paths are ready; exercise candidate14 through bounded fixtures, not fake old graphs.
3. **S2 format14 and immutable birth preservation.** Add explicit migration/readers and hook every physical upgrade. Positive old13 ordinary and semantic V1/V2/V3 births, partial13 historical phases, current14 new births, and old13 exact-read fixtures. Assert stage bytes, seed frames, completion/initial frames, request/manifest hashes and selected-result pages remain identical across13→14; modified originals/future/downgrade reject. Use the approved V3 outer graph, not a fabricated parser patch.
4. **S3 original task-v3 binding only.** Tests exact row/request/prompt capture, optional absence, actual task identity, changed fork/options/clock rejection, alias mutation refusal, strict failed-save retention, queued different snapshot, cold data-only restoration, and v1/v2 provenance. Implement binding/save/restore without calling private reservation from spawn. Generation/Agent/model counts remain zero in this slice.
5. **S4 genuine compatibility/host integration.** Real immutable MAIN283e positive old parent/task writes; old14 parent refusal before any task access/sweep/write; task-read failure cannot bypass the preceding parent gate; live old owner blocks transition; successful retired-owner handoff; stale callbacks/failed disposal cuts. Run both strict and non-strict direct-old overwrite controls and retain their demonstrated limitation. New configured host positively creates/opens14 and round-trips old/v3 tasks. Only then review a separate fresh launch connection.

Tests should target these obligations and IO cuts, not mirror DTO fields mechanically. No tests or runtimes were run for this research. Exact process/dependency/native-lock evidence roots must be assigned by root; no protected root is a fixture. No deletion/cleanup of retained orphans is part of qualification.

## 7. Remaining decisions before writer

The plan resolves initialization/loss distinction for all supported14 stores by ordering existing owners; it requires no additional durable fact. It cannot retroactively distinguish a never-created legacy task file from a lost one. Root must accept the stated legacy absence policy (or choose universal manual recovery for that case), approve the original task contract injection into all creation hosts, and settle the precise qualified acknowledgment guarantee on Windows/other supported backends. Unavailable acknowledgment is a capability failure, not successful compatibility.

Root must also provide the exact approved V3 outer/integration graph beyond the limited HOST files inspected here, freeze ownership of overlapping bootstrap/format modules, and authorize test/native evidence roots. Existing admitted source/currentness/receipt requirements remain; none of this creates executable cold authority. The next deliverable is reviewed storage/format implementation with fresh launch disabled, not a release or full Task4 completion.


# Session14/task binding: closure of four design findings

2026-10-28. Design-only addendum to the preserved `child-binding-format-plan-20261028.md`, responding to `child-binding-format-review-20261028.md`. Source remains immutable MAIN `283e96da3cf7311bde3eaad80f9e1b960eb89a58`; earlier bounded HOST3714 observations remain as previously stated. This revision also consulted official Microsoft/Node documentation under the explicit research exception. No product, runtime, test, probe, dependency, Git, profile or protected-root mutation/access occurred. Only this addendum was written. CURRENT stays13, product stays0.1.13-rc.1, fresh launch stays disabled, no release. Return to the same Sol reviewer through root; no recursive agent dispatch.

## Decisions superseding ambiguity in S0/S1

1. The usable Windows acknowledgment class is **exact file content synchronized and publication confirmed for process restart**, under a supported same-directory local filesystem and genuine native ownership. Successful directory fsync is **not** a Windows success prerequisite. This class does not promise ordered metadata persistence through OS crash, sudden power loss, defective storage or partial backup restoration.
2. Legacy initialization uses a pure consistency check over the complete original committed **own-parent** history, with explicit identities from start/end and validated delivery facts. A present task document missing a known identity also refuses. No known facts is the accepted legacy compatibility exception, never a proof that no task was lost.
3. All three actual CLI writable constructors, desktop, SDK-created roots and ACP-created roots use the injected original pure task contract. The lock-disabled sessions command remains read-only.
4. Exact-byte confirmation uses a new internal raw observation witness owned by the existing Documents/backend lifetime. Parsed `readDocumentObserved.value` is insufficient; reserialization cannot replace that witness.

The ordering remains: task-v1/v2 initialization/confirmation → first parent14 publication/confirmation → task-v3 binding acknowledgment → later separately authorized private reservation. No new key, prompt copy, registry, marker or automatic cold launch.

## A. Windows acknowledgment: exact promise, operations and outcomes

### Existing evidence, not a new inferred platform guarantee

MAIN `session-persistence-jsonl/src/backend/fact-journal.ts:145–178` writes a complete original batch, awaits file sync and records committed before cleanup; close failure after sync does not erase that receipt. Reconciliation checks original bytes and syncs them. `backend/bootstrap-header.ts:120–162` similarly syncs original header bytes, confirms an existing-empty replacement, and treats directory sync as best-effort. `backend/session-io.ts:12–35` and `backend/format-upgrade.ts:72–92` sync the replacement file before rename and attempt directory sync, explicitly accommodating Windows. Conversely ordinary `index.ts:118–124` create and `index.ts:315–328` task document replacement do not currently supply that file-sync evidence. These weaker paths need upgrading for the new ordering contract; a Documents strict promise alone is not enough.

`packages/fs-lock/src/win32.ts` binds CreateFileW, LockFileEx, UnlockFileEx, CloseHandle and GetLastError through koffi. It supplies exclusive ownership, **not** a file/volume flushing or rename durability API. `coordinator/ownership.ts` retains native release debt when a release consumes its held bit before failing. Preserve that behavior; later no-op cleanup cannot certify successful release.

Official Node documentation says `FileHandle.sync()` requests flushing descriptor data to storage, with OS/device-specific implementation. It does not itself establish a cross-file ordering proof. [Node FileHandle.sync](https://nodejs.org/api/fs.html#filehandlesync). Microsoft documents that cached reads may return system-cache content and that metadata is cached too; therefore successful readback proves namespace/content observation, not independently stable-media persistence. [Microsoft File Caching](https://learn.microsoft.com/en-us/windows/win32/fileio/file-caching).

Microsoft's FlushFileBuffers API requires write access and flushes buffered information for the specified file. This supports keeping actual file synchronization mandatory, but does not let this design claim that an unqualified Node rename has a particular transactional guarantee. [Microsoft FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers). MoveFileEx exposes WRITE_THROUGH, with documented move/copy-delete semantics; the existing code does not invoke a newly qualified native WRITE_THROUGH replacement helper. We must not treat the flag's existence as evidence that current `fs.rename` uses it or that a two-file transaction is implemented. [Microsoft MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

### Frozen acknowledgment class

Call the internal class `file-synced-process-restart-v1` (proposal, not an existing public API). It means:

- The exact original file contents have completed a successful file sync under the original held owner.
- The intended final path has been observed containing exactly those bytes after any publication operation, with a subsequent successful file sync on that final file and owner/currentness rechecks.
- With the OS/filesystem still operating normally, a process interruption and subsequent process reopen can reconcile the acknowledged published files. The supported platform's same-directory replace behavior must be positively qualified. A pre-ack interruption may leave an orphan or uncertain publication as in the original crash table.
- Directory sync remains attempted where available and its outcome is diagnostic; unsupported Windows directory opening/sync does not convert otherwise successful acknowledgment into universally unsupported. Any stronger supported-platform directory-flush path remains in place. This additive acknowledgment must not remove existing file sync, bootstrap receipt confirmation or stronger platform guarantees.

“Clean restart” here means application process shutdown/restart, not an unconditional OS reboot or power-cycle guarantee. OS crash/power loss can violate cross-file namespace persistence ordering under this class even though file-content sync succeeded. After such an event,14+missing still refuses and never reinitializes; that is safe detection, not proof no data was lost. Partial rollback to13 can lose the14 marker itself, so universal post-power-loss old-writer refusal is explicitly **not** claimed. This narrows the new cross-file guarantee; it does not redefine or weaken existing FactReceipt semantics.

No native helper extension is required for this process-restart class: use the existing Node file operations and existing genuine native session/document lease. The preflight capability is the exact runtime/JSONL implementation plus native locking and a qualified same-directory local filesystem, initially the supported Windows local NTFS population. Network shares, unqualified filesystem/runtime combinations and missing native locks must not inherit certification. Positive Windows qualification is future evidence, not a reason to report all Windows operations unsupported today. If the product later requires OS/power-loss atomic ordering, that is a new capability project: an actual native publication/flush protocol, exact Win32 handle/share/access semantics and filesystem/hardware qualification would be required. Do not silently add a volume flush requiring administrator privileges or invent an already-existing helper.

### Phase acknowledgments and failure model

| Phase/outcome | Exact meaning and next action |
|---|---|
| Capability unsupported | Known unavailable lock/runtime/backend contract before issuing publication. Refuse; do not create files to discover permission by trial. |
| Not-issued | Original owner/currentness rejection before any candidate namespace/data issue. No downstream header/binding/reservation. |
| Temp complete + synced | Original candidate bytes are synchronized; **not yet final publication**. Keep the original temp identity for recovery. |
| Rename/create issued, result unavailable or throws | Unknown publication until exact final-path reconciliation. Do not equate an exception with absence or delete evidence automatically. |
| Final exact bytes + successful final sync + live owner | Storage acknowledgment for the named class. A failed close afterward is committed-with-cleanup-debt, not permission to rewrite or replay. |
| Byte mismatch/foreign object | Conflict; no overwrite to “repair” or substitute snapshot. |
| Final path lost/read unavailable/sync fails | Unknown, unless the original owner can separately prove not-issued. ENOENT after an issued publication is not safe reinitialization. |
| Lease release/observation cleanup fails | Preserve storage acknowledgment and original cleanup debt separately; operation is not a successful handoff. No downstream work requiring that barrier may issue. |

Replacement: capture original exact bytes → create same-directory temp exclusively → complete write → sync → close for rename → rename → reopen final read/write → exact compare → sync → recheck owner → retain acknowledgment → cleanup. A close failure before rename prevents publication and retains the temp/debt. A fresh exclusive-create path must similarly complete write, sync and final-path confirmation before successful parent creation is exposed. Existing-present confirmation writes no content. Parent format upgrade/header publication uses the same class in addition to its existing historical frame confirmation. These are changes to existing owners, not a second writer or a weakening of B2's original outcomes.

## B. Exact observed raw snapshot contract

Keep existing parsed `readDocumentObserved` for its existing callers. Add one **internal** operation owned by Documents and the JSONL backend, conceptually `observeTaskDocumentRaw(heldScope, key)` returning `absent`, `present(parsedValue, witness)` or a refused/unavailable outcome. The witness is opaque and nonserializable; backend-owned retained bytes are never public tool input or another persistent store.

Scope binds the original backend instance/root, exact original task key, current parent owner incarnation, and exact document-lease operation. No caller-provided path, guessed owner or hash-only token is accepted. Preserve the existing root availability and tombstone checks before and after read. Only actual ENOENT under an available original root is absent. EACCES, root disappearance, invalid JSON, truncation/incomplete read and uncertain ownership refuse; they do not yield an empty registry.

Read exact bytes from one opened regular-file handle, record its size and available file identity, and check size/identity/currentness before and after. Parse those captured bytes once using the original task codec, and retain an immutable detached value for validation. The identity is the owner-scoped handle/path observation plus raw bytes, not a promise that timestamps or inode numbers alone identify a file. An unsupported link/redirection or unstable read refuses. Same-owner cooperating writes are excluded by the lease; privileged external writers remain outside the contract.

Bound S0 observation to64MiB per task document and fixed-size read chunks; retain at most that one original snapshot per operation, release it after acknowledged handoff/cleanup. Over-limit is an explicit unsupported-size refusal with no writes or truncated parse, not missing storage. This is a new operational limit and must be surfaced in diagnostics and tests; raising the limit later requires resource review, never partial acceptance. No arbitrary bound is applied to the parent's complete journal by silently dropping its tail: history validation can fold the existing complete source incrementally.

`confirmTaskDocument(witness)` must run under the **same live** operation/lease. Open the final original path read/write, compare all raw bytes and size with the witness, sync the file, reread/compare or otherwise verify the same exact final-path observation under that lease, then recheck ownership. Difference is conflict; unavailable access is unknown. Value-equal JSON with reordered keys, different whitespace or newline is **different bytes**. An expired/foreign witness is rejected before IO. A digest may be a fast mismatch check, never a replacement for the retained raw comparison. Confirmation does not JSON.stringify or rewrite v1/v2.

A new snapshot write captures its serialized bytes once before queueing and returns its own exact original operation acknowledgment. Its later confirmation uses those bytes, not a new serialization of mutable records. Cold recovery cannot deserialize a witness; it acquires a new genuine owner, observes current raw bytes, validates them and confirms that current state. It does not thereby acknowledge a lost old promise or gain launch authority.

This supplies the missing bridge in the original plan: task schema validation sees parsed data; byte preservation/acknowledgment sees the exact original file. No duplicate task identity registry is created.

## C. Own-parent known task identity predicate

The **producer** is the existing parent journal/load owner under the genuine parent lease. It supplies a complete validated committed history witness to the transition operation: physical session ID P, physical format, validated seed boundary, complete committed prefix coordinates, and top-level events/frame structure. It is not a tool-provided event array, conversation projection, selected-result view, last-N window, or parsed prompt. Existing `load.ts`/journal validation owns completeness and history validity; pending/unknown writes, unavailable portions, malformed/future format or unreconciled torn tails cannot be interpreted as an empty history. Resolve through the existing original recovery owner first or refuse transition.

The **validator** is a pure helper beside the existing task storage contract, taking this validated history input and the optional parsed task document. It returns a set of explicit known task IDs plus consistency result; that ephemeral set is not persisted or used to allocate IDs. It performs no producer calls, no counter seeding and no history/body expansion. The host composition injects this original task helper into the persistence transition callback, avoiding persistence→subagent import cycles.

Own history is the top-level local journal suffix at/after the validated inherited seed boundary. For semantic births, seed frames are opaque inherited records and bootstrap completion/initial facts do not allocate a parent task. For old raw-seeded sessions, use the validated original `seedLength`; missing/unreliable inherited scope cannot be replaced with zero. An ordinary root whose validated physical header has no inherited-prefix declaration has boundary zero; absence there is the existing no-seed header meaning, not a failed scope lookup. Do not descend into seed groups, nested turns, selected-result origin metadata or discarded bodies. Rewind/compaction visibility does not erase a still-committed local start/end from the consistency input. No extra parent-history traversal is introduced into the later literal-none seed builder; this check belongs to storage transition.

| Local committed fact | Predicate |
|---|---|
| `subagent/start` | Require nonempty explicit taskId and valid original fact. Optional parentSessionId absent means legacy local scope from journal P, **not ignore**. If present it must equal P; explicit foreign/empty invalid parent is inconsistency. Add taskId regardless of role name, delivery mode, background setting or current task status. |
| `subagent/end` | Require valid original fact and nonempty explicit taskId; add independently even if no start is available in a higher-level projection. No role filter or terminal-outcome filter. |
| `agent/delivery-source` | Require validated original delivery frame/history, kind subagent, recipientSessionId=P, immediately preceding actual start with matching taskId/sourceId/startSeq and original dispatch linkage. Add sourceId. Never trust a standalone arbitrary sourceId. |
| `agent/delivery-received` | Require validated original receipt/admission frame and full history linkage: key recipient=P, kind subagent, namespace/sourceId/sourceSeq binding and matching original terminal/resultRevision. Add key.sourceId even if a presentation projection hides the start. Invalid/missing linkage refuses, not “no evidence.” |
| Delivery generation only; call/dispatch alone; job/team bookkeeping; role/reviewer label; tool result or display text | No allocated task ID. Do not infer one. Team/reviewer operations count only if they actually emit valid own task facts above. |
| Inherited prefix/nested seed/result metadata | No task owned by P. Exclude by validated scope, not a role/name heuristic. |

The delivery checks reuse `core-session/src/conversation/delivery.ts:88–105,210–230` and `events/delivery.ts`; do not implement a looser parallel delivery validator. Start/end schemas come from `events/types.ts:159` and adjacent end union. Pre-13 histories cannot admit future delivery facts as ignorable task evidence; they must pass their actual format validation.

For confirmed absent legacy task storage, any known ID means recovery-required. Only complete, valid history with an empty known-ID set permits the root-approved legacy compatibility initialization. Because task submit/save precedes start (`subagent/tools/spawn.ts:100–133`), this does **not** prove unknown lost legacy tasks never existed.

For a present valid v1/v2/v3 document, each known ID must match **exactly one** row with that ID in this original parent's task document. Missing or duplicate rows refuse. A row with a nonempty foreign parentSessionId refuses; an existing legacy empty parent field is retained only where the original task codec permits it, with local file/fact scope providing the consistency match—not newly invented identity. This check does not fill missing callEventSeq/toolCallId or rewrite old rows. v3 bound rows require the stricter exact parent/caller equality already specified. Additional rows without a start are allowed because submit precedes start. Notification IDs, prompt/path similarity and task-N maximum cannot substitute for matching actual allocated IDs. The schema/currentness validators remain responsible for full row domains and result provenance.

The check runs before initialization **and before upgrading a present document's parent**. Explicit foreign local facts or malformed history refuse even if the task file is present. Parent14+missing always refuses regardless of this predicate. The supported-old-writer reduction remains unchanged.

## D. Concrete composition hosts

Pinned source searches included `apps/cli/src`, `packages/desktop-gateway/src`, `packages/sdk/src`, `packages/acp/src` and `packages/session-executor/src`, correcting the package-only inventory.

| Actual site | Role and required injection |
|---|---|
| `apps/cli/src/index.ts:398` | Headless durable create/resume; lock enabled. Supply original task contract before immediate create407 or resume/load. |
| `apps/cli/src/index.ts:656` | SDK stdio durable service coordinator; lock enabled. Supply contract; SDK host's explicit createSession callback778 uses this same coordinator. |
| `apps/cli/src/index.ts:926` | ACP stdio durable service coordinator; lock enabled. Supply contract before service/ACP construction. |
| `apps/cli/src/sessions.ts:218` | Lock-disabled read-only sessions list/show. Uses snapshot/list via listStoredSessions, closes without owned mutation. No fabricated writable capability; keep read-only old/current snapshots working. Any accidental create/upgrade through this instance refuses before mutation. |
| `packages/desktop-gateway/src/host.ts:127` | Desktop original coordinator; inject contract once. createSession454 and `draft-session.ts:12` inherit it. |
| `packages/sdk/src/server.ts:332–352` | SDK ensure-root path can call supplied coordinator.create with requested sessionId. It does not construct a new coordinator; requires supplied configured durable capability. Never inject an SDK-local fake empty task document. |
| `packages/acp/src/index.ts:123` | ACP session/new calls supplied coordinator.create; inherits configured host contract. Without coordinator, existing nondurable path remains nondurable. |
| Public `createSessionCoordinator` consumers outside inspected hosts | Explicit capability requirement for writable14; no fallback. Read-only use needs no manufactured lock/transition authority. |

No model/provider/account call is needed to validate these wiring paths. Composition tests can use inert model dependencies but must exercise the actual constructors and root-creation routing, not pretend SDK roots are exclusively created by the CLI callback.

## E. Updated bounded S0/S1 and closure evidence

**S0 now has concrete scope:** implement the backend-owned raw witness/confirmation and exact original write acknowledgment class, while CURRENT stays13. Tests first: real literal v1/v2 whitespace/property-order/newline preservation; absent versus unavailable/non-ENOENT/root loss; invalid/future/over-limit refusal; equal-JSON/different-byte conflict; expired/foreign witness; write, sync, close, rename, final-read and final-sync cuts; acknowledgment retained across cleanup failure; positive same-owner retry without reserialization. No Session14/task-v3 activation or fresh spawn wiring.

**S1 now has concrete scope:** implement pure complete-history consistency input/helper and original task-contract injection at all listed hosts, then the ordered initialization/confirmation transition capability behind the existing disabled format transition. Tests first: start-only, end-only, valid delivery source/receipt, foreign explicit parent, omitted legacy parent, inherited records, generation-only, task saved before start, complete versus truncated/unavailable history, present document missing/duplicating a known row, legacy permitted empty-parent row, new-parent collision, cold14 missing and retained orphan paths. Preserve task-v1/v2 exact bytes until an actual later task save is requested.

Platform qualification still required after implementation: genuine native Windows lock acquisition/handoff on assigned local NTFS fixtures; positive task create/confirm/replace and parent create/upgrade/header operations; process termination before/after each acknowledgment; no old production task access after14 refusal; failed cleanup/stale callbacks; original direct-old overwrite counterexample. Mock tests do not certify native semantics. Pin actual runtime/dependency provenance; this research did not execute them. Stronger OS/power-loss testing is outside the selected class and cannot be reported as passed by process-kill tests.

All four requested contracts are now specified. Remaining uncertainty is whether implementation and native qualification satisfy them, plus root supplying the already approved V3 outer integration graph/evidence roots—not an implementer choice of acknowledgment model or guessed task-history predicate. Root and the same Sol reviewer should assess this addendum before dispatching S0. No release or runtime success is claimed.
