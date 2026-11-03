**F1-L1 legacy fork retention owner — implementation report**

Status: the connected owner implementation and review-round-1 corrections are committed and frozen for the same independent reviewer; acceptance remains pending. Root owns acceptance and integration. This report does not declare the public fork callers or the product version complete, and the explicitly preserved public semantic-fork baseline still fails.

| Item | Value |
| --- | --- |
| Assigned checkout | `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main` |
| Branch | `codex/legacy-fork-retention-20261025` |
| Base | `f2726707915c940efe64d4ebe2e6b0cc8980f72b` |
| Feature commit | `2bd11d06783826307f139095e40f2d14bbcdd7bf` — `feat(context-output): retain bound legacy fork results` |
| Original test qualification commit | `16f7c0bab79792db7fc0f47381c4416b990c55e4` — `test(context-output): qualify held capacity after legacy rename` |
| Current HEAD / review-round-1 fix | `7c1ee4536fdec6ff8ad73beedfd47cfc839ca79b` — `fix(context-output): fence foreign legacy paths and pruning` |
| Current full review range | `f2726707915c940efe64d4ebe2e6b0cc8980f72b..7c1ee4536fdec6ff8ad73beedfd47cfc839ca79b` |
| Evidence | `D:/I-harness-main/.superpowers/sdd/2026-10-25-legacy-fork-retention/task-1/` |
| Runtime | Windows, Node `v24.15.0`, pnpm `12.3.4` |
| Preserved formats | Product `0.1.13-rc.1`, Session `12`, SemanticSeedV1, original legacy result body and owner-array JSON |

All commands used explicit assigned-checkout/package working directories. Workspace import resolution was checked: core-session, fs-lock and settings resolve to the assigned CURRENT checkout. No dependency reinstall, link replacement, new worktree, subagent, push, tag, release build, provider operation or installed-profile operation was performed. The pre-existing protected `.task3-evidence/` was not read, run, changed, staged or deleted. Its name remains visible in Git status only.

The implementation follows the tracked L1-01..14 specification and root's subsequent binding rulings L1-15..21. L1-15 composes local observation session identity in ContextOutput rather than guessing it in core. L1-16 separates Gateway broker and unmanaged outer-F0 handoffs. L1-17 distinguishes existing B2 immutable-payload validation compilation from forbidden new source export/render/producer work. L1-18 retains original native handle cleanup. L1-19 puts derived staging/proof metadata in the existing main SQLite index under L0 admission. L1-20 preserves fractional legacy expiry numbers. L1-21 migrates the native quota observer to the actual shared `lstat` inventory without weakening its ordering assertions. Root also explicitly approved the late alias and whitespace-reclamation fixes under L1-04/05.

**Implemented owner behavior**

The existing ContextStore remains the canonical byte, manifest, owner-map and SQLite owner. The existing workspace mutation owner remains the single mutation/quota lane. There is no second storage, quota, semantic-seed cache or bootstrap receipt authority.

The new host-only service methods register/confirm/reconcile/close a legacy transfer and perform observed legacy read/search. Scope objects are issued by the service and checked by identity. Captured host containers are checked without recursively JSON-cloning ManagedDocument views or capabilities. Native AbortSignal branding is checked without invoking a caller's `aborted` getter. Closing a scope retires admission, joins its original attempts and file retirements, releases source/target callback captures, and permits retry of the same unresolved cleanup.

Strict observed-recipient enforcement is captured immutably at service construction. New transfer registration refuses unless it is enabled. In that mode, an ordinary unobserved noncreator legacy read/search cannot use generic ownership or missing index/root hints to obtain transferred bytes. Default unrelated legacy compatibility remains explicit. Metadata transfer remains possible while retrieval is disabled; enabling retrieval then permits the properly observed read.

The core structural companion reuses B1 boundary/history/turn/visibility selection. It emits typed local ref coordinates and sound child anchors without rendering or exporting payloads. Local `original` contains only seq/part in core; the host owner composes its observing document's captured `sourceSessionId`. The real fixture deliberately has creator `creator` and observing document `source`, so a creator-derived address would fail. Inherited observations retain original coordinates and append only immediate `via`. The nested positive preserves `source:2` through a target-to-grandchild transfer and survives clearing the intermediate target.

