# R3 F2 positional replacement readers — verification record

**Status:** F2 readers completed and independently accepted through `7a151340419501833cc4029378b9edf7b36e18ac`. The original reviewer accepted fix round1 as spec compliant, quality Approved, with no new fix-diff defect. Deferred Minors and wider qualification limits remain explicit below. This is not whole ContextEngine completion or a release claim. Product remains `0.1.13-rc.1`; original decomposition remains `27/43`.

Task BASE is `732ab578a2ed7bcbac3a23d9ba408e8988030602`. The initial reviewed delivery ends at `7fc5fc355b4059e573aae17353c620b55083aadd`; its complete five-commit diff and report are preserved under `.superpowers/sdd/2026-10-16-context-engine-r3-replacement-readers/`. The [implementation plan](../superpowers/plans/2026-10-16-context-engine-r3-replacement-readers.md) fixes the scope and root amendments.

## Implemented boundary

The existing core-session history/validation owner now derives structural item descriptors once for both validation and rendering. Replacement records validate at their own historical prefix, consume complete contiguous source units and insert the derived summary at the selected position. Later results or rewinds cannot retroactively validate earlier incomplete coverage. Hiding a summary does not resurrect its consumed originals.

Coverage includes actual admission, image, native and physical-step companions. Two active items sharing a source must be selected together. A later new model-visible message cannot reuse an already-consumed admission/image address and disappear silently; it is rejected at that later staged event. A fresh admission creates new coordinates and remains usable, even with identical image bytes or the same logical input ID. Raw archive reading, late non-content observations and ordinary replacement-free histories retain their existing behavior.

Format7 is explicit across full/incremental validation, serialization, JSONL load/repair, file-backed query and real SDK/Gateway consumers. Formats1–6 remain readable; old6 actually refuses7. The owned6→7 upgrade streams a header-only change while preserving journal metadata and framed body bytes. Same-file byte copying, deterministic structural export and child-owned journal import remain distinct operations; structural serialization is not a durability receipt.

The central seed compiler resolves required original/nested/lifecycle/acceptance/native/image/admission/rewind proof inside the requested boundary before renumbering. Complete prefixes retain that proof; partial tails refuse before child creation instead of pulling extra history. Seeded acceptance is structural/inherited and never copies parent execution or receipt authority. This intentionally retains extra raw history until R4 semantic seeds.

Existing old compaction/reset paths explicitly refuse replacement-bearing histories before model calls or marker writes. Ordinary reads and valid continuation remain supported. This is a temporary development boundary removed by connected F3 selection/publication; no replacement producer is activated by F2 readers alone.

## Source-bound evidence before fix1

At `7fc5fc35`, source-tree SHA256 is `990eb9a7c4b74a01d58b741375b0970dfb2ad83ad2b2c8220880201bf76e004d`. `.tmp/context-r3-f2-validation/qualification-revision.json` binds2,253 source/config/test files,64 changed Git blobs with explicit LF/CRLF normalization,17 final-source phases and seven earlier scopes with a documented two-file delta. Root checked64 changed files and all24 manifest/log hashes; the independent reviewer additionally checked all2,253 source hashes and every reused source map.

| Scope | Evidence |
|---|---|
| Final-source reader tests | core-session326; persistence149; JSONL83; SDK context2; Gateway cold4; six-protocol corpus81 |
| Earlier unchanged scopes, explicitly reused | snapshot10; subagent89; Gateway64; query49; compaction154; whole-workspace types; E2E types |
| Reuse boundary | Only structural serializer header ordering and its new session test differ from `99219a68`; public serializer signatures are unchanged. Affected readers/types/corpus were rerun. Counts overlap and must not be added. |
| Final structural gates | affected package types, dependency/reachability audit402 with no new rows, atomic rollback, fresh Gateway/CLI builds and CLI dist verification |
| Copied readers | `packaged-readers-FqOolp/result.json`:41 changed reader source/copy matches, real Gateway and bundled CLI SDK read/import/fork, child/imported own receipts, actual old6 refusal; model/tool/transport calls0 |
| Existing F1 controlled regression | `packaged-f1-regression-NzzN8y/result.json`:215 source/copy matches, retained outcome/finalizer, shared reconciliation, title Stop, feedback dedup and CLI/query; unmatched transport0 |

