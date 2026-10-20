# R4A structure fix1 — preserve live workspace reads

2026-10-21. The fresh review of `bad38c2d..f9b0dcd7` found a real P2 regression: the extracted legacy capture evaluated mutable `options.workspaceId` before its original producer/storage awaits. The original body evaluated that property twice during reference construction afterward. A fresh unopened store could consequently persist a `before` reference inside the `after` workspace directory; live read succeeded, but cold reopen refused `Invalid context artifact identity`. **The prior frozen candidate was not accepted.** Its green tests and body-token comparison did not cover this evaluation boundary.

The narrow additive repair is `f7086d8acbf6febb5724688408d597beabae1d03`. Incremental code/test range is `f9b0dcd79e628e8776a717937a7df126481b1f51..f7086d8acbf6febb5724688408d597beabae1d03`; full structural code/test review range is `bad38c2dc8b5663eaaeb2ef283ecd2b8de7b9994..f7086d8acbf6febb5724688408d597beabae1d03`. The subsequent proof/documentation commit is included in the exact final ranges in the separate local fix1 handback. Original whole-R4A BASE remains91d8fef0 for later root acceptance. No amend, push, merge, tag or release occurred.

## Exact repair and regression

Only two product files change. Service passes `() => options.workspaceId` instead of an evaluated scalar. `captureLegacy` accepts that narrow getter and invokes it **separately at both original reference-construction expressions**: referenceId's workspace argument and the reference's workspaceId field. It does not cache one late value. The existing lazy getStore still reads the same options object in its original location. Options remain mutable; no clone/freeze/validator/identity-policy/config/job/queue/lock change is added.

The new actual public-entry test file is `packages/context-output/test/legacy-workspace-timing.test.ts`, with three tests:

- An independent constructor calibration records the three existing constructor accessor reads and proves the legacy directory remains unopened. It uses a separate fresh service/root from capture cases.
- An ordinary held-producer positive and a same-options mutation case record zero accessor reads before producer release. After release, the first workspace read occurs while the legacy directory does not exist, and the next two occur after the real store opens. This distinguishes original lazy-store timing plus two original ref expressions from both an early scalar and a single cached late read.
- Both capture cases validate the independently constructed SHA reference identity, actual workspace directory, persisted ref, live exact literal body and cold exact literal body. Producer invocation remains once; finally releases/joins capture and closes services with jobs0. Files remain intentional evidence after owners close.

Native gate01 reproduces genuine RED on the unfixed candidate: constructor calibration passes, two accessor cases fail; mutation also preserves the wrong workspace/ref and cold identity refusal. Soft assertions collect the cold consequence after earlier timing failures. Gate02 runs the unchanged final three-test file against the **byte-exact original BASE service entry**, and all3 pass. The original supplied buffer hash is checked against the old sealed replay and actual Git BASE text under its recorded newline convention. New leaves remain on disk but are not referenced by BASE service; TaskRegistry/shared package closure stays current. `replay.json` preserves both buffers/hashes and exact restoration. Gate03 then passes3/3 after the narrow repair. No failing assertion or deadline was weakened.

The review's independent original public control is preserved read-only in `.tmp/r4as-rv2` and copied into the new proof inputs: ordinary calibration passes both, BASE mutation passes, candidate mutation fails, with native exits0/1, producer1 and jobs0. Its source-map explicitly distinguishes copied Context Output entries from shared unchanged package dependencies; it is not a full BASE checkout or packaged runtime. No old sealed control/runner was rerun.

## Refreshed qualification

Fresh affected gate04 passes **87/87 tests in11 exact current files**, including the new3 tests and84 existing affected regressions. It uses repo cwd, explicit `--dir packages`, exact selected paths, `.tmp/.worktrees/release*/build/dist` exclusions and maxWorkers2/minWorkers1. [The actual receipt](context-r4a-structure-fix1-proof-20261021/04-related/receipt.json) records the complete argv/env and exact expected/collected paths; they match. The [native test report](context-r4a-structure-fix1-proof-20261021/04-related/tests.json) preserves all results.

Selected scopes are Context Output `legacy-workspace-timing`, `legacy-operation-boundaries`, `service`, `disabled-grant`, `result-integrity-{vectors,codecs,corruption,witness}`, `cold-lookup-integrity`, and executor `mixed-retention-{quota,native}` `.test.ts` files. No unrelated original task/S25 suite or physical crash matrix was repeated. The previous210-test evidence remains source-scoped historical evidence;126 unaffected tests are reused rather than described as a fresh213-test combined run. Task/S25 code, existing result/outbox/save authorities, public API/manifests/dependencies and old graph findings remain unchanged.

