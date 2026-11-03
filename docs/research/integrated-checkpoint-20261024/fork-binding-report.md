# F0 connected owner packet — Task 1 report

Status: implementation committed and frozen for fresh full-range owner review. This is staged F0 owner work, not shipping fork completion. Root owns review/acceptance and subsequent F1 dispatch.

Native sole-writer/runtime checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`

Branch: `codex/fork-binding-observation-20261024`

BASE: `ca81bdd2ec944105b9fd62534a932336e587179e`

HEAD: `ab314b81e70a75c884fa4edf572db567f638357e`

Commit: `feat(persistence): observe fork bindings under owned leases`

The entire tracked plan and root SDD ledger were read. Root rulings F0-01 through F0-06 govern this implementation. No child agents, remote actions, live user providers, or accounts were used. Native host evidence is Windows only; Linux is an existing supported locking implementation, not a host-verified claim from this packet.

## Connected implementation

All three implementation steps are included in this one 11-file range (879 additions / 180 deletions):

- JSONL adds optional strict `readDocumentObserved`, with storage-root stat/readability checks and tombstone checks before and after actual document IO. Only document-file ENOENT under an available untombstoned root produces absent. Existing tolerant `getDocument` remains tolerant. Tombstones carry `SESSION_DELETED`.
- Ownership replaces temporary booleans with identity claims on the actual held/acquiring/releasing slot. Pins, repair borrows, and persistent promotion share one acquisition flight. Last temporary cleanup cannot release an independent live adopter. New claims wait for an existing release incarnation. create/adopt/load cleanup drops its own claim, and successful owned load retains live ownership.
- Documents owns the new private `binding-observation.ts`. Scopes register synchronously; request admission captures bounded distinct IDs and canonical invocation without invoking own accessors. Session pins are acquired before exact sorted binding-document OS leases. Existing-session profiles use short lanes; target profile is never called. Strict captured values are immutable. Callback and lease lifetime are outside the document chain and session lanes.
- Synchronous pending mutation admission revokes affected scopes before put/strict/create/updateMeta/deletion and facade retirement await anything. Writers join observation cleanup outside their existing lanes/chains. Private AsyncLocalStorage tracks the full nested callback stack, rejecting self-waits while permitting disjoint work.
- Deletion captures its manifest before its first await, revokes/joins scopes, then takes direct sorted document leases under existing session ownership for actual tombstone/unlink. Its keys and backend manifest cannot diverge if the caller changes an array during the join.
- Facade close fences observations permanently, joins actual acquisition/callback/disposal lifetimes, then closes managed owners. Unknown observation/managed work preserves dependent original session ownership. Independent write-behind/doc drainage is attempted through lifecycle close with ownership retirement disabled. Normal ordinary coordinator reopen behavior remains available.
- Native release errors are retained as cleanup debt. If the primitive consumed its held bit before throwing, its subsequent no-op cannot establish success. If the same native capability demonstrably remains held, retry uses that same capability. `ownerOf` reports the primitive's actual held resource bit; debt separately refuses usable authority. No native backend implementation was changed.
- Exact captured target bootstrap runs through the original managed/bootstrap owner; the temporary target pin does not retire its live promotion. A different invocation, ordinary observed-target loader, and later bootstrap adoption during explicit retirement are refused. Malformed original bootstrap request refusal still does not execute accessor fields.

No executor/context-output/result-store/assembly/SDK/CLI product file was changed. No package version, Session12 format/schema, or new project authority registry was introduced.

## Final source-bound verification

All Vitest invocations ran sequentially from their package CWD, using `pnpm exec vitest run ... --maxWorkers=2 --minWorkers=1`. Source was frozen before the final package commands. Both final typechecks also ran from their package CWD.

| Final command | Actual outcome | Receipt |
| --- | --- | --- |
| persistence full Vitest | 227 passed, 1 known F1 RED; 31 files passed, 1 failed | `evidence/task-1/persistence-final.log`, `.exit` = 1 |
| JSONL full Vitest | 264 passed; 21 files passed | `evidence/task-1/jsonl-final.log`, `.exit` = 0 |
| persistence `pnpm exec tsc --noEmit` | exit 0 | `evidence/task-1/session-persistence-types-final.log`, `.exit` |
| JSONL `pnpm exec tsc --noEmit` | exit 0 | `evidence/task-1/session-persistence-jsonl-types-final.log`, `.exit` |
| `git diff --check` | exit 0; only existing Windows line-ending conversion warnings | `evidence/task-1/diff-check.log` |

The observation file contributes 32 passing tests; strict JSONL reader contributes six. Existing ownership, repair/load, managed, document ordering, bootstrap physical, deletion, format predecessor, native replay and journal controls ran in the full packages.

The persistence failure is `test/semantic-fork-baseline.test.ts`: archived fork output still contains `CONSUMED-PROOF-ONLY`. Root explicitly identifies this as the original F1 obligation, not an F0 failure or waiver. The test source, fork.ts, seed.ts and core-session source are diff-empty against BASE, recorded in `evidence/task-1/f1-paths-unchanged.patch`. No failing oracle was edited. The earlier broad receipt was 205 passed / this same one failure; the final broader count includes additional F0 tests. JSONL's expected injected managed journal file-close diagnostic remains visible in raw logs.

`final-freeze/manifest.json` includes exact bytes/SHA256 for all 11 files and copies of source. `committed-source/manifest.json` binds the same bytes to HEAD. `freeze-comparison.json` confirms all final test source hashes match committed source. `full-base-head.patch` and `.stat` cover the entire BASE..HEAD range. `status-final.txt` shows only the four preexisting protected retirement directories as untracked; they were not edited, deleted, staged, or run.

## Causal RED and failure cuts

Initial RED was before product changes: strict JSONL read was absent, observation was absent, and pin ownership was absent. `red-head.txt` records BASE; `jsonl-red-corrected.log` and `observation-red.log` record the missing production capabilities. Early commands predate the per-gate snapshot helper; their tool transcript and BASE receipt are retained, and these early receipts are not represented as having captured a contemporaneous copied source tree. Later gate directories include exact source copies/manifests before their command.

Additional named causal REDs and subsequent GREEN receipts:

| Actual RED | Cause proved | Subsequent receipt |
| --- | --- | --- |
| `edge-red.log` (three failures) | ordinary self-put swallowed conflict; close entered a disposer twice; different target invocation bootstrapped ready | `edge-green.log` |
| `ordinary-loader-red.log` | observed target reached actual ENOENT through normal managed loading instead of self-wait refusal | expanded/final controls |
| `deletion-manifest-red.log` | caller array mutation changed the durable deletion receipt to an empty document set | expanded/final controls |
| `independent-drain-red.log` | unrelated queued write remained absent after unknown managed close | `independent-drain-green.log` |
| `nested-context-red.log` | inner disjoint callback waited for its own outer observation | `nested-context-green.log` |
| `held-resource-red.log` | ownerOf incorrectly returned false for a demonstrably held resource after a release failed before native action | `held-resource-green.log` |
| `retirement-bootstrap-red.log` | a later target bootstrap adopted during explicit retirement | `retirement-bootstrap-green.log` |
| `bootstrap-accessor-red.log` | facade executed an accessor invocation field before original-owner refusal | pre-final/final controls |

The close/acquisition tests cut each of five acquisitions (two new session pins plus three document leases, with an existing persistent source). For every cut: callback count 0, temporary native live count 0, acquired and released counts equal the cut, and source ownership is released only after close joins. Abort likewise waits for a real acquired-but-not-returned handle, then releases it with callback count 0.

The native disposal fault fixture uses actual OS acquisitions and a controlled primitive-boundary throw. One control throws after underlying release: all three temporary disposers are attempted, original callback result/invocation are retained in the aggregate, repeated close remains rejected without treating raw held=false no-op as proof, and persistent source ownership remains held. This demonstrates truthful debt accounting; it does not claim an actual kernel CloseHandle failure was forced. A complementary cut throws before native action, proves the raw resource remains held, refuses authority/new pins, and succeeds only by retrying the same native handle. Fixture-only raw handles are explicitly cleaned after debt assertions.

Actual JSONL managed unknown controls issue through the original backend, preserve the original key, make close reject with source ownership held, restore original backend reconciliation, and recover through the same document/key before successful close. Independent queued writes are durably flushed during the failed close without releasing the dependent source lease.

Other concrete controls cover real shared-lockRoot coordinator document exclusion; direct manifest lease exclusion for external deletion; local synchronous metadata ABA and deletion revocation; final guard rejecting callback success after revocation; other-key progress; strict present/ENOENT/EACCES/EIO/bad JSON/root inaccessible/missing/tombstone recheck; readonly immutable captures; unsupported locking/backend withholding; passive target-only profile trap; callback self-write/update/delete/release/close/nested refusal; explicit retirement/adopter/reopen; original-bootstrap target promotion; and actual source-event append witness remaining separate from binding ownership.

A genuine nonempty semantic source is exported under the original source view/witness, bootstrapped with original invocation and guards outside the target lane, remains owned by the original managed target, and is read cold from JSONL. Its external dependency closure is empty and its dependency port throws if called. It is not presented as F1 nonempty catalog/member transfer coverage.

## Preserved setup/failure receipts

- First JSONL fault fixture attempted ESM `spyOn` on the native namespace. `jsonl-red.log` contains the setup errors. Corrected module mocking then produced the intended missing-capability RED in `jsonl-red-corrected.log`.
- An early Python edit helper exited 1 without output on this host; the intended caller edits were subsequently applied with apply_patch. No product edits from that helper were assumed.
- An early Node helper used a repository-relative path while in package CWD and failed ENOENT before editing. The tool output records it; actual source edits used apply_patch afterward. `affected-initial.log` is the subsequent test command's separate receipt.
- `persistence-types-initial.log` is the tsc help/setup failure from an accidental repository-root invocation without a tsconfig. Later package-CWD typecheck receipts replace no logs and provide the actual validation.
- `failure-controls-initial.log` and `failure-controls-green.log` preserve a fixture error: managed reconcile was initially called without its original batch key (the initial no-commit variant also could not establish recovery). Corrected control performs an actual append whose response is unknown and reconciles the original captured key. `failure-controls-corrected.log` is the passing receipt.
- `strict-expanded.log` preserves a mock-reset setup failure (`read.mockClear` after namespace restore). The corrected spy fixture passes in `strict-expanded-corrected.log` and final JSONL.

No receipts were deleted or overwritten to conceal failure. `evidence-manifest.json` hashes the evidence subtree excluding itself.

## Remaining acceptance boundary

Fresh full BASE..HEAD connected owner review remains required. Source writes are stopped after this report and evidence handoff. Root may request corrections based on that review.

The real F1 `acquireCliForkTransfer` production caller, actual stdio fork request, nonempty result catalog/member transfer, cold ordinary target read and original-invocation adoption remain mandatory. No fake caller, reachability waiver, export reseed or production-consumer claim was added. Normal reachability is deferred exactly as the plan requires until the actual consumer is present; staged observation exports remain visible for that later vertical range. General decomposition, native backend changes, remote release and version/schema work remain outside this packet.
