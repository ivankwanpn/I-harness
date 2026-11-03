# A6 plan — conditional comparison to frozen surface-retirement source

2026-10-21. **Source/design comparison passes within the requested scope; conditional on root's later surface acceptance.** No new A6 build-route or original-scale import/API incompatibility was found from the retired private names, guard/option removal, output-retention/CLI dependency removal or ACP test-only dependency. This is not an accepted-source rebase, independent acceptance of the retirement implementation, executed closure proof or runtime qualification.

Root supplied frozen HEAD `8943a4438c4d0bb59f3ebe6d0562b3ba9a39febf` and clean status. Direct reads of `.git/HEAD`/its loose branch ref at the beginning and end of this comparison agree with that HEAD. Clean status is root-supplied; no Git command was run in this task. Fresh independent implementation review is active and root acceptance has not been issued.

Only this comparison file was written. Product/test/helper files and earlier reports were not edited. No product import, runtime, test, build, audit gate/old audit script, GC, install, Git command/mutation, cleanup or agent operation occurred. Checks were bounded source reads/searches and in-memory metadata/hash comparisons; no old runner was executed. The entire accepted-unit matrix was not re-audited.

## Inputs and identity scope

Re-read the retirement delivery and complete responsibility/case/dependency map, local handback identity, current relevant source/manifests/lock importers/builders and original three scale fixtures. The A6 revised draft remains SHA256 `1c417ca45168707bf14ddc73c0b2521ad1fdfe3d2dedc31e0a64c62874ad41ad`, already covered by the scoped amendment recheck in `preflight-review.md`.

For the limited original→frozen comparison, read writer `source-baseline.json` (SHA256 `ae0601f158d395ed6337ccc029e0a2e87aecbd12c5f7e9755dff7c60f5ef5c0b`) and `source-delivered.json` (`ea9753d069317d4cba2d232da6bf7ceb0fa08c10b7a59ec385c3ab5423f0967a`). Thirty selected current files all match their delivered manifest rows. Twenty-five match their baseline rows; five selected changed files are the three requested manifests and two capture declaration leaves. This is selected source evidence, not independent verification of the entire writer seal or source inventory.

The25 byte-identical selected files are: the four builder/copy/verification scripts; Gateway `cli.ts`, `router.ts`, `result-reader.ts`, `subagents/read.ts`; executor lifecycle `result-retention.ts`, `exec-result-retention.ts`, `task-result-retention.ts`, `result-store.ts` and service `result-reader.ts`; subagent `task/result.ts`, `task/registry.ts`, `report-policy.ts`; public indexes for context-output, core-tools, session-executor, exec, sandbox, sandbox-policy, core-plugin, llm-openai-compatible; and ACP `src/index.ts`.

## Retirement dispositions relevant to A6

| Surface | Frozen source finding | A6 implication |
| --- | --- | --- |
| Five unused private root names | Core-session root no longer exports `ExecFrameRecord`, `JsonStreamOptions`, `validResultEnvelope`; output-retention root no longer exports `ResultCaptureOptions`, `ExecFrameCaptureOptions`. Their defining interface/function declarations remain module-local. For **all five defining files**, adding only the removed `export ` prefix in memory reconstructs the exact recorded baseline SHA256. No temporary source file was written. | Existing encoder/decoder/stream/capture signatures and internal validator algorithms are preserved. Original scale fixtures import their functions, not the retired names. Test-only copied leaves can use actual remaining factories; no new product export is needed. |
| Inactive guard and options | `packages/output-retention/src/spill-guard.ts` is absent. Maintained inspected source roots contain no `createOutputSpillGuard`, `gcSpillStore`, `createUnifiedSpillStore`, `OutputSpillGuardConfig` or `outputSpill` match. Current core-session validator remains called from retained-revision/fact validation. | Do not copy old guard tests into A6 or preserve inert host options as qualification knobs. Current collection uses actual surviving tests and mapped transferred obligations. Literal historical raw readers and standalone live shell/native fallback remain separate. |
| Mandatory production capture | `session-executor/src/assembly.ts:558` still constructs the registry with `createToolResultRetention`; line734 supplies `createExecResultRetention` to actual exec registration. Both are independent of the deleted option. The lifecycle retention leaves match baseline bytes. | Removal does not remove ordinary/synthetic/native mandatory capture. A6's real PreparedCall/source/F1 and native dependency controls retain their actual owners. |
| Live shell fallback | Output-retention still exports `createTextRetainer`, `createSpillStore`, `spillNotice` and both capture factories. Shell `tools/retention.ts:2,11–14,44–65` still consumes the live retainer/store/notice API and original explicit fallback. | Keep the existing standalone/shell fallback evidence; do not identify live fallback as the removed registry guard or claim that historical spill bytes were cleaned. |

