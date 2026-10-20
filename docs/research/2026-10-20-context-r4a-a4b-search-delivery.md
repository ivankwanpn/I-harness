# R4A A4b Task1 — retained-result search delivery

Task1 is implemented and handed back for independent review. The canonical search projection now reads retained result facts in `tool/result`, `code/result`, `code/output`, and `subagent/end`. Inline retention serializes only the original owned value with the existing shared JSON-data serializer; artifact/unavailable retention indexes only the stored preview. Arbitrary inline fields named `images`, `error`, or `ref` remain data. Separate typed media, immutable artifact descriptors, and dependency catalogs are excluded. Historical raw branches and unrelated control/status indexing policy remain intact.

The existing file-backed derived schema/projection advances from1 to2. The original application-id validation and transactional schema setup remain the only rebuild owner. An old owned cache is discarded before reconciliation even when source revision/fingerprint are unchanged. Future derived version3 and foreign application IDs are refused without resetting their tables. Session format10, JSONL bytes, legacy persistence SQLite, query DTOs and public producer contracts are unchanged.

## Identity and scope

- Checkout/branch: `D:/I-harness-main`, `codex/v0.1.13-development`.
- BASE: `4b0f949c4aa0e44b9061686cdc357dcb39f2218e`; clean working tree at dispatch.
- Product HEAD: `d2b624edb46c75000079e8867d2794631b61ce38` (`fix(session-query): index retained result facts and rebuild old cache`). This report/ledger are a following documentation commit.
- Sole product writer: Task1 implementer agent `/root/a4b_search_implementation_20261020`; no recursive delegation or checkout switch. Root retains design/integration/acceptance ownership.
- Approved basis: [Task1 and READ-01/02/03](../superpowers/plans/2026-10-20-context-r4a-a4b-result-consumers.md). Applied TDD, systematic debugging and verification-before-completion workflows.
- Product remains0.1.13-rc.1; Session format10 and decomposition27/43 are unchanged. No push, merge, tag, release, live provider/account or user-session work.

## Actual producer and reader path

Accepted result producers record the closed `ResultEnvelope` through core-session intake and original framed F1 JSONL. File-backed search scans the actual source root, decodes the verified journal prefix with `readFactJournal`, and runs `deriveSearchText` while rebuilding `indexed_docs` inside the existing per-session transaction. The existing factory reconciles before SQL FTS search and returns the original hit DTO including event type, sequence and snippet. No artifact reader/service is imported into the search projection or query owner.

The defect had two connected boundaries: tool/code results read absent legacy `output`; child completion read the historical shadow preview; inline `code/output` used message-oriented `resultText`, which also serialized dependencies. Separately, genuine `indexed_sessions` revision/fingerprint rows caused the existing unchanged-source skip to retain obsolete empty FTS content. A private projection helper and the existing schema version invalidate those obsolete rows without adding a freshness owner.

## Exact evidence

Evidence root: `D:/I-harness-main/.tmp/context-r4a-a4b-search-20261020-implementation/`. Every numbered receipt retains `receipt.json`, raw output, working-tree status, and before/after SHA256 manifests. Commands run offline and sequentially with Vitest max/min workers1. All13 receipts report equal source manifests before/after. Each receipt's Git HEAD is the BASE with the tested changes in the working tree; the final seal maps those bytes to product HEAD.

