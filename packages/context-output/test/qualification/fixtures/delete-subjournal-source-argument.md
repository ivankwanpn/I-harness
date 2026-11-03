> Portable reviewed argument copy. Original artifact SHA256: a1c12de07088f445758295591aced1eca1f4b73a2b2c59ea42eefd4b88e85b03. Local evidence references were rewritten to exact official URLs or bundle-relative names, and text uses UTF-8/LF. These are new bytes with a new manifest hash; they are not the original audit bytes or original Node/SQLite source files. Historical review references are provenance, not execution inputs.

# DELETE subjournal and retained-scratch source proof

Addendum to `delete-main-journal-source-argument.md`, 2026-10-25. This is a narrow read-only investigation of the same pinned native sources and saved plans. No runtime, native probe, test, product-code or Git change was made. The only write is this addendum. OFF remains rejected. FB01's existing owner/gate/generation/authority/completion design is unchanged; the main-journal formulas remain source arguments pending the actual bounded probe.

## Result

There is a concrete native undo bound in terms of the installed/read-back main-page ceiling; it need not be constant memory. With no application SAVEPOINT, no statement-error continuation and the fixed reconstructed schema, an outermost automatic statement savepoint always releases to its entry subjournal offset. Its flag cannot be marked nontruncatable by a younger savepoint. Consequently a connection-local in-memory statement subjournal does **not accumulate undo across all streamed application rows** merely because construction has one outer BEGIN/COMMIT.

For one automatic savepoint level, at most N different page records are retained during that statement. For at most two nested levels, a conservative bound is `N² + 2N` records; this follows from the exact older-page-bit / younger-release rule below, rather than a claim that every nested record is unique globally. The fixed schema/data paths support a tighter separation: plain data/FTS shadow operations need at most one automatic savepoint level; CREATE VIRTUAL TABLE may execute a plain shadow CREATE VDBE beneath it and is covered by the two-level bound during the schema phase. Native qualification should verify these exact generated statements, not substitute an arbitrary depth constant.

The owner-delete source audit also resolves the missing distinction: **`DELETE FROM owners WHERE ref_id=?` can collect every matching rowid because owners has a child FK**. It must not inherit the reset tables' streaming qualification. The smallest retained replacement is bounded rowid selection followed by scalar rowid deletion, preserving nullable owner rows and FK checks. IF09 remains the streaming nullable-preserving count replacement; application membership materializations stay prohibited.

## Exact source locations

Use the full A/F absolute source paths, SHA256 and native identities in the preceding DELETE draft: A is the downloaded Node24.15.0 SQLite3.51.3 amalgamation; F is Node22.18.0 SQLite3.50.2. All lines below are one-based in those exact files under `the original reviewed evidence (provenance retained in manifest.json)`.

| Mechanism | A line | F line |
| --- | ---: | ---: |
| Oldest missing savepoint page; mark younger release flags false | 59987 | 59121 |
| Set page bit in all applicable active savepoints | 60730 | 59864 |
| Append `(pageSize+4)` subjournal record, increment nSubRec | 63465 | 62586 |
| Savepoint entry nOrig/iSubRec/initial release flag | 65838 | 64959 |
| Release destroys frames, resets nSubRec and truncates memory journal | 65926 | 65047 |
| VDBE statement close releases B-tree frame, then decrements nStatement | 90048 | 89105 |
| Statement frame eligibility / BEGIN frame ordering | 89523,99409 | 88584,98384 |
| Subjournal memory selection / allocation / truncation | 63439,108606,108679,108772 | 62560,107513,107586,107679 |
| Bitvec512-byte nodes and set recursion | 55576,55652,55706 | 54792,54867,54921 |
| Simple VALUES unwrapped; initial multiwrite selection | 137678,137743 | 135739,135804 |
| Multiwrite/abort setters | 129784,129805 | 128370,128391 |
| Rowid REPLACE without indices avoids statement journal | 139051 | 137112 |
| FTS index SQL uses NO_VTAB; data write/delete | 248169,248195,248219 | 245117,245143,245167 |
| FTS storage SQL templates / NO_VTAB | 260732,260850 | 257624,257742 |
| Plain shadow CREATE helper / storage schema | 260958,260993 | 257850,257885 |
| FTS savepoint/release flush | 259911,259928 | 256804,256821 |
| Vtab callback dispatch / make writable (no SQL itself) | 160848,160969 | 158629,158750 |
| FK-required test for child DELETE | 136381 | 134445 |
| Delete bComplex / disable multirow onepass / RowSetAdd | 131099,131239,131323 | 129679,129819,129903 |

