# B2 source capture reservation — scoped acceptance

The connected prerequisite is accepted in MAIN through `dd98e9831ee0916fffd9648e0810a473cc34e7d9`. Product remains `0.1.13-rc.1`, Session format12. This acceptance covers the persistence/JSONL owner and its actual host integration control; public fork/SDK/CLI/Desktop callers have not yet switched to it.

The [plan](../superpowers/plans/2026-10-26-bootstrap-pre-capture.md) and [spec](../superpowers/specs/2026-10-26-bootstrap-pre-capture.md) require the existing B2 owner to confirm a seed-free reservation before the first source callback. An existing, spent or uncertain reservation cannot authorize another source capture. Promotion preserves that reservation, original callback provenance and actual resource ownership through the existing stage/header/seed/receipt path. Strict inspection owns only its actual temporary resources and does not create a target session or readiness claim.

The donor range is `a4d8b971fd5781a3bfb27852303eeb6ea203b508..d438727150e3ee8f63a5d7aa7d929ddecd0c6b35`. Original candidate `b255d6c2` and correction `d4387271` integrated as `9ef7be45` and `b656d278`. Root's test-only snapshot-capability narrowing is `dd98e983`. The complete donor range contains19 files; the correction report's18-file wording is a count erratum. The manifest, root audit and Git identities agree on19, with no missing change.

## Independent review and corrections

The fresh full-range review found two P2 defects. Callback-thrown cancellation/stale codes, null/undefined and other falsy values could be misclassified or lost; deletion's new join delayed the original synchronous ordinary write-admission closure. The same implementer reproduced both before fixing them, and the same reviewer accepted the correction.

The capture owner now distinguishes a callback failure from an internal guard outcome and preserves its exact value, including in combined original-resource cleanup errors. Deletion stays in the original lifecycle owner, which closes ordinary-session/document admission before its first await and then joins observation and managed capture. The actual ordinary-session barrier changed from two backend append calls after deletion began to zero backend appends/document writes while the observation was still held.

Root's downstream Gateway typecheck then found one test-only TS2722: the new actual-host fixture called the optional coordinator snapshot method without narrowing it. The fixture now explicitly requires and binds the original capability. The same reviewer approved this narrow change and its integration evidence. No product behavior was altered for that type correction.

## Source-bound evidence

Evidence is retained under `.superpowers/sdd/2026-10-26-bootstrap-pre-capture/`; original failures and earlier candidate artifacts were not overwritten.

| Population | Observed result and boundary |
|---|---|
| Original connected candidate |356 passing tests across18 files; persistence and JSONL types pass. This predates the two review corrections. |
| Causal correction controls |11 callback failures out of18 before correction, then18/18; ordinary deletion barrier reproduced two actual backend appends before correction. |
| Corrected affected population |274 nonduplicated passing tests: binding57, unchanged other persistence85, JSONL131, actual Gateway source-deletion/pin-retention1; both persistence package types pass. The retained initial binding test-probe microtask failure was corrected without a product change. |
| MAIN integrated `b656d278` |All19 donor Git file identities match. Gateway project/transfer47/47 and Executor types pass. Gateway types fail only at the new fixture's optional snapshot call; failure retained. |
| MAIN test-only correction |Actual BC11 fixture1/1 and Gateway types pass. All2920 recorded source entries remain stable during the followup; only the explicitly recorded fixture differs from the original integrated source. |

The original47 and final1 are overlapping evidence, not48 distinct tests or one all-green invocation. Unchanged passing populations were not repeated merely to regenerate logs. Root verified original17 source/55 evidence hashes, correction19 source/18 evidence hashes and exact full/fix patch hashes. Full-range, correction and integration review reports are retained separately.

BC11 uses a genuine completed ManagedDocument source, native result runtime, project broker and actual artifact/catalog membership owners. It observes capture1, no pre-READY target profiles/preparation/dependency publication, then actual preparation1/dependency confirmation1. A fresh coordinator/runtime/broker reads the retained text and catalog member through SessionService with cold source reads0 and no assembly. Actual process interruption after confirmed reservation and before callback also retains the spent fence across cold reopening.

## Qualification and remaining work

The qualified guarantee is Windows process-interruption/restart. Optional directory flush is deliberately skipped; required file write/sync/readback/rename, claim and cleanup outcomes remain strict. This is not a power-loss or unrun-platform guarantee. The catalog-member control does not establish provider-native replay permission.

A headerless spent operation can remain payload-required under its original identity; no eager deletion/reset or new capture authority is added. Public fork preparation/begin/retry and actual SDK/CLI/Gateway/Desktop cutover, strict host legacy read adapters, child/instruction inheritance, delivery/wake and final packaged version gates remain separate work. This scoped acceptance does not close those tasks or the whole release.
