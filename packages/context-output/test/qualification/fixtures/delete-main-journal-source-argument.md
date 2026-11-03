> Portable reviewed argument copy. Original artifact SHA256: 1e0af7b40bf8f24afb086416138130107d11017a7fd53741a053775cf3522c67. Local evidence references were rewritten to exact official URLs or bundle-relative names, and text uses UTF-8/LF. These are new bytes with a new manifest hash; they are not the original audit bytes or original Node/SQLite source files. Historical review references are provenance, not execution inputs.

# Derived-index DELETE resource-policy proof draft

Read-only source investigation, 2026-10-25, after foundations WIP `2cd94218`. No runtime, reproduction, test, product-code, Git or native-setting change was performed. The only write is this requested draft. FB01's same-owner cleanup/completion, private gate, generation and original-authority design remains unchanged. OFF is rejected as a fixed product policy: active official Node 24.15.0 defaults defensive=true and returns DELETE, while floor 22.18.0 accepts OFF. Do not weaken defensive or synchronous settings or introduce a fallback toggle.

## Finding and proposed narrow direction

**Fresh construction in unchanged DELETE mode has a source-grounded main-journal bound of two sector headers, not a full index copy.** With original transaction page count zero, the main rollback journal contains no page records. A first cache spill may append one extra header; after the pager enters WRITER_DBMOD, new pages do not need further journal sync. On the two pinned Windows builds, the conservative header bound is **8192 bytes**: `2 × DEFAULT_SECTOR_SIZE(4096)`, with the actual pager sector possibly reduced to512 by powersafe-overwrite. This bound is independent of artifact/ref/graph count and does not require turning off spilling or journaling.

That is a **main rollback journal proof**, not yet a complete no-hidden-temp/native-memory qualification. Explicit construction transactions may open statement subjournals. Default temp policy can spill those to a temporary file outside the managed tree. `temp_store=MEMORY` makes them stay in RAM, but requires the fixed-operation/statement-scope memory audit described below. The viable next step is a bounded DELETE construction/subjournal qualification on the same two runtimes, retaining defensive/synchronous defaults. Do not reopen the broad architecture or claim the small main-journal bound settles all scratch.

## Exact sources and evidence authority

All source line numbers below are one-based in these downloaded, version-pinned files:

- **A** = `https://github.com/nodejs/node/blob/v24.15.0/deps/sqlite/sqlite3.c`, SHA256 `9512509b1bccb7461f79bea8aad6280ae4699e925fa4804381b71f59e7efb0c5`, SQLite3.51.3/source ID `737ae4a34738ffa0c3ff7f9bb18df914dd1cad163f28fd6b6e114a344fe6d618`.
- **F** = `https://github.com/nodejs/node/blob/v22.18.0/deps/sqlite/sqlite3.c`, SHA256 `c9a0b6829b81d5f1b78392181f09744c818117a725667411d517b98149fcd3be`, SQLite3.50.2/source ID `2af157d77fb1304a74176eaee7fbc7c7e932d946bf25325e9c26c91db19e3079`.

Manifest.json and source-argument-v24.15.0.md / source-argument-v22.18.0.md record exact official release-tag source URLs and original hashes. The reviewed observation extractions beside them retain the fixed schema and SQL plans; reviewed-policy.md summarizes the qualified native runtime/compiler conditions and earlier IF09 count comparison. These are retained review observations, not experiments performed by this source-drafting text. Node safety refusal is located in active src_node_sqlite.h:126, src_node_sqlite.cc:947 and A:143345. Statement finalization before close is floor src_node_sqlite.cc:1052 / active:1389; preserve the no-close-during-executing-SQL discipline.

