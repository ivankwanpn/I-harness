# Task 1 DELETE proof wave — IF10–IF14

Status: **new fixed DELETE source/native qualification GREEN; ready for independent root review**. This is the same foundations task, not product adoption, integration or a claim that the existing expiry/full-budget WIP is accepted. The original OFF policy remains rejected, its required-policy RED and callback-close crash receipts remain historical. No Store/service/gate changes were made in this wave.

Sole checkout: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`, branch `codex/derived-index-foundations-20261025`. Wave BASE is WIP `2cd94218c94675665d430402f0661fe3f7e8253f`; original task BASE remains `abbc30c416ef12b897917e2ef049b84424a54d28`. Evidence directory: `D:/I-harness-main/.superpowers/sdd/2026-10-25-derived-index-foundations/task-1/delete-if10-13/`. Explicit policy revision: `DELETE-IF10-13-20261025`, with IF14 compiler-only audit adaptation.

## Native results on BOTH required Windows runtimes

Official-checksummed active Node24.15.0/SQLite3.51.3 and floor Node22.18.0/SQLite3.50.2 produced matching bounded outcomes. Every child executable, argv, native version/source identity, environment, source/receipt hash, stdout/stderr/status and phase observation is saved. No runtime fallback, defensive downgrade, synchronous/cache/spill weakening or global temp redirect was used.

| Control | Native result |
| --- | --- |
| Fresh construction | page_count0 before BEGIN; one transaction contains unchanged schema plus all rows; schema21pages under read-back64page cap; same-transaction raise to768 confirmed |
| Normal construction |377 lexical4088-byte rows; first sampled pre-COMMIT main spill by row369; before COMMIT main90112bytes, journal1024; commit581pages; exact original close and unlink succeed |
| Natural FTS merge |89 lexical4088-byte rows from a bounded12-cycle CJK corpus; default hash/merge policies; idx-row decrease observed; before COMMIT466logicalpages, main438272bytes, journal1024; commit466pages; close/discard succeed |
| Native FULL |96page main cap after schema; native ERR_SQLITE_ERROR / errcode13 / original `database or disk is full`; no post-failure SQL/recovery query; original close and discard succeed |
| Real constraint |64 streamed rows then duplicate legacy_rows(binding,ordinal); original errcode1555 and UNIQUE message retained; no post-failure SQL; original close/discard succeed |
| Transaction process exit |377rows; process.exit29 while actual transaction remains open, before COMMIT and without native close; parent inspects retained main90112/journal1024 only after child exit; no recovery SQL or parent unlink |
| Existing-index mutation |N0=D=21, p4096, Sbound4096: conservative journal envelope270504bytes; actual pre-COMMIT journal37448/main86016; owner batches64+64+2, legacy reset, owner reinsert succeed; close/discard succeed |

Native failure controls retain original failure and filesystem state before close. No continued application SQL, retry, ROLLBACK TO or reused ready generation occurs after a failure. DELETE's native rollback during error/close is permitted; these controls do not prove future Store generation invalidation or authority semantics.

## Source proof and MEMORY precondition

`source-audit/qualification.md` records the exact source/compiler reasoning **before MEMORY was enabled**; `source-qualification.json` binds its hash, both exact native sources and both prior passing plan receipts. The child rechecks these hashes before each MEMORY candidate.

The source-based fresh main-journal envelope is `Jfresh<=2S<=8192` on these pinned Windows builds. Transaction original pages remain0, hence no main original-page records; first spill can add one extra sector header, later normal spills and COMMIT do not add another. Page allocation/write/Windows size-hint paths respect the read-back main ceiling; no chunk-size option is issued. Admission is `Abytes+N*p+2S<=Q`, contingent on the qualified no-disk-temp operation set. Observed1024-byte journals corroborate, and do not replace, that source proof.

Existing transactions are separate: `Jexisting<=D*(p+8)+(2D+3)*S`, with D=N0 unless a tighter bound is proved. This wave does not promote old unexplained32768byte margins into a theorem or guarantee that arbitrary survivor layouts fit a quota.

Statement undo data-depth<=1 and schema-depth<=2 are source/compiler conditions for this exact fixed schema and generated SQL. Schema uses `min(N,64)` before data; native same-transaction cap raising is confirmed. R1=N; R2=N²+2N; logical payload is R*(p+4), with source chunk/bitvec/layout terms recorded. For schema64:4224records/17,318,400logical bytes/17,455,104requested chunk bytes; for data768:768records/3,148,800logical bytes/3,174,400requested chunk bytes. Add exact journal/savepoint/bitvec wrapper terms; no native allocator-arena or whole-process RSS cap is claimed. The source top-level release rule truncates RAM undo to entry offset0 between successful statements; necessary native undo is not an application ref-membership graph.

After qualifying retained SQL, connection-local temp_store=MEMORY reads back2 with journal_mode stillDELETE and original safety/cache/spill/FK settings unchanged. TEMP_STORE=1 plus local2 feeds subjInMemory, forcing nStmtSpill=-1; the memory wrapper's disk-spill guard nSpill>0 is unreachable. Retained plans have no graph membership sorter/tree; fixed-schema index sorts have empty input. Native FTS buffers allocate memory/write main shadow tables; generated data/idx merges and ordered queries are included. No ATTACH/WAL/VACUUM/backup/serialize/second DB, special FTS command, callback SQL, schema trigger or temp directory redirection appears in a candidate. Native NOMEM/I/O/full/refusal remains a truthful failure contract, not assumed success.

## Compiler audit and its limits

Active defensive mode correctly refuses direct public shadow mutation preparation. Root IF14 permits ordinary clones of actual captured shadow DDL in the separate compiler audit fixture; actual resource candidates use the unchanged schema with no clones. Exact generated SQL differs only by clone identifier substitution; numbered native bind positions are honored. The source analysis covers TF_Shadow's authorization branch and NO_VTAB ordinary-table resolution: neither changes the relevant multiwrite/abort flags for these fixed ordinary shapes. The clones are **not an active internal trace or dynamic frame-depth measurement**. Source conditions, captured schemas/plans and actual FTS work jointly support the qualified bound.

Both versions' generated shadow scalar mutations, native range deletes/ordered reads, legacy reset and IF09 count/keyset/FTS plans have no OpenEphemeral/Sorter/RowSet collection. Bulk owner deletion genuinely uses RowSetAdd/Read and remains rejected. A bounded rowid page plus scalar deletion removes72 matching owners, including two NULL sessions, as64+8 while preserving other/NULL-ref rows and FK policy. The original combined DISTINCT-count failure and the earlier IF09 nullable-preserving streaming comparison remain historical evidence. Shipping FTS/ref deletion and VACUUM are retired by planned cleanup; native FTS merges remain audited.

Default-temp diagnostics ran before MEMORY. No attributable disk subjournal high-water was exposed by available between-statement temp-name snapshots. That is an observation gap, not absence proof; no trace/interceptor was invented or installed. Filesystem snapshots are not transient-I/O/RAM-peak measurements. The managed journal is explicitly observed before COMMIT; zero post-COMMIT journal length is not the proof. Any changed VFS/build, SQL, shadow schema, trigger/index/FK, callback, special command, user SAVEPOINT or error-continuation discipline requires requalification.

## Verification and exact scope

Final replay: `runs/qualification-80e93f61-8842-417d-8249-5aee6af56dbe/`.

```text
pnpm exec vitest run test/legacy-index-native.test.ts --exclude test/legacy-fork-scale.test.ts -t '^(?!.*10001)' --maxWorkers=2 --minWorkers=1
pnpm typecheck
```

Result: native file2/2passed (14 actual child controls across both versions), tests exit0, typecheck exit0. Six IH isolation roots are fresh for tests and refreshed for typecheck. Pre/post verification source hashes match. Gate/source tests and close/callback characterization were not rerun; unchanged gate remains the prior independently reviewed foundation. No1001/10001/full-budget/broad-package/Gateway/provider work ran.

Only `packages/context-output/test/legacy-index-native.test.ts` and `packages/context-output/test/helpers/derived-index-native-probe.mjs` changed since WIP. The gate, original Store/search/legacy files, package manifests and lockfile are hash-stable. The protected Gateway test remains unread/unrun/untouched; only its pathname appears in Git status. No package/global/profile change or product adoption.

The next connected Store+service task still must implement/test actual generation fencing, retirement/cursor settlement, original ordinary-grant restoration, funded authority cleanup, real policy/source preservation and complete public outcomes. This test-only probe does not substitute a lifecycle controller or fake owner for any of those. Existing Task2/full-budget status remains unaccepted.

## Handoff artifacts

- `runtime-manifest.json`: active/floor official executable hashes, exact SQLite source IDs and compile options, configuration/phase readbacks, raw directory paths.
- `sql-plan-audit.json`: actual generated schema, clone metadata, exact SQL/bindings/plans/opcodes, owner semantics and retained scratch classification.
- `source-audit/qualification.md`, `source-qualification.json`, `source-audit/undo-bounds.json`: source-equivalence/truncation/temp proof, hash-bound pre-MEMORY qualification, explicit requested allocation formulas.
- `native-summary.json`: full/constraint/exit/normal/merge/existing receipts and per-phase file observations.
- `source-manifest.json`, `final-verification-result.json`, `replay.ps1`, `wip-to-delete-wave.patch`: source identities, exact replay commands/environment/results and review diff.

Official Node/pager sources remain at `D:/I-harness-main/.superpowers/sdd/2026-10-25-derived-index-foundations/task-1/sources/v24.15.0/` and `/v22.18.0/`: `src_node_sqlite.cc`, `src_node_sqlite.h`, `deps_sqlite_sqlite3.c`, `deps_sqlite_sqlite.gyp`. Their exact URLs/SHA256 are in parent `sources/downloads.json`; no download was replaced or executed without official checksum verification. Full commit/range receipt follows at the task boundary.

## Final commit/range receipt

Commit: 63825004a6a53d686e0955a771e27274d3b14c68 (test: qualify fixed DELETE derived-index native foundations).
Wave range: 2cd94218c94675665d430402f0661fe3f7e8253f..63825004a6a53d686e0955a771e27274d3b14c68 — two native test/helper files only.
Full same-Task1 range: abbc30c416ef12b897917e2ef049b84424a54d28..63825004a6a53d686e0955a771e27274d3b14c68 — exactly four allowed files.
Tracked working tree clean; sole untracked pathname is the preexisting protected Gateway test. Final replay source hashes still match after commit. No more tests ran after the final recorded GREEN replay.
Status READY_FOR_INDEPENDENT_ROOT_REVIEW. No promotion, integration, product adoption or connected next task started.