| Gate | Native result / purpose |
| --- | --- |
|01-red |exit1,1pass/2fail; actual accessor timing/ref/cold-read regression |
|02-base |exit0,3/3 unchanged tests on original BASE service entry |
|03-green |exit0,3/3 after repair |
|04-related |exit0,87/87 in11 exact current files |
|05-types |Context Output TypeScript `--noEmit`, exit0 |
|06-executor |Executor main TypeScript `--noEmit`, exit0 |
|07-mts |Executor `--noEmit -p tsconfig.mixed-retention.json`, including actual `.mts` helpers, exit0 |
|08-gateway |Gateway TypeScript `--noEmit`, exit0 |
|09-equivalence |Updated original algorithm token comparison, unchanged authority hashes and hard-size check, exit0 |
|10-freeze |Frozen47-file source census, exit0 |

All10 native gates are sequential/nonoverlapping and source-stable. Node is the explicit installed `C:/Program Files/nodejs/node.exe` v24.15.0. Shell IH_CONFIG_DIR points to the fresh `.tmp/r4as-fix1-1021/config` **before** Node/imports/subprocesses. Each gate receives fresh guarded mixed/integrity/native/publication/physical/structure roots. The new test calls the existing ancestor-aware guard before dynamic product imports. Actual argv/cwd/HEAD/pid/times/exits/stdout/stderr and before/after source manifests are retained.

The token comparison now substitutes original `options.workspaceId` with `getWorkspaceId()` at each expression, alongside the existing narrow config/store/policy substitutions. **Body-token equality alone does not prove argument evaluation timing.** The prior scalar substitution was insufficient; the new actual public accessor/count/cold-read controls supply that missing evidence. The old token proof and all earlier report/hash bytes remain unchanged. Current helper output records this limitation explicitly.

The responsibility map's previous scalar capture-port notation is superseded here by `captureLegacy(getWorkspaceId, captured, producer, getConfig, getStore, owned)`. All other ownership/S25 lifetime and consumer mapping remains as reviewed. Census remains47 scoped files, no function≥250lines or≥18000characters: service176lines/9365characters, capture35lines/2116characters, registry unchanged201lines/8866characters. Catalog121, artifact ownership172 and job registry145 remain the same reviewed cohesion exceptions; this repair adds no state owner or new closure.

Normal reachability was not rerun or repaired. The prior identical six exported-name findings remain failed/open as reported. Public-surface retirement and A6 work are root-owned; this repair neither removes APIs nor adds fake consumers/exemptions.

## Separate frozen evidence and cleanup

The new `.tmp/r4as-fix1-1021` root is sealed with **760 entries:748 regular files/14,253,339bytes plus12 recorded links**. Its inventory excludes only itself and the outer seal. Final source/input manifest contains2676 entries; all2671 product/test/root-config inputs remain byte-identical to the final affected run. Five task helper scripts are separately inventoried; only the evidence finalizer was added afterward, declared in gate-summary. Reports/progress/docs are excluded from runtime manifests and separately hashed.

| Artifact | SHA256 |
| --- | --- |
| Final source inventory | `43e2bc1a8480f5d13c54361382f6aaa7acd62ef6663fdb2aca9de8a52b74b798` |
| Evidence inventory | `60ec10a1d28013d9f151c84203ae01a5cab1eea64bcd220a76f99dde9d5fbf9e` |
| Outer seal | `a1a638494fd7568ecb674f1fa8a15b3d8dfc7eea831806cd1428bc107353027c` |

The [separate portable proof directory](context-r4a-structure-fix1-proof-20261021/) contains readable JSON receipts/reports/replay/census/cleanup plus `original-bytes.json` preserving53 exact encoded original artifacts, including raw stdout/stderr and the original reviewer control/source map/report. Full physical fixture bytes stay in the sealed local root. Encoded originals preserve actual bytes across Git newline policy. Read-only exploratory receipt-path mistakes and the prior proof limitation are recorded in setup-notes rather than fabricated native failures.

Read-only provenance verification confirms all nine captured review inputs unchanged and every one of the original writer's1456 inventory entries still matching:1432 regular files retain their exact bytes and24 link identities remain unchanged without traversal. Neither original `.tmp/r4as-1021-01` nor review `.tmp/r4as-rv2` was written.

All12 new timing observation records finish with activeJobs0. All five final mixed fixture cleanup records join native/broker/coordinator closure with open=false and zero Context/Code jobs. Task-root process query finds no matching node/pwsh/powershell/bash process excluding the query itself. This is joined task cleanup, not a universal OS handle or historical temporary-directory audit; preserved artifact files are evidence, not live owners.

## Stop boundary

The repair is ready for the original fresh reviewer's recheck and root audit. It does not self-accept the structural unit, S25/CX2, original27/43 counter changes, R4C or whole R4A/A6. No final100MiB/100child/copied/bundled/renderer/provider/installer work or new agent was started.
