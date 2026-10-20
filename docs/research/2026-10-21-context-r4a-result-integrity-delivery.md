# R4A bounded result integrity and original cold lookup — implementation delivery

2026-10-21. Ready for fresh independent review and root evidence audit; this document is not acceptance. Implementation range: `0df518e7042039ef0f312c53aa565abf314bef3a..740c515399eebe1c4a27e7367b44ef353b212310`. The final handback records the additional documentation commit and exact review HEAD. Workspace `D:/I-harness-main`, branch `codex/v0.1.13-development`. Product0.1.13-rc.1, Session10 and unrelated decomposition27/43 remain unchanged. No push, merge, tag, release, installed-app change, real profile/provider use or new agent.

The approved [bounded plan](../superpowers/plans/2026-10-21-context-r4a-result-integrity.md) maps this work to original **A6 bounded integrity**. Original A5 is durable pins. Accepted native witness unit `aa2cadae` and its product `139bf777`/tests `38286491` were retained; this unit does not restart their producer, publication, CLI or ten-cut qualification. A6 scale/100MiB/packaged work, mixed legacy/managed retention and whole R4A remain open.

## Reproduced findings and original-owner changes

Root reviewed the actual controlled failures before product edits and approved the two repairs in the frozen local `cold-repair-decision.md`.

| Demonstrated pre-change behavior | Final original-owner behavior |
| --- | --- |
| Cold lookup returned committed for16 initial inconsistent ref/operation/embedded or missing/damaged disk manifest rows. Genuine capturing/staged/refused/committed baseline passed. | `artifact/recovery.ts` validates one bounded rooted operation snapshot, expected operation and directory identity derived from original workspace/session/call/operation, supported version/phase/codec and safe count. Committed requires exact closed ref plus both canonical embedded and bounded rooted disk manifests and safe dimensions. |
| A fixture junction outside the managed owner was followed and operation metadata opened twice, producing a commitment. | Existing `ownedPath` checks run before authoritative cold metadata opens. Directory, operation-file and manifest-file link controls refuse without opening the linked metadata. |
| Replacing A's operation after its first actual native read with B's record returned B's ref for A's checked operation/id. | The checked snapshot itself supplies the disposition/ref; no unchecked second operation read exists. The controlled replacement returns checked A or a bounded refusal, never B. |
| Changing only actual pin.operationId to foreign still returned plaintext and opened body/index. | `artifact/ownership.ts` requires real pin.operationId equal actual operation.owner.operationId before content I/O, retaining the existing pre/post authorization and policy sequence. |

The public host `reconcileResult(operationId,id)` interface is unchanged. Live original sink reconciliation remains `writer.commit/createArtifactPublication`, separate from cold classification. Capturing may have no ref/manifest; staged remains recovery-required. Authentic cleaned refusal remains recorded refusal, including a genuine staged-to-deleted refusal retaining its prior ref/manifest. A valid committed metadata receipt can exist with missing body/index; the page then refuses. None of these dispositions grants a read pin/current policy, restores producer scope, proves execution/F1, starts work or repairs storage.

Only three product files changed: the original cold recovery leaf, the existing pin authorization comparison, and the reader comment corrected from one to a possible two64KiB chunks. Accepted witness authorization remains separate; no global cold disk-manifest check, catalog body scan, new schema version, journal, ACL, store, repair service or production test-only export was added. This is not an atomic multi-file filesystem snapshot or protection against coherent rewriting of all trusted local metadata.

## Independent format and native-I/O evidence

The test-only `integrity-vectors.ts` constants were produced before product writer invocation by independent Node crypto/literal buffers in the frozen `literal-vectors.mjs`. It imports no product serializer/ref/index/hash builder. It constructs domain00 ordinal/length real leaves, domain02 ordinal padding, domain01 ordered branches, literal64byte headers and complete one-based heaps. Full body digests, tree roots, complete index bytes/digests, exact ordered manifest bytes and revisions are pinned and compared to actual writer files.