| Source responsibility | Active A | Floor F |
| --- | ---: | ---: |
| Journal record/header sizes (`p+8`, sector size) | 59688,59694 | 58822,58828 |
| Header alignment/write | 60263,60359 | 59397,59493 |
| Windows sector size; pager PSOW reduction | 51792,61649 | 51100,60783 |
| Journal open/first header; transaction original size | 64750,64841 | 63871,63962 |
| Original-page record and bitvec; new-page NEED_SYNC | 64910,64967 | 64031,64088 |
| Spill -> syncJournal(newHdr=1) -> DBMOD | 63528,63205 | 62649,62326 |
| Commit syncJournal(newHdr=0) | 65531 | 64652 |
| Main page-ceiling check/write/size hint | 64510,63348,51608 | 63631,62469,50938 |
| Statement-journal eligibility / OP_Transaction | 89523,99409 | 88584,98384 |
| Statement savepoint snapshots; subjournal membership | 65838,59987 | 64959,59121 |
| Subjournal opening/record writes | 63439,63465 | 62560,62586 |
| Savepoint release/truncation | 65926 | 65047 |
| Memory-journal spill/write/truncate/open | 108606,108679,108772 | 107513,107586,107679 |
| Local temp policy propagated to pager | 76140,187586 | 75261,185269 |
| FTS pending threshold / crisis merge / savepoint flush | 254007,252272,259911 | 250946,249211,256804 |

## Main rollback allocation proof

Let `p` be database page size, `S` the pager's effective sector size, `N0` the main page count at transaction start, `N` the installed/read-back maximum main page count, `Abytes` actual managed original/other retained bytes excluding the one new index/journal, and `Q` configured quota. All arithmetic must use safe integers and a fresh actual inventory in the original workspace turn. This concerns the existing physicalBytes model (actual file lengths and hardlink identity), not filesystem allocation-unit rounding or total free space on the host volume.

Conditions for the tight fresh bound: confirmed old DB retirement/unlink; one new zero-length/zero-page main file; DELETE and normal locking mode; one outer transaction includes **all schema and all rows**, including FTS shadow tables; no intervening COMMIT, ATTACH, explicit nested SAVEPOINT, VACUUM, extra connection or cache reuse after any statement error; default synchronous/spill policy retained. Automatic statement savepoints are separately audited below. Do not call current `schema()` in autocommit and then describe later inserts as a zero-page transaction.

1. `sqlite3PagerBegin` snapshots `dbOrigSize = dbSize`. Confirmed zero original pages means `dbOrigSize=0` for this entire outer transaction.
2. `pager_write` adds a full main rollback record only for `pgno <= dbOrigSize`; all actual pages have positive numbers, so record count stays zero. Repeated modification of pages created earlier in this transaction does not turn them into original pages. FTS shadow writes share the same main pager, not a separate original-page journal.
3. `pager_open_journal` writes the first `S`-byte header. Prior to the first DBMOD transition, new pages may get NEED_SYNC. `pagerStress` calls `syncJournal(...,1)` when a page needs sync **or** state is CACHEMOD. On a filesystem without SAFE_APPEND this may write a second header, even with zero records. Because the preceding offset is exactly `S`, no alignment gap is needed.
4. `syncJournal` clears cache NEED_SYNC flags and enters DBMOD. New pages written in DBMOD do not acquire NEED_SYNC. No original page record can add another such flag. Thus further normal spills do not append headers. Commit calls `syncJournal(...,0)`, adding none. If an operation fails, stop the candidate and settle rollback/close; do not continue construction after a savepoint rollback and assume the success-path bound still applies.

Therefore `Jfresh <= 2S`. The fresh construction managed-disk envelope is:

```text
Abytes + N*p + 2S <= Q             [provided no other on-disk temp/subjournal]
N = floor((Q - Abytes - 2S) / p)   [read back actual max_page_count]
```

`winSectorSize` returns the compile-time DEFAULT_SECTOR_SIZE, not an unknown actual disk sector. Both manifests say4096. `setSectorSize` uses512 with PSOW, otherwise the sanitized VFS value. Thus `S <= 4096` on these actual Windows builds; `2S <=8192` is source-based. No arbitrary64KiB maintenance allowance is needed for the main journal. For other native builds/VFSs, use their proved S bound; the amalgamation's general MAX_SECTOR_SIZE65536 is an explicit source ceiling, not a Windows requirement. Do not silently generalize the4096 bound to unsupported VFS/build combinations.

