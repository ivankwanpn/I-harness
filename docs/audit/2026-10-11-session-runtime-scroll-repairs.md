# Desktop environment and scrolling repairs — 2026-10-11

## Scope and evidence

The user supplied `I-HARNESS-ENV-TEST-REPORT-0.1.7.md` from their `env-test`
workspace and screenshots of a failed archive operation, streaming text drifting
from the bottom, and the native conversation scrollbar. The report is evidence;
its prior analysis-only instructions do not govern this repair request. The
external report, clone, installed application, settings and conversation data
were left untouched. Version remains 0.1.7, based on main commit `6f8da587`.

The user clarified two interface requirements: the right scrollbar needs equal
top/bottom inset and rounded styling, and manually scrolling or dragging back to
the physical bottom must resume following, alongside the Jump-to-latest button.

## Verified runtime causes and repairs

- Completed child Bash/shell calls use pipe transport. Native automatic closure
  could retire stdin before a later EOF request, turning existing successful
  output into an `input already ended` error. EOF now joins closure, including
  before/during-release races. Failed release still fails and ordinary data
  requests retain their rejection. Real child-scope fixtures preserve output
  and verify the command's side-effect marker occurs exactly once.
- MSYS master writes hold the same internal mutex needed by master read/poll.
  A full unread input buffer could therefore starve output despite a writer
  thread. The writer waits for readiness outside the write and sends one byte
  per readiness opportunity. The original pressure failure was reproduced;
  output, resize, cancellation, UTF-8 and control-byte checks now pass.
- MSYS cancellation previously killed its trusted adapter before observing the
  child exit. Private POSIX termination lets the reaper report the real SIGKILL
  exit before descendant settlement. A bounded outer-owner fallback retains
  unknown/error observations when the adapter cannot finish. Private controller
  acknowledgements/errors keep their native ownership. The internal request ID
  is explicitly reserved so public requests receive an error rather than hang.
- Terminal descendant fixtures derived executable paths from process cwd;
  repository-root invocations looked in the wrong directory. Module-relative
  paths remove that difference. The reported ConPTY INT timeout did not recur
  on this host; its timeout was not increased.
- Periodic Desktop policy refresh held the provider-settings lease while
  awaiting native backend diagnostics. Synchronization now excludes expensive
  diagnostics, and explicit diagnostic reads run after lease release. Controlled
  tests proved the lock defect. The report's five original full-host failures
  did not reproduce in focused baseline runs, so they are not all attributed
  conclusively to this one cause. Bounded host-boundary traces retain evidence
  for any remaining stall.
- Code-index refresh repeatedly scanned committed chunks and terms. SQLite
  indexes now cover file chunk lookup and reverse chunk references, including
  existing schema-v1 stores. Isolated actual-repository refresh fell from
  56.70 seconds to 5.88 seconds with the same 60-second deadline; cached lookup
  time fell from 48.70 seconds to 0.56 seconds. The index grew from approximately
  115.5 to 143.3 MB, within the existing quota. Failed attempts retain the prior
  generation and failure outcome; additive job/phase diagnostics identify the
  current attempt separately from stored usable data.
- `pnpm --no-bail` still skips dependents in topological scheduling. A controlled
  A→B→C failure reproduced this. `--no-sort` now runs every workspace test script
  and retains the failing exit code. The first whole-repository repair pass also
  reported all 78 projects despite two newly added failing Timeline regressions.

## Settled conversation management

Cold unresolved rewind recordings were treated as active even after work had
settled. Archive/delete now recover them only after admission drains, idle checks
exclude live/durable work, and the coordinator acquires its write lease. Idle is
checked again under that lease. Pre-images and orphan evidence are preserved;
workspace files are unchanged. Active recorders, unfinished durable turns,
pending work, descendants and foreign ownership retain their existing guards.

