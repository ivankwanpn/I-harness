# Desktop interactive terminal

Use existing terminal package and node-pty; Desktop gateway owns user terminal processes per workspace, renderer uses a public terminal emulator. A human-operated terminal is separate from agent tool execution and uses the local user's shell permissions; UI states that scope. Agent sandbox policy is unchanged.

- [x] Fix absolute ring cursors after retention trimming and add opt-in raw output for emulator control sequences, preserving existing normalized default.
- [x] Gateway open/list/read/write/resize/close with fixed workspace cwd, default system shell, bounded reads/input and eight-terminal limit; shutdown owns cleanup.
- [x] Scoped Desktop IPC, terminal pane/tabs, emulator input/resize and bounded polling while visible; no second shell implementation.
- [ ] Raw/native PTY integration, state switching/lifecycle tests, packaging ABI validation and reviewer pass.

Operations remain in playground; no push; no provider usage/reset/OAuth; visual acceptance deferred.

Checkpoint: original terminal ring cursor bug and CRLF normalization were reproduced with failing tests. Absolute start offsets now survive trimming; dropped output is explicit and rawOutput opt-in preserves emulator control sequences. Small chunks coalesce to avoid an unbounded array of one-character entries. Gateway human-terminal service opens only the fixed workspace/system shell, validates dimensions/input and closes on host teardown. Scoped Desktop IPC/emulator/native packaging remain pending. Plugin gateway lifecycle also passed source/install/enable/restart/disable/uninstall using local fixtures.

UI/native checkpoint: xterm5.5.0 and fit addon0.10.0 are public pinned dependencies, lazy-loaded only when the terminal pane opens. Header entry and work-pane tab support up to8PTYs, input ordering/bounds, resize observer,5000-line emulator scrollback, bounded non-overlapping polling and cleanup without terminating a background PTY on tab unmount. Explicit close ends the process. Retry reattaches the emulator after read errors. UI test proves no automatic open, scoped input and non-destructive unmount. Native backend smoke in D:/agent-complete/playground generated a marker in PowerShell, resized, closed and verified PID59956 no longer exists; result/log/script are outside repo in desktop-audit. Known node-pty AttachConsole stderr was observed on close, so process exit was checked independently. This is not a renderer or packaged-ABI verification; those remain separate (pixels deferred, packaged ABI required).
