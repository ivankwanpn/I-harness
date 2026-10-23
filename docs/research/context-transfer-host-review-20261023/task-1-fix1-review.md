# Task 1 fix1 re-review — e0196e85..afd10203

## Verdict

**Spec compliance: ✅ R1 ADDRESSED; R2 ADDRESSED under the current T-07/T-08 contracts.**

**Task quality: Approved for the Task 1 artifact primitive gate.** No new blocking issue was found in this fix. Genuine Task 3 broker/coordinator composition remains a dependent qualification requirement, not a result of these callback-boundary tests.

Reviewed exact range `e0196e85eaf28de75fbf9fb43ab07be4bef9e4e7..afd10203e169114f01297d0a5edffacf7b43f99d`, using the complete supplied two-file diff and the appended fix-round report. This is the same reviewer's scoped R1/R2 assessment, not a restart of the initial thirteen-file review.

## Finding disposition

**R1 — ADDRESSED.** `packages/context-output/src/artifact/bootstrap-transfer.ts:54-59` strictly captures the current target source identity while preserving the original immutable target baseline and revocation checks. `:107-112` uses that genuine captured capability for staging and compares an original owner's sourceId, when present, against it. Both roots (`:120-122`) and retained members (`:137-139`) undergo that check, and `:186` checks every retained operation again before final acknowledgment. The ordinary target `authorizeResult` calls are removed from both transfer modes. Ordinary body-read authorization code, public visibility, and pin/witness formats are unchanged by this fix.

The real-service controls at `test/bootstrap-transfer.test.ts:274` verify that a denying or throwing ordinary target authorizer is never invoked during NEW or PASSIVE confirmation but still denies the subsequent ordinary member read. The root/member source-mismatch controls at `:289` first establish permitted source reads, then require typed staging refusal before target publication. The legacy source-less control at `:298` retains the existing read-owner behavior without inventing source metadata. Correcting the fixture's unrelated target sourceId and changing the passive ordinary-read-policy expectation at `:250` are justified by T-07; the actual body-read denial assertion and separate target-capability revocation remain.

**R2 — ADDRESSED.** `packages/context-output/src/artifact/bootstrap-transfer.ts:78-89` records distinct full-ref/direct and full-ref/via-catalog relations and invokes the existing internal source authorizer afresh. The map contains descriptors, not cached authority decisions. `:91-97` accumulates every relevant relation on shared pin/access publications and rejects inconsistent values at a shared path. A member encountered through two catalogs retains both source authorization relationships.

All source relations are validated before publication during traversal (`:121`, `:138`), renewed after metadata/quota preflight (`:164`), and the relevant relations are renewed before directory work, immediately before immutable continuation, and after it (`:166`, `:174`, `:176`). Every authorization await is followed by the existing currentness checks. After final publication and integrity confirmation, `:189-190` renews all relations and performs the final synchronous checks before returning confirmed. PASSIVE returns from renewal at `:85` before accessing source authorization and retains its source-independent exact-publication behavior.

The tests at `test/bootstrap-transfer.test.ts:314`, `:326`, `:343`, and `:365` cover quota-preflight denial, the reviewer's first-target-pin denial, one denied relation of a shared member during unrelated catalog publication, and late final-integrity denial. They assert typed refusal, truthfully retained partial/final bytes, preserved access through the other catalog, and source-free passive confirmation or unavailable disposition as appropriate. These controls directly address the earlier false-confirmed result.

## Verification and limits

- Read the recorded R1 RED/GREEN logs: five meaningful R1 failures with 26 passing tests, followed by 31/31 passing. Read the recorded R2 RED/GREEN logs: four late-policy false-confirmation failures with 31 passing tests, followed by 35/35 passing. Their before/after manifest hashes were independently recomputed and agree with the stable result records.
- Read final raw logs and result records under `.tmp/context-transfer-artifact-20261023/f1ct`, `f1all`, `f1nt`, and `f1nty`: context-output typecheck exit 0; 21 files / **169 tests passed**; four native dependency files / **11 tests passed**; session-executor typecheck exit 0. No warning/error noise was found in these final logs. The 35 focused tests are included in 169 and are not additional coverage counts.
- Independently hashed all **4,178** current source-manifest files: zero mismatches against the final tested snapshot. Both changed physical files match the commit-binding record, and its normalized/committed blob identities agree with the reviewed diff. Final manifest SHA256: `a835bd171f6aec47770d195cbec08583f67599d5f28fbe1b889d5cdb27f9c010`. Binding SHA256: `801095117cc0d812cd95dacde7b10ffac2d87ac341892d9eab3780c4f9b73d7c`.
- No tests were rerun: the fix diff and recorded targeted evidence resolved the previous doubts. No new probe, subagent, product/index/HEAD mutation, or git-state command was needed. Only this requested review report was written; all review commands completed.
- The initial review's evidence limits remain: callback-boundary tests do not prove actual broker preparation or READY target body access; original Task 4 caller cutover, the separate audit collector work, and the historical long-path SQLite failure remain outside this fix. No whole-Task-3, publication, or decomposition completion is claimed.
