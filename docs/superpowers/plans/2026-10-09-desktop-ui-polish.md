# IH Desktop product polish implementation plan

> **For agentic workers:** Use subagent-driven-development with independent ownership, task reviews and a final whole-branch review. The user explicitly authorises comparison and independent design decisions. Continue through the full goal without another generic approval pause.

**Goal:** Beautiful, simple, coherent and comfortable IH Desktop, with all normal
agent and management/detail states audited and polished in actual Electron.

**Architecture:** Keep existing desktop/gateway/package contracts. Improve shared
React controls and renderers; relocate redundant navigation while preserving
resources and operations. Use isolated actual runtime fixtures and a complete
surface/action/state ledger.

**Tech Stack:** Existing React/Electron, Lucide, IH bridge/package contracts,
Vitest and actual packaged runtime acceptance.

**Spec:** docs/superpowers/specs/2026-10-09-desktop-ui-polish-design.md

## Global constraints

Use spec boundaries verbatim: no account UI; lower-left Settings; one sidebar
toggle; resizable both sidebars; floating/inset Todo; preserve context-origin
labels, backend authority/drafts/CAS/ownership/provenance/bounds; owned QA only;
reference trees readonly; no external installs/model spending/release changes.

## Task1 — Complete runtime inventory and missing-state evidence

Own root qualification helpers and ledger `.superpowers/sdd/2026-10-09-desktop-ui`.
Produces matrix of every existing page, button/action, package surface, dialog
and state, reference fit and concrete missing detail UI.

- [x] Actual15 settings pages and initial workbench baseline; reference versions/licenses/resources verified.
- [x] Populate real controlled agent runs: reasoning/tools/file changes/outputs/Code Mode/approval/question/errors/stop/queue/history.
- [x] Exercise management/resource/provider/plugin/MCP/form/preview operations with owned fixtures; record callback and actual state effects.
- [x] Record dark/light/narrow/large-font/focus/keyboard/overflow findings; do not count snapshots as action verification.

## Task2 — Shared control, dialog and visual foundation

Own shared controls under renderer/design and vendor/opencode, shared dialog,
scoped styling and attribution. Coordinate tokens with root. Preserve existing
button APIs; new pending/danger/form/detail primitives have explicit semantics.

- [x] RED behavior tests for pending controls, accessible actions, modal layering/IME/focus.
- [x] Adapt selected current OpenCode/DSH/ZCode patterns into IH React; style all supported control states and responsive rows.
- [x] Real rendered dark/light/large-font/narrow visual inspection and task review.

## Task3 — Page value, settings navigation and resource management

Own SettingsPane/nav metadata, resource tabs, search/discoverability, related
settings tests. Context/resource/manager detail edits assigned separately if
needed after Task1 findings. Consumes Task2 controls, preserves backend APIs.

- [x] RED for alias migration, searchable fields, persistent resource tab drafts and retained management operations.
- [x] Apply justified page dispositions from spec, not a blanket Advanced category; merge/relocate only with working destinations.
- [x] Latest user clarification supersedes the advanced Context UI prototype: keep only Context Mode and Code Context on/off switches at the top of Execution and permissions, preserve context-mode/claude-context origin descriptions, and migrate old routes/search aliases. Backend data/configuration and API bounds retain their existing owners.
- [x] Resource/package/model/MCP/hook/memory detail consistency, empty/error/loading/save/conflict states; actual operations and review.

## Task4 — Conversation, reasoning, tools, output and code changes

Own timeline/activity/reasoning/code/log/file-change presentations and tests;
review composer/interaction/job/workflow/subtask/Todo surfaces from Task1 matrix.
Split independent renderer tasks after concrete findings, keeping source owners
clear. Never change authoritative event classification to obtain prettier UI.

- [x] RED meaningful tests for actual state summaries, disclosure/copy/wrap, readable specialized output and preserved raw fallback.
- [x] Add missing supported detail surfaces and polish work stages, thinking, tools, outputs and actual file review/diffs.
- [x] Polish approvals/questions/error/retry/stop/queue, model/picker/composer/attachments and nested menus; preserve focus and drafts.
- [x] Actual streaming/completed/cancelled/failed/truncated and historical read-only verification across supported protocols; task review.

## Task5 — Shell, native feedback and full product acceptance

Own root integration fixes/qualification/docs/build. Coordinates earlier tasks.

- [x] Native maximize/restore feedback; responsive composer/panes and toolbar hierarchy, no duplicated controls, Todo stacking/inset.
- [x] Fresh candidate from final source; inspect every matrix entry with actual operation/result evidence and screenshots.
- [x] Complete tests/typechecks/reachability/package graph, scoped regressions, independent final review and fix material findings.
- [x] Requirement-by-requirement completion audit; local commit/candidate/report, user goal remains active until entire scope proven.

### Final review follow-up, 2026-10-10

The source has a fresh local candidate 11 and actual navigation/browser/Todo/
subagent primary-action receipts. Final integration closed after the following corrections and verification:

- Independently reproduced prepared/mounting session writer split: an acknowledged
  human Todo write can be lost and its durable sequence reused while asynchronous
  extension mounting finishes. Unify writable ownership, preserving readonly
  snapshots and close/reopen semantics; reproduce before/after through the real
  coordinator and service.
- Preserve the original abort reason if failure finalization also cannot save;
  keep both errors/cause and CLI graceful shutdown behavior.
- Complete the final source, packaged-runtime, full-gate and review checks after
  these corrections. Earlier green gates and family counts do not close them.

Current evidence and exact owned fixture paths are recorded in
`.superpowers/sdd/2026-10-09-desktop-ui/progress.md` and the qualification indexes.

Final evidence: docs/audit/2026-10-10-desktop-ui-polish-acceptance.md. Final full gate: 5,595 passed, 21 existing skips, zero failures, 76/76 projects, types/E2E/reachability passed. Candidate 13 and the exact 214-family receipt index are recorded there. Local implementation commit is the last delivery step.