Full ContextResultRef metadata is streamed lexically through `streamJsonData` under `ih.legacy-ref.metadata.v1\0`, including exact encoded-byte count and exact expiry. Body revision does not substitute for metadata digest. Long source metadata is not copied into plans and has no added8192/64KiB descriptor cap. Target source identity is independently streamed under `ih.legacy-fork.target-source.v1\0`; the root contains its bounded digest, not the raw unbounded identity. Canonical bounded publication bytes make warm retry independent of host property insertion order. Existing capture optional source fields are normalized to the same omission semantics as their original JSON manifest.

Binding/page/root/application records use the actual invocation and manifest supplied by B2. B2 constructs deeply frozen, closed preparation facts from its validated captured request/stage, and on cold adoption only after `checkBirth`. ContextOutput compares actual seed digest, source observation, completed boundary, turn-domain digest/count/prefix and group anchors before publication. The Gateway change is only forwarding the optional facts argument through its existing preparation wrapper. B2 remains the sole seed/completion receipt owner and no wire/on-disk B2 format changed.

Pages contain only bounded commitment/address fields. Leaves and directories obey both100-entry and64KiB limits. Directories have uniform decreasing levels and permit a rightmost one-child node; a one-child whole root collapses. Root/page range, count, digest, immutable-pending and EOF checks are strict. Repeated observations remain separate rows, while full commitment tuples must agree and each distinct ref is funded/applied once. Empty retention has an exact empty root and application; absent records never mean empty.

Derived consistency and page/row proof hints live in the existing disposable main SQLite index. Growth occurs only in explicit L0 owner phases with actual physical inventory, SQLite page ceiling and conservative rollback-journal headroom. There is no TEMP spill database or unbounded in-memory distinct scratch. Incomplete derived rows never authorize retrieval. Cold/read-entry repair is an explicit owner phase; private lookup is read-only and must verify the actual root-to-leaf proof, current canonical membership, exact commitment, dispositions and current typed visibility. Negative hint filtering cannot authorize a candidate. Canonical file inventories remain unchanged during passive index repair. Full-budget repair can honestly refuse when its derived state cannot be funded.

After original graph validation, actual canonical manifests and bounded body hashes are checked. The owner pre-funds deterministic dual revocation/expiry slots, each tracked ref's independent rewrite capacity and fixed journal, and the exact pending application before target owner additions. Target additions merge into current canonical owner arrays, preserving unrelated owners. Application is published only after canonical effects and reserve restoration confirm. Passive reconciliation cannot add owners, complete pages/application or manufacture a B2 birth receipt from a raw owner-ID grant.

Tracked owner arrays remain ordinary valid JSON and can exceed64KiB. Their hashes/writes/readback stream. The two-inode replacement protocol keeps a hardlinked predecessor across canonical rename, then reuses that already-funded old inode as scratch. Bigint native device/inode and exact link counts are checked: canonical is independent before padding/new predecessor, the known predecessor pair has exactly two links, and independent scratch has exactly one link before overwrite or truncate. A cross-ref/outside hardlink refuses before either real canonical file changes. Recovery finishes the original canonical-before-reserve shrink cut; canonical truncation verifies actual trailing JSON whitespace and reserve reclamation follows in safe order. Unknown/torn/foreign phases remain fenced instead of using an old whole-array rollback.

The shared `physicalBytes` inventory counts reliable nonzero bigint device/inode aliases once, conservatively counts unknown identities per path, refuses symlinks/overflow and retains the original tree-wide32-slot listing/stat bound with started-I/O joining. ContextStore.diskBytes delegates to that same inventory. It measures file payload sizes, including staged/pending/unknown files and funded reserves; it does not measure NTFS clusters or guarantee immunity to device errors.

Clear/delete write deterministic revocation before removing a transfer target's canonical ownership. Source clear removes only the source's own membership and preserves other targets, including an owner whose rename landed but whose response was lost. Actual document deletion runs independent managed cleanup alongside legacy cleanup; managed-only deletion does not acquire a spurious new legacy store. TTL writes the exact original expiry tuple before byte/manifest GC. Historical applied-plus-expiry evidence can acknowledge an original application but cannot authorize a read, recreate owners or let same-body recapture inherit old permission. Project revocation/ABA invalidates old scopes without creating a persisted data tombstone; a fresh real matching scope can requalify preserved grants.

