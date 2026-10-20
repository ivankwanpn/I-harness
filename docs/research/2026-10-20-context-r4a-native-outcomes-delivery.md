# R4A native producer outcomes delivery — 2026-10-20

The original foreground native execution and Code Mode launch now declare their trusted execution outcomes through the existing registered producer. Program values, retained bytes, envelope schema and model identity remain owned by their existing paths. Successful startup, promotion, observation and control calls keep their own success semantics.

Implementation base: `72a04b02b123ba2371cd78ac21029fe020b4de0e`. Product/test commit: `3cf3bc12c4eea5518f0d7753c0dbb9b1e007cb0b` on `codex/v0.1.13-development`. The documentation handoff commit follows this product commit. Independent review is pending; this delivery does not claim release readiness or acceptance of later R4A units.

## Original owners changed

- `sandbox/execution-lease.ts` stores the admitted native termination reason synchronously in its existing termination object. Its immutable observation reads original native termination and first successful reason, including failed termination after cleanup recovery. No cancellation, listener or cleanup action is introduced by observation.
- The existing POSIX, WSL and Windows Psec handle whitelists explicitly forward that optional method. Their original settlement and release paths are preserved, including Windows session release before lease release.
- `exec/capture/completion.ts` classifies after its original root, tree, I/O and cancellation barriers, using the original RootExit before null normalization. Confirmed timeout/output-limit fails; confirmed cancellation/authority/shutdown cancels; supported none plus reliable integer exit yields success/failure; unsupported/pending/failed or unreliable root yields unknown. Caller abort, capture stop, root code and tree disposition remain distinct.
- The existing retained-output WeakMap holds reader and outcome together. Reader registration preserves outcome; internal outcome registration preserves reader. Retention-failure rewrapping transfers the whole entry, including streaming outcome-only identities. The original already-aborted no-launch branch attaches canceled at admission. No enumerable field or symbol was added to ExecResult or shell output.
- `core-tools/registry/result-finalization.ts` adds a declaration bit to its existing row so explicitly declared unknown survives ordinary return. Only undeclared returns default to succeeded. Presentation metadata and prepared identity checks remain intact; serialized execution remains only outcome/dispatch.
- Original foreground shell/bash/pwsh producers read host identity before presentation; built-in custom ExecService paths lacking it declare unknown. Original binding, validation, policy and backend refusals declare failed while preserving their bodies. A small shell helper holds the shared identity declaration.
- Only `code_exec` declares from the original runtime observation before serialization. Failed/terminated map to failed/canceled; running/completed map to succeeded. wait/status and successful terminate observations stay successful. Policy-refusal throws and guest-caught nested failure behavior remain intact.

## Root-authorized NAT-13 repair

The focused runtime gate reproduced the unchanged `bounds retained completed cells and truthfully refuses evicted observations` failure: a synchronous closed callback resolved the test listener, but unconditional `await event(...)` deferred installing completed status. The next admission saw a running cell. The earlier A3 delivery already recorded this same failure; this run preserved its test and RED.

Root explicitly authorized a narrow repair in the original `runtime/retirement.ts` terminal owner: call the callback, await its returned Promise only when one exists, then commit. The callback must return before commitment. Actual asynchronous acknowledgements still block completed status/admission; ordinary rejection remains failed, FACT rejection remains recovery-required. Added discriminator tests cover those barriers. The original eviction test is unchanged and now passes. No separate state owner or storage bypass was added.

## Behavioral evidence

Fresh evidence root: `.tmp/context-r4a-native-outcomes-20261020-implementation/`. Each named run has `.json` executable/argv/cwd/start/end/exit/source-before/source-after/stability metadata and raw `.log` output. Commands use package cwd, explicit files, one worker and no file parallelism. Runs and product writes were sequential; returned process sessions were explicitly joined before the next run.

| Evidence run | Result |
| --- | --- |
| registry-red → registry-green | Explicit declared unknown wrongly succeeded, then 4/4 pass through actual prepare/dispatch/finalize. Ordinary payload lookalikes remain succeeded. |
| lease-red → lease-green; lease-final | 3 missing-observation failures, then 27/27 pass; final 27/27 includes failed→successful retry reason, pending/reentrant ownership, immutable snapshots, late tree-empty cancel and root0/live-tree controls. |
| exec-red-corrected → exec-green; exec-final-controls | 17 missing-host-outcome failures, then 17/17; final 18/18 includes real lease output-limit admission, exact admitted byte, root0 cancellation/timeout and late abort before output return after resource release. |
| shell-red-corrected → shell-green | 8 semantic failures, then 10/10; actual registered shell/bash/pwsh native nonzero/null/success, custom lookalike unknown, refusal and startup/promotion controls. |
| code-red → code-green | Immediate failure and terminated launch wrongly succeeded; then 4/4, including caught nested failure and running/wait/status success. |
| retention-transfer-withdrawal → retention-transfer-restored | Removing metadata transfer causes 4 failures, including null streaming outcome-only identity; restoration 6/6. This is a recorded regression withdrawal, not a historical baseline claim. |
| sandbox-owners | 30/30. |
| posix-owners | 9 passed, 2 host-inapplicable skipped. |
| wsl-owners | 19 passed, 6 integration cases skipped. |
| psec-owner | 25/25 fake protocol ownership and cleanup. |
| registry-owners | 15/15; outcome/presentation ordering and unknown serialization controls included. |
| exec-owners | 70/70; capture lifecycle, streaming/Stop, cleanup, retained bytes/frame tests. Final native controls add one more test as above. |
| shell-owners | 53/53, including a real unrestricted Windows helper through registered pwsh exit0/exit7. |
| managed-owners | 21/21, including native normal/nested retained assembly, exact native frames, automatic background settlement, Stop hooks, retained code output and MCP outcomes/presentation. |
| nat13-red → nat13-green | Original eviction case fails; 3 asynchronous callback controls pass. After repair all 4 selected cases pass. |
| code-final-owners | 69/69 across runtime, registration, native outcomes, human Stop, managed-store Stop and output recovery. |
| nat13-managed-final | 27/27 across actual native normal/nested assembly, retained code output, managed output boundaries, durable store/forks and full MCP controls. |
| observations-corrected | Actual registered job_output/list/wait/kill factory control passes. |
| subagent-owners | 67 passed, 3 failed across original tools and the new factory control; unresolved cases listed below. |
| type-* | Ten affected package typechecks passed: sandbox, sandbox-local, sandbox-wsl, sandbox-windows-psec, core-tools, exec, shell, code-mode, session-executor, subagent. |
| type-final-* | Final sandbox/exec/code-mode/session-executor typechecks all pass after NAT-13 and final controls. |

