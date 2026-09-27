# Desktop session reminders

The schedule engine already stores `schedule/change` events and exposes `schedule_create`, `schedule_list`, and `schedule_delete` to an Agent. Its driver checks due rules at an Agent step boundary. Desktop currently has no interface for a person to inspect or manage those records; a timeline line only says a schedule changed.

## User-facing contract

- The selected conversation's right pane gains **此會話提醒**. It lists active schedules with their prompt, next target, and kind, and offers create/delete actions. It is absent without a selected conversation or the gateway's `desktop-schedule` capability.
- Creation supports the engine's three rule families: delay, one specific local date/time, and repeat interval. The UI translates local time to RFC 3339 UTC; the engine remains the validator and allocates `schedule-<n>` IDs.
- Every screen explicitly says: an overdue reminder is processed at the next Agent step while this conversation is running. Desktop does not start an idle conversation, a background daemon, a remote job, or a paid model call by merely opening this panel.
- List is read-only and available for a cold saved conversation. Create/delete require the existing model-bound assembly, refuse a running or queued session, append through the existing schedule tool body, and flush the session log before reporting success. A failed flush is reported as uncertain; the UI refreshes the list before another action.
- Desktop sends only a finite, validated schedule command. A renderer cannot provide an executable, workspace path, or raw event. The gateway owns the selected session and rechecks its state.

## Verification

- Gateway tests prove cold list, each creation kind, validation, deletion, event durability, and busy/no-model refusal without modifying other sessions.
- Renderer tests prove correct labels, explicit next-step limitation, selected-session changes, busy states, and failure refresh.
- Packaged Electron uses only `D:\agent-complete\playground` for an end-to-end create/list/delete test; the test schedule is removed before exit. Full serial tests, typecheck, E2E, reachability and package build pass.