Observed read/search revalidate after actual body awaits. A result that expires during that await is discarded even if its project/view epoch did not change. Canonical expiry is checked again after owner-ledger I/O. Current typed visibility is checked after proof/ownership awaits. Creator compatibility, UTF-8 boundaries, existing query budgets and disabled-mode behavior remain covered by the affected original suites.

Original file handles retire through ContextStore using the existing LeaseRetirement semantics. Acquired handles are inside guaranteed cleanup before an after-await guard can throw. Pending retirement calls coalesce; confirmed retirements are removed promptly. Scope/store close join original handles before dependent DB/lifetime disposal. A failed close with a consumed fd stays unknown, and a later no-op cannot falsely confirm disposal.

**Connected runtime acceptance evidence**

| Control | Actual qualification |
| --- | --- |
| Initial behavior RED | Real legacy capture, real B1 seed and actual B2 reserved target; old raw owner grant returned VISIBLE body despite proposed strict mode (`002`) |
| Gateway positive | One-pass real broker preparation then legacy confirmation before B2 READY; no ordinary incomplete target profile; empty managed closure with nonempty legacy refs |
| Unmanaged positive | Actual outer F0 before B2; actual absent source/target bindings and actual reservation/facts checked; scope close joined before F0 exit |
| Mixed closure | Actual managed dependency catalog/member plus legacy retention; both owners participate before READY and both remain readable after cold source-free recovery |
| Cold/source disposal | Source clear and source document close, service/coordinator/broker cold reopen, actual B2 adoption with zero source hooks, VISIBLE read and search positive |
| Selection negatives | Rewound HIDDEN, captured/unselected FUTURE, pre-READY/unobserved bypass, wrong actual B2 seed/observation/selection/turn domain, absent application/root, malformed capabilities |
| Warm continuation | Stop after a real leaf; original bytes retained; fresh real host scope with the same original witness; exact prefix and one target/application; zero L1 source re-export/capture/compile |
| B2 validation oracle | Five existing B2 immutable validation compile calls during finalization, separately measured; zero source re-exports. These calls were not waived or bypassed |
| Unknown cuts | Actual owner rename response loss, application response loss, partial slot allocation, torn terminal slot, before/after rename, canonical-before-reserve shrink, unrelated-owner preservation |
| Lifecycle | Actual document deletion, source/target clear, full-budget target clear, exact expiry after GC, fractional expiry, same-body recapture, project ABA, body-await expiry |
| Cleanup | Real original FileHandle close failure, late acquire/retirement guard, same-scope cleanup retry, consumed-fd sticky failure; original lease/close consumers retained |

The earlier combined reserved-header/broker/F0 arrangement was retained as evidence of the ordering investigation, not installed as a mandatory public happy-path workaround. The final real positives use the distinct host handoffs required by L1-16.

**Verification and source binding**

Every Vitest command was package-CWD, sequential across packages, with `--maxWorkers=2 --minWorkers=1`. Raw output is retained in the numbered evidence files. Later gates have adjacent `*-command.json` and `*-result.json` recording command, CWD, source manifest and exit. Source manifests bind changed/new files by SHA256, with the base commit identifying unchanged repository content. No final-HEAD full-monorepo-green claim is made.

