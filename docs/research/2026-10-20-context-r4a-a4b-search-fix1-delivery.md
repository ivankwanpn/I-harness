# R4A A4b Task1 fix1 — canonical child aggregate preview

The corrected consumer indexes both present current-format `subagent/end.resultText` and `error` strings, joined with a newline. It returns empty text when neither exists and preserves empty present strings. The historical no-envelope first-present fallback remains unchanged. Ordinary tool/code results still follow READ-01, and the derived index remains schema2. The original child producer, capture, descriptor, store, result body, execution outcome and publication authority are unchanged.

Status: implementation complete and product writes stopped for the original reviewer's re-review; independent acceptance pending. No Task2, publishing or release work was started.

## Identity and correction basis

- Checkout `D:/I-harness-main`, branch `codex/v0.1.13-development`; clean fix1 BASE `f653b8c1997d3760a8bc2619ed2fa4745ba7d00e` (root's READ-08 plan correction).
- Product HEAD `42bbaebce6ec0b14ef410511b869cfd4f4043d2c`, commit `fix(session-query): index canonical retained child previews`. Delivery documentation follows separately; local SDD reports/ledger remain in the existing ignored workspace.
- Sole product writer `/root/a4b_search_implementation_20261020`; root owns design/integration/acceptance, original reviewer owns re-review. No recursive delegation, branch/worktree switch, push/merge/tag/release, live accounts/providers/user sessions, version or decomposition changes.
- Basis: amended [READ-01/02/08](../superpowers/plans/2026-10-20-context-r4a-a4b-result-consumers.md), local `task-1-review.md` Important finding and `task-1-fix1-brief.md`. Root explicitly approved the real-registry/store/F1 test path after its genuine RED.

The original Task1 plan and fixture were wrong about child-preview ownership. `TaskResultOwner.settle` deliberately writes `preview:''` in its retained descriptor; `tools/spawn.ts` publishes that original descriptor together with the actual bounded `resultText` and `error`. Current validation gives those two fields one aggregate2048-byte budget. Calling them `LEGACY_SHADOW` and preferring descriptor content tested a false expected behavior. The original core RED's three child failures are not product defects, and the query fixtures' child component had the same problem. Initial historical counts are preserved with a dated correction in [the original delivery](2026-10-20-context-r4a-a4b-search-delivery.md). Ordinary result and old-cache defects are separate from that false oracle.

## Real producer counterexample and fix

New `packages/subagent/test/retained-task-search.test.ts` exercises actual TaskRegistry→TaskResultOwner→existing result capture→existing context-output artifact store, then records the original settled descriptor/fields through the existing managed F1 delivery slot used by child completion. It does not instantiate or simulate an entire spawn/model run; the tested producer boundary is the real task settlement owner, using the same managed-publication pattern as the existing retained-task cold fixture.

Four cases cover completed/error outcome × artifact/quota refusal. Before search, each independently verifies the actual empty descriptor preview, execution disposition, retained storage kind, both original preview markers and aggregate byte bound. The retained original body contains both full strings and a body-only marker beyond the preview cut. Actual framed format10 JSONL is closed before the real file-backed factory searches it. Both canonical markers must yield the original parent/seq/event/snippet; the body-only marker and artifact ID must not. Search performs no additional capture or artifact read and preserves exact source bytes and observed revision stat members.

For artifact cases, explicit bounded revision-bound pagination reconstructs the complete original both-field JSON and checks equality with the original body; stale revision reads are rejected. Quota cases retain the bounded fields but correctly refuse a full-result read. Existing cold tests retain their original complete-value/publication/notification assertions and were run in source and copied controls. No preview-only assertion replaced them.

The production fix changes only the child branch in canonical `deriveSearchText`, plus README clarification. Core fixtures separate ordinary envelope content from child aggregate-preview fields; they cover all three retention kinds, both/single/absent/empty fields, deliberately different descriptor content and historical fallback. File-backed fixtures now use canonical child fields with an empty descriptor preview and assert both markers independently. The real old-schema/cache test still preserves actual source revision/fingerprint and bytes, now expecting ordinary result preview hits at seq2/4/5 and canonical child-field hits at seq6.

## Exact source-time evidence

Fresh evidence root: `D:/I-harness-main/.tmp/context-r4a-a4b-search-fix1-20261020-implementation/`. Original17 receipts and both original copies/seals are untouched. Numbered fix1 receipts contain raw output, exact command/cwd/times/exits, status and source manifests before/after. All13 fix1 manifests are stable. Runs were offline and sequential, Vitest max/min workers1, with original timeouts and no edits during a run. No setup/collection failure was counted as behavioral RED.

| Receipt | Observed outcome |
| --- | --- |
| `01-child-producer-red` |4 genuine behavioral failures/4 cases against clean-BASE production: actual TaskResultOwner descriptors have empty preview and real bounded fields, but FTS returns no canonical hit. |
| `02-canonical-fields-red` |8 failed/10 passed among18 core tests. Correct child-field selection/absence/empty cases fail; ordinary tool/code and historical/control cases pass. |
| `03-child-query-red` |4 failed/6 passed among10 file-backed tests. Wrong inline-child body coverage and missing artifact/unavailable canonical fields, including old-cache child-field restoration. |
| `04-child-producer-green` |4/4 actual producer cases pass, including full original artifact body pagination and quota refusal. |
| `05-core-search-results` |37/37 tests across4 files pass: corrected retained search, code search, result envelopes and JSON-data owners. |
| `06-session-query-full` |62/62 across7 files pass, including literal8/9/current10/future11 source controls, owned predecessor1/schema2 rebuild, unchanged-source skip, foreign/future3 refusal, real DDL rollback, legacy query and tools/warning/ordering owners. |
| `07-retained-child-owners` |15/15 across4 files pass: new actual-producer search, existing retained-task-body/cold/negative tests; full-value, revision, publication and refusal checks retained. |
| `08-types-core-session` / `09-types-session-query` / `10-types-subagent` | All three affected owner `tsc --noEmit` checks exit0. |
| `11-gateway-build` | New isolated final Gateway copy exits0 with242 shipped packages. Unsupported-platform optional skips remain in raw output. |
| `12-copy-prepare` |923 source/manifest matches,280 internal in-copy dependency edges,5 QA fixtures and21 mapped production imports. |
| `13-copy-runtime` |37/37 across5 files pass against final copied entries: corrected core18, query10, tools3, actual child producer4 and cold authority/full-body2. |

Fix1 genuine RED began `2026-10-20T12:19:30.2161403Z`. Final copied runtime ended `2026-10-20T12:23:27.5497477Z`. Receipt Git heads are fix1 BASE with the source-time working-tree changes; the final seal maps the final tested bytes to product HEAD. Node runtime remains v24.15.0. No unrelated A3/MCP/whole-workspace suite was rerun; CLI/Gateway type gates from the earlier unit are historical evidence, not newly repeated checks.

## Copied runtime and provenance

New final copy `D:/I-harness-main/.tmp/context-r4a-a4b-search-fix1-20261020-gateway/` comes from the original Gateway builder. QA lives under the new evidence root's `copied-qa/`. TypeScript AST rewriting maps test production imports to copied modules; product copies remain unmodified. `copied-qa-before.json` records all mappings, hashes and internal dependency resolution. The actual child producer test imports copied TaskRegistry, capture, artifact, persistence/JSONL and query owners. The copied cold fixture retains its genuine committed/uncommitted F1 distinction and complete body read.

`seal.mjs`/`seal.json` rechecked all13 receipt stability/exit expectations, final2,665 source inputs against the runtime manifest, all copied production/QA hashes and `git diff --check`. Source-manifest SHA256: `3c00b6391f2e6e7a8407efc49d84786637d32817fcfb78148abaef04001c7ec3`. Inventory:77 evidence files, digest `9e7399e16fe0affdada883b5bb7628106708ef30d2f8603e0d635649bf3bb142`, excluding inventory/seal outputs to avoid self-reference. Seal time `2026-10-20T12:24:07.154Z`. `residual-processes-final.json` is `[]`; all task fixture owners close and remove their own temporary roots.

## Re-review boundary

Self-review checked the complete five-file product diff, producer assertions, corrected oracle and evidence. No TaskRegistry/TaskResultOwner/producer/storage mutation, new API/dependency/service/store/authority owner, schema increment beyond2, source repair, exemption or fake execution consumer was introduced. Existing product0.1.13-rc.1, Session10 and decomposition27/43 remain unchanged.

No known unresolved failure remains in this fix1 tested scope; independent root/original-reviewer acceptance is pending. Copied controls establish library/query/task-owner behavior, not Gateway IPC/Electron/CLI transcript runtime or live protocols. Full-artifact search remains excluded. Task2 and the following explicit artifact-page reader remain outside this writer's scope and continue only under root after acceptance.
