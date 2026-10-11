# Tools and environment diagnostics refinement

The user requested a useful, readable diagnostics pane matching IH, followed by GitHub publication and merge. Desktop version remains 0.1.7. This change is UI-only; opening the pane does not create a session or execute version commands.

## Result

- The header explains that the pane helps investigate unavailable commands and tools.
- A neutral cold-state overview explains when tool and role information becomes available. An existing assembly is described as an established environment, never as proof that a task is running.
- The shell is labelled as currently configured, with an explanation that a pre-existing session may retain an earlier selection.
- Executable cards show purpose, localized status and collapsed path/version/error details. Untested entries do not imply failure. A shell configuration error is distinguished from an actual failed version probe.
- The packaged I-harness.exe Node runtime path is explained. WSL shell diagnosis and host probes are explicitly distinguished.
- Advanced searchable tool/role information is collapsed. Declaration, model visibility and execution authority are explained separately.
- Check environment explicitly requests probes; Refresh reads configuration and declarations. Errors retain prior evidence with a visible notice, and scope-generation guards reject old responses.

## Validation

Root reran diagnostics-pane (7), execution-surfaces-ui (7), and central-ui-integration (8): 22 passed. Desktop TypeScript check passed. Independent review found the shell configuration/probe distinction; it was fixed and covered by a regression test. The central integration test was updated for the new Check environment button label.

Browser evidence under `.tmp/diagnostics-qa/` renders the actual component and IH styles inside the review-pane container, using synthetic data. 26 captures and 26 checks passed, zero runtime exceptions: 420/720px, dark/light, cold/live/probed/WSL, expanded details/advanced tools, retained probe errors, and English. No real provider/account/reset operations are involved.

The first full verification overlapped the final wording correction and retained an old central button expectation. That failed attempt is retained in `.tmp/diagnostics-merge-verify-all.log`; it is not described as a passing run. Final stable-source verification is recorded separately before merge.

## Merge verification

- Full `pnpm verify:all` exercised 81/81 test projects. It recorded 6,336 passing / 21 skipped / 3 failed tests, with all failures in Desktop; whole-workspace typecheck, all 6 e2e files and the reachability gate (423 rows, no new rows) passed.
- After the final diagnostics wording and integration expectation correction, the full Desktop package was rerun with maxWorkers=2/minWorkers=1: **1,226 passed / 3 skipped / 0 failed**, 170 passing files and 1 skipped, exit 0. Log: `.tmp/diagnostics-merge-desktop-final.log`.
- Combined coverage is 6,339 passed / 21 skipped with no remaining failure across the 81 projects. This is the full run plus the complete corrected Desktop rerun, not a claim that the original verify:all invocation exited 0. Unchanged packages were not rerun merely to replace their already passing results.
- Production Desktop build passed, log `.tmp/diagnostics-merge-build.log`; cached diff whitespace check passed after EOF cleanup.
- Independent rereview confirmed the shell configuration/probe distinction is resolved and found no important remaining diagnostics issue. A separate offline audit of Coding Plans, subscription routing and transport passed 80 targeted tests and found no important issue.
- The change includes the preceding approved Coding Plans and usage-statistics work on the same branch. Version remains 0.1.7; no live sign-in or reset card was used.