| Gate | CWD package / scope | Source | Result |
| --- | --- | --- | --- |
| `054` | ContextOutput full package excluding distinct-scale file | final-1 |241 pass,1 managed-only deletion regression;10001 case itself passed |
| `055` | Existing managed integrity/deletion controls after fix | subsequent repair |11 pass |
| `062` | ContextOutput package, distinct-scale file and already measured10001 excluded | final-3 |32 files,241 pass,1 intentionally not rerun |
| `063`..`068` | Types: context-output, core-session, session-persistence, session-persistence-jsonl, desktop-gateway, session-executor | final-3 | All six exit0 |
| `069` | Full core-session | final-3 |52 files,569 pass |
| `070` | Full session-persistence | final-3 |251 pass,1 preserved public semantic-fork baseline failure; exit1 |
| `071` | Full session-persistence-jsonl, actual B2/F0/native storage | final-3 |21 files,264 pass |
| `072` | Gateway bootstrap-project/bootstrap-transfer/project-scope | final-3 |3 files,65 pass |
| `073` | Executor mixed native/quota and original-close/grant consumers | final-3 |15 pass,2 setup failures from absent isolated config directory |
| `074` | Executor quota after setup correction | final-3 |3 pass,1 old stat-vs-lstat instrumentation failure |
| `075`→`076` | Real fractional expiry transfer/cold/read/disposition | L1-20 segment | Causal RED then four focused expiry/disposition positives |
| `077` | Executor quota with L1-21 actual caller-context instrumentation | final-4 | All4 pass; original managed hold/admission/body/blob/pre/post assertions retained |
| `078` | Real101 and1001 distinct selected/funded refs, summary anchor | final-4 | Both pass; timing below |
| `079`→`080` | Cross-ref/outside hardlink and whitespace-cut controls | late ledger segment | Three causal REDs; all8 ledger controls pass after fix |
| `081`→`082` | Invalid source/signal/ref metadata and original cleanup/Stop | late capability segment | Causal RED then8 focused positives |
| `083`,`084` | ContextOutput and executor types | final-5 | Both exit0 |
| `085` | Affected ContextOutput full fast package gate | final-5 |32 files,248 pass,1 intentionally not rerun10001 |
| `086` | Representative real101 distinct funding after late ledger guards | final-5 | Pass;1001 not repeated |
| `087`→`088` | Read/search expiry during actual body I/O | final freshness segment | Two genuine stale-payload REDs, then6 expiry/mixed/cold/disabled positives |
| `089` | ContextOutput types | final-6 | Exit0 |
| `090` | Final affected ContextOutput full fast package gate | final-6 |32 files,250 pass,1 intentionally not rerun10001; exit0 |
| `091`,`092` | Additional actual managed writer after original canonical rename loss, plus ContextOutput test types | final-7, test-only qualification | Actual `beginResult` at exact held physical occupancy refuses quota without consuming the predecessor capacity; original recovery then succeeds. Focused case and types both exit0 |

Segmentation is explicit. The final-3 broad gates were followed only by the authorized fractional-expiry/native-observer corrections, late alias/reclamation/capability controls and strict response-freshness fixes. Affected types and ContextOutput controls were rerun. The final-7 commit only adds the actual managed-writer-after-crash assertion to an existing cut; production source remains identical to final-6. The unchanged10001 and1001 expensive cases were not repeatedly executed for routine checking, per root instructions. Their exact earlier source manifests and raw receipts remain; they are not represented as measurements of every later HEAD instruction.

The full persistence failure is unchanged `test/semantic-fork-baseline.test.ts`, “fork archives only the current summary and typed tail, without consumed proof bodies”: the public legacy fork still archives `CONSUMED-PROOF-ONLY`. Its assertion was not edited, skipped or relaxed. This is the expressly retained F1-C caller debt, not a passing whole-fork claim.

**Scale, allocations and R6 measurement debt**

| Actual control | Measured result |
| --- | --- |
|10001 observations /101 leaf pages (`054`, final-1) |44.016s case time;22170 actual ContextStore file retirements, peak1 pending, live0; rightmost one-child level1 directory and level2 root; deleting rightmost leaf denies retrieval |
|101 distinct refs (`078`, final-4) | Setup2.748s; owner10.755s; actual canonical target owners, reserves and application checked |
|1001 distinct refs (`078`, final-4) | Setup85.100s; owner487.808s; total case573.118s; all1001 real target owner arrays/reserves checked |
|101 after late alias/reclaim guards (`086`, final-5) | Setup2.770s; owner11.098s; pass |
|Owner array above64KiB |10000 real owner IDs; original canonical replacement/removal at full measured file-payload budget; before/after rename and held-capacity controls |
|Long metadata/identity | Actual source path far beyond64KiB; independent literal row/hash/byte expectation. Separate streamed large source-identity digest control without treating a genuine source-policy mismatch as capacity success |

