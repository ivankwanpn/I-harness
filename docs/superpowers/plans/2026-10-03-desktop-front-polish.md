# IH Desktop Front Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Complete the approved frontend progress report sections II and III with usable, persisted Desktop controls and native acceptance.

**Architecture:** Extend the current Workbench, native IPC and Desktop gateway with owner-scoped adapters. Each of eight batches is a separately reviewed vertical slice; integrate actual producers rather than inventing frontend-only authority. Reuse existing DSH/ZCode visual references and licensed tokens.

**Tech Stack:** TypeScript, React, Electron, existing IH packages, Vitest/JSDOM, real filesystem/JSONL fixtures, isolated packaged Electron via Playwright.

**Spec:** `docs/superpowers/specs/2026-10-03-desktop-front-polish-design.md`.

## Global Constraints

- All changes in `D:/frontend-test`, branch `codex/desktop-workbench`, starting `293077e0`; no main/reference edits or remote push.
- Exclude original `packages/desktop/electron.vite.config.ts` modification from all commits.
- Zero routine paid provider calls. Native tests use owned isolated workspaces/config/userData and loopback providers.
- Preserve ordinary/subagent/reviewer visibility, current owner authority, Todo durability, existing approval/sandbox/Plan checks.
- File identity is `{workspaceId: string, path: string}` with a relative path and current main-confirmed project membership; revision checked full-content saves.
- Product destructive operations require explicit confirmation; tests may delete only their own fixtures.
- Cold history never becomes a live worker or permission grant; no automatic replay.
- Reminders, DSH Agent presets, OAuth/account usage, shortcut/statistics pages and public distribution stay out of scope.
- User authorized parallel implementation on 2026-10-03. Controller assigns disjoint file ownership and keeps shared central contract edits exclusive; no worker spawns agents/reviewers. Integration workers use gpt-6.1-sol/high explicitly. Final whole review uses gpt-6-astra/high.

## Task 1: Complete Composer and navigation

**Files:** `renderer/session/{Composer,SlashCommands,SessionModelPicker}.tsx`, `renderer/shell/{Workbench,ui-store}.tsx/ts`, `renderer/app.tsx`, `renderer/settings/SettingsPane.tsx`; new `renderer/session/ContextPicker.tsx`, `desktop-gateway/src/context-picker.ts`; corresponding bridge/ipc/host/router/types adapters and tests.

**Interfaces:** Existing `desktop/session/input/submit`, `session/create`, model selection and `desktop/agent-settings/{state,configure}` remain authoritative. New `desktop/context/search` consumes workspaceId, optional projectId/sessionId, query, kind=`files|sessions`, offset; returns bounded items with explicit workspaceId/path or sessionId/seq. References use this returned identity and attach readable bounded context through the existing admission surface. New draft submit creates the session only on explicit submit, sets the selected model, then admits text/context/images; failure retains the draft.

- [x] Add behavior regression: type a new-task draft and choose a model/attachment; assert no session/create until submit, failure retains text/attachments, retry admits once.
- [x] Run `pnpm --filter @i-harness/desktop test` with the new Composer test and watch the missing behavior fail.
- [x] Implement complete draft-first Composer, project file/session `@` picker and keyboard `/` selection; preserve IME and single Send/Stop behavior.
- [x] Add effective approval controls beside attachments, direct workflow entries and disabled settings explanations. Latest user steering keeps sandbox controls only in Settings and uses a floating approval menu with the actual effective-mode label.
- [x] Test stale picker replies, project root removal, empty/no-match, keyboard selection/escape, and read-only permission rejection; run covering Desktop/Gateway tests and types.
- [x] Commit scoped files and report exact tests/limitations; review this diff before Task 2.

```ts
expect(bridgeCalls.filter(x => x.kind === 'session/create')).toHaveLength(0)
await user.click(screen.getByRole('button', {name: '送出'}))
expect(bridgeCalls.filter(x => x.kind === 'session/create')).toHaveLength(1)
```

