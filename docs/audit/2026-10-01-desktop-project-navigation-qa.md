# Desktop projects, conversation management and composer acceptance — 2026-10-01

## Scope

Implementation in `D:/frontend-test`, branch `codex/desktop-workbench`, starting from `e62bdd0e`. The user requested projects containing multiple folders, direct conversation management, one changing Send/Stop button, persisted follow-up delivery settings, and one generic attachment entry. The user explicitly clarified that **each conversation can access all folders belonging to its project**. UI follows the provided Codex project editor and ZCode/DSH navigation references, using the existing attributed ZCode composer surface.

Reminders remain deferred. `D:/I-harness-main` was not edited and nothing was pushed remotely. The user's existing `packages/desktop/electron.vite.config.ts` change is preserved and excluded from the local commit.

## Delivered controls and behavior

| Capability | Human UI | Backend / persistence |
| --- | --- | --- |
| Projects | Project sidebar and a management page with search, create, rename, pin, edit and confirmed removal. | A versioned, atomic local `projects.json` catalog references canonical folder IDs. The first migration preserves existing folder IDs and conversation storage. Revision checks reject stale edits. Removing a project preserves folders and conversations. |
| Multiple folders | Project editor adds native-picked or already opened folders, removes members and selects a primary folder. Sidebar groups conversations under their folders. | A conversation retains a project owner. Its selected folder remains the default cwd; current project roots govern file and command write authority. Paths come from the native catalog, never renderer-submitted roots. Empty or unavailable projects block execution. |
| Child / workflow scope | Existing team and task controls remain mounted after project binding is ready. | Ordinary task children, team members, resident children, guardian context, workflow and background execution inherit the current project context. Cached Windows ACL setup does not grant a later command a removed folder. |
| Conversation management | Row More menu, right click and keyboard context-menu access; rename, pin/unpin, read/unread, copy ID, open folder, fork, archive and restore. | Navigation flags and titles persist. Archived conversations remain recoverable. Fork preserves project ownership; a conversation with no completed turn cannot be forked. Failed rename drafts remain editable. |
| One primary button | Arrow for sending; filled square in the same button while running without a new draft; disabled spinner while admission, compaction or image reading is pending. A new draft while running restores the sending arrow. | Input clears after durable admission. Queue/steer and Stop keep their existing authoritative lifecycles. Empty Enter does not stop the Agent; IME composition does not send accidentally. |
| Follow-up delivery | General settings → **後續訊息處理方式**: **加入佇列** or **引導目前執行**. | Native local preference survives restart and applies to the next message. While running, Ctrl+Enter uses the opposite delivery. Shift+Enter still inserts a newline. The inline keyboard hint was removed. |
| Unified attachments | A single **＋** opens the generic native picker. Images, workspace references and external text share the attachment area. Clipboard images still work; there is no separate image picker option. | Native selection validates the whole batch before changing drafts. Workspace files become relative references; external UTF-8 text becomes bounded snapshot context; supported images become image inputs. Failure retains previous attachments. |

### Authority publication and lifecycle repair

Independent review found a startup race: a gateway could capture old project roots, remain pending while a folder was removed, then publish itself as ready with the removed root. The earlier update loop inspected only ready gateways.

The runtime manager now increments a publication epoch synchronously, serializes native project publications, includes already owned pending startups, and requires startup to synchronize the current epoch before becoming ready. Pending invalidation uses a generation fence; shutdown closes and drains owned startup/publication work. Failed publication closes the affected runtime rather than retaining its old authority. Deterministic tests reproduced stale-root publication and publication after invalidation before the fix; both now pass.

## Verification

Fresh `pnpm verify:all` passed **3,983 tests, 10 skipped, 0 failed, 70/70 projects reported**. All typechecks, five E2E files and reachability passed. Log: `D:/frontend-research/desktop-project-navigation-delivery-verify-2026-10-01.log`. Focused runtime publication tests passed 29/29 before the full gate. Independent re-review confirmed that the original pending-publication/invalidation blocker was fixed and found no concrete remaining release blocker in that scope.

The final UI-only packaged pass also passed: normal project header width 980 CSS pixels, height 35.8 pixels, no header overflow; narrow project page had no horizontal overflow. Log: `D:/frontend-research/desktop-project-navigation-visual-final-2026-10-01.log`. Screenshots were visually inspected.

## Package

Build log: `D:/frontend-research/desktop-project-navigation-final-package-2026-10-01.log`. The portable gateway ships 193 dependency packages. A separate release folder permits packaging while an earlier local output is locked.