The main ceiling is checked before acquiring a new page; `pager_write_pagelist` writes at page offsets and commit only extends/truncates to the DB image size. Windows SIZE_HINT does not pre-extend when `szChunk` is zero; the opened native handle is zero-initialized and IH/Node does not issue CHUNK_SIZE. Any future chunk-sizing/native-option change needs requalification. No promise that this schema/survivor text fits N follows: FULL remains a clean index-unavailable outcome after exact candidate disposal.

### Retained transactions on an existing derived index

For later staging/owner mutations, `N0>0`, so the fresh bound is inapplicable. A conservative main-journal envelope can use `D <= N0`, the number of distinct original pages journaled before any error. A main original page is recorded at most once because `pInJournal` is set. A subsequent header-adding sync requires newly unsynced original records, apart from the first CACHEMOD/new-page transition. Bound extra headers by `D+1`; each adds at most `S-1` alignment plus S bytes. A source-grounded conservative bound is:

```text
Jexisting(D,p,S) <= D*(p+8) + (2D+3)*S
Use D=N0 when no smaller dirty-page bound has been proved.
Abytes + N*p + Jexisting(N0,p,S) <= Q  [again excluding disk temp only if absent]
```

This is conservative; it is not a claim that every page actually changes. The zero-page special case tightens3S to2S because no record creates misalignment. No formula permits crediting planned canonical removal: recompute Abytes after actual reclamation and after any preceding original ledger/body growth in the same turn. Under FB01, inability to admit a derived mutation is explicit unavailable/refusal, never a new maintenance floor imposed by configure or a reason to block already-funded canonical cleanup.

## Statement subjournals: the real remaining resource condition

The precise counterexample to “zero original main pages means header-only total scratch” is in the source, without needing a speculative corruption scenario:

- VDBE marks a statement journal necessary when `isMultiWrite && mayAbort`; OP_Transaction opens one inside an explicit transaction (or with another active statement). Schema and FTS work can qualify. Scalar outer input alone does not prove there is no nested statement journal.
- A statement savepoint snapshots **current** dbSize, not outer dbOrigSize. On the second/later insert, pages created by earlier inserts can therefore be original to that statement and need subjournaling even though they never enter the main rollback journal.
- Each subjournal record has `p+4` bytes. `openSubJournal` uses SQLITE_OPEN_SUBJOURNAL/DELETEONCLOSE with null filename. With current TEMP_STORE=1/default local temp_store0, the memory wrapper spills at `SQLITE_STMTJRNL_SPILL = 64*1024`; at p4096, **16 retained records need65600 bytes**, crossing the threshold. `memjrnlCreateFile` then opens a native temporary file. This is outside the managed ContextStore directory unless an impermissible global temp redirect is introduced. No such redirect is proposed.
- FTS can flush pending terms at savepoints or its hash threshold; crisis merge calls `fts5IndexMergeLevel(..., nLimit=0)` and can touch many existing shadow pages. A4096-byte lexical input or one ref does not prove a≤15-record statement journal. This source route defeats a universal “small insert cannot spill” argument; an actual minimal workload exercising it is still a probe obligation, not an observed result here.

`temp_store=MEMORY` is **connection-local**, feeds `sqlite3TempInMemory` into `sqlite3PagerBegin(subjInMemory)`, and makes `openSubJournal` select nStmtSpill=-1. The memory wrapper then has no spill-to-file route. This preserves main journal DELETE and defensive/synchronous settings. It does not make statement scratch disappear or establish a constant memory bound.

For a single nonnested statement savepoint, `subjRequiresPage`'s page-membership bitvec gives at most N page records; payload is at most `N*(p+4)` plus bitvec/chunk metadata. Releasing an in-memory savepoint truncates/frees to its starting iSubRec when bTruncateOnRelease is true. The complete FTS/schema bound needs exact nested savepoint reasoning: a write needed by an older savepoint marks younger bTruncateOnRelease false, retaining records until older release. **Do not assert the nonnested N-record bound for the entire FTS outer statement without auditing that nesting and its generated shadow SQL.** The pending hash's default1MiB threshold (A:242252/F:239239) bounds neither all FTS merge working buffers nor subjournal record retention by itself.