## Exact lifetime and truncation argument

1. `pagerOpenSavepoint` records current dbSize in nOrig, current nSubRec in iSubRec, a fresh page-membership bitvec and `bTruncateOnRelease=1` for every new automatic frame.
2. `subjRequiresPage` searches oldest to youngest. A record is needed only for an active frame whose nOrig covers that page and whose bit is unset. It marks **younger** frames nontruncatable when an older frame needs this record. `subjournalPage` writes the page image and `addToSavepointBitvecs` marks that page in every active frame to which it belongs. A repeated write in the same unchanged frame does not append another copy.
3. On successful RELEASE, pager destroys released frames. If their release flag stayed true, it restores nSubRec to that frame's entry iSubRec. If the journal remains in RAM, it also physically truncates/free-chunks to `(p+4)*iSubRec`. A spilled disk subjournal may retain its physical high-water even when nSubRec is restored; the two quantities must not be conflated.
4. There is no active older automatic frame outside the outermost top-level SQL statement, under this proposal's no-user-SAVEPOINT/no-reentrant-SQL discipline. Therefore nobody can clear that frame's own release flag: the marking loop starts at `i+1`. Its entry iSubRec is zero after the preceding outer statement release. Releasing it returns nSubRec and RAM endpoint to zero, even if younger frames could not truncate earlier.
5. VDBE closes the B-tree statement before decrementing nStatement and invoking virtual-table release callbacks. Any subsequent plain shadow work is a newly scoped operation, not an immortal old frame. On SQL/constraint/FULL error, stop the generation; do not use ROLLBACK TO and continue building while assuming this successful-release argument. Whole transaction rollback/confirmed disposal remains allowed under DELETE.

An outer BEGIN by itself is not a pager savepoint retaining subjournal records for the whole index. Its old pages are protected by the separate main rollback journal. FTS's `iSavepoint` bookkeeping is not a second native page journal.

## Concrete record and requested-allocation bounds

Let N be the installed/read-back main-page ceiling, p page size, and D the reachable automatic statement frame depth. Only page numbers at most N are admitted; no native rowset or graph count is used as an authority. Count a partially written final record conservatively as a full record on the first failing operation.

```text
R1(N) = N
R2(N) = N*N + 2*N                 [safe two-level high-water bound]
U(N,D,p) = R_D(N) * (p+4)         [logical statement undo payload]
```

Proof of R2: a depth-two frame has no children and can append at most N records before release. If it cannot truncate on release, at least one new page bit was filled in the older frame during its lifetime. The older frame has at most N such bits, so at most N completed inner frames can leave retained blocks, each of at most N records. Add at most N direct older-frame records and at most N records for the currently active inner frame. This intentionally overcounts; it handles duplicate page images across sibling inner frames. A page freed/reused within the admitted main image still has the same bounded page number and already-set bits. No continued savepoint rollback is allowed to clear bits and replay this proof indefinitely.

For the pinned win32/x64 memory journal, a FileChunk is16 bytes, the default allocated chunk is1024 bytes and its payload is1016 bytes (`8+1024-sizeof(FileChunk)`). Thus requested journal chunk bytes are bounded by:

```text
Mchunks(U) = 1024 * ceil(U/1016)
```

Add `sizeof(MemJournal)`, at most D `PagerSavepoint` structs, and savepoint bitvecs. A deliberately conservative source-defined bitvec bound avoids pretending they are just a dense N/8 array: define `V(n)=512` for `n<=3968`, otherwise `V(n)=512+62*V(max(3968,ceil(n/62)))` for these x64 layouts. The code's512-byte nodes have62 indirect pointers and3968 bitmap bits; this full-tree bound covers sparse/hash conversion. Bound active savepoint bitvecs by `D*V(N)` and add the main pInJournal bitvec `V(N0)` separately. There is a small bounded rehash stack buffer per recursion level; it is not another graph-sized record set. Native allocator bookkeeping/arenas are not included in requested bytes and no whole-process RSS cap is claimed.