- Executable: `D:/frontend-test/packages/desktop/release-project-navigation-2026-10-01/I-harness Desktop/I-harness Desktop.exe`
- ZIP: `D:/frontend-test/packages/desktop/release-project-navigation-2026-10-01/I-harness-Desktop-0.1.0.zip`
- ZIP SHA-256: `741877119458ED242900AB0D0DAE9EA2A9BC8F064B88B7FF9C0BF7FB37D4B9C7`

### Actual packaged Electron and provider acceptance

Acceptance used a temporary two-folder project under `D:/agent-complete/playground`, isolated app data and isolated configuration. Existing DeepSeek credentials were copied without being printed. **Provider transport was real**, using the configured `deepseek` Anthropic Messages route, `deepseek-flash`, Max. Native dialogs were directed to known fixture paths; no synthetic model response replaced the provider.

- The Agent read a file in each project folder, wrote `PROJECT-WRITE-QA` through the file tool into the second folder, and wrote `PROJECT-SHELL-QA` through selected PowerShell 7 `shell` into that folder. Sandbox remained **workspace-write**, and no tool requested a widened sandbox.
- Native UI renamed a conversation, pinned it, marked it unread, copied its ID into the real clipboard, forked it, archived it and restored it.
- General settings saved the default **steer** preference. A subsequent message used steering, and Ctrl+Enter admitted another message to the queue. Real tool calls and the one-button Send/Stop states were checked.
- The single plus picker accepted a native PNG, a workspace file reference and an outside UTF-8 text file. Chips/removal worked; the independent image action and inline keyboard hint were absent.
- Restart preserved projects, the primary folder, pin state and delivery preference. Removing the project grouping retained source files and saved conversations.
- All temporary acceptance folders were cleaned after owned app shutdown.

Evidence: `D:/frontend-research/desktop-project-navigation-live-qa-2026-10-01.mjs`, `desktop-project-multiroot-live-qa-2026-10-01-final.log`. A final UI-only pass checks the latest packaged project list/editor at normal and narrow widths without provider calls: `desktop-project-navigation-visual-final-2026-10-01.mjs`.

The previous delivery already exercised both configured DeepSeek protocols, Todo after actual model-backed compaction and restart, durable input recovery, source editing and local Git. That evidence remains in [the follow-up acceptance report](2026-10-01-desktop-followup-controls-qa.md). It is distinct from this phase's project-scope and navigation acceptance.

## Screenshots

- Project list/editor: `D:/frontend-research/desktop-project-list-final-2026-10-01.png`, `desktop-project-editor-final-2026-10-01.png`, `desktop-project-list-narrow-final-2026-10-01.png`.
- Conversation menu: `D:/frontend-research/desktop-session-menu-2026-10-01.png`.
- Follow-up setting: `D:/frontend-research/desktop-followup-setting-2026-10-01.png`.
- Unified attachments: `D:/frontend-research/desktop-unified-attachments-2026-10-01.png`.
- Running primary button: `D:/frontend-research/desktop-single-stop-button-2026-10-01.png`.

## Remaining / deferred

1. **Reminders remain deferred**; no worker wakes an idle conversation.
2. Live provider acceptance covers configured DeepSeek routes. Official Claude, OpenAI, Gemini and Bedrock credentials remain unavailable for acceptance against those services.
3. The source editor opens changed files and selected-folder relative paths. A complete multi-folder directory tree is absent. Rewind captures the default folder; valid writes to another project folder are not represented as completely rewindable, and the Agent context discloses that boundary.
4. Confined Agent process/PTY tools retain their existing fail-closed limitation. Real multi-root shell enforcement passed on this Windows host; Linux sandbox execution is skipped here, and there is no macOS sandbox backend.
5. The generic picker supports images, workspace references and bounded external UTF-8 text. External PDF/Office/archive/binary parsing is not implemented and reports an explicit unsupported-format error. Picker images are bounded to 5 MiB each/20 MiB total; clipboard images retain their existing 10 MiB individual bound. There are at most eight combined non-image attachments and ten images. Unsent image/text attachment drafts remain memory-only.
6. Automatic titles remain enabled with no separate toggle. Permanent conversation deletion, exact historical-hit navigation, remembered approval-prefix UI and a complete Agent process explorer remain absent.
7. The inherited static system/tool overhead estimate is not refreshed after a later very large Todo or project context update. Dynamic overhead accounting remains a separate improvement.
8. Earlier explicit deferrals remain: provider account usage/reset/OAuth, shortcuts/statistics, unmounted Agent browser control, signing/public distribution.

The detailed feature inventory is [Desktop fine capabilities](2026-09-30-desktop-fine-capabilities.md). This report is a stop-point inventory, not an instruction to continue deferred work.
