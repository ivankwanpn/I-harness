# Fix round 2 evidence audit

Frozen HEAD: `4d999d251823b964398348165de94ea7d432080e`; reviewed parent: `187eea5545f5ab462e210e168e2db6cb9af1deb9`; original BASE: `ca81bdd2ec944105b9fd62534a932336e587179e`.

The R2 packet is internally consistent: no artifact hash/size mismatch, source binding mismatch or misstated final count was found. This is an incremental evidence audit, not a product acceptance verdict. Initial logic conclusions remain with `root-fix-audit.json` and the independent reviewer.

No product runtime, tests, builds, Git mutations, agents, protected-directory inspection or cleanup occurred. Only this Markdown audit and its JSON companion were written.

## Inventory, report and preservation

| Packet | Listed/current files excluding manifest | Hash/size failures | Extras |
| --- | --- | --- | --- |
| task-1 | 295/295 | 0 | 0 |
| fix-round-1 | 392/392 | 0 | 0 |
| fix-round-2 | 178/178 | 0 | 0 |

All 178 R2 artifacts were independently rehashed, including command receipts, raw outputs, ten gate source copies and committed-source copies. R2 inventory SHA256: `46e57cb403829c89d443d2dd79f87816ce0887a777eef2b75f3169b8756e352b`.

`fix-round-2-report.md` matches its separate manifest entry: 8,594 bytes, SHA256 `8c827e1d258ff19ed1b0ba00eb944c45b22a527c1904525e9aa8745875ee4751`. Both prior reports and prior evidence manifests match the before/after preservation records and independently recomputed current hashes:

- `task-1-report.md`: `8d494615dd60f67a1af065ae593f64bf114567abbd8b0897713500e78370d6d1`.
- `evidence/task-1/evidence-manifest.json`: `18ab5f97557fd54c72f1e9b205fbd45c684111c4bcbaa6b92a29072bfdd0637a`.
- `fix-round-1-report.md`: `c39cd61522b5d91686b051e4428fc8530a7f3549ae66cf8ebb2f00f59ae82ba3`.
- `evidence/fix-round-1/evidence-manifest.json`: `d239b64168a8fc7022a030c79f92b59395dfbc0e5520e5caec8e04373d5ca51e`.

The old 295 and 392 entries were also independently rechecked rather than relying only on `previous-preservation-after.json`. This proves current preservation against recorded hashes; unsigned inventories do not independently prove all historical writes or deletions.

## Frozen and incremental source binding

Git HEAD is exactly the frozen R2 hash and its parent is the reviewed R1 hash. Incremental scope is two files—`coordinator/binding-observation.ts` and its existing test—with 65 additions and 7 deletions. Full BASE..HEAD remains the same eleven paths, now 1,155 additions and 180 deletions.

- Saved incremental patch: 10,728 bytes, SHA256 `82cea7da8aba912ab2cc70d38c6ea9d7a029fe21c8f44be5227338b6940eddc2`; byte-identical to read-only Git diff.
- Saved connected full patch: 113,033 bytes, SHA256 `7430704baee234e5f9caf6cad370ae65359d57dac56a0d0917487688d34dc49f`; byte-identical to read-only Git diff. Saved stats agree with Git.
- All eleven physical checkout files match committed-source copies and their manifest hashes. All four final gate copies independently match those same physical files.
- All ten gate manifests match their own copied bytes. RED product source matches the reviewed parent after CRLF normalization; only its newly extended test differs from the parent.
- Nine physical source files differ from canonical Git bytes due to CRLF. All eleven normalize exactly to canonical frozen Git contents, matching the separately recorded canonical SHA256 values. Raw physical/Git equality is not claimed.
- Current tracked worktree and index diffs against frozen HEAD are empty. Protected untracked directories were not inspected.

The prior 49-control observation source is an exact canonical prefix of the final 56-control file. No earlier assertion was edited in this increment. The 58-test physical bootstrap file and owned-deletion file have identical BASE/HEAD Git blobs. Fork, seed, semantic-fork oracle, the entire core-session tree (including export) and fs-lock tree also remain Git-identical to BASE.

## Causal descriptor/has evidence

The RED and GREEN snapshots contain byte-identical test files. Thus the same seven new test oracles ran before and after the product change. RED used reviewed-parent product bytes and reports six failures, one pass, and 49 skipped controls. GREEN reports seven passes and 49 skipped controls. The one already-passing test checks closed malformed/accessor refusal; it is not a newly failing product regression.

The four primary controls use actual JSONL existing-empty ancestor files, pause an external observation callback, then invoke bootstrap or resume with a guard proxy whose descriptor or `has` inspection throws once. Spies call through to five actual backend methods.

| Case | RED inspections / calls / header | GREEN and final inspections / calls / header |
| --- | --- | --- |
| bootstrap descriptor | 2 / [3,1,1,1,1] / changed | 1 / [0,0,0,0,0] / unchanged |
| resume descriptor | 2 / [3,1,1,1,1] / changed | 1 / [0,0,0,0,0] / unchanged |
| bootstrap has | 2 / [3,1,1,1,1] / changed | 1 / [0,0,0,0,0] / unchanged |
| resume has | 2 / [3,1,1,1,1] / changed | 1 / [0,0,0,0,0] / unchanged |

Vector order is `readBootstrapState`, `prepareBootstrapHeader`, `reconcileBootstrapHeader`, `appendOwnedBatch`, `confirmBootstrapFrames`. These exact facts are emitted as JSON lines in RED, GREEN and final owner stdout. RED failure output contains an actual ready document and receipt, including rewritten ancestor parent metadata, while `observed.assertCurrent()` still succeeds. This establishes a causal product failure rather than fixture setup failure.