| Receipt | Observed outcome |
| --- | --- |
| `01-core-search-red` | Genuine baseline behavioral RED:10 failed/3 passed in13 tests. Tool/code retained text empty; child shadow text selected; inline code/output leaks envelope/dependency metadata. |
| `02-filebacked-red` | Genuine baseline RED:6 failed/13 passed across19 tests/2 files. Three retained-content cases lose tool/code/child hits; literal old cache returns no preview hits with unchanged source; schema2 fresh expectation and predecessor transactional-rebuild discriminator fail. No test collection/setup failures. |
| `03-core-search-green` |13/13 tests pass. All four families × inline/artifact/unavailable plus historical/control policy. |
| `04-filebacked-green` |19/19 tests pass across2 files. Real framed JSONL→factory→FTS hit/seq/snippet, source immutability, schema1 rebuild and unchanged second-query skip, literal8/9 predecessor controls, literal future11 rejection, foreign/future3 byte preservation and real SQLite DDL rollback. |
| `05-core-search-results` |32/32 tests across4 files pass: code-search, retained-result-search, result-envelope, json-data. |
| `06-session-query-full` |62/62 tests across7 files pass, including legacy query owner, journal/ordering, tools and actual child-process warning controls. |
| `07-types-core-session` / `08-types-session-query` | Both `tsc --noEmit` exit0. |
| `09-types-cli` / `10-types-gateway` | Both affected consumer `tsc --noEmit` checks exit0. These are type qualification only. |
| `11-gateway-build` | Fresh isolated Gateway copy build exits0;242 packages shipped. Unsupported-platform optional-dependency skips are preserved in raw output. |
| `12-copy-prepare` |923 source/manifest copies match;280 internal package dependency edges resolve inside the new copy;4 QA fixtures with11 mapped production imports. |
| `13-copy-runtime` |33/33 tests across4 files pass against actual copied entries. Includes actual existing context-output service committing1MiB artifact bytes, explicit fixture read confirming the body marker exists, preview-only FTS hit, no body/ref hit, unchanged JSONL and artifact bytes. |

Source-time RED started `2026-10-20T11:48:50.4153448Z`; final copied runtime completed `2026-10-20T11:52:58.2148158Z`. Exact command arguments, cwd, start/end, exit and source identities are in the individual receipts. `run.ps1` invokes `C:/Program Files/nodejs/node.exe`, the repository Vitest/TypeScript entries, and the original Gateway build script. No sources were changed during any numbered run. No unrelated A3/MCP or whole-workspace suites were rerun.

The cache regression first fills a real persisted index by searching a user-message marker, closes all owner connections, preserves the actual observed `indexed_sessions` rows, empties the four result-family FTS rows and writes literal `PRAGMA user_version=1`. It reopens the real factory without touching JSONL. The fixed query returns seq2/4/5/6, observes `indexed`, then observes `skip` on the second unchanged query. After closing, schema2 and the original revision/fingerprint rows are verified; exact source bytes, size, mtime, ctime and inode still agree.

The rollback control uses real SQLite: replacing the FTS table with a view causes the older-version setup to fail on `DROP TABLE` after dropping `lineage`. The owner rolls that earlier drop back, preserving original lineage/session rows, predecessor version1 and the view. No new transaction mechanism was added.

## Copy mapping and seal

Fresh copy: `D:/I-harness-main/.tmp/context-r4a-a4b-search-20261020-gateway/`. The normal Gateway builder copies approved workspace trees and resolves runtime dependencies. QA fixtures live under `.../context-r4a-a4b-search-20261020-implementation/copied-qa/`. `prepare-copied-qa.mjs` maps imports with the TypeScript AST; copied product files are unmodified. `copied-qa-before.json` records each source/copy hash, rewritten fixture/import target, configuration hash and internal resolution edge.

`seal.mjs` rechecked all13 receipt stability/exit expectations, all final source files against the last runtime manifest, every mapped product/QA hash, and `git diff --check`. `seal.json` records2,664 package/app/script/root-configuration inputs, source-manifest SHA256 `533b37bc524146f1fe58f2fcb0e1eb92497121b5aafff9efa23635b9a4f366b3`, and product HEAD. `inventory.json` records77 evidence files with digest `7c12ae3bbb8cd81e2f37f84c6933ffa28b40a9c57779f64c5f91a84f5327296b`, excluding itself and `seal.json` to avoid self-reference. The seal was written at `2026-10-20T11:54:00.268Z`.

## Review boundary and limits

Self-review inspected the complete product diff, test discrimination and exact evidence. The implementation changes only the existing projection and derived version; no new public API, dependency, service, store, permission owner, reachability exemption, reseed or fake consumer is introduced. Source tests use valid fixture descriptors; the additional copied-runtime control uses an actually committed immutable artifact from the existing owner. `residual-processes-final.json` is `[]`: no task-labelled Node/Vitest process remains. The query and artifact fixtures close their owners and remove only their own temporary roots.

Independent root/reviewer acceptance is pending. Product writes stop at handback. This unit establishes bounded search/cache behavior and copied-library runtime behavior. It does not qualify Gateway IPC, Electron renderer, CLI transcript rendering, six live protocols, full-artifact search, explicit artifact paging, all R4A, or release readiness. Task2 and the following artifact-page reader remain the next approved units after root resolves review findings.
