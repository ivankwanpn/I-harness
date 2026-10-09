# I-harness Desktop interface polish

Date: 2026-10-10, Asia/Hong_Kong. Branch: `codex/desktop-ui-polish`.
Implementation baseline: `13e7f1ca`; accepted design/plan: `c7ff77b5` plus the
user's subsequent two-switch Context clarification.

**Acceptance status:** final source, actual candidate 13, complete workspace gate and independent review are accepted. All 214 inventoried operation families have actual primary-action evidence, with the explicit limits below. No official release or GitHub publication was
performed as part of this interface goal.

## Product changes

- Shared buttons, fields, dialogs, menus, focus, pending/error feedback and
  output presentation use the existing IH React stack. The selected OpenCode,
  DSH and ZCode adaptations retain their source and license notices.
- Settings have 11 destinations. General includes appearance; Skills and
  Commands use persistent Resources tabs; session/workspace operations remain
  accessible from the sidebar and managers. Operational diagnostics are in
  Workbench tools.
- Context Mode and Code Context have only two on/off controls at the top of
  Execution and permissions, with short purpose and source descriptions.
  The separate Context destination and advanced fields were removed. Old
  routes/search aliases migrate without deleting configuration or data.
- Active responses display chronological communication, thinking and tools.
  A durable completed turn creates a collapsed work disclosure above its
  separate final answer. Failures, incomplete work, empty/truncated output,
  raw fallback and actual captured diffs remain distinguishable.
- Provider/resource/Hook/MCP/Memory forms, interaction answers, Todo edits,
  workflow forms and file/review drafts retain their correct owner and revision.
  Hidden pages do not retain foreground modal or native browser ownership.
- Lower-left Settings replaces account UI; the left sidebar has one toggle.
  Both sidebars resize independently. Todo floats over the conversation with
  an inset from the right border and scrollbar.
- Native window state, browser visibility/history/stop/close, terminal
  appearance/lifetime, source navigation, Git controls and clipboard feedback
  have actual operation evidence.

## Requirement evidence

The working ledger and original receipts are repository-owned audit artifacts.
They are intentionally outside the shipped product UI. The family index links
each positive action to its actual report, case, candidate, readback and limits.

| Requirement | Authoritative evidence |
| --- | --- |
| Actual reference versions, useful resources and legal attribution | `renderer/design/CONTROL_SOURCES.md`, `settings/SETTINGS_DRAFT_SOURCES.md`, `session/TOOL_OUTPUT_SOURCES.md`, `vendor/zcode/WINDOW_CONTROLS_SOURCES.md`, shipped `licenses/ui-controls`, `THIRD_PARTY_NOTICES`. The surface matrix records actual upstream consumers and conditional routes. |
| All pages/actions and package surfaces inventoried | `.superpowers/sdd/2026-10-09-desktop-ui/surface-matrix.md`: 214 operation families, 11 groups, 75 package rows with active/internal/conditional/outside-closure dispositions. |
| Actual primary operations for every family | `.tmp/desktop-ui-protocols-83lTVD/family-receipts-214.json`: 214 families have positive primary subsets. Failed driver/product attempts are excluded; counts alone are not acceptance. |
| Dialogs, resources, providers, plugins, MCP, Hooks and Memory | `management-qualification.md`, `management-gap-qualification.md`, `settings-actions-qualification.md` and their exact owned runtime receipts. R25 additionally has genuine live Hook refresh failure/retry in `plugin-live-retry-qualification.md`. |
| Ongoing/final/thinking/tools/output/code, approvals/questions/stop/queue | `.tmp/desktop-ui-protocols-83lTVD/qualification.json`, `primary-mapping.json`, original protocol and supplementary receipts. Four supported protocol shapes use actual adapters/execution with owned loopback HTTP. |
| Todo, tasks, regular subagents, workflow and reminders | `session-workflow-qualification.json`, `task-subagent-qualification.md`; regular registry evidence is distinct from Team. `subagent-guidance-polish.md` includes the no-model candidate 12 locale/history preservation check. |
| Navigation, resize, clipboard, archive and browser controls | Candidate 11 `navigation-cOftqe` positive cases plus the selection-only `navigation-y3rriY` correction; actual native/tray/terminal and OS-composition evidence is separately scoped in the native reports. |
| Final Context shape and real saved effects | Candidate 13 `.tmp/desktop-ui-shell-g3APnD/shell.json`: two switches, 11 destinations, sparse enabled changes preserving other metadata, source-alias route, zero model prompts. |
| Removed-owner denial and explicit recovery | Candidate 13 `.tmp/desktop-ui-session-workflow-upZZQX/session-workflow.json`: actual Composer setup, removal/discovery/open, denied attempt with zero added HTTP calls, balanced failed turn, real idle policy observations, owner-CAS manager move. |
| Concurrent human write during preparation/mount | Independent source rechecks `final-review-mount-write-iDe4Jc` and `iwtwSy`; actual shipped candidate 13 modules under matching Electron runtime in `.tmp/packaged-review-mount-write-wihsas/review.json`: acknowledged Todo/rev1 retained, one Todo event, contiguous sequences 0–10 and successful cold reopen. |
| Preserve baseline parent persistence and readonly boundaries | Final independent review: coordinator-only fresh parent retains the original enqueue/flush/dispatch mirror without loading a parent; explicit loader/hooks win; cold readonly methods never invoke the writable factory. |