**Tighter fixed-phase application:** schema creation can use R2 with `Nschema<=N`, the admitted page high-water during the fixed empty schema phase; ordinary scalar data/FTS operations use R1 once their generated SQL qualification holds. User content rows are not fed into schema SQL. This avoids applying a quadratic schema-only envelope to every later row. A conservative implementation/proof can use N for Nschema until a smaller schema high-water is separately proved; it need not reserve or allocate the worst-case RAM amount. Necessary native undo proportional to the admitted index is not a new application ref-membership index. Native NOMEM remains a truthful failure yielding unavailable/debt, not an excuse to exceed the disk budget or invent successful cleanup.

## Fixed FTS depth and work qualification

The source argument for data D<=1 / schema D<=2 depends on the following actual cache rules, which the connected implementation must preserve:

- Exactly the recreated schema and one trigram FTS table; its shadow tables have their generated ordinary schemas, no triggers, added secondary indexes/FKs, ALTERed definitions or user SQL callbacks. No extension/ATTACH, explicit SAVEPOINT, RETURNING, multirow VALUES, INSERT SELECT, native sessions or callback SQL is added by product code. Prepared reads/cursors settle before native close and do not carry another executing write VDBE into the operation.
- Single-row VALUES becomes a straight-line insert; initial multiwrite is false without SELECT/triggers. Generated FTS content/data/docsize writes are INSERT or REPLACE on INTEGER PRIMARY KEY ordinary tables without secondary indexes; the source explicitly avoids a statement checkpoint for this REPLACE shape. Generated idx INSERT is a scalar insert on its one WITHOUT ROWID primary tree; all constraints are checked before mutation. Config replacement is a scalar one-primary-tree operation. They do not call a virtual table; index SQL is prepared NO_VTAB and write storage SQL is likewise NO_VTAB.
- Native FTS segment-data/idx range deletes have no FK or trigger. The fixed indexed one-pass delete path may modify many rows but has no statement ABORT work requiring another checkpoint; an allocation/IO failure stops the transaction/generation. Their complete opcode plan still needs the bounded native confirmation below. These native merge deletes remain **retained** even though application FTS/ref deletion is retired; do not exclude them from the audit accidentally.
- A top-level operation may open one statement frame. FTS calls ordinary shadow SQL synchronously; the above shadow mutations do not open an additional automatic statement frame. Flush/crisis-merge can do many such steps, but they share the current frame's page bits and therefore increase work, not R1's unique-page bound. FTS pending-hash flush at savepoint/release is included; the default1MiB hash threshold is not used as the undo bound.
- CREATE VIRTUAL TABLE may call the module's plain shadow CREATE statements, which can own one additional frame. Their nested schema parsing generates code in that same plain VDBE, not another virtual-table call. No generated shadow CREATE invokes another virtual module or trigger. The fixed schema phase is therefore covered by D<=2 and R2. Vtab registration/declare-schema parsing does not constitute an executing third write frame.

This is a version-pinned call/compiler argument, not a claim that NO_VTAB alone forbids every possible nested VDBE or that all FTS configuration paths were qualified. Special FTS commands, rank/snippet/auxiliary functions, contentless-delete, external content, secure-delete, schema changes and arbitrary application SQL are outside the fixed operation set. If a native plan/source check shows a generated mutation requiring another frame or a two-pass row collection, do not silently extend D or migrate the collection to MEMORY; return the precise case to root or use the bounded scalar form where possible.

Native FTS hash/page/merge/query buffers remain necessary scratch in addition to undo. For the current fixed configuration, pending hash has a1MiB pre-next-row threshold plus the current bounded lexical row's tokenization expansion; segment count is source-capped2000; per-segment/term/page buffers are bounded by admitted data and fixed query bytes. The search query input is at most1024 UTF-8 bytes and product output is paged64. These facts give budget/input-dependent bounds, **not** a constant total or a fully enumerated malloc-byte formula. No total FTS RSS claim is needed for the managed disk admission guarantee. The remaining no-disk-temp query plan check must include generated idx ordering/range queries and absence of rank sorting; ordinary API result LIMIT alone is not that check.

## Reset and owner scratch: separate decisions

