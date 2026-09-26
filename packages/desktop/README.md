# I-harness Desktop (experimental)

Local Desktop workbench built around the existing SDK and approved desktop-gateway package. Development checkout: `D:/frontend-test`; manual operation workspace: `D:/agent-complete/playground`.

## Run and build

From the repository root:

```powershell
pnpm --filter @i-harness/desktop dev
pnpm --filter @i-harness/desktop test
pnpm --filter @i-harness/desktop typecheck
pnpm --filter @i-harness/desktop dist
```

The unsigned portable build is written to `packages/desktop/release/I-harness Desktop/` and the adjacent ZIP. It bundles Electron, the gateway source/dependencies and its TypeScript loader. No standalone Node installation is required by the portable runtime.

## Implemented flows

- Local workspace selection and nested session navigation with running/attention status.
- New/resumed conversations, Markdown, collapsed tool output, bounded drafts and virtualized history.
- Enter/Shift+Enter and IME-safe submission; stop, task and queue cancellation.
- Explicit approvals/questions with per-request submission and error state.
- Read-only changes, diff/preview, derived diff line numbers, task tab and resizable work pane.
- Workspace/current-session search, manual compaction and saved-note management/search/excerpts.
- Traditional Chinese/English with saved/system locale selection; dark/light/system appearance and text size.
- Narrow sidebar drawer, latest-content navigation, reduced-motion support.
- Native frame controls, bounds restore/reset and opt-in background attention notifications.

Desktop main manages native UI and SDK processes. Renderer does not resolve providers, run the agent loop, implement sandboxing or own backend persistence.

## Backend configuration and deferred interfaces

Gateway uses the existing settings/provider/credential implementation, including its `IH_CONFIG_DIR` configuration location. This experimental UI displays the resolved session model but does not provide a model catalog/editor. Provider/model editing, plugin-marketplace operations, interactive terminal/browser surfaces, account usage/reset and session rename/archive/fork require separately approved Desktop contracts. No replacement backend or fictional controls are provided.

Workspace memory is manually managed. Its excerpt action uses stored notes without a model call; automatic memory extraction is unavailable. Context size continues to be each model's backend setting; Desktop adds no billing threshold policy.

## Verification boundaries

Component/integration tests, repository verification, data-layer profiling and isolated packaged-gateway smoke are recorded outside the repository in the task's `desktop-audit` folder. These do not establish final visual fidelity or native pointer geometry. The user explicitly deferred those checks because browser access remained blocked by a saved origin permission setting. No alternate browser/CDP bypass is used.

`src/renderer/permission-preview.html` is a development-only fixture using labelled simulated data; it is not a production entry or a backend acceptance test.

## Licensing

I-harness code retains the project's MIT license. Adapted ZCode presentation files under `src/renderer/vendor/zcode/` retain Apache-2.0 notices and are documented under `licenses/zcode/`. Portable packaging includes those files. No ZCode logos, private packages or ZCode backend services are imported.

All development commits remain local. The experimental checkout's GitHub push URL is disabled.