The remaining qualification is therefore precise: prove the reachable native statement/savepoint depth and retained subrecord high-water for the fixed generated schema/FTS/scalar operations, as a function of installed N and bounded input, with records reclaimed between top-level statements. Distinguish native page undo state from a new all-ref membership graph. Normal native memory exhaustion may reject and preserve explicit unavailable/debt under FB01; do not promise successful reconstruction on every machine. But moving an unexamined O(R) DISTINCT/RowSet materialization into RAM is not an acceptable way to satisfy the existing no-membership-scratch constraint.

## Kept operations, retired work and smallest query qualifications

| Operation family | Disposition under the existing lifecycle proposal |
| --- | --- |
| Canonical expired/global deletion | Original tombstone/slot/body-before-manifest path; retire DB. Old FTS DELETE, refs CASCADE DELETE and per-ref/global VACUUM are retired, so their ephemeral/RowSet allocation is not a retained proof obligation. |
| Fresh schema + refs/owners/chunk/FTS inserts | Kept in the single fresh outer transaction; main2S bound; schema/FTS subjournal and native buffer audit remains. Schema creation indexes are empty when created; no bulk CREATE INDEX over populated data. |
| Count | Shipping combined COUNT DISTINCT is rejected for MEMORY. IF09 qualified replacement below streams the covering index and preserves nullable semantics; product adoption belongs to the connected task. |
| Hint/first/page lookup and search | Retain audited indexed scalar/streaming plans and bounded keyset hint pages. Native FTS MATCH scratch remains a specific native-source obligation, not solved by LIMIT64 alone. No rank/order/materialized whole-result addition. |
| Reset legacy_rows/pages/plans by binding | Existing mutation EXPLAIN in both saved audits shows indexed one-pass loops and no RowSet/OpenEphemeral/Sorter. Do not inaccurately label these already demonstrated plans unbounded membership sets. Large reset can still dirty/journal many pages; qualify payload/journal work or use bounded scalar batches below. |
| Owner update/restoration | Original ledger restoration remains mandatory and independent of derived failures. Current DELETE owners WHERE ref_id plus SQL reinsert needs its own opcode/subjournal audit; no owner plan was present in saved mutationPlans. Do not infer it from legacy reset. |

Qualified IF09 query, unchanged nullable-domain behavior:

```sql
SELECT COALESCE(SUM(n),0) AS observations, COUNT(ref_id) AS refs
FROM (
  SELECT ref_id, COUNT(*) AS n
  FROM legacy_rows WHERE binding=? GROUP BY ref_id
)
```

SUM includes NULL-group rows; COUNT(ref_id) excludes that group; COALESCE preserves empty(0,0). Saved two-runtime covering/coroutine plans contain no ephemeral sorter/set. NULL bound binding still matches no rows, as with the original `binding=?`. Do not replace it with COUNT(*) over groups, which would count NULL ref_id incorrectly.

If reset/owner mutation scratch or dirty-page admission needs tighter batches, the smallest test-only proposal avoids nullable-key cursor errors and an IN-list materialization:

```sql
SELECT rowid FROM legacy_rows WHERE binding=? LIMIT 64;
DELETE FROM legacy_rows WHERE rowid=? AND binding=?;
-- Same fixed pair for legacy_pages (binding) and owners (ref_id).
```

Fetch at most64 rowids using the existing binding/ref leading index; execute scalar deletes, then repeat the first bounded page after those rows are gone. No ORDER BY, ref-id DISTINCT cache, null-sensitive `>` comparison or new index is required. Null ordinal/name/session_id rows are included exactly when the original binding/ref equality would include them. Schema-qualified code must use fixed trusted table names. Prepare/settle statements before original-proof awaits. A64-row input bound does **not** alone prove constant modified bytes: row payload/overflow and b-tree height still enter a resource bound. If one transaction covers every batch, main journal's original-page count can still reach N0; per-batch transactions bound the effect unit but require generation/readiness fencing until complete. These are proposed qualifications, not code or accepted plan results.

## Optional MEMORY journal comparison