## Task 2: Project explorer, multi-folder editor and drafts

**Files:** new `renderer/review/ProjectExplorer.tsx`, `EditorTabs.tsx`, `editor-drafts.ts`; modify ReviewPane, SourceFileEditor, file-navigation and App/Workbench; new gateway/main project-files adapter with actual root membership validation; bridge/types/router and tests.

**Interfaces:** `ProjectFileRef={workspaceId:string,path:string}`. Directory/search/read/save use this identity plus the selected project/session owner; `save` keeps existing expectedRevision and ReviewSaveResult. Draft keys encode both fields, not basename; draft persistence is outside component mounting. Existing Git operations retain their actual root.

- [x] Red test two roots each containing `same.txt`: open both, edit second, switch/close work pane and restore without losing draft or writing first file.
- [x] Implement bounded directory/tree/search and root-labelled editor tabs using the authoritative refs.
- [x] Persist drafts/revisions; add save/keep/discard choices and conflict-safe reload. Preserve CRLF/BOM and preview-only restrictions.
- [x] Test revoked root, symlink traversal, stale read, external modification and restart draft restoration; run focused Desktop/Gateway tests/types.
- [x] Commit/review this vertical slice.

```ts
expect(await readFile(firstRootFile,'utf8')).toBe('first')
expect(await readFile(secondRootFile,'utf8')).toBe('edited second')
expect(restoredDraft.ref).toEqual({workspaceId: secondId, path:'same.txt'})
```

## Task 3: Session history navigation and management

**Files:** SessionSearch, event-window, Timeline, SessionActions/SessionManager/TaskList; gateway session-management/project-scope; persistence lifecycle/document APIs only where needed; bridge/ipc adapters and actual JSONL tests.

**Interfaces:** Search selection carries `{workspaceId,sessionId,seq}` through App into history window. Batch commands carry explicit IDs/action and result per item. Project move commits a new current owner only when idle, preserving conversation history; permanent deletion closes ownership then removes only the session's records/documents and derived navigation data. Current active work/pending input/interaction/children are blockers.

- [x] Red test selecting an old seq outside the last history window and verify actual visible target text/marker.
- [x] Add history around/before pagination and navigation that rejects stale workspace/session results.
- [x] Add confirmed permanent delete, batch archive/restore and project move UI with partial-failure details.
- [x] Verify actual fixtures: delete leaves sibling sessions/source files intact; busy deletion/move refuses; restart retains moved grouping; internal children remain hidden.
- [x] Run scoped persistence/gateway/Desktop tests/types, commit and review.

```ts
expect(await coordinator.profile(siblingId)).toBeDefined()
await expect(manageBusySession()).rejects.toThrow(/busy|active|pending/i)
expect(screen.getByText('old search target')).toBeVisible()
```

## Task 4: Global setup and native information

**Files:** native provider-settings adapter, native notification history/config; ProviderDirectory, NativeSettings, SettingsPane, new NotificationsPane; provider runtime/settings/auto-title wiring; main IPC/bridge and tests.

**Interfaces:** Global provider commands retain ProviderCommand and the same durable settings/credential store without workspaceId. Notifications have durable ID, createdAt, kind, optional workspaceId/sessionId, summary and read state. About reads installed app/runtime versions. Auto-title preference is persisted and consulted at the next title operation.

- [x] Red native config fixture: configure provider/model with no workspace and read the same model through a later gateway.
- [x] Mount global provider configuration and model discovery; keep secrets out of diagnostics/logs.
- [x] Add title toggle, notification list/read/return and actual About diagnostics; no auto-update or wake worker.
- [x] Test restart, unavailable notification targets and no-workspace configuration; scoped tests/types, commit/review.

```ts
expect(workspaces.list()).toHaveLength(0)
expect(await globalProviders.state()).toMatchObject({providers:expect.any(Array)})
expect(titleRequestsAfterDisable).toHaveLength(0)
```

## Task 5: Resource and memory authoring