These are correctness and physical-funding controls, not latency qualification. Repeated physical inventory scans while funding many refs are expensive and show substantial scaling cost. Source commitment walks still perform repeated canonical metadata checks for repeated observations. The final private reader uses a bounded root-to-leaf proof instead of reconstructing full mutable scratch for every point lookup, but directory EOF/hint-count checks and SQLite metadata work still have plan-size costs. B2's existing immutable-payload validation compilation remains separately measured R6 work. None of these costs was hidden by a total-ref cap, fake receipt, in-memory spill workaround or producer rerun.

**Failure/setup receipts retained**

`001` is disabled-default capture setup; `002` is the meaningful strict pre-READY body-read RED. Early type/import/path/fixture ordering failures (`003`..`015`) are not counted as behavioral RED. All their files remain. The real broker/F0 self-conflicts were resolved by L1-16's separate handoffs.

Other useful preserved causal failures are: funded-journal growth at full quota (`018`); native close fd4 still alive after apparent store close (`028`); source property-order retry conflict (`038`); undefined optional live metadata differing from its JSON manifest (`040`); stale-map source clear deleting an already-landed target (`042`); managed-only deletion regression (`054`); fractional expiry rejection (`075`); real cross-ref/outside canonical corruption and incomplete shrink recovery (`079`); malformed host capabilities/null metadata (`081`); and stale read/search payload after actual body-await expiry (`087`).

`026` also preserves an oracle correction: a landed legacy application alone cannot issue B2's still-missing seed/completion. Passive B2 stays blocked, while direct original legacy reconciliation can confirm its physically landed application. Actual fresh authorized finalization then reaches READY. `031` preserves a test-cleanup reset mistake around a deliberately consumed close; it was corrected without changing product assertions. `036` preserves the summary-scale fixture's wrong rewind anchor; it was fixed to anchor the actual later hidden turn before real101/1001 qualification. `056`/`057` preserve test-only TypeScript fixes for the native overload wrapper and readonly ambiguous-seq fixture. `073` and `074` preserve both native setup and real instrumentation failures; L1-21 changes observation attribution, not the causal assertions or product accounting.

**Limits and handoff obligations**

Filesystem errors, torn/foreign terminal records, ambiguous rewrite phases or lost original source authority return honest unknown/unavailable/policy/conflict outcomes. They are not automatically repaired into live permission. Reliable hardlinks, native nonzero inode/device identity and exact link counts are required for tracked transfer setup. Windows was actually exercised; other filesystems/platforms were not newly qualified here. Physical payload reservations do not promise against device failure or allocated-cluster exhaustion.

Derived-index repair can require actual free space; full-budget repair refusal is tested and documented. Obsolete plans/disposition metadata are conservatively retained and charged. There is no new background eviction or metadata-GC policy. Cold partial transfers cannot invent missing pages/application or B2 payload. A new active attempt requires the same genuine original witness and fresh actual host lifetime, rather than a matching label/count alone.

F1-C still must construct the actual public CLI/Gateway services with strict mode, wire their real legacy read/search observations and fork callers, preserve host callback/F0/project lifetimes and original-witness continuation routing, and replace the public semantic raw-archive fork path. Desktop/SDK/CLI/Gateway public fork rollout, packaged release gates, installed profiles and version completion were not performed by this owner task. Root must review the entire BASE..HEAD range and decide integration.

**Review round 1 — ChangesRequired corrections, frozen for the same reviewer**

Review input: `D:/I-harness-main/.superpowers/sdd/2026-10-25-legacy-fork-retention/task-1-review.md`, reviewing original HEAD `16f7c0bab79792db7fc0f47381c4416b990c55e4`. The original evidence001..092 and scale fixtures/measurements remain preserved. This addendum supersedes any earlier qualification wording about the newly identified cuts; it does not retroactively turn earlier runs into final-source qualifications.

Fix commit: `7c1ee4536fdec6ff8ad73beedfd47cfc839ca79b`, `fix(context-output): fence foreign legacy paths and pruning`. Ten scoped ContextOutput source/test files changed. No integration, public caller rollout, push, tag, release, profile operation, new dependency/worktree, or subagent. Protected `.task3-evidence/` untouched. Tracked working tree is clean.

Actual causal findings and changes:

