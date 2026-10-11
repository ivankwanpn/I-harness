# Dynamic slash menu audit — 2026-10-11

## Scope and design

The reported Resources page contained 14 Superpowers skills, while the composer
queried only `desktop/plugins/commands`. Skills-only plugins therefore supplied
no rows to the old slash list. Native button defaults and an inline container
also made the list visually inconsistent and increased the composer height.

The new `desktop/resources/suggestions` route summarizes the existing effective
commands and skill registry. It carries names, kinds, descriptions, argument
hints, origins and plugin IDs; bodies and authoring paths are excluded. Search
precedes a 100-row bound, with an untruncated total and registry diagnostics.
Workspace/plugin/global precedence and distinct same-name command/skill rows
remain intact. The legacy commands route is unchanged.

The composer queries the selected workspace and refreshes sequentially every
500 ms while the slash overlay is open. Closed or hidden composers stop the
refresh. A changed workspace/query clears previous rows immediately; old replies
cannot populate the new scope. Refresh failures clear stale remote rows. Plugin
installation retains the existing explicit enable step, and the existing hook
content grants remain authoritative.

The UI groups built-in operations, commands and skills, shows source labels and
searches names/descriptions/plugin IDs. Selection inserts `/command ` or
`$skill ` into the draft with editor focus retained. Built-in workflow actions
keep their existing behavior. No selection submits a prompt. The viewport-bounded
portal keeps its own scroll area, shared keyboard/pointer highlight and
identity-based selection. Its visibility follows the actual composer, including
pending interaction overlays. Escape also works with diagnostics focus and
restores editor focus.

Read-only source comparisons covered ZCode, DSH and OpenCode. The rationale and
five SHA-256 records are in
[`SLASH_SOURCES.md`](../../packages/desktop/src/renderer/session/SLASH_SOURCES.md);
the package copies that record into `licenses/ui-controls` with existing notices.
No upstream editor, provider or state-store runtime is imported.

## Focused evidence

- Gateway lifecycle fixtures cover installed-disabled, enable, disable,
  uninstall, same-name precedence, case-insensitive searches, result bounds and
  strict query validation. A skills-only plugin and a commands-only plugin use
  the real Desktop host and an owned local marketplace. Resource reads create
  no session. Existing live assemblies also lose disabled/uninstalled skills
  and commands without modifying history, and recover after re-enable.
- Desktop IPC fixtures verify workspace scoping and query-only forwarding,
  including invalid queries and unknown-workspace refusal before runtime launch.
- Composer tests cover mixed skills/commands, native prefixes, built-in-name
  skill collisions, live add/remove, selection identity during insertion, stale
  workspace replies, refresh failure, hidden owners and Escape with diagnostics
  focus. New behavior was observed failing before its implementation.
- Independent review identified the hidden-owner portal and diagnostics Escape
  cases. Both were reproduced, fixed and passed new regression tests. Final
  review reported no important findings; its four-file focused run passed 30
  tests. A final editor-focus assertion also passed.

## Actual Desktop observation

The built Electron Desktop and real gateway ran against a fresh owned profile,
`IH_CONFIG_DIR`, workspace and local marketplace. The hidden QA window's
compositor was flushed before screenshots. No existing user settings, plugins
or conversations were modified and no live model inference was used.

Fourteen checks passed: installed-disabled visibility, live enable, panel bounds,
End-key selection/scrolling, disable, re-enable, uninstall, reinstall, native skill
insertion, native command insertion, minimum 640×600 viewport, light theme with
18 px type, Escape with draft preservation, and an empty conversation catalogue
after menu use. Screenshots cover the mixed menu, final selected row, plugin
search, uninstall, narrow viewport and light theme.

The development observation is recorded under
`.tmp/slash-desktop-ui-d92b3a80-2d51-46ff-b118-d85cbf391274/validation.json`.
Its initial final assertion used the wrong test-harness result shape; the actual
`session/list` response is `{ sessions: [] }`. The corrected assertion was run
against the same completed observation and passed. The owned app closed cleanly.

## Final verification and local artifacts

The final `pnpm verify:all` returned exit zero: 78/78 projects reported, 6,028
tests passed, 21 existing skips and zero failures. Typecheck passed. Five e2e
files with 12 tests passed. Reachability passed with 424 existing rows and no
new exemptions. The Desktop suite reports 1,068 passed and three existing skips;
the gateway suite reports 414 passed. No dependency or native runtime source was
changed by this feature.

The actual packaged `I-harness.exe`, renderer and bundled gateway also passed
all 14 Desktop checks with a fresh profile/configuration and marketplace fixture.
The packaged runtime reports version 0.1.7 and `app.isPackaged === true`. The
owned QA output used a temporary entry shim solely to keep the observation window
hidden and collect its DOM/frames; it imported the unchanged shipped main entry.
The exact original manifest was restored and the shim removed after a clean app
exit, before installer creation and payload comparison. The packaged gateway
therefore followed its normal bundled launch path, with no repository fallback.

Packaged observation is retained in
`packages/desktop/release-0-1-7-dynamic-slash/desktop-ui-validation.json`; its six
screenshots are in the sibling `qa` directory. The fixture tests a skills-only
plugin with 14 representative Superpowers resources plus a separate command
plugin. It is an observation of dynamic discovery and insertion, without a claim
to have executed every marketplace plugin or a paid model.

The local installer and portable ZIP are in
`packages/desktop/release-0-1-7-dynamic-slash`. Exact digests and the full payload
comparison are recorded in that directory's `validation.json` after artifact
creation. This version is a local build; no new GitHub release is created by this
request.
