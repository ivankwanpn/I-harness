# R4A explicit retained result pages — Task 1 delivery

Explicit bounded artifact pages are now available through SessionService, the SDK, the real CLI host and the conversation-only Gateway adapter. This delivery covers Task 1 and root's narrow PAGE-11 settlement-source repair. Desktop UI/IPC Task 2 has not started.

BASE is `c93b056e68e8f87cdb45af287346e4067a42846f` on `codex/v0.1.13-development`. Implementation commits are `97c6d3558ef8fd5832208e72525b00b5a0b24d22` (memory settlement delegation), `6fd98f9045f496434f5d7619b9075dd57a73ee62` (page service/transport), and `745302f48e71000eac15c30bd7bac780d67e4b7c` (two EOF blank-line removals). The documentation commit and exact handback HEAD are recorded in the final seal. Root's concurrent plan edits are excluded from these commits. Product0.1.13-rc.1, Session10 and decomposition27/43 remain unchanged.

## Original owner and new entry

The rebased BASE had the original ContextOutput artifact operation/ref, pin and current-source checks, plus model-tool `readResult`/`readExecResult` access. Assembly acquisition owned the canonical workspace result-store registry. There was no SessionService page port or SDK page method. Genuine committed-artifact REDs exposed those missing entries before implementation.

The new path is `session/result/read` → SDK transport parser → explicitly injected CLI service port or Gateway conversation adapter → SessionService reader lifecycle → original result-store read lease → shared codec helper → original verified reader. The original artifact owner still checks committed ref identity, caller pin and current source before body/index I/O and after I/O. No new permission or artifact registry was added.

`packages/context-output/src/result-page.ts` defines the original page union and canonical `parseResultPageQuery(input: unknown): ResultPageQuery | undefined`. It is re-exported through ContextOutput and session-executor; SDK's Node transport consumes that same parser. Task 2 may re-export it from `@i-harness/sdk/server` for main-process preflight. Client/protocol DTO exports are type-only. JSON/text use encoded byte offsets; exec uses closed frame cursors and exact base64 slices. The original page DTO and32768 serialized-byte cap are preserved without an extra artifact wrapper. The strict public query refuses oversized budgets and codec-mismatched fields. The model tool retains legacy refId access, exec-offset translation and positive-integer oversized-budget clamping, including64000 and an integer above MAX_SAFE_INTEGER.

The read lease shares the original map, canonical key, factory, deletion observers, source resolver and refcounts. Both acquisition modes retry a retired awaited entry and reserve registration before producer configure. Failure rolls back exactly once. Reads do not configure an active writer, create the legacy SQLite index, capture results or mint pins. Supplied owners are borrowed. A reader registration has no project getter; it cannot mask a confirmed producer scope or turn saved project metadata into execution authority.

The service registers the complete promise synchronously before profile/settings/acquisition awaits and retains it through finally-release. Global and per-session close revoke admission and join that complete lifetime before disposal. A late page is discarded; a session reader can reopen after per-session closing state clears.

The generic SDK router never falls back to the service page method. Capability `session-result-read` requires an explicit host operation. Gateway additionally checks profile existence, archive state, conversation visibility and its management fence before and after a read, inside `fence.run`. Hidden children remain denied even with real pins. The separate parent-scoped child-result route is unchanged. Fresh unbound CLI reads work; a cold saved project binding without an existing confirmed producer scope is unavailable. No execution project resolver, assembly, model preparation, authentication, input admission or wake is invoked to make a read work.

## PAGE-11 original-owner repair

The expanded SDK gate exposed an existing nondurable `skill_get` failure. Receipts32–34 preserve the failing run, diagnostic and exact BASE-production overlay discriminator. The original agent wrapper delegated managed bindings but lost a genuine registered memory binding; synthetic result validation then required recovery before producing tool/result. Root approved the two-line repair in `core-session/src/managed/source-scope.ts`.

Delegation now also preserves the existing memory parent/view binding. Managed and memory bindings remain distinct; a memory source has no storage session ID. The actual parent lifetime and wrapper drain checks remain intact. Tests use a real nondurable owner, real tracked wrapper, real registry and original retention implementation. Same-view capture succeeds; foreign, unregistered, shape-only and closed sources are refused. The original SDK test now verifies the complete failed/dispatched inline envelope, exact SKILL_NOT_FOUND error, one call/result, second-model continuation and idle usable queue. Neither synthetic validation nor durable artifact authorization was relaxed.

## Qualification and source time

Evidence is `.superpowers/sdd/2026-10-20-context-r4a-explicit-result-pages/task-1-evidence/`. Receipts19 onward record executable/arguments, package cwd, UTC start/end, exit, stdout/stderr, isolated IH_CONFIG_DIR and complete before/after manifests of git-listed tracked/untracked package/application/script sources and root configuration. Tests run sequentially with one worker. All successful final behavioral/type gates below use the recorded source digest `661955612947b2b03f8aef377dcba5be16dac9b917eb2c7c71d8eb82544ba5db`.