- **P1 disposition write containment:** `readSlots` still returns read-only unknown on unsafe paths. Explicit terminal mutation now separately proves both slot paths with `ownedPath`, native bigint file identity, regular-file kind and exact nlink1. It validates each opened handle against the actual current path before I/O, and requires the exact active tuple before deterministic same-owner inactive repair. Rejected symlink/junction paths and hardlinked aliases never become writable torn slots. Original acquired handles remain inside `try/finally` retirement before after-await guards can throw. Actual file symlink and hardlink negatives preserve outside bytes; redirected original parent preserves both outside slot bytes. A real service target-clear negative refuses without changing outside inactive bytes or canonical owner array. Existing actual torn independent slot repair remains GREEN.
- **P2 namespace creation:** shared internal `ownedMkdir` validates each existing ancestor before creating the next component, then validates the new directory before descent. Transfer publication and disposition funding use it instead of recursive mkdir-before-check. Actual junction controls cover a pre-existing already-open ContextStore and direct original funding; no outside directory or file is created.
- **P2 original listener lifetime:** scope cleanup ownership enters the actual scope map before intrinsic installation. A throw-after-possible-install marks the scope invalid, drops its source/view/host capture, and attempts the original intrinsic removal. Successful removal retires the unreturned token. Failed removal retains that same original cleanup debt for service.close, which retries it. The native-signal tests use real add/remove and `node:events.getEventListeners`, including throw after actual registration and first removal failure; no listener remains after confirmed cleanup. There is no fake successful cleanup flag.
- **P3 closed codec:** explicitly present `via:null` now enters the immediate-via validator and rejects; it is not treated as omitted.
- **Startup/prune authority:** ContextStore validates committed original transfer namespaces before startup can reclaim canonical tombstones. It confirms namespace/invocation/workspace identity, exact original binding/root/application, complete bounded page graph, revoke state and row expiry tuples from original files. Before expiry pruning it repeats this read-only authority preflight; for a ref with a funded expiry slot it additionally requires that exact full commitment in a confirmed original application before terminal expiry and canonical deletion. Expiry.0 existence alone supplies no GC authority. Derived SQLite hints do not authorize deletion, and validation writes no replacement root, binding, slot, owner or application. Incomplete applications remain available for original-source continuation but do not acknowledge funded expiry as a completed transfer. The actual corruption tests independently damage committed plan, page and revoke disposition, then exercise real capture-triggered expiry prune and a cold reopen/capture attempt; both original body and manifest remain byte-identical. Valid historical GC and fractional expiry controls still pass.

**Causal original-witness qualification**

The initial added negatives in096 ran after the fixture's broker preparation had closed. They were not causal evidence for original witness invalidation and are retained only as an explicitly rejected premise. The test fixture now offers an `afterAttempt` callback **inside** the actual live host preparation, before scope and broker cleanup. This is a test helper change, not a production callback/API.

In103, strengthened by105, actual publication loses its response after the original `pages/0-0.json` link, without aborting the registered scope. The same original scope then continues before host finally. The unchanged witness confirms the remaining original application. The negative arms cause real ManagedDocument metadata admission, coordinator.closeManagedDocument, or service source-clear plus original document close. The final tests explicitly prove the target broker capability still passes, while the actual captured original source-current capability fails; they then confirm the owner refuses. No closed-broker or F0 self-write conflict explains those negatives. Changed view length is also guarded directly by the owner. Source-clear additionally retires the affected original scope. Exact original prefix/directory entries, canonical owners and body remain unchanged by refused continuation. No source reopen, seed re-export, new compile, capture or producer occurs.

This SAME-live-scope continuation is distinct from the existing fresh-authority warm positive, `stops after a real page and continues the exact original prefix with fresh scope and no capture work` in `legacy-fork.test.ts`. That test aborts the first scope after a real page, exits through actual closeLegacyForkTransfer and preparation.close, then registers a fresh broker preparation and legacy scope over the same unchanged original ManagedDocument and cached actual B2 request/facts. The new scope confirms the exact original prefix and suffix owner-only with zero L1/source compile/export/capture, and actual B2 finalization reaches READY. It passed again in104. Existing unmanaged outer-F0 positive/cold-source-free path also passed104; this report does not relabel it a partial-prefix F0 warm test.

**Review-round receipts and final source segmentation**

