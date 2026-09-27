# Desktop remaining work inventory — 2026-09-28

This is the stop-point inventory after the terminal-selector change in `D:\frontend-test` on `codex/desktop-workbench`. The packaged Electron app and `D:\agent-complete\playground` were used for acceptance. `D:\I-harness-main` was not edited and nothing was pushed.

## Completed in the current local build

- General settings exposes a persistent, detected **整合終端 Shell** selector and terminal-font override even before opening a workspace. Auto, Git Bash, PATH Bash, PowerShell 7, Windows PowerShell and CMD were detected on this Windows host. Choosing CMD opened a real CMD PTY in playground; the original Auto preference was restored after QA.
- The workbench and 14 present settings sections, image attachments up to ten, `/compact`, DeepSeek thinking/tool replay, the provider directory, reminders and the capability-backed panes have source and packaged-Electron checks. The local package is `packages/desktop/release/I-harness-Desktop-0.1.0.zip` (SHA-256 `3733A2BAFBD2D533A68F11EF3B36FD8BCF52B0ED255574E5BA93A82A30A4D424`).
- Final `pnpm verify:all` passed: 3671 tests passed, 9 skipped, 0 failed; 70/70 projects reported; typecheck, five E2E files and reachability passed. Log: `D:\frontend-research\desktop-global-shell-final-verify-2026-09-28.log`.

## Still to decide or verify

1. **Agent shell scope.** The selector currently controls newly opened *human* built-in terminals. Agent `bash` and `pwsh` retain their explicit dialects. Matching ZCode's setting would also change Agent Bash on Windows; that requires a deliberate command-dialect, approval-parser and runtime contract. A scope clarification was requested and has not been answered.
2. **Live provider acceptance.** Local official-wire fixtures and cross-package tests cover Anthropic Messages, OpenAI Responses, OpenAI-compatible Chat, Gemini and Bedrock, and real DeepSeek Anthropic-compatible Max sessions exercise thinking and tool calls. This environment has no usable Claude, GPT Responses, Gemini or Bedrock credentials for live acceptance. Do not describe those routes as production-verified until each is exercised with its own provider.
3. **Legacy signed-thinking sessions.** New Anthropic continuations fingerprint the exact earlier prompt/tool prefix and bind tool calls. Older persisted sessions lack that fingerprint and keep legacy replay to preserve existing tool-turn continuity. A migration or conservative fallback needs a real Claude preserved-thinking test before changing that policy.
4. **Thinking display timing.** Separate reasoning blocks are stored and expandable, including multiple blocks in a turn. Long blocks are displayed after a block/tool boundary rather than token by token. A live short-batch event path is needed if immediate in-progress display is required.
5. **Final visual acceptance.** Packaged screenshots exist for narrow and normal workbench/settings views, with no measured horizontal overflow on the checked pages. Visual similarity to the ZCode references is a product judgment still open to the user's review.

## Backend work needed for additional ZCode-like surfaces

The current Desktop host does not provide durable job-status history, an Agent team roster/task board, Goal mutation, a Plan Mode switch or a global approval-default setting. The domain packages or event types alone are insufficient; each needs a real producer, authority/lifecycle contract and Desktop route before adding its control. Existing live `session/tasks` and Todo views are implemented. See `2026-09-28-desktop-workflow-capability-gaps.md` for source evidence.

## Deliberately deferred or external

- Provider account usage/reset/OAuth, Agent browser-control settings without a mounted tool, keyboard-shortcut settings and data/statistics pages were deferred by the user.
- The installed Superpowers hook's `hooks.json` version mismatch is an external plugin diagnostic, not a completed app repair.
- The local portable ZIP is unsigned; signing and public distribution were not requested.

The next development turn should begin with item 1's scope answer and any desired visual corrections, then perform credential-backed adapter acceptance where available. This document is an inventory, not an instruction to change the current package while work is paused.
