# Composer and context indicator audit — 2026-10-11

## Requested scope

The user requested a prompt-input redesign based on the existing ZCode, DSH and
OpenCode references, retaining version 0.1.7. Their Codex recording additionally
specified no new text-focus rectangle and automatic height adjustment. The
context capacity button must show approximate usage before opening its details.

The pre-change Electron observation confirms `field-sizing: fixed`, native
vertical resizing and a 72 px editor for both one-line and twelve-line drafts.
The source also applies a textarea focus outline and a separate project band.
The native geometry supports `field-sizing: content` in the shipped renderer.

## Final design

- A joined project/input card uses IH theme variables and keeps the same neutral
  surface on text focus. The existing ZCode slot adapter remains attributed.
  Textarea focus has no painted rectangle and no native resize handle. Toolbar
  controls retain keyboard focus indicators.
- Native content sizing grows and shrinks the textarea, including restored text
  and line wrapping. A `min(16rem, 35vh)` maximum bounds it; long text scrolls
  internally. No second draft state, DOM measurement loop or editor dependency
  is introduced. Leading/trailing toolbar groups wrap within the card.
- Execution/send errors stay inside the card with a bounded scroll area. The
  project band therefore remains joined when an error appears, and long error
  output leaves the editor and controls usable.
- A small context gauge displays backend-estimated usage such as `8.1%`, using
  the existing `session/context` contract. Unknown/invalid/error/unavailable
  states show an em dash; actual zero shows `0.0%`; tiny positive values show
  `<0.1%`. Over-capacity text retains its actual value while the gauge clamps.
  The popup retains token totals, role breakdown, estimate explanation and retry.
- Initial context reads happen without opening the popup. Durable events are
  coalesced at 250 ms with at least one second between background starts. One
  request and at most one follow-up are retained per scope. There is no idle
  polling or per-chunk read. Bridge/workspace/session/key/revision gates reject
  stale responses; cleanup removes listeners and timers.
- Model state, operation state and a successful apply revision refresh the
  estimate. The captured bridge/scope identity prevents an old apply from
  refreshing a newly selected conversation. A disconnect latches automatic
  reads offline, including later key changes, until explicit retry or remount.

No provider/backend contract, plugin format, credential handling or native asset
is changed. The source comparison and SHA-256 records are retained in
[`COMPOSER_SOURCES.md`](../../packages/desktop/src/renderer/session/COMPOSER_SOURCES.md)
and copied into the desktop license records. Existing slash-menu discovery is
retained on the same 0.1.7 branch.

## Focused verification and review

The context suite passed 42 tests after observed failing cases for newly visible
usage, request coalescing, invalid readings, StrictMode startup, stale scope/key
responses, and disconnect/key interactions. Three Workbench integration tests
cover model changes without events, successful same-model reapplication and a
late apply from an old conversation. The same-model test was also observed
failing without its successful-apply revision before passing with the revision.

Independent read-only review identified the joined-card error-slot gap and
disconnect/key background restart. Both were fixed. The final reviewer passed
all 45 context/Workbench tests and reported no remaining actionable finding.
The parent also passed composer project, picker and approval integration checks.

## Actual desktop observation

A hidden Electron window used a fresh owned profile, workspace and
`IH_CONFIG_DIR`. A loopback-only OpenAI-compatible response server provided a
controlled successful stream and a long HTTP 400 error. Its credential was a
dummy environment reference in the owned process. No existing user settings,
plugins or history were modified; no paid or external model service was called.
The focus state was emulated within the owned renderer, and hidden compositor
frames were flushed before capture.

Fifteen checks passed: no painted text-focus outline/resize handle, unchanged
surface edge on focus, growth, bounded scrolling, shrinkage, joined project
geometry, native Shift+Enter without sending, visible stop while streaming,
inline gauge/percentage layout, popup details, Escape return focus, light theme
with 18 px type, minimum-window toolbar bounds, slash-menu anchoring, and long
error containment. Seven screenshots cover those layouts. The development
observation is in
`.tmp/slash-desktop-ui-63635d8a-16cb-43d4-943c-099f6c9f2da2/composer-validation.json`.

## Final verification and local build

The final `pnpm verify:all` returned exit zero: 78/78 projects reported, 6,070
tests passed, 21 existing skips and zero failures. Desktop reports 1,110 passed
and three existing skips. Typecheck passed, five e2e files with 12 tests passed,
and reachability passed with 424 existing rows and no new exemptions.

The updated candidate keeps version 0.1.7 and uses the separate
`packages/desktop/release-0-1-7-composer` folder, preserving the earlier dynamic
menu candidate and its evidence. Its actual packaged executable, renderer and
bundled gateway passed all fifteen composer checks with a fresh owned profile,
local response server and a longer synthetic conversation to show a nonzero
percentage. The executable reports 0.1.7 with `app.isPackaged === true`.

An owned temporary entry shim imported the unchanged packaged main entry to
keep the QA window hidden and collect DOM/frames. The exact original manifest
was restored and the shim removed after clean shutdown, before installer creation.
The final byte comparison checks the restored payload against the portable ZIP.
The full packaged observation is retained as `composer-ui-validation.json`, with
seven screenshots in `qa`, the whole-repository log in `verify-all.log`, and exact
artifact digests/payload comparison in `validation.json` in the candidate folder.
No new GitHub release is created by this request.
