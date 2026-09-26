# Live plugin implementation

Spec: ../specs/2026-09-27-live-plugins-design.md. User approved immediate enable/disable for existing agents and slash commands; implement inline without another approval round.

- [x] Add disposable prompt-command registration and hook registry lifecycle in their existing packages.
- [x] Add differential live plugin capability updates to session-executor assemblies; keep instances and active turns.
- [x] Add serialized service refresh, gateway mutation acknowledgement and cross-host state observation.
- [x] Add live slash command discovery/composer selection and remove fresh-instance-only copy.
- [ ] Same-assembly/live-turn tests, cross-host cases, reviews, full verification and updated package/report.

No D:/I-harness-main changes, no reference-project edits, no GitHub push, public deps only; actual user-workspace tests stay in playground.

Implementation checkpoint: same-assembly command enable/disable/history retention, active-turn updates, cross registry-host observation, unchanged MCP connection retention, two existing agents mounting the same real stdio MCP, late-added extension cleanup, hook disposal and ephemeral-role persistence tests pass. The first executor suite used the Windows default bash and failed shell fixtures; rerunning with the project's Git Bash PATH passed149tests. Hooks37/interaction27 tests pass. Fresh review found MCP global reservation, swallowed live failures, late cleanup and UI error-reset defects; all fixed and reviewer confirmed. MCP reservation now belongs to ToolRegistry. Live apply failures aggregate after other capabilities apply; initial mounts retain existing containment. Observer failures do not spin unchanged state versions; UI offers explicit retry. Full verification first passed3411tests/E2E/gate but failed SDK test-stub typecheck after adding refreshExtensions; stub updated. Final full gate and package refresh remain.

Verification follow-up: next full run reached3411passed/1failed with typecheck/E2E/gate passing. The sole CLI hook trust test timed out at1000ms despite its declared timeoutMs5000. Investigation reproduced a real parser defect: timeoutMs was validated but omitted from the parsed spec. Added a failing metadata assertion and preserved the validated field; hooks22tests and CLI hook-mount5tests now pass without changing the default timeout or trust behavior. Final verification is rerun on this fix.