Writer delivery/case map explicitly labels retired17guard cases and7estimator corpus rows; it moves missing semantic obligations to actual executor/finalizer/native/public legacy codec owners. SDK/ACP option-spy replacements are only construction/close evidence, headless cold facts do not claim full native paging, the synthetic helper's reader reopen does not claim full process retirement, and Gateway DTO validation does not claim complete child/F1 authority reconstruction. These limits are compatible with A6's still-required actual packaged flows and full retirement/cold checks. The delivery's601tests/72files and graph claims remain writer assertions awaiting the active independent review/root acceptance; they are not rerun or independently certified here.

## Dependency and builder comparison

| Change | Actual declaration/copy route | Conclusion and limit |
| --- | --- | --- |
| Output-retention removes core-plugin/diagnostics | Its manifest and normal lock importer retain core-session/context-output/exec/core-tools only. Maintained `src`/current `test` searches found no import of the two removed dependencies. `core-tools/package.json` still declares its real core-plugin dependency, and Gateway directly declares core-plugin too. | No missing retained production import was found. Original scale `createContext` remains available via the actual copied Gateway graph; a retired direct dependency need not be restored for a fixture. |
| CLI removes direct output-retention | Current CLI `src`/`test` search has no output-retention import. CLI still imports/declares session-executor; executor's real production manifest still declares output-retention. | Ordinary/native/Code/task retention remains transitively part of CLI source bundling. CLI did not own the real capture factory merely through its former type dependency. Actual bundle/closure execution remains an A6 gate. |
| ACP adds core-session devDependency | `packages/acp/test/acp.test.ts:10,730` imports public `fromJSONL` for persisted restart facts. `packages/acp/package.json` and lock importer agree that this is a devDependency; unchanged ACP production `src/index.ts` does not import it. CLI already directly declares/imports core-session. | Gateway's copier intentionally walks only dependencies/optionalDependencies, so this test-only row is not an omitted production requirement. `runtime-copy.mjs` excludes tests/node_modules. CLI esbuild starts from production `apps/cli/src/index.ts`, not the ACP test. No reason was found to change either builder or expand shipped devDependencies. |

`build-gateway.mjs`, `runtime-copy.mjs`, `build-dist.mjs` and `verify-dist.mjs` are byte-identical to the selected baseline/delivered manifests. Gateway still copies `cli/src` and recursively declared production/optional dependencies, then tsx/native/WSL assets. CLI still bundles actual CLI+ACL runner and copies native/QuickJS/model-catalog/reader/worker/cpu-budget assets. Both outputs stay inside the repository; ancestor node_modules fallback is still possible without the planned runtime control. Current source/declaration validity does not establish installed resolution or executed ESM/CJS/native/worker closure.

## Actual routes after retirement

- Gateway main remains copied `cli/src/cli.ts` under copied `node_modules/tsx/dist/loader.mjs`, absolute `--session-dir`, fixture workspace cwd. Main calls `createDesktopHost`; package-root `src/index.ts` remains transport DTO exports. Actual host moved one line after removal: `host.ts:463–465` wires `createSdkServer`, conversation reader and membership support. In-process host tests still cannot stand in for main.
- True CLI entry remains `node <cliOut>/ih.mjs sdk --session-dir <absolute>`. Current source `apps/cli/src/index.ts:755–756` wires genuine result reader and membership support. No source tsx/index substitution is permitted in the candidate process.
- Gateway child body remains `desktop/session/subagents/result`, parent sessionId + childSessionId + camelCase resultRevision/refId/refRevision/offset/maxBytes; router/ref/lineage readers are byte-identical in the selected comparison. CLI active `get_task_output` revision selectors remain at unchanged report-policy owner; CLI cold read remains original parent history/ref→`session/result/read`, without task result_revision support. Existing source policy/ref visibility leaves match baseline. Genuine behavior is still to be executed; no cold parent-ref success is inferred from source alone.
- `packages/sdk/test/result-page-cli.test.ts` still requires its declared test-only argv transformation from checkout tsx/source CLI to ih.mjs. Retirement did not turn it into bundle coverage. The original fixture's storage-owner setup limit remains.

## Original scale fixture imports and APIs

