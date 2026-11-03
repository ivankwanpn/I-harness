# R4A original publication and document pins — acceptance

Root accepts the test-only range `5e4f6038a98a5363babda0c9a15bbbef4dc80f1b..32c88704a56c15094d793717a1d0150799db67b1` after reading the complete independent GPT6.1Sol review and auditing original evidence. This qualifies existing artifact publication and original document-pin behavior. It introduces seven test/helper/type files and a delivery note, with **zero production source changes**.

Product **0.1.13-rc.1**, Session **10**, and the original decomposition **27/43** remain unchanged. No push, merge, tag, release, installed IH operation or live provider/account was used. R4A as a whole remains incomplete.

## Accepted behavior

The real TaskRegistry and retention owner use the original assembly result-store lease, source resolver, JSONL coordinator and deletion subscriber. The fixture requires an actual saved format-2 running task document and its exact backend bytes before terminalization. It does not trust a caught persistence flush or invent a terminal row.

Ten selected native transitions are qualified both by live reconciliation after lost acknowledgement and by hard process death followed by fresh read ownership:

- Body, leaves and index sync.
- Staged-operation and manifest rename.
- First task-document pin and access rename.
- Committed-operation rename.
- Second parent-document pin and access rename.

Every cut happens after the original native operation succeeds and before its acknowledgement returns. Exact transition prefix, transaction payload, original operation, body bytes, pin IDs and changing access pointer are retained. Both document pins have the original pending state; no nonexistent later pin-state transition is inferred.

All ten live cases reconcile through the same original capture, source binding, scope, sink and operation. Input normalization runs once. The full original JSON body is read through 17 advancing bounded pages: 262,197 bytes, SHA-256 `fc28ff87ec0ff9500a8afc32d988a8873d8823094dc7a44d7d4c078554d5aeb8`. Original task revision and manifest-derived artifact revision are distinct and preserved.

All ten selected physical children are killed through their retained ChildProcess handle and close with SIGKILL before fresh owners are constructed. Capturing/staged operations remain recovery-required. The three committed cuts return only the original immutable reference and permit current authorized reads through the original first pin. This readability does not establish a second pin or task/F1 publication. The saved running task document remains byte-identical, with no outcome, result or new parent event.

Four coupled actual coordinator deletions cannot resurrect pins or a ready artifact on same-capture retry. The original component and last store lease are then genuinely retired. A distinct fresh service observes the durable tombstone and profile/source refusal separately from stale-ref or missing-file read failure. Direct coordinator deletion is not mislabeled as the full Gateway drain lifecycle.

Real quota controls distinguish commit-reserve refusal from second-pin refusal. Actual original errors, phase and independently counted physical bytes are retained:

| Boundary | Last required successful state / failed reservation |
| --- | --- |
| Commit reserve | Last write total 1,832,386 fits 1,870,000; original capturing commit requests 1,701,282 + 198,688 = 1,899,970 and fails |
| Second original pin | Commit fits; committed physical 1,853,928 + 262,144 exceeds 2,097,152 while original first pin/body remain |

Both preserve the original successful execution outcome and explicit unavailable/quota retention. A concurrent registry join may reject the concrete quota message; a later retry keeps the same known-unavailable descriptor. Permanent component closure is monotonic and cannot restore its old capture authority.

## Verification

The [independent review and provenance addendum](context-r4a-publication-pins-review-20261021/review.md) pass both spec and quality within this scope, with no actionable findings. The [writer delivery](2026-10-21-context-r4a-publication-pins-delivery.md) preserves original implementation detail and all failed attempts. The following provenance clarification takes precedence over broader readings of its archive wording.

Final recorded gates are **28 focused tests**, **24 established owner tests**, and the explicit typecheck including all four new `.mts` helpers. The positive native interception gate also passed; its control is already included in the 28 and is not counted twice. Root did not rerun unchanged suites for this documentary acceptance.

Root's [audit v2](context-r4a-publication-pins-review-20261021/root-verification.json) verified:

- All **1,418 sealed evidence files**, totaling **52,934,253 bytes**, against their closure manifest.
- Four source ZIPs against their corresponding exported/physical content definitions.
- All **2,659 qualified current source entries**, with exactly seven added test/helper/type files and no product change.
- All **90 owned-child close receipts** and unique nonce bindings, including all 30 crash runs and three preserved failed setup children; the final selected matrix contains ten crashes.
- All **28 selected cases**, exact native prefixes, baseline bytes, operation and pin/access identities, independent body/page checks, fresh classification and real quota arithmetic.
- Fifteen command/exit receipts and the exact focused/established final log counts.

Evidence remains at `.tmp/context-r4a-publication-pins-20261021-implementation/`. Closure SHA-256: `989a4476dce47cb06d4e543fc8a596d5aea4ee6068e5408b8824286f6a81785d`. [Handback](context-r4a-publication-pins-review-20261021/handback.json), [commands](context-r4a-publication-pins-review-20261021/command-receipts.json) and root audit scripts are preserved with this acceptance. No sealed evidence was rewritten.

## Precise source provenance and preserved corrections

The initial direct manifest records 555 on-disk files before new tests. The 562-entry direct qualified snapshot was captured **after positive gate 11 and before focused gate 12**. The wide 2,659-entry capture was expanded **after gate 15**; all earlier 562 entries and the final checkout match it. There are no independent source-hash snapshots for each gate. The evidence supports this sequence and final identity, not continuous independent hash observation at every invocation.

The BASE ZIP was written directly by:

```powershell
git archive --format=zip --output=.tmp/context-r4a-publication-pins-20261021-implementation/source-before-wide.zip 5e4f6038a98a5363babda0c9a15bbbef4dc80f1b packages scripts tsconfig.base.json pnpm-lock.yaml pnpm-workspace.yaml package.json
```

Its entries are Git export bytes under the local EOL configuration, **not raw blob bytes** and not the initial physical checkout. Root compared all 2,652 BASE archive entries to actual `git cat-file` blobs: 71 match byte-for-byte, and 2,581 differ only by LF→CRLF conversion. No other content difference exists. The qualified direct/wide archives match their physical checkout manifests.

The first root checker incorrectly paired the physical initial manifest with the Git-export ZIP and required export/raw-blob byte equality. Its [failed v1 report](context-r4a-publication-pins-review-20261021/root-audit-v1.json) is preserved. Corrected v2 uses the documented different provenance and verifies the exact EOL-only conversion. This is a root verifier interpretation correction, not changed product/test evidence.

Earlier writer failures remain disclosed: the concurrent quota promise oracle, a proposed commit budget that fit by 30 bytes and instead failed second pin, test-helper type annotations, and historical `.tmp` suite discovery. The latter command passed all intended current tests but collected missing-tsconfig historical copies; the corrected command excludes those copied directories and passes the exact five current suites. No current test was exempted. Module-mock warnings remain recorded.

## Remaining scope

This is original storage-owner component and Windows/Node process-crash qualification. It does not establish power-loss durability, a complete spawned child/model/guest/F1 lifecycle, saved terminal-row recovery at these cuts, dependency-catalog/whole-set observer grants, mixed retention/TTL/clear, metadata/index/path integrity, A6 scale/packaged entry flows, or R4B/C–R6.

Next is actual multi-source native catalog finalization and the live child-to-parent result observer, with genuine current source/visibility checks. Broad event-driven, instruction-file and unrelated decomposition work remains paused.
