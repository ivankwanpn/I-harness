# Task 1 evidence and source binding audit

Frozen range: `ca81bdd2ec944105b9fd62534a932336e587179e..ab314b81e70a75c884fa4edf572db567f638357e`. Checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`.

The current packet is internally consistent and its final eleven changed files bind to the frozen commit after explicit Windows line-ending normalization. This is an evidence audit, not product acceptance. Product logic is reserved for the separate reviewer. No product runtime, tests or builds were run; no Git state or product files were changed. Only this Markdown file and its JSON companion were written. Protected retirement directories were not inspected or touched.

## Current inventory and frozen source

- Independently recomputed all 295 entries in `evidence/task-1/evidence-manifest.json`: every path exists, byte count and SHA256 match, and there are no extra files under the evidence subtree excluding the manifest itself.
- Manifest SHA256: `18ab5f97557fd54c72f1e9b205fbd45c684111c4bcbaa6b92a29072bfdd0637a`. Report SHA256: `8d494615dd60f67a1af065ae593f64bf114567abbd8b0897713500e78370d6d1`.
- Git independently gives exactly 11 changed paths, 879 additions and 180 deletions. The saved full patch is byte-identical to fresh read-only Git diff output (88,113 bytes; SHA256 `6a4c7e45e10b3551e2dce318c532957d1c190af984d63f85f9502bc28057ddea`). Saved stat matches as well.
- All 20 gate/source manifests contain 11 files and match their own copied bytes. Every final-freeze file equals the committed-source copy and current physical checkout file. Current tracked worktree and index diffs against frozen HEAD are empty; no untracked directory inspection was performed.
- Frozen HEAD has BASE as its parent. The final-freeze manifest records BASE as its then-current precommit HEAD; this is expected metadata, not a claim that its copied changed files are BASE contents. The committed-source manifest records final HEAD.

Physical SHA256 and canonical Git SHA256 must be kept separate. Nine source files contain CRLF (some mixed with LF) and differ byte-for-byte from their Git blobs; removing CR from CRLF gives exact canonical Git bytes for all eleven files. The two new tests are already byte-identical. Thus “same bytes bound to HEAD” needs the line-ending qualification; `freeze-comparison.json` alone compares copied physical files and does not establish raw Git-blob equality.

| Changed path | Physical SHA256 | Canonical Git SHA256 |
| --- | --- | --- |
| `packages/session-persistence/src/coordinator/documents.ts` | `ef03e4df71588521f054b810bedc52e6f738de3bf672fc1ecee31bdcffbfeedc` | `306a13cfd3cd8e4fbb8fbcdc8ff58d3664af2e44a3dd9f62b345c73fb9b9cbda` |
| `packages/session-persistence/src/coordinator/ownership.ts` | `159bf69f8e00e2d1b46de75f465f49d4451c75b39a9544b59cb9248b040cdd89` | `fdcce3d861b98cb2a4322451ebce92ba544c2cf27927c3e9884b3e1a8aa58edb` |
| `packages/session-persistence/src/coordinator/mutations.ts` | `f784db59d19a3e1c94366e16b53d367e03f925abbaa3ab126a75594d1a548308` | `622207b749ea0f71873fe38909e90c8ebe2f5da55553410872f81cfff41b28a0` |
| `packages/session-persistence/src/coordinator/load.ts` | `66e206124d16f77a342b73057be6f642e2ddaa640b10468153d8778c18358f6c` | `08ef7ec6e8e20cf7d7aa412312f0aa322a4b11b0ed367df00dc23cc710533cc1` |
| `packages/session-persistence/src/coordinator/lifecycle.ts` | `93ce635d98e188942b097ae93efacaec4b6208c2d35bc460c760d8fc212529b8` | `bae322f29ffbf4b710261968f4da7d1d889eeb34be23d54c36ea02371c20f7a1` |
| `packages/session-persistence/src/coordinator/types.ts` | `2ca2149d8068b75d4e18da8e825380814932c13c5a84e18a8be5b2b1a9a3d9e5` | `f332f259fdac743d6098448ac9561959f104055ecdc2bee7b7bd32c2e49295d9` |
| `packages/session-persistence/src/coordinator/binding-observation.ts` | `2e2076e04965d705d87176a94f6ebe822d0686c970872bee516e9d37e76f8977` | `04d6dcf067ce32e9e67ec31fd87835bb91e32b821efdeba29d6c8d064423a9e8` |
| `packages/session-persistence/src/index.ts` | `805ef4764230dffcacc7a98a4bfdddc29d0896703d8a1b5cb1dc7676eadc74de` | `11f2902d21699a1e4d18f9aa0d24a72ef334e03ed3363f8df21e1f84a45f854d` |
| `packages/session-persistence-jsonl/src/index.ts` | `bdf01fc4ab95a758aeb51fd5396a704a7f8e49b4d00fbeb3885d211005655f24` | `6929f53ec47d6be54dc250af272d2cf0104cf273fa4206db2dfde05cb7d50828` |
| `packages/session-persistence/test/binding-observation.test.ts` | `a929516ff3956f6f5809380d32ef9996ec28d47730b6f5e26d44e53348335105` | `a929516ff3956f6f5809380d32ef9996ec28d47730b6f5e26d44e53348335105` |
| `packages/session-persistence-jsonl/test/document-observed-read.test.ts` | `96c307b6c06ecf6e25d202298f2247bb21251e597e4b80db86595b631e935217` | `96c307b6c06ecf6e25d202298f2247bb21251e597e4b80db86595b631e935217` |

The JSON companion preserves byte counts, Git blob IDs, per-file comparisons, gate timestamps and differences, and raw-log failure summaries.

## Final recorded outcomes

| Receipt | Recorded outcome | Evidence qualification |
| --- | --- | --- |
| `persistence-final.log` / `.exit` | 227 passed, 1 failed; 31 files passed, 1 failed; exit 1 | Observation file contributes 32 passing tests. Full package remains red. |
| `jsonl-final.log` / `.exit` | 264 passed; 21 files passed; exit 0 | Strict reader file contributes 6 tests. Expected injected managed-journal cleanup diagnostic appears. |
| `session-persistence-types-final.log` / `.exit` | Empty log; exit 0 | Saved sidecar supports outcome; exact command and CWD are report assertions. |
| `session-persistence-jsonl-types-final.log` / `.exit` | Empty log; exit 0 | Same qualification. |

The final persistence failure is exactly `test/semantic-fork-baseline.test.ts > fork archives only the current summary and typed tail, without consumed proof bodies`, line 40: child events contain `CONSUMED-PROOF-ONLY`. The broad earlier log has the same assertion with 205 passing tests. This is the report/root-designated F1 obligation, not a passing F0 suite or a waiver. No baseline run was repeated.

Git object equality confirms `src/fork.ts`, `src/seed.ts` and that failing test are unchanged. The entire `packages/core-session` tree is unchanged, including seed-export, and the entire `packages/fs-lock` tree is unchanged. The eleven-path range also excludes executor, assembly, SDK, CLI, context-output and result-store files. Empty `f1-paths-unchanged.patch` is corroborated by Git rather than trusted alone.

Final-freeze and committed-source copies have the same eleven hashes; no mismatch is hidden by `freeze-comparison.json`. The freeze timestamp and Vitest start times are consistent with final package execution after freeze and before committed-source capture. A snapshot plus later equality cannot prove an uninterrupted historical freeze or the exact source loaded by every process. Only eleven files were copied; installed dependencies and full runtime environment were not attested.

## RED identities, repairs and counterclaims

| Gate | Actual raw failure / passing receipt | Audit finding |
| --- | --- | --- |
| initial-strict | `jsonl-red-corrected.log` → `jsonl-green-initial.log`: Four tests fail because backend.readDocumentObserved is not a function. | causal missing capability; early source binding limited. First jsonl-red.log mixes two capability failures with two ESM spy setup failures. Corrected log has four missing-capability failures. No contemporaneous initial source copy. |
| initial-observation | `observation-red.log` → `observation-green-initial.log`: Seven failures: one owner.pinOwnership missing, six c.withSessionBindingObservation missing. | causal missing capabilities; early source binding limited. Proves absent entrypoints in the recorded run, not seven independently reached behavioral failures. red-head.txt=BASE and empty red-source.patch do not snapshot new untracked test contents. |
| edge | `edge-red.log` → `edge-green.log`: Self-put resolves undefined; disposal invoked twice (2 vs 1); different invocation resolves ready. | three behavioral REDs; early source binding limited. 10 tests pass afterward, but neither edge gate has a contemporaneous copied source manifest. |
| managed-recovery-fixture | `failure-controls-initial.log / failure-controls-green.log` → `failure-controls-corrected.log`: Coordinator cleanup is unresolved; 17/18 and 18/19 pass respectively. File named green still fails. | fixture correction, not demonstrated product repair. failure-controls-gate -> corrected-gate changes only binding-observation.test.ts: preserve outcome and reconcile(outcome.key), with committed assertion. 19 tests pass. No product file changes in that pair. |
| ordinary-loader | `ordinary-loader-red.log` → `expanded-controls.log`: Expected conflict, received actual ENOENT from ordinary managed target loading. | behavioral RED; preserved named oracle. 20 tests with 19 skipped in RED, expanded 25 pass. Test file changes add controls/import; named loader test is unchanged. Product changes are not a single isolated edit. |
| deletion-manifest | `deletion-manifest-red.log` → `expanded-controls.log`: Expected captured documents array; durable receipt contains []. | behavioral RED; preserved named oracle. 21 tests with 20 skipped; expanded25 pass. Existing test remains unchanged while other tests are added; lifecycle.ts changes. |
| independent-drain | `independent-drain-red.log` → `independent-drain-green.log`: Independent read has 0 events, expected 1 after failed managed close. | strong source-paired behavioral RED/GREEN. Test hash unchanged; only lifecycle.ts and index.ts change; 26 pass. Managed unknown is a controlled backend response after actual append. |
| nested-context | `nested-context-red.log` → `nested-context-green.log`: Top-level unavailable wraps assertion expected reason conflict, received literal self-wait from timeout race. | strong source-paired behavioral RED/GREEN. Test hash unchanged; only binding-observation.ts changes; 27 pass. It records timeout-race evidence of self-wait, not an indefinitely observed hang. |
| held-resource | `held-resource-red.log` → `held-resource-green.log`: ownerOf false, expected true after wrapper throws before native release. | strong source-paired behavioral RED/GREEN. Test hash unchanged; only ownership.ts changes; 28 pass. Wrapper injects failure before native action; not a failed kernel release. |
| validation-cancellation | `validation-cancellation.log`: 30 passing observation tests. | passing controls with copied source. No standalone causal RED for the validation/abort additions. Per-cut counters are source assertions, not separately emitted resource receipts. |
| strict-expanded | `strict-expanded.log` → `strict-expanded-corrected.log`: read.mockClear is not a function; five pass/one fails. | mock fixture setup failure. Corrected6 pass; later final6 pass. Mock EACCES/EIO are fault injections; actual absent/present/malformed/root deletion/tombstone operations also use temp disk. |
| retirement-bootstrap | `retirement-bootstrap-red.log` → `retirement-bootstrap-green.log`: Later bootstrap resolves ready instead of rejecting during retirement. | strong source-paired behavioral RED/GREEN. Test hash unchanged; only mutations.ts and binding-observation.ts change; 31 pass. |
| bootstrap-accessor | `bootstrap-accessor-red.log` → `pre-final-observation.log`: Accessor read count 1, expected 0. | strong source-paired behavioral RED/GREEN. Test hash unchanged; binding-observation.ts and index.ts change; 32 pass. pre-final-source differs from final-freeze in lifecycle.ts, so final package receipts are necessary. |

The strongest paired gates retain identical test hashes: independent drain, nested context, held resource, retirement bootstrap, and bootstrap accessor. Their copied sources differ only in the product paths listed in the JSON. Ordinary-loader and deletion controls retain their named assertion while additional tests are added. Initial strict/observation and edge logs lack copied contemporaneous source trees; their reported BASE association is less strong than later gates.

Initial JSONL RED is not four independent behavioral failures: `jsonl-red.log` has two ESM namespace spy setup errors and two missing-method errors. `jsonl-red-corrected.log` removes the setup failures and reaches four missing-method failures. `observation-red.log` reaches one missing pin method and six missing observation methods. These are causal absent-capability REDs, not reached validation of the later lifecycle cases.

`failure-controls-green.log` is red despite its filename. The paired corrected gate changes only the fixture to retain the unknown outcome and pass its original key to reconcile, then asserts committed. It demonstrates fixture repair rather than product repair. `strict-expanded.log` likewise fails on `read.mockClear` setup and must not be counted as a strict-reader product regression.

The early root tsc receipt is compiler help/setup, not a successful typecheck. Additional preserved receipts contain real TS2345 diagnostics in observation code/tests and strict-document fixtures. Final silent logs plus their zero exit sidecars supersede those failures for the reported final outcome without erasing them. The report's early Python/Node helper failure outputs are not separately present in this evidence subtree, so their exact history cannot be independently verified here.

## Native operation and resource-count limits

The observation test imports `nativeAcquire` with `vi.importActual` and wraps it; the underlying unchanged fs-lock entrypoint chooses the native Windows implementation on this host. Temp JSONL fixtures also perform actual disk operations. This supports real lock capabilities in these tests, with controlled wrapper faults around them.

- Five close cuts use two new session pins and three document leases while source ownership already exists. Acquisition counting starts before real native acquisition; release/live counts change after real underlying calls. Each passing source assertion requires `[callbacks, live, releases] = [0, 0, cut]`, followed by released source ownership after close joins.
- Abort blocks return after an actual raw handle has been acquired, asserts one live wrapper handle, resumes, and asserts zero live/callbacks and no target ownership.
- Disposal-debt injection calls actual raw release and then throws. It checks all three temporary disposers were attempted, original result/invocation remain in the aggregate, original source stays held, and repeated close refuses unresolved debt. It does not force a kernel CloseHandle failure. Fixture raw-handle cleanup is explicit.
- Complementary injection throws before native release. The raw held getter remains true; owner reporting and usable authority are tested separately. Retrying the same capability performs the real release.
- Managed-unknown controls call original JSONL append first and replace its response with unknown using the original key. Restoring reconciliation and reusing `outcome.key` recovers the same document. Independent queued writes are read from disk after failed close.

These numerical values are assertions in passing tests. The saved logs contain aggregate test success, not emitted per-cut counter records or a process/OS resource census. No claim of global zero leaked handles, actual native syscall failure, or Linux host verification follows. Strict-reader EACCES/EIO and inaccessible-root errors are mock faults; actual present/absent/malformed files, removed root and durable tombstones are exercised on temp disk.

The semantic bootstrap control uses an actual nonempty source event prefix, original export/compile/bootstrap path and cold backend read. Its external dependency ports throw if called, so the source has empty external dependency closure. It supplies no evidence for nonempty result catalog/member transfer, an actual production fork caller, stdio routing or later original-invocation F1 adoption.

## CannotVerify and acceptance limits

- CannotVerify exact historical command strings, --maxWorkers/--minWorkers flags, shell CWD for silent tsc, or sequential invocation from raw logs alone. Vitest RUN headers identify package roots; four saved .exit files record outcomes.
- CannotVerify initial RED source provenance beyond BASE receipt, empty tracked patch and recorded failure output; no contemporary source tree copy for initial/edge gates.
- CannotVerify source immutability during historical commands or completeness of entire runtime/dependency/environment from snapshots of eleven changed files. Current equality and chronological saved labels are consistent; snapshots are not execution attestations.
- CannotVerify an OS-wide handle/resource census, actual LockFileEx/CloseHandle failure injection, Linux execution, or crash-time native cleanup from these receipts. Counters are wrapper-local assertions over real underlying capabilities.
- CannotVerify historical nondeletion/nonoverwrite of all receipts from a present self-hashed inventory. The current inventory is complete and internally correct; manifest is unsigned, excluded from itself, and is not an independent trust anchor.
- CannotVerify the reported early Python/Node helper failures or full tool transcript from this evidence subtree; those outputs are described in report but no distinct raw helper receipt was found.
- CannotVerify saved diff-check process exit because no separate exit sidecar exists; saved log contains only CRLF warnings. No check/test was rerun to fill missing evidence.
- Known F1 classification is the report/root acceptance boundary. Same failing test and assertion are established; unchanged fork/seed/core trees support preservation, but baseline behavior was not rerun.
- No product correctness or acceptance verdict is issued. Actual production F1 caller, stdio route and nonempty catalog/member transfer remain outside packet.

The evidence inventory establishes current integrity, not historical completeness or authorship. It is unsigned, excludes itself, and can only corroborate files currently present. This audit finds no byte/hash mismatch or falsified final test count in the supplied packet. Product acceptance and F1 completion remain separate decisions.