None of the original three scripts imports a removed name or supplies `outputSpill`. The required current public factory/codec/context/store/session/lease/policy/task exports are present. Original private lifecycle imports remain at their actual unchanged source leaves. Gateway's declared graph still reaches provider→llm-openai-compatible and executor→output-retention/sandbox/subagent, as well as its direct session-persistence-jsonl/core-plugin dependencies. All transformed copied imports must still be explicitly mapped to candidate package roots/leaves and proven at runtime.

| Original fixture | Frozen API finding / remaining setup |
| --- | --- |
| `normal-100mib.mjs` | `createContext`, `createToolRegistry`, deriveMessages/committedFactSeqs, ContextOutput/coordinator/JSONL and private `createToolResultRetention(service,sourceFor?,ownerSessionId?)` remain. Genuine prepare/dispatch/finalize/source capture route is unchanged. Use fresh evidence root and declared copied import mapping; retain source-less trusted-composition ACL label. |
| `exec-100mib.mjs` | Lease/policy/ExecService APIs and private native/tool retention adapters remain. Genuine tool finalizer still returns `.output` only for program.kind=value (`core-tools/src/registry/finalize.ts:29`); mapped control must check the tag before using compatibility output. Catalog scope/membership are still installed by the unchanged actual retention adapter, not manually bypassed. Keep independent interleaved raw/codec oracles, add exact1MiB case and crossing-chunk I/O as drafted. |
| `child-fan-in-100-v2c.mjs` | SessionService/durable loader, real registered spawn, task registry/taskDocKey/report policy, task result-retention and Gateway context-runtime leaf remain. `restore`, `qualifyRestoredResults`, exact revision/ref page API and parent read owner remain. Preserve default terminal/delivery behavior,180000ms bounds, legal drain, full owner retirement and post-quiescence counters; no use of the removed option. |

Original on-disk script SHA256 reads (no execution/modification):

| File | SHA256 |
| --- | --- |
| normal-100mib.mjs | `4daa6df4e2ab69bfa67fdd3e10c65d51fba0c87dc3b4b5074d86cacf0c68bfba` |
| exec-100mib.mjs | `158f39e3bac664b4363d1c1587856cbbf4d5e9e83bf5b637e0062e12cf040b42` |
| child-fan-in-100-v2c.mjs | `7f18f9517a77b995ba128ca03ebbe06e91bb64b6d9d3f5b413fbeb5c0e37fb13` |

The original fixed roots/imports/cleanup remain unsuitable for direct rerun. Original fixture API compatibility is a source conclusion, not a manufactured runtime receipt. The current draft's fresh mapped copies, fixed independent predecessor wire, paired cold instrumentation, real tool-call SSE, exact1MiB native geometry, runtime closure controls and A1–A10 coverage remain required. No additional route/fixture/closure defect was found that requires changing the scoped draft now.

## Pending accepted-source addendum

Wait for the active implementation review and root surface acceptance. Then bind the final A6 plan to root's actual accepted code/checkpoint, compare any review repairs to this frozen8943a443 scope, select exact rerun/reuse/test-helper/copy import inputs and freeze before execution. A later repair invalidates only the relevant comparisons and affected proof scopes, but must be accounted for before a claim. Do not promote the writer's graph/test receipts into this report's own results, call this frozen source accepted, or begin qualification from this conditional comparison.

Product0.1.13-rc.1,Session10,decomposition27/43,whole-R4A acceptance and R4B/C/R5/R6/renderer/installers/release boundaries stay unchanged. Root retains all acceptance and continuation rulings.

## Final accepted-source design rebase — 2026-10-21

**PASS: the complete revised A6 draft is ready for root promotion and subsequent documentation-BASE pinning against accepted checkpoint `bfc567aa71e7f4a68621d2da9626d34ebe3aeef2`. No remaining actionable source/design finding in this scoped rebase.** This addendum resolves the earlier pending-acceptance condition only. It does not qualify A6 runtime, close the carried P3 test, accept whole R4A or authorize later stages by itself.

Read the canonical `docs/research/2026-10-21-context-r4a-surface-acceptance.md`, SHA256 `2fc30e7803a57183e625e6cd7e8cfd94b7a8b7815cec6c5e76d6245f3ffa2e63`, and the final independent review's recommendation/P3 and source/evidence limits, review SHA256 `1b541680406715c665034eee345303b9f17935ce80dc3cf547c60c45a32e4ffd`. Root now accepts the bounded retirement range through8943a443, with product/test freeze021c7cde, no P0/P1/P2, and one explicit P3 assigned to A6. This replaces the earlier report's statement that root acceptance was pending; it does not replace any accepted scope limitation or failed-install/setup disclosure.