GREEN/final assertions require manifest-invalid refusal, one inspection, no calls to the five counted methods, byte-identical ancestor file, unchanged parent metadata, normal completion of the observation and subsequent ordinary metadata progress. The 200 ms bounded race would expose waiting on the paused observation as a wrong result. It is not an unbounded liveness proof.

Two additional cases test unsupported-before-capture with `prepareBootstrapHeader` removed: RED inspects caller guards once and fails expected-zero inspection; GREEN/final pass unsupported with zero inspections. Source inspection shows the helper's enabled-lock/six backend capability expression matches the original owner's expression. Test coverage is limited to this one missing capability in bootstrap and resume; no complete missing-capability/disabled-lock matrix is claimed.

These five backend counters are not counters for every backend function, internal lane, owner callback or pending admission. No direct per-internal-entry receipt proves each such non-entry. Product source and the tested observable behavior support the report within that boundary.

GREEN source differs from final source only by two explanatory comments in the product file and the explicit mock-call type annotation in the new test. The assertions are unchanged. The intermediate `final-types-1` failure is preserved: exit 2, TS2339 at test line 601, `.mock` on `never`. The final annotation repairs instrumentation typing; final owner/JSONL suites and both typechecks all ran again on the final source.

## Exact final verification receipts

All four final gates record executable `C:/Users/inkik/AppData/Roaming/npm/node_modules/pnpm/pnpm.exe`, exact argv, package CWD, UTC start/end, exit, signal, worker values and source-manifest reference. All final commands exit zero with null signal/error; stdout/stderr are preserved.

| Gate | Recorded argv | Recorded result |
| --- | --- | --- |
| handoff-jsonl | `exec vitest run test/bootstrap-physical.test.ts test/document-observed-read.test.ts test/delete-owned.test.ts --maxWorkers=2 --minWorkers=1` | 70 passed: physical bootstrap58 + strict reader6 + owned deletion6 |
| handoff-owner | `exec vitest run test/binding-observation.test.ts test/ownership.test.ts test/managed-fact-batch.test.ts test/strict-document.test.ts --maxWorkers=2 --minWorkers=1` | 90 passed: observation56 + ownership18 + managed14 + strict2 |
| handoff-types-1 | `exec tsc --noEmit` | exit 0; empty stdout/stderr |
| handoff-types-2 | `exec tsc --noEmit` | exit 0; empty stdout/stderr |

The final owner CWD is the persistence package; JSONL gate CWD is its JSONL package. Typechecks use those respective package CWDs. The saved timestamps show all Vitest invocations sequential; final typechecks overlap as reported. Final owner runs 11:52:54.572Z–11:52:58.597Z and JSONL runs 11:52:59.164Z–11:53:04.017Z. Both final typechecks start 11:52:49.113Z and end before owner tests begin.

The saved `git diff --check` command records exit 0 with empty stdout and only two line-ending warnings in stderr. It was not rerun by this audit.

These are selected affected-file runs. Full persistence/JSONL packages were not repeated at R2 HEAD. Prior full-package results apply historically to their earlier hashes; no new whole-package-green result or newly observed F1 failure at this HEAD follows. The unchanged F1 oracle and preserved original/round-1 failing receipts maintain that obligation visibly.

## Native counts and remaining limits

R2 backend counts are call-through JSONL spies over real temp-disk work, not native resource counts. The prior I3 wrapper receipts still run in the 56-control suite and emit override-count zero, callback-count one, wrapper-live zero and normal close for five override cases. Their wrapper delegates actual native acquisition/release, but those counters remain local to the instrumented fixture. They establish no OS-wide resource census, global absence of leaked handles or actual native failure injection. Windows-only execution limits remain.

- Full packages were not repeated at 4d999d25. The 90/70 receipts are selected affected-file runs; original and fix-round-1 full package outcomes are historical evidence for earlier commits.
- The F1 semantic-fork-baseline/CONSUMED-PROOF-ONLY obligation was not rerun in R2. Its unchanged oracle and preserved earlier failing receipts establish continued visibility, not a newly observed result at this HEAD.
- Unsupported-before-capture regression controls exercise bootstrap and resume with prepareBootstrapHeader absent. They are not a dynamic matrix of disabled locking or every other missing capability. Source inspection shows the same enabled-lock/six capability expressions as the original owner; separate reviewer owns adequacy/correctness.
- Four primary refusal cases count five JSONL methods, not every backend function or every internal owner/lane/admission entry. No direct counters attest each internal non-entry; source and bounded outcome checks support the report within this test boundary.
- Actual backend spies call through to JSONL. Emitted backend call vectors and physical file comparison are not kernel failure traces or OS-wide handle/resource counts. Old real-native wrapper live counters retain their existing scope.
- Command JSON and raw outputs are self-produced receipts. They identify executable/argv/CWD/times/exits and source snapshots, but are not independent process provenance, uninterrupted-freeze proof, or installed dependency/full runtime attestation.
- Evidence manifests are unsigned current inventories, exclude themselves, and cannot prove historical nondeletion/nonoverwrite or authorship on their own. Current hashes and prior preserved hashes were independently recomputed.
- No Linux execution, native kernel-failure injection, production fork consumer/reachability or nonempty result transfer coverage is established by this increment.
- No product acceptance verdict is issued; product logic remains with the independent reviewer.

The JSON companion preserves all independently checked source hashes, all ten gate receipts and summaries, emitted R2 facts, preservation hashes, and scope qualifications. No product approval or F1 shipping/completion verdict is issued.