**Files:** ResourceSettings, HookSettings, MemoryPane; gateway resources/hook-settings/memory-wire; effective registry loaders and memory revision API; bridge/main adapters and tests.

**Interfaces:** Resource writes carry kind, source=`workspace|global`, canonical name, body and expectedRevision; plugin sources are copied into a local layer rather than mutated. Native import chooses a local SKILL.md. Memory update carries id/title/text/expectedRevision. Hook edits invalidate exact-content trust.

- [x] Red actual-registry test: create/edit a local skill/command and verify the engine consumes the new body; external edit causes conflict with draft preserved.
- [x] Implement create/edit/import/local remove controls and bounded editor/validation; maintain effective precedence and source identity.
- [x] Implement local Hook authoring/trust invalidation and memory revision-checked editing/batch management with confirmation.
- [x] Test plugin readonly/copy, invalid names, symlink scope, registry refresh and memory CAS; focused tests/types, commit/review.

```ts
expect((await effectiveSkills.getSkill('edited')).body).toContain('new content')
expect(await writeWithStaleRevision()).toMatchObject({kind:'conflict'})
expect(await hookTrustAfterEdit()).toBe(false)
```

## Task 6: Attachment readers and durable drafts

**Files:** main file-attachments, new attachment-readers and attachment-draft-store; image/file-reference/text drafts and Composer restoration; manifests/lock if dependencies needed; main/bridge and real format fixtures.

**Interfaces:** Picker output includes content type, bytes, bounded text/images/references, truncated and reason. PDF/docx/xlsx/pptx/ZIP readers never execute content or extract into source folders. Drafts are scoped by workspace/session/new-task identity and cleared only after acknowledged durable admission.

- [x] Red fixtures for PDF, each OOXML type and ZIP; prove actual text read, malicious/oversized entries bounded and unsupported formats explained.
- [x] Implement readers using verified primary library docs, named limits and preserved unified plus/clipboard flow.
- [x] Persist unsent images/text/references with bounded owned storage and stale/quota cleanup; restore on restart and retain on failed submit.
- [x] Test parser failure, archive traversal, encrypted/invalid PDF, duplicate names and admission/cleanup races; focused tests/types, commit/review.

```ts
expect(await parseFixture()).toMatchObject({text:expect.stringContaining('attachment marker')})
expect(await restoreDraft()).toMatchObject({attachments:expect.any(Array)})
expect(await outsideFileExists()).toBe(false)
```

## Task 7: Code Mode, environment and process surfaces

**Files:** new CodeModeSettings/ExecutionPane/DiagnosticsPane/AgentProcessesPane; gateway read-only execution/diagnostic adapters; assembly/code-mode status API and process owner controls; WorkflowJobsReviews; shared contracts and tests.

**Interfaces:** Code Mode reads cell/call/output history plus exact current runtime status; actions validate live session owner and refuse cold cells. Configure persists off/mixed/only and discloses current effective mode. Diagnostics separate declared direct/deferred/role tools from executable probe status. Process actions use exact session/job/terminal ID and existing sandbox backend authority.

- [x] Red actual runtime test: a live yielded Code Mode cell appears with nested call/output and stops via the authorized UI adapter; cold history is readonly with zero inference calls.
- [x] Implement mode settings, code/output/trace tabs and direct execution-panel entry.
- [x] Add environment/tool/role diagnostics and owner-labelled Agent PTY/process/job controls and output navigation.
- [x] Test unrelated-owner/cold/refused sandbox actions, stale responses and unavailable executables; focused runtime/Gateway/Desktop tests/types, commit/review.

```ts
expect(coldView.canTerminate).toBe(false)
expect(modelCallsWhileReadingHistory).toBe(0)
expect(await waitAfterUiTerminate()).toMatchObject({status:'terminated'})
```

## Task 8: Remembered approval controls

**Files:** approval rule persistence/validation broker, PendingPanel/ApprovalCard/AgentSettings, main/gateway interaction integration and real prepared-tool tests.