| Literal UTF8 body recipe | Real/padded leaves | Stored index | Revision |
| --- | --- | --- | --- |
| Empty |1/1|96|`da32e22048d68e2fb1cecccf1ec47b1c70f8712f4aac7cc37bec804a0ad0e3c5`|
|65,536 ASCII A bytes|1/1|96|`16d6d01465c2bbbe5864129a6cfe7766d459423b6eb0778ff18096a53849c875`|
|65,536 A +1 B|2/2|160|`bb01dc5ef54e2028d836d708912864d6cdf3f6480cd5dcbc7e022b3d3e5d047d`|
|65,536 A +65,536 B +1 C|3/4|288|`92c8008f34b02c35abbff0e87f6c5e329e0ef15dd8427df6d7ba2467d87f47d3`|

Every shape has successful complete advancing pages after writer retirement and a fresh store, including an actual empty page. Final serialized pages meet their budgets. The passthrough native observer records actual file opens and every FileHandle read's requested length, actual bytes and offset, including repeats/retries. Positive pages calibrate the observer before each denial family.

- Empty index stores96bytes but reads128bytes: header64/root32/real-empty-leaf32, including the repeated root/leaf offset.
- Raw page offset65535/max900 over the three-leaf body verifies two full64KiB chunks (131072actual body bytes) plus288actual index bytes. Bounds follow `min(remaining,maxBytes+3)`, rather than the later smaller text payload.
- Real native reads capped at8191bytes join18body reads with the same131072byte total; zero-progress before expected EOF refuses as short read.
- One-leaf native exec positive separately verifies header, preceding-LF boundary and record window: body is read three times and index384bytes. It is not counted as one raw page proof.
- Witness positive selects exactly one companion twice, checks catalog policy then frame policy with validated visibleVia before/after the page, and opens no catalog body/index for membership.

Raw I/O arrays and complete literal constants are preserved under `.tmp/r4ai-1021-01/`; no unique-offset deduplication or product-computed expected digest substitutes for those oracles.

## Controlled matrix and authority boundaries

Five new test files contain30 tests with discriminating table rows and eight test/helper files total. They cover original cold identity/phase/ref/manifest/path/two-observation controls; malformed/oversize operation, access and pin metadata and pin identities; semantic manifest fields/types/order/keys/truncation/missing/4096budget; header dimensions/reserved bytes/root/leaf/siblings, body corruption/chunk swaps/truncation/missing; preexisting body/index/manifest/operation/access/pin links; held same-length body/index identity replacements; valid-proof malformed codecs; public ranges, UTF8 boundaries, EOF/tiny budget and unsafe dimensions without giant files; selected witness8192budget/schema/cross-key/link/cleanup confinement and post-body companion change.

Equivalent manifest JSON whitespace/escaping succeeds because decoded canonical identity is unchanged. Valid UTF8 with invalid whole JSON syntax remains page-readable JSON text. Malformed UTF8 bytes and malformed native framing are committed through authentic low-level sinks, independently shown to pass original rooted byte verification, then refused by their original decoders. Stale body bytes/proofs are not claimed as codec coverage. Public malformed UTF8 returns existing bounded `unavailable`; malformed native framing returns `corrupt`. Existing beyond-EOF combined range/budget mapping returns `budget`.

An untouched corrupted body chunk can remain readable from another range; reading the changed chunk refuses. The companion cannot mask frame corruption. Fixture filesystem replacements are explicitly outside the serialized store queue. Held reads always release in finally before joins/close; post-I/O refusal may have touched bytes. No full revoke-and-restore ABA claim is made. Cleanup-link tests use the trusted original store lifecycle seam; actual Gateway broker/archive/fence behavior is separately reused from its existing real frontdoor tests.

