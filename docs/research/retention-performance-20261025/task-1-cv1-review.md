# Task 1 CV-1 source-comparability resolution review

**Verdict: CV-1 resolved.** The clarification supplies exact recovered RED source matching the independently preserved pre-run hashes. The named one-admission control has the same test body, interception prefix and successful counter/native-forwarding semantics as the final control. Its preserved two-to-one inventory result is causally comparable. No runtime rerun is necessary to close the source-comparability gap. This scoped follow-up supplements `task-1-review.md`; it does not erase its historical finding, reopen the production review or extend the original acceptance scope.

Reviewed 2026-10-25 against unchanged frozen candidate `a3dbcfc528e5ed4e87dfb229cf478704271b5e0b`. Read the clarification, reconstruction metadata, both recovered helper/test files, their complete `.to-final.patch` files and the named-control comparison. Independently hashed the recovered files and current frozen files, compared named/prefix content, validated each patch hunk against both source files and reconstructed the entire final line sequence from each patch in memory. No product/test edits, runtime workload, native job, subagent or protected-file access occurred.

## Independently checked source identities

| Source | Recovered RED SHA256, matching original `red-final-probe/source-before.json` | Current SHA256, matching `final-fast-gate/source-before.json` |
|---|---|---|
| Helper | `F8D32CFFD988BC3DC2D00502A134D1B64C3A4AF7E2D75F8E52DE9DE0A6702B50` | `49572EC2F49C3E88940583C1EC4E4B3BEFF0F4674109DF2A976DF3CEED657721` |
| Performance test | `F8165304AEDF7C0CEB0D29E32748C066A27240120ACCF44359CF2447A48610AA` | `E2A7C216464F36227267E3EDCE89E5319D593C9656CC7768A7F79EB0FC2B1747` |
| Store | `BD991EE39EA2BEF15D75717CF05E5DB7022268BA0F8897D4ED710C7E2C605C3E` | `596B263C249D9C05DC99B472D2D68580C4EC4E2675A597482D6FC9F8C21E4EF3` |

The recovered files are explicitly retrospective reconstructions from inverse known edits, not contemporaneously archived full-source snapshots. The exact match to the earlier preserved SHA256 identities resolves the missing-content problem: the reviewer can now examine the particular prior bytes identified by the original receipts. This conclusion depends on those preserved manifest identities, rather than the writer's recollection alone. Hashing the recovered store was a binding check only; its unchanged production review was not repeated.

The module prefix before `it.each([` is identical between recovered RED and final test. The named admission control is also identical, with independently recomputed SHA256 `4AF7AC4AB38720A3ACF5B800423137729613E4DDB2537BDADB68B091981BEBE0`, matching `named-control-comparison.json`. Thus imports, native interception declarations, SQL observation, method wrappers, receipt handling and both direct admission-control bodies are unchanged.

## Semantic check of the differences

The complete helper patch has one hunk: `const pending = work()` becomes declaration plus a synchronous-throw catch that records a failed span and rethrows the same failure. Native observers, inventory recognition, actual byte counting, handle forwarding and asynchronous settlement handlers are unchanged. A successful callback still returns its original promise through the same observer path. Both named-control receipts have successful admission spans, the same successful page admission and no native failure counter in the admission bucket. The later intended RED `expect.soft` failure happens outside the measured admission call. The added synchronous-failure bookkeeping therefore cannot account for its inventory delta.

The complete test patch has only the disclosed changes: fixture-setup failure receipt handling, post-expiry assertions and teardown receipt preservation in `finally`. The fixture arguments, successful owner invocation and owner phase markers remain the same. The added post-expiry assertion work follows the settled expiry capture/sweep, under `assertions/expiry-effects`, and performs real body-absence checks. It does not add work to the earlier transfer-owner, startup or expiry-sweep scopes. The setup and teardown changes preserve failure evidence without replacing successful native work. The supplied patches account for the entire file differences; no additional edit was found outside their hunks.

## Claims now established and remaining qualifications

The preserved original and final named-control receipts independently reconcile to total/index 86,016 bytes and quota 217,145 bytes. Original versus final counts are inventories 2 versus 1, readdir calls/returned entries 8/8 versus 4/4, and lstat calls 8 versus 4. Each has one successful SQLite admission, the same requested 24-page ceiling, no failed admission span and zero final active observed I/O/handles. With the recovered equivalent successful observers and identical test control, the named structural RED/GREEN claim is established.

The wider successful owner scopes also retain the same measurement and fixture semantics. Their reported structural inventory/admission/lstat/body-read/hash comparisons can be used with the already stated phase-boundary qualifications; the recovered changes do not manufacture their delta. This is scoped structural comparability, not byte-identical whole-test execution. Final source adds post-expiry correctness assertions that RED did not perform. Whole-test assertion duration, aggregate/all-scope hashing, all-scope counter bookkeeping, total test workload and failure-path receipts must therefore remain separately qualified. In particular, final post-expiry assertion success cannot be attributed to the earlier RED run.

No controlled elapsed speedup follows from these observations. The coarse funding bucket still includes the trailing derived-index confirmation; nested spans still overlap owner time; counter-update time remains a lower bound on instrumentation overhead. The 101-owner 5-second ceiling remains missed, R6 stays open, and Task 2/3 plus later scale/usability acceptance remain outstanding. The accidental 10001 run and its procedural deviation remain disclosed in the original review and report.

No new actionable defect or unresolved source-comparability item remains from CV-1. Root retains responsibility for Task 1 acceptance, integration and subsequent task authorization.
