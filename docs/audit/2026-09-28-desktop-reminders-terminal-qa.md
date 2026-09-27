# Desktop reminders and terminal selection QA

## Behavior

- Desktop exposes the existing schedule engine in the selected conversation's **提醒** right pane when `desktop-schedule` is advertised. It supports delayed, fixed time, and repeating rules, with a visible note that due reminders are handled at the next Agent step. It does not wake an idle conversation.
- Reminder writes go through the selected workspace and session's gateway. The renderer cannot supply an executable or raw event. Create and delete flush the durable `schedule/change` log; failed writes refresh the list before another action. If that read-back also fails, writes stay disabled until a successful explicit reload. Older reads cannot replace newer schedule state, and queued sessions are not offered writes.
- General settings already had an **整合終端 Shell** selector with detected host shells and a saved local preference. Windows **自動選擇** now picks Git Bash first, CMD if Git Bash is absent. Explicit shell choices continue to open the named shell. The Agent's separate `bash` and `pwsh` tools keep their named shell semantics.

## Evidence

- `pnpm --filter @i-harness/desktop test`: 65 files, 277 tests passed after review fixes. The two additional tests cover stale list responses and failed mutation plus failed read-back.
- `pnpm --filter @i-harness/desktop-gateway test`: 33 files, 91 tests passed. An earlier parallel run timed out in two unrelated Git review tests; the standalone gateway run passed.
- `pnpm -r --no-bail --workspace-concurrency=1 test`, `pnpm typecheck`, `pnpm e2e` (12 tests), and `pnpm verify:reachability`: exit 0.
- `pnpm --filter @i-harness/desktop dist`: portable Electron package built.
- Packaged Electron, `D:\agent-complete\playground`: with the configured `deepseek/deepseek-flash` model and **without a model prompt**, created and deleted `schedule-1` from the UI. `session/history` contained one create and one delete event, the list was empty afterward, and `sample.txt` modification time did not change. The test session was archived.
- Packaged Electron, same workspace: selected Git Bash and Auto in General settings on separate runs. Both opened `C:\Program Files\Git\bin\bash.exe`; `pwd` returned `/d/agent-complete/playground`. The test terminal was closed and the original local preference restored.
- Rechecked on 2026-09-28 after the request for a shell selector: the setting already lives under **設定 → 一般 → 整合終端 Shell**. A real host probe enumerated Auto, Git Bash, Bash (PATH), PowerShell 7, Windows PowerShell and CMD. CMD `cd` and Git Bash `pwd -W` both returned `D:\agent-complete\playground`; both PTYs were closed. `packages/desktop/test/native-ui.test.tsx` now sets its own locale before checking the selector, avoiding a false failure when another test leaves English selected. This does not change the separate Agent `bash`/`pwsh` tool semantics.
- Visual screenshot artifacts: `D:\frontend-research\desktop-session-reminders-2026-09-28.png`, `D:\frontend-research\desktop-shell-settings-git-bash-2026-09-27.png`, `D:\frontend-research\desktop-shell-settings-auto-2026-09-27.png`.
- A read-only reviewer found three reminder UI issues (read-back uncertainty, response ordering, queued-session gating). Each was fixed and exercised by the Desktop suite; the packaged Electron create/delete and Auto shell checks were repeated after rebuilding.
