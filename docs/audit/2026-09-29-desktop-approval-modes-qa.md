# Desktop approval modes and live sandbox QA — 2026-09-29

The Desktop build now has four persisted approval modes in **執行與上下文**:

| Mode | Tool policy | Human involvement |
| --- | --- | --- |
| 僅危險操作詢問 (default) | Read-only and known routine session/PTY resize tools run. The existing shell danger classifier, arbitrary terminal/process commands, out-of-workspace writes, `apply_patch` calls (which can span or delete files), memory notes and unknown side-effect tools still require approval. | Only a risky or unclassified operation produces an approval card. Explicit sandbox escalation also asks. |
| 逐項詢問 | Every tool dispatch except the structured `ask_user_input` question reaches approval. | The user clicks **批准** or **拒絕** once. |
| 代我審批 | Every dispatch reaches the existing reviewer Agent. The reviewer has no tools even if a saved role declares them. Its Desktop policy approves clearly safe actions, returns uncertain/risky ones to the user and denies clearly malicious actions. | A reviewer `allow`, malformed verdict, timeout or open breaker falls back to human approval; explicit sandbox escalation remains human-owned. |
| 完整存取權 | Tool approvals are automatic. Selecting it also saves and applies the `danger-full-access` sandbox. | New approval requests do not appear. Already pending requests remain explicit and are not retroactively approved. |

The product Agent no longer has a default 20-step ceiling. Explicit `maxTurns` is still an opt-in library/testing parameter; Desktop supplies none. Cancellation, repeated-tool guarding and context-budget enforcement remain separate mechanisms.

The sandbox setting now applies to existing assemblies on their next tool call and to newly created assemblies. The service appends a `sandbox/mode` event to active sessions and reconciles an assembly immediately before publishing it, including when extension mounting awaited during a settings change. A confinement provider is prepared for Desktop's live transitions even when the initial mode is full access. Other active workspace gateways periodically validate and reconcile the shared settings file, applying sandbox/approval changes without restarting; a two-host integration test observed the second host's sandbox change in about one poll interval. The first reconciliation runs at host startup, later attempts retry after transient failures, and invalid settings temporarily constrain a live gateway to read-only sandbox and ask-all approval until a valid document can be loaded. The Electron IPC queries the gateway's current sandbox state instead of reporting its startup cache, and the workbench updates its status after saving. Auto-compaction remains a separate setting that takes effect after restart.

The approval UI displays the tool's actual command or a bounded arguments preview, with common credential field names redacted in the latter. For sandbox escalation, the prompt names the actual shell command instead of merely naming the shell executable. Buttons immediately submit allow/deny; structured questions still require a selected answer and **送出回答**. An already pending approval keeps its original human decision requirement when the mode changes.

## Packaged Electron acceptance

- `D:\frontend-research\desktop-approval-settings-900-2026-09-29.png`: isolated settings/configuration in a 900px window; workspace-write → read-only → full-access changes were reflected immediately in the gateway's `desktop/sandbox/state`, Agent settings effective state and UI, with document scroll width equal to window width.
- `D:\frontend-research\desktop-approval-manual-pending-2026-09-29.png`: real DeepSeek `list_dir({"path":"."})` in playground under ask-all mode. The approval card exposed the arguments and a single click on **批准** completed the call. The session had one human prompt, one tool call and one matching result.
- `D:\frontend-research\desktop-approval-delegate-finished-2026-09-29.png`: a second real DeepSeek read-only `list_dir` task under delegate mode completed with one tool call, one matching result and zero human prompts. No playground files were modified. The scripts used isolated temporary settings/userData and removed them after the checks.
- QA scripts: `D:\frontend-research\desktop-approval-settings-packaged-qa-2026-09-29.mjs` and `D:\frontend-research\desktop-approval-live-deepseek-qa-2026-09-29.mjs`.

The first live QA attempt selected a model immediately after composing a new-session prompt and observed that the draft had cleared before send. The QA script re-entered the prompt after selection. This may be a new-session creation timing issue in the composer and is not validated as fixed by the approval changes; it remains a separate UI follow-up.

No GitHub push or edit to `D:\I-harness-main` was made. `packages/desktop/electron.vite.config.ts` remains an unrelated user-owned local modification and is not staged by this work.

The final local portable ZIP is `D:\frontend-test\packages\desktop\release\I-harness-Desktop-0.1.0.zip`, SHA-256 `455A71574B7BA0E9BD2899C4BD854CAAAB219CBE309196CB447258C7FD71C3D2`. The packaged settings check was rerun after the final source changes and again confirmed live read-only/full-access transitions with no 900px horizontal overflow.

Final `pnpm verify:all`: **3701 passed, 9 skipped, 0 failed**, all 70 test projects reported, typecheck exit 0, five E2E files exit 0, reachability gate exit 0. Log: `D:\frontend-research\desktop-approval-delivery-final-verify-2026-09-29.log`.
