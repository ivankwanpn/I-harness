# IH Desktop product polish

## Objective and authority

User goal: research and obtain useful resources from OpenCode's new Desktop UI,
DSH Desktop and ZCode Desktop; actually launch IH and inspect every interface,
button, package surface and small dialog/error detail; produce a beautiful,
simple, comfortable and coherent interface; evaluate whether each separate page
has value and remove unnecessary destinations. User explicitly includes normal
agent session/work stages, thinking, tool calls, outputs and code changes and
authorises the agent to compare references and decide independently.

This objective extends through real rendered acceptance; a source inventory,
settings-only pass or green component tests cannot complete it.

Base13e7f1ca, branch codex/desktop-ui-polish, workspace D:/I-harness-main.
Existing clean checkout is reused; old milestone worktrees are unrelated.

## Evidence and resource choices

Actual isolated Electron/main/preload/shipped-gateway baseline visited all15
settings destinations and captured108 controls plus initial workbench. Evidence:
`.tmp/desktop-ui-baseline-CwM25r/baseline.json` and screenshots. It contains real
empty/configured capability states; callbacks/edits and normal agent content
need further controlled runtime fixtures. The early General capture shows
capability discovery still pending; repeated unavailable notices are a defect
in presentation, not proof that those features are absent.

OpenCode local1.18.30 new V2 widgets/settings/app/session UI were independently
verified identical to official1.18.35 relevant Git trees. Sources are MIT.
Use compact shared buttons, form fields, selected/menu/busy/focus treatments,
tooltip suppression, dialog composition and responsive settings rows; retain IH
React and semantic tokens. Avoid upstream unlabeled clear buttons, div-based tab
close, copy-icon alias defect, CSS-only disabled loading and global light reset.
[Official V2 source](https://api.github.com/repos/anomalyco/opencode/contents/packages/ui/src/v2?ref=v1.18.35).

DSH0.2.0-rc.2 MIT shared Desktop/Web client supplies modal layer ownership,
IME-safe Escape, focus restoration, visited tab retention, human error and
operation feedback patterns. ZCode3.14.0 Apache-2.0 supplies resource action
hierarchy/list/scope/form/empty states and adaptive composer patterns; preserve
separate dependency attribution where applicable. Keep current Lucide glyphs
and system fonts. Record source paths, versions, hashes and notices for adapted
code. Reference source trees remain read only.

## Product design

### Shared visual language

Use one IH palette, typography hierarchy, spacing scale, input/button states and
dialog frame across workbench, settings, resources, questions, approvals, code
and outputs. Comfortable density, clear primary actions, quiet secondary actions
and visible keyboard focus. Dark/light themes, large fonts, narrow windows and
reduced motion must work. Buttons and number fields currently using raw browser
chrome will use the shared controls. Each empty state distinguishes no items,
no matching search, unavailable environment, pending work and operation failure.

### Page value and navigation

Evaluate actual user workflow per page; no blanket Advanced category. Initial
disposition, to validate through runtime operations:

| Current destination | Disposition |
| --- | --- |
| General + Appearance | Combine local preferences with named appearance/window/terminal groups. Move Agent Shell to execution. Remove settings checkboxes for transient review/sidebar operations already controlled by workbench. |
| Notifications | Keep notification preference/history/read/target workflow discoverable; no new duplicated bell/toolbar surface solely to reduce page count. |
| Models/providers | Keep independent durable model, protocol and connection workflow. |
| Execution/context | Rename to execution/permissions; keep runtime defaults, approval, sandbox, WSL, web and Code Mode. Put operational diagnostics in existing diagnostic surface or subordinate disclosure. |
| Context/retrieval | User clarification on 2026-10-10: native Context Mode and Code Context have only on/off switches at the top of execution settings. Remove the separate destination and extra configuration controls; retain context-mode and claude-context origin labels and existing backend configuration. |
| Subagents, Hooks, MCP | Keep separate coherent model/role, trust/script and server/connection workflows. |
| Skills + Commands | Shared Resources destination with named persistent Skills/Commands tabs and searchable direct aliases; preserve kind/source/authoring/use semantics, drafts and deep navigation. |
| Memory, Plugins | Keep independent durable data/package management workflows. |
| Workspace | Remove settings destination after confirming/retaining all session/archive/batch/move/rewind actions in the existing session/project management surface. |
| About | Keep recognizable support, version, diagnostic copy and licensing destination. |

Settings search covers field/function aliases as well as headings. Capability
loading, missing workspace and truly unavailable service are distinct. Keep one
concise contextual explanation rather than repeated navigation paragraphs.

Confirmed context disposition, 2026-10-10: the settings destination count is
**11**. Stored `context-subsystems`, `context-mode` and `claude-context` selections
resolve to execution; function search aliases remain discoverable there.
The former complex context page is not retained as a hidden product surface.
Backend configuration, authored data, indexing and output metadata remain under
their existing authority. Removing the advanced context UI does not reset or
delete those settings or data.

Unsaved provider, resource, hook, MCP and memory forms are retained by their real
identity for the renderer app session. Private drafts are kept in memory, never
in browser storage or a global settings file. Visited form bodies and pending
editor owners survive navigation; inactive dialogs release modal ownership and
hide their portals. Explicit operation readback remains valid while hidden,
while hidden polling and notification-history subscriptions are paused.

### Normal agent workflow

Inspect populated, streaming, completed, stopped, failed, empty and truncated
states. Work stages/thinking/tool summaries communicate authoritative state and
elapsed information when available. Typed summaries for commands, files,
searches, Code Mode and package/MCP operations have readable output previews,
copy/wrap/expand controls and raw detail access. Do not discard recorded data or
invent durations, running states, successful output or file diffs.

File changes link to actual review/diff/file preview with source and dirty draft
identity preserved. Review handles clean/no-repo/modified/conflict/read-only and
save/stage/commit errors. Composer/model/permissions/attachments/context/slash
pickers, queue/stop/retry, stages, subtasks, jobs, Todo, code/logs, pending approval
and structured questions all receive the same visual/interaction treatment.
Missing detail interfaces must be added where the backend actually supplies
the capability, and every added action receives real operation evidence.

User correction from the paired Codex screenshots: a work-stage disclosure is
created only when the response turn finishes. While execution is active, show
thinking/commentary/tools in their actual order without an early aggregate
work-stage header. Completed work collapses into the summary above the separate
final answer; expansion restores the intermediate recorded content. Preserve
reader choices and never invent an elapsed duration when records lack time.

## Boundaries

- Preserve package structure and backend authority, role/tool bindings, sandbox,
  ownership, safe file paths, drafts/CAS, actual status provenance, cancellation
  and bounded history/output. UI observation does not replay execution.
- No account/login UI. Lower-left Settings, one left-sidebar toggle, two
  independently resizable sidebars; Todo above transcript with right inset.
- Test profiles/config/workspaces/providers/packages/files are repository owned;
  actual desktop uses isolated data before startup. No live paid model calls,
  credentials, reference edits, global installations or official release edits.
- UI page removal is navigation relocation, not deletion of stored resources.
- Source attribution is retained. No inactive upstream affordance copied as a
  working IH feature. Avoid unnecessary framework/font/icon dependencies.

## Completion evidence

Maintain an enumerated surface/action/state matrix from actual current UI and
callback/package mapping. Each item needs rendered action/result evidence,
including dialogs, errors, keyboard/focus, persistence, resize and recovery.
Compare reference resources and record every page keep/combine/remove decision.
Finish with a fresh packaged Desktop, before/after screenshots, meaningful
regressions, complete gates, independent task/final review and scope audit.
Only then is the user goal complete.
