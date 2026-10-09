# Task 3 settings, gateway and Desktop evidence — 2026-10-09

Scope: packages/settings, packages/desktop-gateway, Desktop execution/Agent Shell settings, their transport validation/types and related tests. No commits, candidate installs, global packages, distribution changes, model/API calls or external messages were performed by this worker.

## Implemented behavior

- `windowsSandboxBackend` accepts `legacy | psec | wsl`; the native default remains `legacy`.
- `wslExecution` stores `{ distribution, networkAccess, workspaceDependencies }`, defaulting to `Ubuntu`, `false`, `true`. Normalization returns detached defaults; gateway configuration rejects unsupported fields/types and damaged policy documents.
- New stores default `webSearchMode` to `cached`. Existing raw documents without that field retain prior `live` fetch behavior. A first unrelated write by a new layered store persists its cached default; existing layers retain live semantics.
- Gateway host captures WSL and web defaults for new assemblies through `wslExecutionFor` and `webSearchModeFor`. Backend/distro/network/dependency changes never rewrite existing assembly status. Web cache storage is `join(sessionDir, 'web-cache')` and the web callback changes only the next-assembly default.
- Managed dependencies use the real `@i-harness/workspace-runtime` factory lazily, rooted at `join(dirname(settingsPath), 'workspace-runtime')`. New WSL assemblies resolve captured configuration with `installIfMissing: true`; native assemblies and a disabled workspace-dependency setting skip that manager entirely. The host merges only returned managed `runtimePath` into the captured configuration.
- `desktop/wsl/state`, `/diagnose`, `/repair` read the saved distribution. Explicit diagnosis calls real distribution/runtime inspection and the manager's `diagnose`; explicit repair calls its `repair`. Caller supplied target/installation parameters are rejected by the gateway. Unsupported/error results propagate to the UI; disabled repair refuses. No WSL inspection or managed installation is added to ordinary legacy settings reads.
- Diagnostic results are bound to the full captured WSL setting. Changing settings while diagnosis/repair runs cannot attach the prior result to the new target. Serialized WSL actions drain on host close and reject subsequent work.
- Chinese groups separate approval, three sandbox modes, four web modes, WSL execution/networking, workspace dependencies and compaction. Installed distribution choices carry WSL version/state; WSL1 entries are disabled. Pending edits must be saved before diagnosis/repair. Saved/new-assembly defaults and actual session execution status are shown separately, without a restart claim.
- Agent Shell settings show `resolveWslAgentShell` Linux Bash metadata for a WSL next-assembly binding. Native choices are host-labelled. Native command resolution stays a host resolver because session assembly owns the immutable WSL binding. Host environment probes never try to test `/bin/bash` as a Windows executable; explicit WSL diagnosis owns that probe.

## Observed RED / GREEN

The following failures were observed before their fixes:

- New settings lacked WSL/web fields; three normalization/persistence tests failed.
- Gateway rejected new configuration keys and the `wsl` backend (`Unknown agent setting` / invalid backend).
- Desktop tests could not find WSL distribution, web access or diagnosis controls.
- New layered stores returned `live` instead of `cached` after load.
- A prior diagnosis stayed attached after workspace-dependency configuration changed.
- A disabled dependency setting retained a manager-provided `runtimePath`.
- WSL action close/draining was missing (`adapter.close is not a function`).

Focused GREEN runs at approximately 21:09–21:10 Asia/Hong_Kong, executed with cached Node/Vitest from each package cwd:

```powershell
# packages/settings
node ../../node_modules/vitest/vitest.mjs run
# 9 files, 110 tests passed

# packages/desktop-gateway
node ../../node_modules/vitest/vitest.mjs run test/wsl-product-settings.test.ts test/wsl-agent-shell-settings.test.ts test/wsl-settings-router.test.ts test/wsl-environment-diagnostics.test.ts test/wsl-settings-host.test.ts test/agent-settings.test.ts test/agent-shell.test.ts test/execution-surfaces.test.ts test/backend-integration.test.ts test/router.test.ts test/cold-session.test.ts
# 11 files, 54 tests passed

# packages/desktop
node ../../node_modules/vitest/vitest.mjs run test/wsl-product-settings-ui.test.tsx test/agent-settings-ui.test.tsx test/agent-shell-ui.test.tsx test/ipc.test.ts test/central-ui-integration.test.tsx test/composer-approval-menu.test.tsx
# 6 files, 53 tests passed

# Each of the three package directories
node ../../node_modules/typescript/bin/tsc --noEmit
# All three exited 0
```

`git diff --check` for owned scopes exited 0. New settings/host fixtures are repository-local `.tmp/wsl-product-settings-*` roots and are removed by the tests; they do not use the user's live settings or runtime cache. The host integration test injects an explicit controlled manager while exercising actual gateway routing, persisted configuration and service option capture.

## Qualification boundaries / root follow-up

- These tests validate persistence, host wiring, metadata and UI behavior. Root must qualify actual managed download/digest/extraction, installed Node/npm use, real registered WSL tool effects and source-independent candidate packaging after Task 5 implementation finishes.
- Root owns dependency lock/workspace link metadata and final combined assembly/web integration. The gateway workspace-runtime dependency and direct wiring are present; no placeholder success result is returned by gateway code.
- Desktop main IPC `longOperation` should include `desktop/wsl/repair` so bounded managed downloads can use the existing long operation deadline. This narrow main-process change was reported to root because it is outside the worker's renderer ownership.
- Task 4's real `registerWeb(..., {mode, cache})` implementation must enforce the saved/captured modes. No search provider or OpenAI index was invented by these settings controls.
