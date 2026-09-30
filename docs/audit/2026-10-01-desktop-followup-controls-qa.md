# Desktop follow-up controls acceptance — 2026-10-01

## Scope

Implementation in `D:/frontend-test`, branch `codex/desktop-workbench`, starting from `e9fb49f7`. User requested continued work following the fine capability inventory, reference UI from DSH/ZCode, and deferred reminders. The user's existing `packages/desktop/electron.vite.config.ts` modification is excluded from the change set.

## Delivered controls

| Capability | Backend and human UI | Persistence / behavior |
| --- | --- | --- |
| Todo editing | Task pane adds content, edits, deletes, and selects pending/in progress/completed. `desktop/session/todo/write` checks the displayed revision. | Every model/human write updates durable whole-list state. Stale human drafts are refused and retained. Summary, prune, reset and restart retain Todo. Every model request gets the latest authoritative Todo context, including an explicit empty list. |
| Input queue | Composer releases after successful durable admission; another input can be sent from the same window. Task pane shows/cancels queued inputs and resumes saved ones. | Admission is flushed before acknowledgement. FIFO includes cold saved input. An unstarted input stays pending if shutdown wins before promotion. Running execution is interrupted on close; no process or Promise is restored. |
| Steering | Composer offers Queue next turn / Steer current turn while working. | The inbox adds steering to model-visible context at the next provider boundary. If that boundary has passed, pending input remains available for continuation. |
| Pending questions / approvals | Interrupted cards persist and disclose their state. Questions save an answer; approvals save a reassessment request or dismiss. | Atomic workspace-scoped snapshots preserve deadline/session identity. Recovered input is idempotent, explicitly resumed, and uses current policy. An old approval never becomes a grant or replayed tool call. Cancellation covers generated retry input IDs. |
| Source editing | Change pane opens a workspace-relative source path or a changed file, shows a gutter, unsaved state, Save and Reload; supports keyboard save. | Full UTF-8 content revision is checked. Conflicts retain the draft/external file. CRLF/BOM are preserved. Binary/truncated/large files remain preview-only. Missing files are not recreated. |
| Local Git | Stage, unstage, staged count, commit message and local commit result. | Literal pathspecs and workspace boundaries are enforced, including renames. Commit uses a frozen index snapshot; concurrent staging outside the workspace cannot leak into it. No push control is added. |

UI references inspected: ZCode `ConversationQueuePanel`, `WorkspaceFileTreeRowView`, `GitPane`, `GitPaneChangeCard`, `previewPaneCodeContent`; DSH `QueueDock`, `TodoPanel` and approval services/components. Existing adapted ZCode file-row/diff/permission/composer components are reused. New editors use the existing Desktop tokens. No additional reference implementation code was copied.

## Verification

Final `pnpm verify:all` passed **3,858 tests, 9 skipped, 0 failed; 70/70 projects reported**, typecheck, five E2E files and reachability. The reachability gate reports one existing allowlist entry that matches no live row; no new reachability rows were added.

Log: `D:/frontend-research/desktop-followup-controls-final-verify-2026-10-01.log`.

An earlier run exposed two real-Git integration test timeouts under suite concurrency and Windows cleanup `EPERM`. Cleanup now awaits owned Git children before deleting their cwd, with a regression that reproduced the original failure. Long real-Git tests are split; the remaining integration timeout is based on measured subprocess startup cost. Final full verification includes this repair.

Independent review found and verified fixes for abort-before-promotion, canceled recovery generations, cold FIFO, persistence-before-draft-clear, and cancellation of the returned retry generation ID.

### Actual packaged acceptance

No mock provider transport was used for these runs. Temporary settings copied existing DeepSeek credentials without printing them. File/Git acceptance used a fresh repository under `D:/agent-complete/playground`; it was cleaned after app shutdown. Recovery acceptance read the existing playground and used isolated session/user data.

- Both `deepseek` (Anthropic Messages) and `deepseek-responses` (Responses), `deepseek-flash`, **Max**, accepted three inputs: first task, next queued turn and current-turn steering. Each route completed two turns, two reasoning blocks, `list_dir` and `read`.
- Human Todo added through the UI survived actual model-backed compaction. The next real model answer named that Todo; restart preserved it.
- Actual source save, stage, unstage, restage and local commit through the packaged UI succeeded; Git reported a clean worktree afterward.
- A real `ask_user_input` question was interrupted by app shutdown. Restart restored its card. The UI saved the answer to a durable queue; manual Resume delivered it exactly once, and the model returned the actual answer.
- The final package's Todo status selector was exercised; source editor was visually checked at 1,000-pixel window width with no document horizontal overflow.

Logs/scripts: `D:/frontend-research/desktop-followup-live-qa-2026-10-01.{mjs,log}` and `D:/frontend-research/desktop-recovery-live-qa-2026-10-01.mjs`, `desktop-recovery-live-qa-2026-10-01-final.log`. The initial recovery script needed explicit sidebar session selection after restart; corrected acceptance passed. Source screenshot `desktop-source-editor-final-2026-10-01.png`; Todo screenshot `desktop-todo-controls-2026-10-01.png`; queued recovery screenshot `desktop-recovered-input-2026-10-01.png` in the same research directory.

## Package

Build log: `D:/frontend-research/desktop-followup-controls-delivery-build-2026-10-01.log`.

- Executable: `D:/frontend-test/packages/desktop/release/I-harness Desktop/I-harness Desktop.exe`
- ZIP: `D:/frontend-test/packages/desktop/release/I-harness-Desktop-0.1.0.zip`
- SHA-256: `F587EFF7A63DD11DF4EACF7BE90600542C4886598FC059D7D1D7320A378C076F`

## Remaining / deferred

- **Reminders are deferred by the user's latest instruction.** Existing next-step reminder behavior is unchanged; no idle wake worker was added.
- Actual provider acceptance covers the two configured DeepSeek routes. Official Claude, OpenAI, Gemini and Bedrock service credentials remain unavailable for their own live acceptance.
- Source navigation supports changed files and opening a workspace-relative path. A complete directory tree is still absent. Source edits are local drafts; closing the editor/work pane is not a durable draft store.
- Pending request presentation/input can recover. A running process, PTY, provider request, original async question resolver or original tool approval cannot be resurrected.
- The assembly currently estimates system/tool overhead at construction or model rebinding. Later large Todo updates are supplied to the model but do not update that static budget estimate; dynamic overhead accounting remains a separate improvement.
- Earlier explicit deferrals remain: account usage/reset/OAuth, shortcuts/statistics, unmounted Agent browser control, signing/public distribution. Permanent chat deletion, exact-hit history navigation and remembered approval-prefix UI remain absent.

Work was locally committed and packaged; no remote push and no changes to `D:/I-harness-main`.