## Corrections discovered during verification

Real checking found and corrected stale WSL shell presentation, erased pending
interaction/Todo drafts, reset Todo pages during loading, post-save file preview
conflicts, removed-project sidebar disappearance, failed-turn boundaries and
policy oscillation, a preparation/mount writer split, and masked abort errors.
The failing original histories were preserved; neither repair nor replay was
used to obtain passing evidence.

Final independent review found the writer split, independently reproduced it,
then verified its closure and the subsequent coordinator-only compatibility
correction. Review results and overlapping scoped test counts are recorded in
the progress ledger; they are not added together as unique tests.

## Qualification limits

- Action-family proof is an exercised primary path plus specified error/draft
  variants, not every permutation of every input or future service configuration.
- Native picker selections and registered tray callbacks are controlled owned
  operations; physical OS picker/tray-menu interaction is not implied. Native
  guest-view OS composition has its own genuine captures; Electron page PNGs
  alone do not prove that composition.
- No paid provider, signed AWS/cloud transport, real credentials, global package
  installation or WSL repair/install was used. Configured protocol behavior
  and actual local readonly WSL diagnosis have their stated receipts.
- MCP configuration/secret/application semantics are verified; the settings
  response does not supply general live authentication/connection status, so the
  UI does not invent it. The R25 fixture has no Hook script execution or replay.
- Original corrupt/denied/history artifacts remain unchanged. The candidate is
  a local portable build with its adjacent resources, not a newly published
  installer or official GitHub release.

## Final gate and delivery

The final `pnpm verify:all` run passed: **5,595 passed, 21 existing skipped,
zero failed**, **76/76** projects, all type checks, E2E in five files and
reachability with no new rows. Its log is
`.tmp/desktop-ui-verify-all-delivery-03.log`; handle `45336` completed exit 0.
Four old reachability allowlist entries match no current row and exempt nothing.
Earlier failed gate attempts remain diagnostics and are not accepted gates.

The local portable candidate is `.tmp/desktop-ui-polish-candidate-13`:
keep `I-harness.exe` with its adjacent `resources`. It combines renderer build13
and gateway13. The final visible Context check records actual checked controls
and settled thumb transforms of 13px; hidden-window captures paused compositor
animations and are not treated as proof of a settled switch. All owned audit
processes, loopback servers and guest views were retired.

The implementation is prepared for a local commit under the configured GitHub
identity (`ivankwanpn`). Official releases remain the previously published
versions until a separate publication action is requested.