The saved two-runtime reset mutation plans already contain no RowSet/OpenEphemeral/Sorter for DELETE legacy_rows/pages/plans WHERE binding=?. Those tables have no FKs/triggers; keep that actual qualification. Large resets may journal many pages; use the accepted existing-transaction main envelope, and mark readiness false until a complete reset/stage/confirm sequence finishes. One loop over reset rows is not an implicit graph membership cache.

Owners is different. Its schema has `ref_id REFERENCES refs(id)`. Both `sqlite3FkRequired` implementations return nonzero for deleting from either a child or parent FK table. Delete compilation sets bComplex and withholds WHERE_ONEPASS_MULTIROW. `ref_id=?` is nonunique because one ref may have many owners, so the general bulk delete cannot use the at-most-one-row path. It falls back to collecting rowids in a RowSet before deletion. This source-grounded unbounded owner collection is a concrete issue even without a newly executed EXPLAIN.

Proposed fixed test-only replacement (no schema/FK-policy change):

```sql
SELECT rowid FROM owners WHERE ref_id=? LIMIT 64;
DELETE FROM owners WHERE rowid=? AND ref_id=?;
```

Read at most64 scalar rowids from the existing leading ref_id index, delete each using unique rowid plus exact ref_id, then repeat the first page after deletion. No ORDER/IN/nullable-key cursor is needed. Null session_id duplicates are still removed, and null bound ref_id still matches nothing as before. A scalar unique-rowid DELETE can use ONEPASS_SINGLE even though FK processing is retained. The next bounded native probe must confirm no RowSet/ephemeral and current FK semantics on **both** builds; do not disable foreign_keys to manufacture streaming. The same small selection/scalar deletion pair remains available for resets if a changed supported plan ever loses its existing one-pass qualification. Per-batch transactions may reduce dirty-page units but are not required to pretend the entire original operation is atomic; generation/ready fencing stays real.

The retired application `DELETE chunks_fts WHERE rowid IN (...)`, `DELETE refs` cascades and every VACUUM remain outside the future retained set. Do not use their RowSet findings to reject all DELETE-mode index construction, or use their retirement to omit native FTS merge deletes from proof.

## Smallest discriminating qualification, not a new product architecture

No runtime authorization is implied. Extend only the existing bounded native harness after root dispatch, with the same actual runtime/floor executable and original safety settings:

1. Extract the generated shadow schemas and the exact fixed SQL templates above. EXPLAIN each instantiated data/content/docsize/config/idx scalar mutation, native idx/data range delete, owner bulk delete, scalar owner replacement and existing reset. Include normal, nullable corruption-domain and duplicate-conflict inputs. Preserve plans before proposed replacements. Confirm native FTS/internal range deletion is one-pass and owner bulk/scalar distinction is real. Source flags determine usesStmtJournal; do not misread Transaction.p5 (schema-cookie checking) as that flag.
2. Reuse the already proposed zero-page single-transaction construction with bounded main ceiling/default cache. Record subjournal observations while transaction is open; test schema phase separately from streamed data. Under default temp policy, spilled disk subjournal high-water survives statement release until transaction end, while nSubRec can reset. Under qualified connection-local temp_store=MEMORY, source-truncation/freeing argument replaces any claim that final directory snapshots measure native RAM. No native extension/controller, process-global setting or UDF close is required.
3. Use one large-but-bounded native FTS merge workload and one real constraint/FULL refusal; stop the failed candidate. The source bound permits substantial undo proportional to N. A native-memory sample is corroboration, not a proof of constant RSS. If any source-visible generated operation invalidates the stated D<=1/D<=2 conditions, retain that exact statement/plan as the discriminator and return to root; do not rerun scales or substitute a different journal policy.

The proposed current-owner resource policy is therefore feasible in a precise conditional sense: DELETE main disk allowance from the previous draft, qualified connection-local MEMORY temp routing, native undo bounded by the admitted main image and the fixed statement scopes, IF09 streaming count and scalar owner deletion, with actual native failures retained honestly. This is an admission-budget argument with an explicit environment/memory failure contract. It is not a promise that arbitrary quotas fit survivors or that every host has enough RAM. Product generation/authority/rollback correctness still requires the later one connected Store+service task and actual owner tests.
