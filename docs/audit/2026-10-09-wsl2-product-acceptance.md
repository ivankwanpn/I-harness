# WSL2 product acceptance — 2026-10-09

Branch: `codex/wsl2-sandbox-experiment`, experiment baseline `1c46040e`, approved
design/plan `ec7a1272`. Work stays in packages; runtime installation uses owned
versioned caches. The source references were read only.

## Implemented and exercised

- Persistent backend, distribution, network, dependency and web settings reach
  the actual CLI run/SDK/ACP and Desktop gateway assembly paths.
- Trusted `executionTarget` is captured before approval and asynchronous work;
  Linux argv/environment bypass Windows executable lookup. Main, Code Mode and
  child callers share their captured backend and ownership.
- WSL RO/WW/full, network defaults/opt-in, readonly references, cancellation,
  root-bound background and managed Node/npm have real process/file effects.
- Web disabled/cached modes perform no external call; indexed fetch checks the
  current provider's URL grants and every redirect. The local bounded cache
  never supplies execution authority or persistent URL grants.
- CLI and Desktop ship fixed worker/manifest assets. Candidate 02 executes
  without the source worker and uses its own loader and package files.

## Evidence

| Scope | Result / evidence |
| --- | --- |
| Engine | 54 package tests before final diagnosis regression; 44 complete real Python worker regressions. Missing-Bash regression subsequently passed. |
| Large Desktop tree | 19,270 entries / 3,027 directories; preparation 23.3007 s, fresh commit validation/startup 22.6214 s. `.tmp/wsl-product-engine-1lsgoh8e/timing.json` |
| Actual source application | Eight cases passed: registered Bash protected references/outside writes, Code Mode, background kill/drain, RO, full caller writes, full+reference refusal, headless runtime, and child Code Mode. `.tmp/wsl-product-qualification-M3dzoi/qualification.json` |
| Managed runtime | Official fixed Node 22.23.3/npm 10.9.9 installed in 9.3 s; actual npm project task, Code Mode and background Node, readonly cache write refusal and full settlement. `.tmp/wsl-product-integration-task5/workload-evidence.json` |
| Final packaged runtime | CLI 02 and gateway 02 used saved WSL settings, the real approval path and actual Linux Bash. `.tmp/wsl-product-packaged-2Hr6jg/qualification.json` |
| Desktop settings | Real candidate main/preload/renderer and shipped gateway with isolated profile; runtime diagnosis available, mandatory dependencies/path mappings reported, window remained hidden. `.tmp/wsl-product-desktop-ui-7Jxm8U/evidence.json` and `settings.png` |
| Complete verification | `verify:all`: 5,320 passed / 21 conditional skips / 0 failed; 76/76 projects reported; all typechecks exit 0; E2E 12 tests in 5 files; reachability gate passed. `.tmp/wsl-product-root-verify-20261009/verify-all-serial-final.log` |
| Package graph | 76 workspace packages, 75 reachable from CLI/Desktop, zero production dependency cycles. Existing fs-watch remains outside the application graph. `.tmp/wsl-product-root-verify-20261009/package-graph.json` |

Candidate locations:

- `.tmp/wsl-product-integration-task5-cli-candidate-02/ih.mjs`
- `.tmp/wsl-product-integration-task5-gateway-candidate-02`
- `.tmp/wsl-product-desktop-candidate-01/I-harness.exe`

The full Desktop candidate contains the fresh main/preload/renderer build and
gateway 02. Qualification uses source-controlled scripts under
`scripts/qualification/wsl-product` and repository-owned temporary fixtures.
The Electron GUI harness uses the installed matching Electron runtime, explicit
candidate resources, packaged launcher behavior and an isolated hidden window.

## Review and corrections

Independent review covered integration, engine, settings, web, manager and final
packaging. Concrete findings were fixed with targeted RED/GREEN regressions:

- Cached search payloads and page titles bypassed output caps.
- Invalid enum arrays were coerced into different settings.
- Missing Bash was not reflected in WSL diagnostic availability; diagnosis IPC
  was shorter than its component budgets.
- Desktop dropped managed runtime integrity errors.
- Windows readonly corrupt archive replacement failed; concurrent installers
  read an already locked byte; cancellation did not reach the CLI download.
- CLI SDK/ACP did not pass their saved execution/web settings.

All material review findings were cleared. Final candidate source bytes, worker
digest/protocol and source-independent loader were checked independently.

## Verification observations

The first full gate encountered an existing search integration test's 15 s
deadline. Its four cases passed on a separate run (the two actual search cases
took 9.08 s and 9.62 s). Serial workspace execution still allowed the same
package's files to compete for Windows process resources. The final verification
serializes those Windows integration files and uses streamed workspace output
so the population count remains verifiable; test deadlines and assertions are
unchanged. Failed/prefix reports remain in
`.tmp/wsl-product-root-verify-20261009`.

An initial attempt to launch the complete candidate with an Electron harness
argument used its normal packaged entry instead. That candidate process was
closed. It created Electron profile/cache data under
`C:/Users/inkik/AppData/Roaming/I-harness`; those files were left intact. Subsequent
GUI acceptance used the explicit isolated profile above. No existing session or
credential content was edited for qualification.

## Limits

The backend remains experimental assurance. It controls the command and its
Linux descendants, with caller-readable files; it is not whole-WSL isolation.
WSL PTY and retain-tree transport are unsupported. Full access with reference
locks refuses. Missing prerequisites, unsupported layouts and revoked authority
refuse without switching to an unrestricted host command. Every launch repeats
bounded inventories; the large-tree timing above is a real cost, not a general
performance guarantee. Other distributions/architectures and cloud/provider
services are outside this local acceptance.