Historical team roster paths now support an exact, inactive idempotent close
without recreating a runtime. Unknown paths still reject. Jobs capture and
persist exact agent/session provenance, preserving links after closure and
restart. Legacy backfill uses only an exact saved job-ID link, not a reused label.
Independent review found no actionable issue in those ownership and lifecycle
changes. Focused management, subagent, team and rewind checks passed.

## Conversation following and scrollbar

Timeline previously inferred reading intent from every scroll event and aligned
to a virtual row extent. Markdown/layout growth and virtualizer compensation can
produce those same events. Following now uses the physical DOM maximum, reacts
to delayed content/viewport resize, and pauses on explicit upward reading.
Forward wheel/key/touch input, native thumb return and Jump-to-latest resume at
the bottom. Search/history positions retain their scope.

Classic Chromium captures a native thumb without DOM pointer-move events. A
real-thumb review exposed that synthetic pointer movement was insufficient.
The virtualizer's supported scroll-write adapter now subtracts actual clamped
programmatic movement from the next observed delta. Remaining native movement
controls drag direction, including coalesced layout/user events. Holding through
layout compensation stays paused, returning to the bottom resumes before release,
and reversing upward pauses again. Cancelled/blurred gestures clear their intent.
Observers, global listeners and pending frames are removed on cleanup.

Thirteen following regressions and related disclosure/navigation checks pass.
Independent real React/Tanstack Chromium traces, with native scrollbars visible,
confirm held return, reversal, keyboard input, compensation, overlap, search and
zero final bottom gap. The final trace is
`.tmp/timeline-native-capture-fix-review.json`. Styles use symmetric 16 px rail
inset, a rounded thumb and no arrow buttons, scoped to the conversation timeline.

## Native identities and limitations

The final helper is `e497393df04b923b581ba0c0886aaa9398180b255d6d277b041a98d7a8e51fc2`;
MSYS template is `6fa3b1f2fc15868cd09e873cef625c6ced400f36c0c67c2c92ce9282231ce186`;
protocol is `2024d9bc325df7122415f01efb5a14ee1ff11f64b7e8d9ad177167cd818b3298`.
Frozen metadata was rebuilt with the repository workflow and fresh observations;
earlier records are retained in qualification history. Final native smoke has
34 passing controls, Rust unit checks 27 passes, and native-owner package checks
59 passes. Fresh qualification has 39 passes, zero failures and four existing
unsupported PSEC/MSYS named-object cases. Its exit two and experimental/incomplete
classification are retained. These repairs do not establish broader PSEC support.

## Final verification and local candidate

The final whole-repository log, actual packaged UI observations, native identities,
artifact digests and byte-for-byte portable comparison are retained in
`packages/desktop/release-0-1-7-session-repairs`. Tests use owned fixtures and
loopback models. No paid or external model call is required for this validation.
Final `pnpm verify:all` returned exit zero: 78/78 projects reported, 6,116 tests
passed, 21 existing skips and zero failures. Desktop reports 1,136 passed and
three existing skips; Desktop gateway reports 423 passed. Typecheck, all six
e2e files and reachability passed. Reachability retains 424 rows with no new
exemptions. The first repair pass retained the two just-added Timeline RED cases;
a later pass was interrupted by a simultaneous Desktop rebuild removing its
attachment worker. Both logs were retained, and the final successful pass ran
with source/native assets and worker payload fixed.

The actual packaged executable and bundled gateway passed eleven UI checks in
`.tmp/slash-desktop-ui-c305fd51-1237-48bc-8d5b-7c3fc5be2e7f/timeline-ui-validation.json`.
They cover text streaming, viewport resize, physical final bottom, scrollbar
styling, upward reading, wheel return, Shift+Space and native held-thumb return.
The owned input harness was corrected to emit printable Space input, wait for
native scrolling to settle, and move into the native thumb before pressing.
Hidden compositor frames were flushed before the three captures. The packaged
entry shim was removed and the original manifest restored before the installer
build. Exact artifact identities and payload comparison are recorded in
`validation.json` after all checks complete.