`journal_mode=MEMORY` is not OFF: it retains logical rollback in a memory journal and can be allowed under defensive mode, but actual mode acceptance is untested here. `pager_open_journal` calls sqlite3MemJournalOpen; syncJournal skips disk-header extension for MEMORY. Its main logical undo payload is bounded by `S + N0*(p+8)` for the same stop-on-first-error/no-savepoint-reuse discipline; a fresh zero-page transaction needs only its initial header in memory. Statement subjournals are also forced to memory, so the unresolved nested subrecord bound is **unchanged**. Chunk allocation is source-defined1024-byte blocks with payload determined by FileChunk metadata, not zero-cost RAM.

This is a bounded obligation tied to actual main N0 rather than an unbounded second authority: account main undo payload/chunks, statement high-water/bitvecs, pager cache and native FTS buffers simultaneously; admit no arbitrary RAM guarantee. At a512MiB index the main undo obligation alone can approach another512MiB, before those other consumers. The current product has no explicit native-memory admission policy guaranteeing that capacity. Native NOMEM can be a truthful environment failure, but choosing MEMORY solely to hide a disk obligation without the scratch audit is unjustified. **Prefer DELETE's small fresh disk header bound for the next probe; no MEMORY journaling policy change is recommended or authorized by this draft.** No process-global setting, separate owner/process/store or native extension is proposed.

## Minimal next bounded probe for root to authorize

Use the existing native evidence harness only after root dispatches it; preserve both executables, safety settings and source hashes. No Store/service generation or authority claim can be made by this probe.

1. Add a test-only fresh DELETE zero-page single-transaction schema + bounded original-shape row insert scenario. Keep default cache/spill/synchronous. Cap the main file at768 pages and input at512 lexical4KiB chunks (one/few refs, no1001 scale); stop earlier once the normal cache-spill path is source-correlated or capacity refuses. Verify page_count0 before BEGIN and read-back ceiling. Capture main journal length/header fields **while the transaction is open**, after selected synchronous statements, including a second post-spill statement, then COMMIT. Compare with2S; commit source uses newHdr0. This corroborates the source bound; post-COMMIT length0 alone proves nothing.
2. Under default temp policy first, exercise statement-requiring schema/FTS and retained reset/owner shapes in the same bounded fixture. Capture actual subjournal high-water if its disk file is exposed. Source says spilled disk subjournal is not truncated on statement release, so between-statement observations during the outer transaction can retain its earlier high-water; memory-only subjournals can truncate immediately. Do not invent a native hook, call a UDF close, install tracing infrastructure, or present absent directory snapshots as proof that no transient file existed. Record any observation gap explicitly.
3. Finish exact fixed-operation/subjournal nesting audit, including generated shadow SQL and FTS flush/merge scope. Qualify IF09 and proposed scalar reset/owner opcodes with nullable controls. Only after that source/plan audit, test connection-local temp_store=MEMORY with readback; verify it routes the subjournal to RAM and retains bounded streaming/nonmembership plans. Do not move all default SQL scratch to RAM first and call the audit complete afterward.
4. Run one normal commit, one native main-ceiling FULL and one real statement constraint failure in each runtime, with stop-on-first-error disposal. Confirm exact DB close before unlink/replacement and retain original errors. No requirement to make native ENOSPC/EIO/NOMEM vanish; no retry of a failed generation. If any necessary source bound or mode is refused, report the exact remaining condition to root before product work.

Acceptance is an **admission-budget guarantee**: under the qualified native build/VFS/operation set and original held turn, the installed main ceiling plus proved on-disk journal/temp envelope cannot deliberately exceed Q in the managed accounting model. It is not a guarantee of all survivor index layouts fitting N or native success under volume exhaustion, access denial, device I/O failure, memory exhaustion, changed identity or unresolved close/lease debt. FB01 already permits clean derived unavailability while confirmed funded authority cleanup progresses. Preserve that distinction rather than building an impossible-environment theorem or silently charging hidden scratch.

The result of this source review is a viable narrower DELETE construction direction and an exact remaining subjournal/memory qualification. It does not authorize product code or promote foundations/Task2 acceptance.
