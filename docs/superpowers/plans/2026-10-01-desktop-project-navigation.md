# Desktop project navigation implementation plan

> Use parallel independent slices, integrate shared transport centrally, review before packaging.

## Design

A local Project is a named collection of canonical folder IDs. The user clarified that every conversation can access all project folders. Existing folder IDs and session directories remain stable storage identities; a conversation has a sticky project owner, and the selected folder is its default cwd. The current project primary folder and full root set govern file and command writes. Normal/team/resident agents inherit the same live context. Project paths are confirmed from the current native catalog rather than restored permission snapshots. Empty or unavailable projects fail closed; deleting a grouping preserves legacy conversation data. Invalid persisted project data is reported rather than silently overwritten.

The sidebar shows projects and folders, with direct conversation context menus. Conversation management reuses rename/archive/restore/fork and adds durable pin/read metadata. Menu actions are scoped by folder/session, with keyboard and pointer access. Source folder opening uses known catalog IDs. Send/Stop is one changing primary button; General settings persists follow-up queue/steer with Ctrl+Enter inversion. One plus opens the generic attachment picker; images remain pasteable and no inline keyboard hint is displayed.

Reminders remain deferred. No remote push or main-checkout changes. Preserve the user's electron.vite.config.ts change.

## Tasks

- [x] Project catalog: migration, serialized atomic mutations, validation, restart and removal/data survival tests.
- [x] Session sidebar: visible actions, durable pin/read metadata, confirmations/error handling, isolated context menus.
- [x] Single Send/Stop button, persisted follow-up delivery, inverse shortcut and unified attachment picker.
- [x] Live project scope broker, native catalog confirmation, multi-root file/shell enforcement and child/workflow/background inheritance.
- [x] Project edit/manage UI: name, multiple folders, primary folder, add/remove/pin and unassigned folders.
- [x] Shared main/gateway/IPC/bridge/App/Workbench integration with selection-scope safeguards.
- [x] Cross-slice review, focused regressions, full gate, portable build and real Electron acceptance.
- [x] Update capability inventory/QA report; local commit and deliver package.

Acceptance: [project navigation QA](../../audit/2026-10-01-desktop-project-navigation-qa.md), 3,983 passed / 10 skipped / 0 failed, all 70 projects reported. Real packaged multi-folder writes and final normal/narrow visuals passed. Stop after delivery; reminders remain deferred.