The artifacts above live under `.tmp/context-r3-f2-validation/`; fresh `b` package directories are `.tmp/context-r3-f2-{gateway,cli}-20261017b`. They identify the pre-fix1 reviewed source, not a later repair automatically.

Retained failed evidence includes shared-source omission, separate input/image admission rendering, duplicate suffix iteration, deterministic export interpretation, and exact structural roundtrip header ordering. Each defect has specific RED/GREEN evidence and original assertions retained. The header-order issue also reproduces in the preserved real old6 runtime with identical frame/body bytes; it was corrected, not dismissed as an obsolete byte-equality test. Two Gateway fixtures were migrated to actual ownership only after exact old6 reproduction at their original exclusive-owner boundary.

## Review and fix round1

The fresh full-range reviewer found one Important defect: a legal legacy reset without optional `removedSeqs` projects normally, but replacement seed proof traversal iterated undefined. Original writer reproduced the remapper and actual public-fork failures, then also reproduced the same field assumption in the outside-marker predicate. Fix `7a151340` applies the existing empty-list interpretation at both checks.

Literal controls verify the complete R7 prefix, exact remapped references/namespace, child-owned continuation receipt and unchanged parent bytes. A harmless outside no-op reset succeeds without widening the selected prefix; a real outside reset removing R7 still refuses because it changes selected visibility. The repair scope is persistence31 and subagent fork-isolation11 passing, four affected/direct consumer typechecks, reachability402, new Gateway/CLI builds and actual copied reader smoke.

Fix source SHA256 is `fec0c4d8a9addddceb02fe4e6be1b8e4c61d2ffa99173acf736d739ce09745c9`. `.tmp/context-r3-f2-fix1-validation/qualification-revision.json` binds the three changed files and11 passing phase receipts; root independently rehashed those files and all11 manifest/log pairs. The scoped tests were run before the commit while HEAD still read7fc5fc35; their actual source hashes already match the committed7a151340 fix. This distinction is preserved instead of rerunning just to change a Git label.

Fresh fix1 artifacts are `.tmp/context-r3-f2-fix1-{gateway,cli}-20261017a`; copied result `.tmp/context-r3-f2-fix1-validation/packaged-readers-OPnoJa/result.json` includes the additional legal absent-list reset12/R13 case through actual Gateway/CLI read, fork and import. It verifies41 current reader source/copy matches,85 old6 source identities, distinct child/imported receipts and model/tool/transport calls0. The original read/old-version/immutability assertions remain. The original reviewer accepted I1 at both locations after independently checking all2,253 current source hashes,11 passing receipts, three RED receipts and preserved prior evidence; no suites were rerun by the reviewer.

Deferred Minor `F2-M1` is the direct in-memory sparse-array diagnostic gap: malformed replacement input remains refused but can throw a bare TypeError. It is assigned to connected F3 publication/validation and must be accounted for in final review. `F2-M2` records intentional fixture diagnostic noise and existing dynamic-import warnings. Both are in the [later qualification obligations](2026-10-17-context-engine-r6-archive-obligations.md); they are not silently discarded or included in the I1 fix loop.

## Limits retained

F1-CLOSE-OBS-01 remains an unclassified original child-close AggregateError despite an identical-production later pass. The unchanged B2 reasoning-coordinate failure, earlier whole-program failures, pre-fix1 warm100MiB memory cost and36 dynamic TypeScript-import warnings remain separate obligations.

The controlled corpus contains a132,018,224-byte JSONL-equivalent archive with302 events and two active model messages. It verifies the stated six-route grouping/native/request scope; it does not establish bounded cold-load memory, provider behavior, production latency or full large-session qualification. R6 still requires streaming archive reads, checkpoint-plus-tail restoration, historical paging and complete qualification. F3 reduction/publication, F4 physical attempts, E admission policy and R4/R5 delivery/retention/observations are not completed by this reader gate.