Actual model `context_output_read` traverses original storage/pin policy for canonical success and corrupted manifest refusal with zero body/index opens. Existing actual Gateway/SDK and executor regressions preserve current conversation/project/source policy, denied content opens, cold no-assembly/no-provider/no-session/F1-mutation and read-lifetime behavior. Complete task fixture inventories before/after reads/lookup exclude deliberate accounted fixture corruptions; reads do not create scope/sink/pin/grant/witness, recapture/reindex, append execution facts or replay work. This is not cryptographic detection of an attacker changing every trusted local record coherently; native sourceId/ordinal remain registry-authored semantic metadata.

## Verification receipts and source scope

All runtime gates ran sequentially through the new local runner. Exact executable, cwd, argument array, shell IH_CONFIG_DIR/IH_RESULT_INTEGRITY_EVIDENCE_ROOT/IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT, UTC timestamps and native exits are in each immutable `*.receipt.json`, alongside before/after actual workspace-byte source manifests. Fresh short evidence/config/native roots precede runner imports. New fixtures reject `evidence-seal.json` before writes or product imports and permit a fresh root override. No new `.mts` file was introduced; all new `.ts` helpers/tests are explicitly covered by context-output tsc.

| Receipt group | Actual result and claim |
| --- | --- |
|01,05|Original controlled cold and pin behavioral RED; preserved before engineering repair approval.|
|12–14|Save exact fixed owner bytes; install byte-exact Git BASE owner files;13 repeat calibrated RED with complete named/hidden source manifests (11pass/6fail tests); restore each fixed owner SHA256 exactly.|
|15|12context files,50/50PASS; named-source/hidden-input coverage.|
|16|Actual Gateway/SDK read visibility/project broker/archive/fence6/6PASS.|
|17|Executor cold/read lifetime/shared-store/child pins19/19PASS.|
|18–21|Context-output, executor, Gateway and SDK tsc all exit0.|
|23|Full package/app/root config inventory, contained18current files/75PASS, exit0.|
|25|Final18current files/75PASS, exit0, `--dir packages` and explicit temporary/worktree/release/dist exclusions; collected paths checked against intended paths.|
|26|Final context-output tsc exit0, all final new test/helper bytes.|

The final source inventory contains4271 package/app/root-config/hidden-task files. Final before/after groups are compared byte-for-byte; final handback records hashes/counts and current tracked source identity. This is actual workspace-byte evidence, not an EOL-normalized Git export claim. The final75 tests are30new bounded controls plus45existing affected regressions; repeated runs are not added as distinct tests.

Preserved failures/limitations:

-02 generator invocation was a setup failure;03 corrected independent generation succeeded before writer vectors.06 corrected the assumed public beyond-EOF reason, with no product reason change.09 found a test-only inferred-string discriminant; later type gates pass.
- Early manifests omitted ignored hidden files because `--hidden` lacked `--no-ignore`. They remain bounded early evidence, not complete hidden-input proof. Corrected13/15–21 capture616 named-owner/hidden inputs. Later4271file inventories explicitly expand to all package/app/transitive source plus root config; this is a scope expansion, not a source change.
-22 root-cwd Vitest substring matching selected historical temporary copies:75current +20historical test executions passed and5historical suites failed in transform for missing copied tsconfig; native exit1. This gate is not qualification. `22-selection-audit.json` records the five executed baseline snapshot paths/source hashes and fresh fixture roots/cleanup. They used fresh snapshot-build or OS mkdtemp children; no prior sealed evidence root is addressed by their fixture source. Historical dynamic OS tmp names were unlogged, so no retroactive inventory or global old-evidence-unchanged claim is made. Old snapshots were not cleaned or changed by this writer.23/25 constrain discovery and collect exactly the intended18current files.
- One extra EOF blank in generated literal constants was removed before final25/26 and the final implementation commit. Git diff whitespace checks pass.

No full repository suite/build, optional SQLite packaging, live native producer/CLI requalification,100MiB scale, mixed retention or release validation is claimed. Final root/fresh-review acceptance remains required. The frozen handback identifies local commits, report/evidence seals, final source hashes and actual process cleanup.
