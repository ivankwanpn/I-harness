# Model recovery and Desktop diagnostics implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans task by task. Do not redispatch completed tasks; consult the plan ledger.

**Goal:** Recover transient model failures automatically and provide independent error popups with safe persistent logs.

**Architecture:** One retry wrapper outside physical-attempt usage capture; core-agent explicitly discards uncommitted failed output. Native diagnostic persistence owns redaction and forwards safe records to a standalone Desktop feedback surface and log page.

**Tech Stack:** TypeScript, React, Electron, existing IH packages and Vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-reconnect-errors-design.md`

## Global Constraints

- Honor the shared contracts and exact bounds in the spec.
- No live provider calls, credential reads, user-profile changes or reference-tree edits for testing.
- References are evidence, not authority. Preserve IH ownership, admission, audit and tool-execution boundaries.
- No model errors in the composer, no blocking error popup, no focus stealing.
- Exactly one retry layer. No already-executed tool replay. Cancellation must stop backoff.
- Capture no prompt/tool payloads or raw response bodies in default diagnostics.
- Work on `codex/reconnect-errors-logs`; preserve explicit retry policies.

### Task 1: Retry engine and safe attempt recovery

**Files:** llm-seam/src/index.ts and focused tests; llm provider adapters' HTTP failure sites/tests; provider-runtime/src/index.ts and runtime tests; desktop-gateway/src/usage-capture.ts/tests; core-session/src/index.ts/tests; core-agent/src/index.ts and new retry tests.

**Interfaces:** Implement ModelRetryInfo and the retry event/request opt-in exactly as the spec. `createRetryingClient(client, policy, metadata?: { providerId?: string; modelId?: string })` emits lifecycle events. Runtime profile construction activates a default normal policy without changing the raw builder's undefined-policy behavior.

User update: Task 1 also owns Settings.modelRetryLimit (integer 0..100, default5), persistence/normalization, runtime refresh and gateway desktop/model-retry/state/configure routes returning `{ maxRetries }`. Use withDesktopSettings and reject invalid configured values; test zero, overrides, persistence, and next-request adoption in already-open sessions.

- [ ] Write failing tests: 503->success emits waiting/attempting/recovered; maxRetries zero calls once; malformed/auth/quota never retry; ECONNRESET normalizes; cancellation interrupts a parked backoff; Retry-After 2s waits until its deadline and advice >60s never retries early.
- [ ] Add failing core-agent regression: first attempt emits partial text and a write call then transient error; next attempt receives the original safe model history, completes, and only its tool runs once. Earlier successful step effects remain once. Failed attempt messages/calls remain in the raw journal but are excluded from deriveMessages.
- [ ] Implement abort-first policy, stable classification and HTTP retry metadata, preserving failed attempt usage and output safety.
- [ ] Implement durable core retry events and attempt reset; include final failure/cancel handling without success markers.
- [ ] Run llm-seam, affected adapters, provider-runtime, core-session, core-agent and usage-capture suites/typechecks. Record red/green evidence and review the task before continuing.

### Task 2: Native diagnostic persistence and IPC

**Files:** create desktop/src/shared/runtime-diagnostics.ts, main/runtime-diagnostics.ts and tests; update main/index.ts, main/ipc.ts, shared/bridge.ts, main/sdk-runtime.ts only if required to forward safe events.

**Interfaces:** RuntimeDiagnosticEntry and request/list contracts from the spec. Native service observes DesktopEvent, persists safe entries, exposes list/copy/export/reveal and onEntry subscription. Constructor receives owned storage directory and injectable clipboard/save/reveal callbacks. Main binds these to Electron.

User update: Task 2 also owns the no-workspace Desktop proxy requests desktop/global-retry/state and desktop/global-retry/configure `{ maxRetries }`, forwarding to the Task 1 gateway routes through the existing configuration gateway. Shared bridge and IPC guards must validate the integer 0..100.

- [ ] Write failing tests using temporary directories and injected native callbacks for retry/error/recovery/cancel attribution, duplicate delivery, restart retention, filter/list/export limits and redaction.
- [ ] Implement owned-file rotation (5 MiB, three files, seven days), bounded record reading and sanitized display/copy/export. Read at most 1,000 records for a view/export and enforce 20 MiB export ceiling.
- [ ] Observe all workspace events once in main; use turn/request identity to distinguish new failures from duplicate notifications. Treat canceled user work as informational.
- [ ] Add IPC routes and sanitized runtime/diagnostic notifications; reject arbitrary paths and malformed filters, and isolate write failures from model execution.
- [ ] Run native diagnostic, IPC and SDK lifecycle tests/typecheck. Record evidence and complete task review.

### Task 3: Independent popup, retry status and Log UI

**Files:** create renderer/session/RuntimeFeedback.tsx/styles and settings/RuntimeLog.tsx/styles; update renderer/App.tsx, session/Composer.tsx, shell/Workbench.tsx as needed; settings/SettingsPane.tsx, settings-navigation.ts and i18n/tests.

**Interfaces:** Consume sanitized runtime/diagnostic events and desktop/diagnostics IPC. No raw diagnostic persistence in renderer. Settings page and explicit details dialog share the native list and copy/export operations.

User update: Add Settings > General retry-count control using desktop/global-retry/state/configure. Default 5, integer 0..100, 0 disables; describe that it applies to the next model request. Show persisted value only after successful save, preserve draft on error and avoid changing the current attempt's budget mid-flight.

- [ ] Write failing component tests: 503 retries recover with no final popup; terminal failure shows one dismissible popup; duplicate notifications do not stack; no focus stealing; cancellation clears retry status; separate chats do not overwrite each other's state.
- [ ] Implement floating error popup with concise summary, Details/Log and close; keep reconnect state through attempting until recovered. Use countdown derived from nextAttemptAt, not a fake progress bar.
- [ ] Add searchable/filterable Log settings page and details with safe copy/export feedback. Refresh works after dismissal/restart.
- [ ] Route model/network failures out of ComposerSurface while retaining local validation/draft errors. Handle both failed/error SDK status variants and disconnections through the diagnostic surface.
- [ ] Run affected Desktop component/integration tests and typecheck. Perform actual-component narrow/wide and light/dark visual QA with fixture data; verify popup does not change composer dimensions.

### Task 4: Integration, review and delivery

- [ ] Verify end-to-end local HTTP 503->success recovery, retry cancellation, terminal popup and persisted/exported safe diagnostics.
- [ ] Run relevant full package suites, Desktop full suite, typechecks and production build; record actual results without reusing old counts.
- [ ] Independent whole-branch review; address findings with scoped regressions.
- [ ] Update audit/reference records and version for delivery. Follow the user's established submit/merge/release workflow after checks pass; validate packaged files and uploaded assets.