All Vitest invocations used package cwd `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main/packages/context-output`, sequentially with maxWorkers2/minWorkers1. No 1001-distinct or10001-observation scale rerun was performed in this fix round. Earlier scale evidence remains qualified to its recorded source.

| Receipt | Actual result and scope |
| --- | --- |
|093|Causal RED: outside inactive symlink bytes overwritten; outside hardlink terminal call resolves; junction funding creates outside directory; via:null accepted. Four failures,5 passes.|
|094|Initial containment/codec fixes:9 passed.|
|095|Causal RED for intrinsic listener retention, already-open publication junction outside creation, and3 committed authority corruption cases losing original manifest during GC. Also3 invalid witness test setup/oracle premises retained, not counted as behavior RED.9 failures total.|
|096|Listener/namespace controls pass; initial witness negatives use invalid already-closed broker premise and are superseded, not accepted as causal.6 total passes with that qualification.|
|097|Actual committed plan/page/disposition corruption before hot/cold expiry GC, plus valid historical/fractional expiry positives:5 passed.|
|098|Original slots:8 passed, including redirected parents, real symlink/hardlink outside byte preservation, original after-open guard invalidation closes acquired native fd, and torn original repair.|
|099|Broad run lacked required IH_CONFIG_DIR:11 fixture import/setup refusals,22 passing files/158 passing tests,1 intentionally not repeated10001. Retained as setup failure; no product failure hidden.|
|100,101|ContextOutput and core-session typechecks exit0.|
|102|One actual service target-clear outside-symlink control passed. An attempted Python edit before this command used an unavailable WindowsApps alias, exited1 with no output/no edit; corrected with apply_patch.102 does not claim witness cases selected.|
|103|Same still-live actual host/scope unchanged positive and changed/closed/lost source negatives:4 passed.|
|104|**Affected ContextOutput fast package gate:33 files,267 passed,1 intentionally unrerun10001, exit0.** Excludes `legacy-fork-scale.test.ts`. Includes original managed integrity, transfer, quota, close and all new containment/lifetime/authority controls. Fresh isolated IH_CONFIG_DIR, integrity and legacy evidence directories are recorded in104-command-result.json. Duration61.86s.|
|105|Final test-only strengthening explicitly proves live target broker + failing original source guard for3 negatives, unchanged positive:4 passed. Production bytes identical to104.|
|106|Final ContextOutput source/test typecheck exit0. Core-session typecheck101 is unchanged-source evidence for this round; no core product changes occurred.|

The full old session-persistence semantic-fork baseline RED070 remains later F1-C debt exactly as before. No assertion or test was skipped/waived to declare public fork GREEN. The1 skipped10001 in104 is the deliberate expensive earlier scale qualification; both distinct-scale cases are excluded as explicitly recorded. This is not a full monorepo requalification.

Final reviewed source manifest: `task-1/source-review-round1-final.json` (39 hashed files, including previous unchanged root fingerprint files). `task-1/review-round1-source-verification.json` confirms all39 hashes, current HEAD `7c1ee4536fdec6ff8ad73beedfd47cfc839ca79b`, Git tree `546b47435bc684e5ef9acf79224592d8b38b7c78`, correct branch/cwd and clean tracked status after commit. `review-round1-committed.patch` and `review-round1-commit.txt` freeze the same review delta. Production bytes in104 match final commit; only the explicit witness-guard assertions/formatting in105 were added afterward, followed by106 types. Raw logs093..106 are retained. Adjacent command/result JSON104..106 and the round command index preserve cwd/exit/selection.

Remaining limits are explicit. Native original-slot identity requires reliable nonzero bigint ino and exact nlink1; no fallback or copy is invented. Startup/TTL validation streams original graph metadata and can refuse unavailable/corrupt committed authority rather than reclaim it. It does not repair corrupt authority. Full graph/slot checks add startup/expiry I/O and may repeat across expiring refs; this is R6 measurement debt, not a performance qualification or a point-read new authority. Current owner remains the one ContextStore/main index/L0 physical quota. No universal no-fail reads/full-quota repair claim, public caller rollout, new background GC, non-Windows filesystem qualification or version acceptance is made. Same reviewer and root own re-review and integration.