| Receipts | Qualified result |
| --- | --- |
| 55 | core-session full suite:436 tests /36 files |
| 56 | agent source/synthetic controls:43 tests /3 files |
| 57 | tool finalization/retention:5 tests /2 files |
| 58 | ContextOutput full suite:58 tests /8 files |
| 59 | affected service/original-producer/child controls:39 tests /12 files |
| 60 | affected SDK, real CLI subprocess and original server:71 tests /7 files |
| 61 | Gateway reader, actual host, native policy, fence and child route:40 tests /6 files |
| 62–68 | core-session, core-agent, ContextOutput, session-executor, SDK, Gateway and CLI types:exit0 |
| 69–72 | fresh v2 normal Gateway build;72 copied tests /9 files; package/source/edge/fixture/generated provenance |

Controls cover genuine JSON/text/exec commits, binary and multibyte cursor boundaries, full ref/completeness echo, tiny budgets, serialized page caps, malformed requests, forged revision/codec/bytes/digest/completeness, missing pins, foreign workspace, archived/hidden caller, and native project revocation before/during I/O. Denied/forged/syntactically invalid entries cause zero artifact body/index I/O; an authorized semantically invalid internal cursor may require bounded verified reads. Race controls hold settings/acquisition, page I/O, final release and producer configure, including failure rollback and both producer/read retirement. Mutation receipts24–27 demonstrate those controls fail when the corresponding protection is removed.

The final current source digest is `b42fa3bc76c636d1e51c0b5f067f6cd447e7dc91a6ee313bc373045d9bba777a`. `whitespace-equivalence.json` proves exactly two test EOF blank-line removals and2686 other source files unchanged; every product source is byte-identical to the qualified661 source. Do not attribute the earlier runs to the later physical test bytes. Receipts74–79 had already completed when root stopped unnecessary repeats;80 onward did not launch. All six completed repeats passed. Types and broad Gateway coverage retain their original qualified source time.

Fresh final candidate `.tmp/context-r4a-result-read-20261020-gateway-final-v3/` was built normally after that cleanup. Receipts88–91 cover its build, exact current fixture maps, eight focused copied codec/Gateway/actual-host tests and provenance. The v2 candidate and earlier proofs are preserved. Both copies ship242 packages; the final map verifies78 internal packages,1146 source-identical payload files and322 internal dependency edges resolving within the candidate. Nine fixtures have27 AST-confirmed import-literal substitutions; assertions and bodies remain unchanged. Final copied execution uses workspace Vitest tooling and copied original runtime owners. `copy-map-final-v3.json` and `fixture-transformation-map-final-v3.json` contain every hash and resolution.

The generated WSL worker manifest is verified against its exact generator serialization/schema and original worker bytes. Native helper/MSYS binaries retain their original manifest/source/protocol/qualification identities, verified by the normal asset verifier; they were not rebuilt or live-qualified here.

## Preserved failures and limits

Setup/raw failures remain preserved: the first codec fixture exceeded the65536 producer chunk limit; a scripting attempt did not apply the initial registry edit; an initial Gateway fixture used the private grant name rather than the public grant port; the first copied-fixture script used a Windows path instead of an ESM file URL; and the original SDK failure required PAGE-11. Receipts46/47 preserve the additional model integer compatibility RED/GREEN. Receipt73 preserves the EOF whitespace check failure. Native Git exit handling initially allowed the product commit after that check failed; the separate cleanup commit and later explicit exit gates correct this process mistake.

Early service/SDK fixture acquisitions omitted an explicit settings path and reached the original default settings read. These runs are excluded from the clean-isolation claim. Source-only inspection shows `loadContextOutputConfiguration` calls `readFile(resolveSettingsPath(...),'utf8')`, parses and normalizes in memory; it does not instantiate SettingsStore or invoke writes/migration/auth/credential ports. The resolved default chain is IH_CONFIG_DIR or the harness home. No user settings were reopened to investigate, and no user configuration cleanup was performed. Corrected fixtures use explicit empty task-owned settings; all later gates use task-owned IH_CONFIG_DIR too. Artifact/coordinator roots throughout were task-owned temporary directories.

Final affected gates have no remaining failures. Existing missing optional child-tool diagnostics and optional packages for other platforms are retained in raw stderr. This qualifies the Windows offline owner/service/SDK/CLI/Gateway compositions and the specified copies. It does not qualify Desktop IPC/rendering, live providers/accounts, installed profiles, other operating systems,100MiB/fan-in/crash cuts, full-artifact search, automatic hydration, whole R4A or release readiness. No dependency/version/decomposition changes, branch switch, publishing, push, merge or tag occurred. Implementation writes are frozen for a fresh independent review; mutable progress is excluded from the evidence seal.