The real managed assembly tests retain complete native values as artifacts for nonzero and null root exits through both original tool/result and nested code/result owners. They verify source/call identity and complete program JSON. Normal model projection uses the same failed/unknown envelope; the guest can consume a nested nonzero/null result while its normally completed outer code_exec remains succeeded.

MCP tests retain true isError failure and arbitrary structured fields independently; ordinary lookalikes do not become failure. The finalization row tests cover presentation before outcome and outcome before presentation, including declared unknown, without exposing internal bits.

## Fresh copied runtime proof

`gateway-final-build` uses the original `packages/desktop/scripts/build-gateway.mjs --out .tmp/context-r4a-native-outcomes-20261020-implementation/gateway-final`. It completes with 242 shipped packages. Unavailable optional packages for other operating systems are recorded in its raw log.

`gateway-final-copy-map.json` maps 245 copied source files across the actual owner packages, with matching source/copy SHA-256 values, 13 resolved package entries under the copied runtime, and a separate 9-item generated/native asset provenance list. Generated outputs are recorded separately, not discarded as source comparison exclusions. The test fixture is copied into the candidate proof directory with exactly one documented import relocation: `../src/index.ts` becomes `@i-harness/exec`. It resolves copied production owners and does not import the workspace source.

`gateway-final-probe` runs the candidate's own copied tsx CLI from candidate cwd. Its import.meta.resolve records point under `gateway-final/node_modules/@i-harness`. It passes all 9 shell/bash/pwsh × exit0/nonzero/null combinations through genuine registration, code_exec failure, successful code_wait termination, five synchronous completed cells plus eviction through the repaired original terminal owner, and real Windows pwsh exit7 through the copied native adapter. The final source/copy comparison and evidence seal preserve the exact reviewed source state.

The earlier `gateway` copy and `gateway-probe` failure are retained. That probe reused a fixture execution ID across several runs in one supervisor, and the genuine duplicate-ID admission fence rejected it. The final fresh copy uses a fresh fixture/supervisor per producer variant. The failure is setup evidence and is not represented as a product RED or a successful copy qualification.

## Failures, limits and remaining work

Three unchanged original subagent tools tests remain failed: `publishes complete followup lifecycle patches and clears previous output at start`; `background:false blocks until the task settles and returns the summary`; `job_output still reads subagent jobs (unchanged path)`. The exact raw assertions are preserved in `subagent-owners.log`. The prior A3 delivery also records the same three status failures. No subagent production owner was changed in this unit; root reserved them for separate terminal/cold-cut follow-up. They are unresolved, not waived or relabeled as flakiness.

Initial test setup failures are preserved: abort was initially triggered before the admission fence; a shell test called nonexistent waitForJobs; the managed fixture needed explicit read-only test registration; and the standalone job fixture's optional finish callback was absent. Corrected runs distinguish these from behavioral REDs. Early RED metadata snapshots enumerate tracked source files; later qualification snapshots enumerate tracked and newly added source/tests. Final committed tests and the sealed copied maps provide the complete candidate identities.

Host coverage is Windows x64: real unrestricted Windows helper and native PowerShell foreground execution are exercised. Controlled native boundaries exercise all disposition rules. Psec protocol fake ownership is exercised. Confined Psec, real Linux/POSIX and real WSL execution are not newly qualified here; explicit forwarding and typechecks are not claims of live Linux/WSL qualification. Optional custom backends without termination observation remain unknown. Missing custom ExecService host identity remains explicit unknown in built-in foreground shell; ordinary third-party returns retain their success default.

Product0.1.13-rc.1, Session10, decomposition27/43, dependencies, native bytes, frame dependencies and original cleanup/Stop contracts remain unchanged. No live account/provider/profile calls, publishing or audit exemption occurred. Root-owned future plan files are excluded from implementation commits. Product writes are frozen for fresh independent review. Artifact paging and later approved units remain root-owned next work.