**Interfaces:** Rules have explicit tool/executable identity, validated argument condition, scope, expiry and policy revision. Remembering requires explicit human UI input. Exact matching is available for all supported tool shapes; any command prefix uses parsed argv/structure and rejects appended compound commands. Current guard/sandbox/Plan/role checks always run.

- [x] Red prepared-tool test: revoke/expire a rule and verify approval is requested again; prefix plus an appended shell operation never matches.
- [x] Implement durable list/add/revoke/scope/expiry and explicit remember checkbox; wire into the actual approval decision seam.
- [x] Test policy change, executable/binding replacement, parser ambiguity, cold restart and refusal paths; focused guard/Gateway/Desktop tests/types.
- [x] Commit/review without granting permissions or deleting real user data during QA.

```ts
expect(matchRule('git status && dangerous-other-command')).toBe(false)
await revoke(rule.id)
expect(await prepareSameOperation()).toMatchObject({approvalRequired:true})
```

## Task 9: Frozen delivery acceptance

- [x] Independent final review of completed scope, resolve concrete findings with focused regressions.
- [x] Run frozen `pnpm verify:all`, confirm whole population and new package inclusion; do not substitute partial green runs.
- [x] Build distinct portable release folder and perform native Electron clicks on all eight batches in an isolated external copy.
- [x] Record screenshots, zero routine remote calls, format/backend limits and artifact hashes; update gap checklist to actual outcomes.
- [x] Commit locally with original config excluded; report delivered controls and remaining explicitly deferred scope.

## Final delivery — completed 2026-10-03

- Source/test/package commit: `e669335bb4db44b9809b272f8b8bdcd2f0411d8a`,184 files. Task1 earlier commits `bd7c77d0`/`9ee00a3d` remain in history. Final four public docs are saved in the subsequent local documentation commit; no remote push/PR/merge.
- Final frozen `pnpm verify:all`: exit0,4322 passed/10 skipped/0 failed,71/71 includingDesktop592 andGateway246; types0,E2E5files12tests0,reach421/no new/PASS. Log `D:/frontend-research/ih-desktop-front-polish-approval-menu-final-verify-2026-10-03.log`.
- Final copied package: `release-front-polish-approval-ux-2026-10-03`. ZIP211634801bytes SHA256 `811DF19BACA92528DCA47D5D1A61C7034AD09BF8B5D7812F3119473769E119E2`; EXE246032896bytes SHA256 `BD14928E0728366FD3F41499CB398FF3F4304DAB259A3E605077899A6F8C748E`.
- Actual native evidence composed through full payload comparisons:47 original+25producer+0layout+15CPU+3approval-menu=90loopback,0remote/blocked/errors. LastUI viewport682×982/1502×982; approval-only DTO/current-effective labels/popup/keyboard/Settings/window controls and human Stop accepted. All native/fixture owners IDLE; original clipboard restored.
- Final source reviews through Round10, packaged executable identity, CPU completing-accounting and approval-menu focus are CLEAN. Fixed clock/guest-budget evidence and user-authorized100ms reliability fixture are distinguished from formal1000ms default and dedicated30ms probes.
- U01–U24 inventory/remaining scope, provenance, parser/draft/output/fingerprint limits and grep/rg research-only recommendations are recorded in `docs/audit/2026-10-03-desktop-front-polish-acceptance.md` and `2026-10-03-desktop-design-analysis.md`.
- Original dirty `packages/desktop/electron.vite.config.ts` remains unstaged/uncommitted SHA256 `EDE81F84EE9571D43587EFEEC4970F5FB2F54C54E2B2E9EE7FCA7B029C6D8085`. One test-only EOF blank line was removed after the functional gate and before the final source amend; no behavior/artifact change.
- Automatic approval review rejected removal of old owned Temp `ih-pty-launch-yETTtR`/`ih-pty-launch-nqWViN`, reason `blocked by policy`; left intact without retry/alternate cleanup.