Read the **complete** revised `plan-draft.md`, SHA256 `11d9c859284510a73ee7b83171358216857ef865225da90e1bd8b9fb30efce08`. The three previously checked amendments remain intact: exact1MiB/native geometry and independent oracles; independently fixed predecessor wire and distinct unknown/usable fixtures; precise Gateway/CLI active/cold routing and scoped zero-work measurements. ESM/CJS/native/worker/tsx/inherited loader provenance, positive restricted flows, real tool-call SSE, next-model input and source/ACL versus model-auth distinctions also remain intact. The new Task1 step4 and renumbered size step are bounded additions.

### Accepted checkpoint drift

Read-only commit-range comparison `8943a4438c4d0bb59f3ebe6d0562b3ba9a39febf..bfc567aa71e7f4a68621d2da9626d34ebe3aeef2` lists eight paths, all beneath docs: the canonical acceptance; review/audit-attempts/audit.json/audit.mjs/original-bytes artifacts; and the original R4A and surface plan status updates. The audit.mjs is an added **review artifact**, not a changed shipping or A6 execution helper, and it was not executed here. A separate scoped numstat comparison for packages/apps/scripts/installer and root package/lock/workspace/TypeScript configuration returned no changes. Direct branch-ref metadata reads the supplied bfc567aa checkpoint. Clean status is root-supplied.

Therefore no product/test/manifest/lock/build repair intervened between the preceding frozen-source comparison and this accepted checkpoint. Its selected exact source comparisons, retired-name/API/dependency findings, actual route distinctions and build/fixture limitations carry forward to bfc567aa. The changed draft and this report are planning documents, not a new runtime freeze. Root still needs to promote/pin the plan checkpoint and the actual qualification inputs before execution.

### P3 exact native-preview addition

The new step explicitly targets the existing `session-executor/test/synthetic-result-retention.test.ts:83–138` native-timeout control. Actual source supplies `'native partial 中文🙂'.repeat(10000)` and explicitly selects `createExecResultRetention(f.service,1024)` at lines84–86. The existing assertions preserve timedOut true, exitCode0, stderr empty, exact primary detail/media/code/error, stdout/stderr truncation flags, capture-canceled dependency, complete admitted raw frame content, source/launch/termination/release/body/hook/model counts and final model/envelope caps. The carried weakness is only the stdout cap-only assertion at line128.

Inspected `exec/src/capture/preview.ts:4–20`: push copies first bytes up to cap; snapshot uses `TextDecoder.decode(...,{stream:total>retained})`, leaving an incomplete final UTF-8 sequence undecoded. Independent literal arithmetic through standard .NET UTF-8 byte counting, with no product import/preview/encoder invocation, confirms:

- `'native partial 中文🙂'` is25bytes;40repetitions are1000bytes.
- `'native partial 中文'` is21bytes; the complete expected string is1021bytes.
- The1024-byte admitted prefix has three additional bytes, inside the next four-byte emoji. Those bytes contribute no decoded character under this exact incomplete-sequence policy.

Consequently the draft's literal equality `original.stdout === 'native partial 中文🙂'.repeat(40) + 'native partial 中文'` is a valid independent exact oracle for **this** first-byte preview fixture. It is not generated by the production preview, does not demand full stdout, widen timeouts, weaken raw-frame/metadata/cap checks, or redefine the separate shell head/tail policy. Treat it as test-only coverage hardening with an actual focused/final-scope rerun and final reviewer closure. No product bug/RED or new production behavior is asserted. The test is not edited or executed by this addendum, so P3 remains carried until A6 actually implements and qualifies the assertion.

### Final handoff boundary

Root may now promote the reviewed plan and pin its subsequent documentation BASE under the established continuous-work authorization. Required execution still includes the final owner/consumer reuse map, exact selected test/helper/import manifests, fresh isolated roots, source stability, original scale/copy/runtime proofs and independent final original-range review. The surface acceptance clears its prerequisite, not those remaining obligations. Product0.1.13-rc.1,Session10,decomposition27/43 and R4B/C/R5/R6/renderer/installers/release limits remain unchanged.

For this rebase only the assigned report was appended. Read-only Git diff commands, source/document/hash reads and independent literal byte arithmetic were used. No product runtime import, test/build/audit/old script, install/GC/cleanup, product/test/helper edit, Git mutation or agent operation occurred.
