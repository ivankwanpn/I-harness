# M49 Remaining Tasks Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete M49 Tasks 6-15 from the reviewed Task 5 checkpoint, delivering only Grok-aligned TUI behavior backed by real I-harness capabilities.

**Architecture:** Continue the existing TypeScript TUI and cell renderer, using the canonical provider runtime, session services, SDK capability negotiation, and domain-owned projections established by Tasks 1-5. This document is the continuation runbook; the canonical implementation details and literal TDD examples remain in the full M49 plan and the generated task briefs.

**Tech Stack:** TypeScript ESM, pnpm workspaces, Vitest 3.2.7, Node.js >=22.18, `tui-core` cell renderer and PTY harness, JSONL session persistence, SDK JSON-RPC wire, provider/settings/credentials packages.

**Spec:** `docs/superpowers/specs/2026-09-06-m49-grok-tui-parity-design.md`

**Canonical implementation plan:** `docs/superpowers/plans/2026-09-06-m49-grok-tui-parity.md`

## Global Constraints

- Production composition must never pass `modelPolicy: "test-mock"`; only unit and PTY harnesses may opt in explicitly.
- `settings.llm.providers` is the only final provider/model persistence plane; `settings.tui` keeps presentation/input/dashboard preferences only.
- Raw API keys, bearer tokens, passwords, and authorization headers never enter settings, status lines, tool summaries, snapshots, or logs.
- Provider protocol/profile/probe/client code remains in `provider`; settings/credentials composition belongs in `provider-runtime`.
- Session lifecycle/model binding/queue changes follow `session-executor` and `core-agent` patterns; task projections follow `subagent`/`jobs` patterns.
- Visible TUI commands, rows, hit areas, settings, and actions require a real backend or local source; absent capability means hidden or explicitly unavailable.
- Unknown or hidden slash commands render `Unsupported command: /<name>` and are never submitted to the LLM.
- Minimal mode must not enter the alternate screen or emit mouse-enable sequences.
- Fullscreen zero-byte idle, resize, UTF-8/codepage, selection, timeline, and byte-budget invariants remain green.
- New behavior follows strict red-green-refactor TDD. Every task ends with focused tests, typecheck, commit, task-spec review, and task-quality review.
- Do not modify or stage `D:\I-harness-main\packages\tui-core\test\harness\case-010.test.ts` from the main checkout; M49 work is confined to `D:\I-harness-main\.worktrees\m49`.

---

## Resume Checkpoint

Use exactly this workspace:

```text
Repository:      D:\I-harness-main
Worktree:        D:\I-harness-main\.worktrees\m49
Branch:          m49
Task 5 commit:   c47822b4bb51641b34c2b4fecca9c0416d60566d
Completed:       Tasks 1-5
Remaining:       Tasks 6-15
First task:      Task 6
```

The continuation-plan documentation commit may be directly above `c47822b`. Record the actual `HEAD` as Task 6's base when dispatching it; never reset a docs-only descendant back to `c47822b`.

Task 5 closure evidence:

- Task 5 package gate: 63/63 tests passed.
- TUI app gate: 15/15 tests passed.
- Full `@i-harness/tui` gate: 57 files and 571/571 tests passed.
- Both TUI typechecks and `git diff --check` passed.
- Task 5 review and scoped re-review are clean.
- `case-024` is clean at 80x24 and 120x32.

The canonical recovery state is:

```text
.superpowers/sdd/2026-09-06-m49-grok-tui-parity/progress.md
```

Trust that ledger and `git log` over conversational memory. A numbered completion line, for example `Task 6: complete`, means that task is complete and must not be re-dispatched.

## Workspace Safety

- [ ] Run all commands with working directory `D:\I-harness-main\.worktrees\m49`.
- [ ] Verify `git branch --show-current` returns `m49`.
- [ ] Verify the worktree is linked by comparing `git rev-parse --git-dir` with `git rev-parse --git-common-dir`.
- [ ] Read `git status --short --branch` before each task.
- [ ] Preserve unexpected changes. Assume they belong to the user or another completed task; never reset or revert them blindly.
- [ ] Never edit the main checkout's modified `packages/tui-core/test/harness/case-010.test.ts` or untracked `.pnpm-store/`.
- [ ] Do not merge, push, publish, delete the worktree, or rewrite branch history without explicit user instruction.

Expected initial checks:

```powershell
Set-Location 'D:\I-harness-main\.worktrees\m49'
git branch --show-current
git status --short --branch
git log -5 --oneline
Get-Content '.superpowers\sdd\2026-09-06-m49-grok-tui-parity\progress.md' -Tail 40
```

If `HEAD` has advanced, do not assume work was lost or duplicated. Read the ledger and commit log, inspect any task report, and resume the first task without a completion line.

## Source Of Truth

Read these once before dispatching Task 6:

1. `docs/superpowers/specs/2026-09-06-m49-grok-tui-parity-design.md`
2. `docs/superpowers/plans/2026-09-06-m49-grok-tui-parity.md`
3. This continuation plan
4. `.superpowers/sdd/2026-09-06-m49-grok-tui-parity/progress.md`
5. The brief for the current task only

The authority order is:

```text
User instructions > design spec > canonical full plan > current task brief > this runbook summary
```

When text conflicts, rule in favor of the higher authority. Use the same concrete ledger form as existing rulings, for example:

```text
Ruling: preserve modelsURL as a full endpoint - spec section 3.3 defines it as an exact endpoint - cost if wrong: custom providers may probe the wrong URL.
```

## Ownership Map

| Task | Primary ownership | Produces for later tasks |
|---|---|---|
| 6 | `settings`, `provider-runtime`, TUI settings/provider views | Typed settings registry/controller, provider controller, canonical provider plane |
| 7 | TUI prompt editor, `tui-core` cursor | Grapheme-safe editor, atomic paste, visible cursor transitions |
| 8 | `tui-core` themes, settings, minimal/fullscreen startup | Six persisted theme values including system, real minimal mode |
| 9 | New `text-diff` package and `fs` results | Structured `TextDiff` consumed by tool presentation |
| 10 | TUI tool mapping, scrollback, viewer/modal, host bridges | Typed tool blocks, redaction, real viewers and clipboard |
| 11 | `core-agent`, `session-executor`, SDK, TUI queue | Real queue list/cancel capability |
| 12 | `subagent`, `session-executor`, SDK, TUI tasks | Real task/subagent/job projection and cancellation |
| 13 | SDK, settings, TUI dashboard/status, executable host | Local dashboard and truthful status aggregation |
| 14 | Preset, session assembly, subagent prompt, slash registry, terminal | Capability-gated commands, default prompts, mouse capture toggle |
| 15 | PTY integration, documentation, repository/distribution verification | Integrated parity proof and final branch review |

Tasks are sequential. Tasks 6-8 repeatedly touch settings/TUI startup, Tasks 7/10/13/14 touch input routing, Task 9 is consumed by Task 10, and Tasks 11/12 feed Task 13. Do not run multiple implementation agents against this shared worktree.

## Spec Coverage Matrix

| Spec section | Delivery task |
|---|---|
| 0-2 goals, truthfulness, ownership, scope | Global Constraints plus every task review |
| 3 provider/auth/model architecture | Tasks 1-2 complete; Task 6 removes the transitional legacy plane |
| 4 production model gate/session binding | Tasks 3-5 complete; Tasks 6 and 11-13 preserve capability semantics |
| 5 Welcome/startup/Agent visual contract | Task 5 complete; Tasks 7, 8, 10, and 13 extend its surfaces |
| 6 prompt editor/cursor | Task 7 |
| 7 scrollback/minimal/tool blocks/diff | Tasks 8-10 |
| 8 queue/tasks/dashboard | Tasks 11-13 |
| 9 settings/theme/modal/status/interaction | Tasks 6, 8, 10, 13, and 14 |
| 10 slash command contract | Task 14 |
| 11 system prompt contract | Task 14 |
| 12 error/security semantics | Per-task negative tests and Task 15 honesty/security review |
| 13 verification contract | Every task GREEN gate; Task 15 integrated/final gates |
| 14 delivery slices | The ordered Task 6-15 sequence in this runbook |
| 15 completion definition | Task 15 plus Final Whole-Branch Gate |

No spec section is deferred outside Tasks 6-15. Explicitly excluded account/OAuth login, billing, delete, privacy, cross-machine dashboard, and unsupported discovery remain excluded rather than becoming hidden work.

## SDD Execution Protocol

Use `superpowers:subagent-driven-development` in the controller session.

For every remaining task:

- [ ] Read only the exact brief named in that task's section below. Task 6 starts with:

```text
D:\I-harness-main\.worktrees\m49\.superpowers\sdd\2026-09-06-m49-grok-tui-parity\task-6-brief.md
```

- [ ] Record the exact implementation base:

```powershell
$base = git rev-parse HEAD
```

- [ ] Dispatch one fresh implementer. The prompt must identify the worktree, brief path, report path, inherited interfaces, deferred findings that overlap this task, and the no-subagents rule.
- [ ] Require strict RED-GREEN-REFACTOR evidence. Production code may not precede a test that fails for the intended reason.
- [ ] Require the implementer to self-review, run the brief's complete GREEN gate, commit, and write the exact numbered report:

```text
D:\I-harness-main\.worktrees\m49\.superpowers\sdd\2026-09-06-m49-grok-tui-parity\task-6-report.md
D:\I-harness-main\.worktrees\m49\.superpowers\sdd\2026-09-06-m49-grok-tui-parity\task-7-report.md
D:\I-harness-main\.worktrees\m49\.superpowers\sdd\2026-09-06-m49-grok-tui-parity\task-8-report.md
D:\I-harness-main\.worktrees\m49\.superpowers\sdd\2026-09-06-m49-grok-tui-parity\task-9-report.md
D:\I-harness-main\.worktrees\m49\.superpowers\sdd\2026-09-06-m49-grok-tui-parity\task-10-report.md
D:\I-harness-main\.worktrees\m49\.superpowers\sdd\2026-09-06-m49-grok-tui-parity\task-11-report.md
D:\I-harness-main\.worktrees\m49\.superpowers\sdd\2026-09-06-m49-grok-tui-parity\task-12-report.md
D:\I-harness-main\.worktrees\m49\.superpowers\sdd\2026-09-06-m49-grok-tui-parity\task-13-report.md
D:\I-harness-main\.worktrees\m49\.superpowers\sdd\2026-09-06-m49-grok-tui-parity\task-14-report.md
D:\I-harness-main\.worktrees\m49\.superpowers\sdd\2026-09-06-m49-grok-tui-parity\task-15-report.md
```

- [ ] Generate a review package from the recorded base, never from `HEAD~1`:

```powershell
$plan = 'docs/superpowers/plans/2026-09-06-m49-grok-tui-parity.md'
$head = git rev-parse HEAD
& 'C:\Program Files\Git\bin\bash.exe' 'C:/Users/inkik/.codex/plugins/cache/openai-curated-remote/superpowers/6.3.0/skills/subagent-driven-development/scripts/review-package' $plan $base $head
```

- [ ] Dispatch a fresh task reviewer with the brief, report, review package, exact base/head, and the Global Constraints above.
- [ ] Require both verdicts: spec compliance and task quality.
- [ ] Record Minor findings as deferred ledger entries. Do not silently discard them and do not enter a fix loop for Minor-only findings.
- [ ] For Critical, Important, spec failure, or a confirmed cross-task gap, run up to five fix rounds:
  - Rounds 1-3 resume the original implementer.
  - Rounds 4-5 use a fresh, more capable implementer.
  - Every round appends RED/GREEN evidence to the same task report.
  - Every round receives a scoped re-review package from the previous reviewed head to the new head.
- [ ] Mark the task complete only after review is clean or the five-round breaker has adjudicated every residual finding with a ledgered ruling.
- [ ] Start the next task immediately after completion. Do not ask the user between tasks.

Stop only for an irreversible/destructive action, a security-sensitive action, an external side effect such as merge/push/publish, or a plan defect for which every path is guesswork.

## Carry-Forward Review Items

These are deferred Minors from Tasks 1-4. They are not permission to broaden a task arbitrarily; they must remain visible to the relevant task reviewer and the final whole-branch reviewer.

| Source | Deferred item | Required handling |
|---|---|---|
| Task 1 | Provider-selection precedence test uses the same provider id on both sides. | Task 6 should strengthen the migration/final canonical-plane test with distinct provider ids while already changing these tests. |
| Task 2 | `discoverModels(..., { signal })` does not cancel an in-flight provider probe. | Task 6 reviewer must assess discovery cancellation. Fix in Task 6 only if the provider-runtime/probe interfaces are already touched; otherwise retain for final review. |
| Task 3 | `closeSession()`/`close()` lacks a gated in-flight model-binding regression. | Tasks 11 or 12 touch `SessionService`; add the focused race regression if the lifecycle path is modified, otherwise retain for final review. |
| Task 4 | Production comments still describe a removed mock fallback. | Remove stale wording in the first task touching each file, and include the final production-honesty scan in Task 15. |
| Task 4 | `BackendClient` create/fork/set-model methods are mandatory although the spec describes optional capability shape. | Tasks 11-13 already extend SDK/backend capability negotiation. Their reviewers must require either optional capability-gated methods or a ledgered spec-based ruling that proves mandatory methods are intentional. |

Task 5 has no deferred finding.

Existing scope/security rulings in the ledger remain binding history. Do not delete or rewrite them. The final response must extract every `Ruling:` line from the ledger before the SDD workspace is deleted.

---

### Task 6: Typed Settings And Models/Providers Flow

**Brief:** `.superpowers/sdd/2026-09-06-m49-grok-tui-parity/task-6-brief.md`

**Consumes:** Task 2 `ProviderRuntime`; Task 4 backend `setSessionModel`; Task 5 Welcome model gate.

**Produces:** `SettingsCategory`, `SettingDefinition`, `SettingsController`, and a UI-only `ProviderController`. Finalizes `SettingsTui` as presentation preferences only and removes the legacy TUI provider/model builder plane.

**Critical acceptance behavior:**

- Eight typed settings categories; empty or unavailable-only categories are hidden.
- Boolean, enum, integer, string, action, and dynamic-list rows.
- Preview, commit, rollback-on-failure, and exact `Applies to new sessions` label.
- Models & Providers master/detail over real provider templates and configured providers.
- API key text is written only to `CredentialStore`; settings retain only the credential ref.
- Discovery uses `ProviderRuntime`; failed discovery preserves stored models and displays attempts.
- Manual model add validates non-empty id and positive capacities.
- Default model writes `llm.defaultModel`; active-session model selection calls backend idle-rebind semantics.
- No OAuth/login action is visible because no OAuth backend exists.
- Case 021 ends with a real injected-client response, not a mock fallback.
- Delete `ProviderStore`, `createTuiModelBuilder`, and legacy provider writers/types after migration tests prove old files still load.

- [ ] Run the RED commands from the brief before product edits.
- [ ] Implement Steps 4-6 exactly as defined in the brief.
- [ ] Strengthen the Task 1 precedence test with distinct provider ids.
- [ ] Run the legacy-plane scan and inspect every remaining match.
- [ ] Run the complete GREEN gate:

```powershell
pnpm --filter @i-harness/settings test
pnpm --filter @i-harness/settings typecheck
pnpm --filter @i-harness/provider-runtime test
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui typecheck
```

- [ ] Commit:

```powershell
git add packages/settings packages/tui pnpm-lock.yaml
git commit -m "feat(m49): add typed provider and settings flows"
```

**Review focus:** raw-secret lifetime, settings rollback, canonical persistence, Bedrock ambient auth, full `modelsURL` behavior, capability-gated session rebinding, and absence of fake OAuth.

---

### Task 7: Grapheme-Safe Prompt Editor And Visible Cursor

**Brief:** `.superpowers/sdd/2026-09-06-m49-grok-tui-parity/task-7-brief.md`

**Consumes:** Task 5 Welcome/Agent prompt ownership and overlay precedence.

**Produces:** `PromptEditor`, atomic `PromptPaste`, `CursorTarget`, and renderer cursor transitions. Replaces direct UTF-16 prompt mutation.

**Critical acceptance behavior:**

- Grapheme operations preserve emoji, combining marks, ZWJ families, CJK, and multiline text.
- All insert/delete/newline/history/stash/mouse/external-editor replacements route through `PromptEditor`.
- Undo coalesces adjacent printable input until movement, paste, newline, delete, submit, or a 500ms gap.
- Left/right, word movement, home/end, select-all, undo, redo, Shift+Enter, and persisted busy-Enter behavior are real.
- Prompt render returns exact wrapped cursor geometry.
- Cursor hides for disabled prompt, modal/viewer, selection drag, unfocused app, and shutdown.
- An unchanged frame emits zero cursor bytes.
- Case 025 covers input, resizing, modal visibility, and cursor bytes without depending on blink phase.

- [ ] Run the brief's RED editor and cursor tests.
- [ ] Implement editor transactions before replacing loop call sites.
- [ ] Add case 025 and prove zero-byte idle.
- [ ] Run the complete GREEN gate:

```powershell
pnpm --filter @i-harness/tui-core test
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui exec vitest run test/harness/case-025.test.ts
pnpm --filter @i-harness/tui-core typecheck
pnpm --filter @i-harness/tui typecheck
```

- [ ] Commit:

```powershell
git add packages/tui-core packages/tui
git commit -m "feat(m49): add full prompt editing and visible cursor"
```

**Review focus:** code-unit versus display-cell offsets, atomic paste source/display separation, cursor transition ordering after cell flush, overlay input precedence, and idle bytes.

---

### Task 8: Production Minimal Mode And Theme Persistence

**Brief:** `.superpowers/sdd/2026-09-06-m49-grok-tui-parity/task-8-brief.md`

**Consumes:** Task 6 typed settings and Task 7 prompt/cursor rendering.

**Produces:** `SettingsTheme = system | grok-night | grok-day | tokyo-night | rose-pine-moon | oscura-midnight`, persisted `tui.prefs.screenMode`, and separate production fullscreen/minimal terminal startup.

**Critical acceptance behavior:**

- Legacy `light` and `dark` normalize to `grok-day` and `grok-night`.
- Tokyo Night, Rose Pine Moon, and Oscura Midnight use semantic palette fields and existing color quantizers.
- Low-color terminals expose only system, Grok Night, and Grok Day.
- `/theme` and Settings share preview/commit/rollback.
- Explicit screen-mode flag wins over persisted mode.
- Minimal mode emits neither alternate-screen nor mouse-enable sequences.
- Minimal modal/viewer chrome is embedded and borderless.
- Inline-engine failure warns once, falls back to fullscreen, and does not rewrite the persisted choice.

- [ ] Run theme/settings/minimal RED tests from the brief.
- [ ] Add palettes and the unified resolver.
- [ ] Split executable startup by resolved screen mode.
- [ ] Run the complete GREEN gate:

```powershell
pnpm --filter @i-harness/settings test
pnpm --filter @i-harness/tui-core test
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui-app test
pnpm --filter @i-harness/tui exec vitest run test/harness/case-015.test.ts
```

- [ ] Commit:

```powershell
git add apps/tui packages/settings packages/tui-core packages/tui
git commit -m "feat(m49): align themes and production minimal mode"
```

**Review focus:** startup byte stream, palette contrast after 256/16/mono quantization, persistence precedence, and fullscreen fallback semantics.

---

### Task 9: Structured Text Diff And Fs Change Results

**Brief:** `.superpowers/sdd/2026-09-06-m49-grok-tui-parity/task-9-brief.md`

**Consumes:** Existing `fs` pre/post images and patch parser.

**Produces:** New `@i-harness/text-diff` package with `DiffLine`, `DiffHunk`, `TextDiff`, `createTextDiff()`, and `renderUnifiedDiff()`. Extends write/edit/apply-patch results with optional structured changes for Task 10.

**Critical acceptance behavior:**

- Use the proven `diff` dependency; do not hand-roll LCS/Myers.
- Default context is 3.
- Added/deleted counts and literal old/new line numbers are computed from structured rows.
- Inputs over 2 MiB per side or 50,000 lines use bounded head/tail windows and set `truncated: true`.
- No-op edits return empty hunks and zero counts.
- Reuse the pre-image already read by fs operations; do not add another unbounded read.
- Preserve existing result fields; retain `rawPatch` when apply-patch cannot produce pre/post images.

- [ ] Scaffold package and add `diff`.
- [ ] Run text-diff/fs RED tests before implementation.
- [ ] Implement structured adapter and attach compatible fs fields.
- [ ] Run the complete GREEN gate:

```powershell
pnpm --filter @i-harness/text-diff test
pnpm --filter @i-harness/text-diff typecheck
pnpm --filter @i-harness/fs test
pnpm --filter @i-harness/fs typecheck
```

- [ ] Commit:

```powershell
git add packages/text-diff packages/fs packages/tui/package.json pnpm-lock.yaml
git commit -m "feat(m49): add structured file diffs"
```

**Review focus:** bounded memory, newline/line-number correctness, no-op behavior, package dependency direction, and backwards-compatible fs results.

---

### Task 10: Typed Tool Blocks, Viewer, Clipboard, And Bridges

**Brief:** `.superpowers/sdd/2026-09-06-m49-grok-tui-parity/task-10-brief.md`

**Consumes:** Task 9 `TextDiff`; Task 7 input/cursor ownership.

**Produces:** Typed `TuiToolEvent`, recursive redaction, `ToolPresentation`, one active modal/viewer owner, real clipboard/file viewing, and production approval/question bridges.

**Critical acceptance behavior:**

- Preserve structured tool args, results, and progress through embedded and remote backends.
- Recursively redact authorization, API key, bearer, password, and equivalent secret fields.
- Dedicated formatters cover execute, read, edit/write/apply-patch, list, search, web, MCP, skill, subagent/task/job, todo, and generic tools.
- Out-of-order tool completion before base call is retained and reconciled.
- Viewer supports rendered/raw, search next/previous, scrolling, selection, and copy.
- Line viewer reads the real file and exact line.
- Clipboard failures display the error and never claim `Copied!`.
- Hit areas exist only when a real callback exists.
- Production approvals/questions attach to every production assembly and remain fail-closed without a UI provider.
- Case 026 runs fake-model decisions through real fs/shell tools and proves no secret appears.

- [ ] Run mapper/presentation/viewer/bridge RED tests from the brief.
- [ ] Implement typed presentation and modal/viewer ownership.
- [ ] Add case 026.
- [ ] Run the complete GREEN gate:

```powershell
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui-app test
pnpm --filter @i-harness/tui exec vitest run test/harness/case-026.test.ts
pnpm --filter @i-harness/tui typecheck
pnpm --filter @i-harness/tui-app typecheck
```

- [ ] Commit:

```powershell
git add apps/tui packages/tui
git commit -m "feat(m49): render typed tools and real viewers"
```

**Review focus:** secret leakage, update-before-call ordering, one active input owner, real versus fabricated actions, clipboard error truthfulness, and PTY raw/rendered transitions.

---

### Task 11: Real Session Queue Projection And Cancellation

**Brief:** `.superpowers/sdd/2026-09-06-m49-grok-tui-parity/task-11-brief.md`

**Consumes:** Existing per-session pacing/lane behavior and Task 4 SDK capabilities.

**Produces:** `SessionQueueItem`, `SessionService.queue(sessionId)`, `cancelQueued(sessionId, id)`, and SDK capability `session-queue`.

**Critical acceptance behavior:**

- Stable public queue id exists before the prompt enters the pacing chain.
- Running row is followed by FIFO queued rows.
- Cancellation links caller/service controllers, settles submit without execution, and removes each record exactly once.
- Service-front and lane pending records merge by public id.
- SDK methods are `session/queue` and `session/queue/cancel`.
- Remote backend omits unavailable queue/cancel actions.
- Queue pane shows real rows or exact `Queue is empty.`.
- Cancel appears only for queued, cancellable rows.
- No fake shell/cron rows and no Send now action without an atomic promote backend.
- Keyboard and mouse call the same cancellation action and refresh backend truth.

- [ ] Run lane/service/SDK/TUI RED tests from the brief.
- [ ] Implement stable records, wire SDK/backend, and replace fixture-only pane behavior.
- [ ] Revisit the Task 3 in-flight close regression if lifecycle code changes.
- [ ] Reconcile Task 4's mandatory `BackendClient` methods with optional capability shape while changing backend contracts.
- [ ] Run the complete GREEN gate:

```powershell
pnpm --filter @i-harness/core-agent test
pnpm --filter @i-harness/session-executor test
pnpm --filter @i-harness/sdk test
pnpm --filter @i-harness/tui test
```

- [ ] Commit:

```powershell
git add packages/core-agent packages/session-executor packages/sdk packages/tui
git commit -m "feat(m49): expose and control the real prompt queue"
```

**Review focus:** cancellation races, exactly-once settlement/removal, FIFO/order stability, capability absence, and no UI-derived queue truth.

---

### Task 12: Subagent/Job Task Projection And Detail Viewer

**Brief:** `.superpowers/sdd/2026-09-06-m49-grok-tui-parity/task-12-brief.md`

**Consumes:** Real subagent/job registries, Task 10 viewer, and Task 11 capability conventions.

**Produces:** `AgentTaskView`, `projectAgentTasks()`, `SessionAssembly.tasks()`, `SessionService.tasks(sessionId)`, `cancelTask(sessionId, id)`, and SDK capability `session-tasks`.

**Critical acceptance behavior:**

- Stable ids come from real agent/job ids, never array position.
- Status mapping preserves running/waiting/completed/failed/cancelled.
- Compact rows keep detail payloads for role/model/parent prompt/result/error/transcript availability.
- Workflow jobs appear only when the assembly owns their executor; schedules appear only with a mounted source.
- `canCancel` derives from registry state.
- SDK methods are `session/tasks` and `session/tasks/cancel`.
- Remote backend omits task/cancel actions without capability.
- `/tasks` shows real groups or exact `No active tasks.`.
- Selection survives refresh by id; group collapse/expand and Enter detail viewer work.
- Stop/kill is visible only for a cancellable row and real backend capability.

- [ ] Run projection/service/SDK/TUI RED tests from the brief.
- [ ] Implement projection at the domain boundary before UI mapping.
- [ ] Add service/SDK/backend methods and the detail viewer.
- [ ] Add the Task 3 in-flight close regression here if Task 11 did not resolve it and this task changes the same lifecycle.
- [ ] Run the complete GREEN gate:

```powershell
pnpm --filter @i-harness/subagent test
pnpm --filter @i-harness/session-executor test
pnpm --filter @i-harness/sdk test
pnpm --filter @i-harness/tui test
```

- [ ] Commit:

```powershell
git add packages/subagent packages/session-executor packages/sdk packages/tui
git commit -m "feat(m49): project live tasks and subagents into TUI"
```

**Review focus:** registry encapsulation, ownership of workflow/schedule rows, recovered-state honesty, cancellation authority, transcript availability, and stable selection.

---

### Task 13: Local Dashboard And Truthful Status Line

**Brief:** `.superpowers/sdd/2026-09-06-m49-grok-tui-parity/task-13-brief.md`

**Consumes:** Real model, session, queue, and task projections from Tasks 4, 11, and 12.

**Produces:** `DashboardSessionRow`, `DashboardState`, SDK capability `session-dashboard`, and injected `StatusSource` with an optional command runner.

**Critical acceptance behavior:**

- Dashboard rows come from session list plus known live model/queue/task fields.
- Filter, keyboard/mouse selection, open/resume, create, tail peek, pin, and order are real.
- Selection remains stable by session id across refresh.
- Persist only pinned/order ids under `tui.prefs.dashboard`.
- No dashboard database, remote team rows, fabricated cost, or cross-machine state.
- SDK method is `session/dashboard`; remote action is absent without capability.
- Builtin status segments use only known cwd/branch/model/context/timer/session/queue/tasks/todo/goal values.
- Unknown segments are omitted; low-priority rightmost segments drop before truncation.
- Command status uses `@i-harness/exec`, workspace cwd, JSON stdin, 1000ms timeout, first non-empty line, 4096-byte cap, and control-code sanitization.
- Refresh interval is at least 300ms and never blocks draw.
- Case 027 proves dashboard, queue, task, cancellation, count refresh, and stable selection.

- [ ] Run dashboard/status/SDK/settings RED tests from the brief.
- [ ] Implement local state/view, SDK capability, and status source.
- [ ] Add case 027.
- [ ] Finish optional-capability cleanup left from Task 4 while touching SDK/backend negotiation.
- [ ] Run the complete GREEN gate:

```powershell
pnpm --filter @i-harness/settings test
pnpm --filter @i-harness/sdk test
pnpm --filter @i-harness/tui test
pnpm --filter @i-harness/tui-app test
pnpm --filter @i-harness/tui exec vitest run test/harness/case-027.test.ts
```

- [ ] Commit:

```powershell
git add apps/tui packages/settings packages/sdk packages/tui pnpm-lock.yaml
git commit -m "feat(m49): add local dashboard and truthful status"
```

**Review focus:** authoritative local rows, capability absence, command timeout/output bounds, control-code sanitization, refresh nonblocking behavior, and no invented status values.

---

### Task 14: Capability-Gated Slash Commands And Agent Prompts

**Brief:** `.superpowers/sdd/2026-09-06-m49-grok-tui-parity/task-14-brief.md`

**Consumes:** Every real TUI/backend capability delivered by Tasks 6-13.

**Produces:** Typed `SlashCapability`, non-LLM unsupported-command path, `DEFAULT_AGENT_PRESET`, subagent prompt fragments, and runtime mouse reporting transitions.

**Critical acceptance behavior:**

- Registry lists only commands backed by present capabilities.
- Account, billing, privacy, delete, cd, memory, voice, and media commands are not registered as executable.
- Unknown/hidden slash parsing happens before user-message append and emits exact `Unsupported command: /<name>`.
- `/help` is generated from the visible registry and active key bindings.
- `/usage` is explicitly local context/session usage.
- Plugin/MCP/hook views distinguish configured, mounted, failed, and unavailable.
- Required command argument validation covers model, effort, rename, fork, compact, find, jump, workflow, and theme.
- Default system prompt is I-harness-owned, readable, and contains repository-first work, approvals/sandbox, debugging, TDD, verification, subagent ownership, progress, and honest capability reporting.
- Explicit preset override remains authoritative; no copied Grok wording.
- Subagent prompt carries scope, no recursive delegation unless supported, changed-file/test reporting, and result delivery.
- Mouse reporting emits bytes only on transitions, clears interaction state when disabled, and remains off in Minimal.
- Final input precedence is confirm/permission/question -> viewer -> modal -> pane -> prompt -> scrollback.

- [ ] Run slash/preset/session/subagent/terminal RED tests from the brief.
- [ ] Implement command inventory and real command wiring.
- [ ] Implement default and subagent prompts.
- [ ] Implement mouse capture transitions and final input precedence.
- [ ] Remove stale production mock-fallback comments in touched files.
- [ ] Run the complete GREEN gate:

```powershell
pnpm --filter @i-harness/preset test
pnpm --filter @i-harness/subagent test
pnpm --filter @i-harness/session-executor test
pnpm --filter @i-harness/tui-core test
pnpm --filter @i-harness/tui test
```

- [ ] Commit:

```powershell
git add packages/preset packages/subagent packages/session-executor packages/tui-core packages/tui
git commit -m "feat(m49): gate commands and align agent prompts"
```

**Review focus:** unsupported commands never reach the model, visible inventory equals capability inventory, explicit preset precedence, no fake account flows, and terminal mouse byte transitions.

---

### Task 15: PTY Parity, Documentation, And Delivery Verification

**Brief:** `.superpowers/sdd/2026-09-06-m49-grok-tui-parity/task-15-brief.md`

**Consumes:** Tasks 1-14.

**Produces:** Case 028 integrated parity proof, truthful documentation, complete distribution verification, and the final whole-branch review record. It adds no new product behavior except test-first fixes exposed by integration.

**Critical acceptance behavior:**

- Case 028 starts with a persisted real provider/model in Minimal.
- Minimal proves no alternate-screen or mouse-enable bytes.
- Fullscreen transition, every terminal-supported theme, persistence, and mouse disable/enable bytes are exercised.
- Settings, Dashboard, Queue, Tasks, tool viewer, file viewer, and Help all prove input precedence and Esc unwinding.
- Unsupported `/login` produces the exact message and zero backend submissions.
- Restart preserves theme/screen/status settings and displays the real binding label.
- Documentation supersedes M46 mock/provider-plane claims and states exact supported/omitted behavior.
- Docs do not claim OAuth login, billing, deletion, cross-machine dashboard, or unavailable discovery.

- [ ] Write case 028 before integration fixes and verify the intended RED failures.
- [ ] Fix only case-028 integration defects, each behind the smallest owning-package failing test.
- [ ] Run all focused package gates from Task 15 Step 4.
- [ ] Run every PTY parity case separately as listed in Task 15 Step 5.
- [ ] Record actual exit codes. A truncated console log is not evidence.
- [ ] Treat the known older-case Windows `node-pty AttachConsole failed` helper output as diagnostic noise only when the owning Vitest command exits 0; do not use it to excuse a failing or hung case. `case-024` should remain clean.
- [ ] Update README, capability docs, research inventory, spec, and full plan.
- [ ] Run repository and distribution verification:

```powershell
pnpm typecheck
pnpm test
pnpm e2e
node scripts/build-dist.mjs
node scripts/verify-dist.mjs
node scripts/build-installer.mjs
node scripts/verify-installer.mjs
git diff --check
git status --short --branch
```

- [ ] Run production-honesty scans:

```powershell
rg -n "falling back to the mock|mock-model|No model.*mock|SETTINGS_NOT_AVAILABLE|SETTINGS_MOUSE_PLACEHOLDER" apps packages -g '*.ts'
rg -n "tui\.providers|SettingsTuiProvider|createTuiModelBuilder|ProviderStore" apps packages -g '*.ts'
rg -n 'name: "(login|logout|share|privacy|delete|cd|remember|recap|voice|imagine|imagine-video)"' packages/tui/src/app/slash -g '*.ts'
```

- [ ] Inspect every remaining scan match. Intentional migration/test strings are documented; production implementation hits are fixed before delivery.
- [ ] Commit integration and docs:

```powershell
git add -u -- apps packages
git add README.md docs packages/tui/test/harness
git commit -m "docs(m49): close Grok TUI parity delivery"
```

**Review focus:** continuous executable behavior, persistence across restart, zero fabricated capability, no secret exposure, no mock production path, PTY byte invariants, complete docs, and reproducible distribution artifacts.

---

## Final Whole-Branch Gate

After Task 15's task review is clean:

- [ ] Determine the actual target-branch merge base:

```powershell
$mergeBase = git merge-base main HEAD
```

If the target branch is not `main`, substitute the user-named target. Never use a guessed commit count.

- [ ] Generate one whole-branch review package:

```powershell
$plan = 'docs/superpowers/plans/2026-09-06-m49-grok-tui-parity.md'
$head = git rev-parse HEAD
& 'C:\Program Files\Git\bin\bash.exe' 'C:/Users/inkik/.codex/plugins/cache/openai-curated-remote/superpowers/6.3.0/skills/subagent-driven-development/scripts/review-package' $plan $mergeBase $head
```

- [ ] Dispatch the most capable available final reviewer using `superpowers:requesting-code-review`.
- [ ] Give it the deferred-minor and parked-finding lines from the ledger.
- [ ] If findings exist, dispatch one fix implementer with the complete list.
- [ ] Generate exactly one scoped re-review package for that fix wave.
- [ ] Adjudicate residual findings with explicit ledger rulings; do not silently discard them.
- [ ] Re-run verification commands that cover every final-review fix.
- [ ] Extract every ledger line containing `Ruling:` into the user-facing delivery report, in order, including the cost if wrong.
- [ ] Only after final review and verification are clean, use `superpowers:finishing-a-development-branch` to present integration choices.
- [ ] Do not merge or push until the user explicitly selects that action.

## Completion Definition

M49 is complete only when all conditions are true:

- Tasks 6-15 each have an implementation report, task review, ledger completion line, and committed code.
- All Critical and Important findings are fixed or have reached the five-round breaker and received explicit rulings.
- Every deferred Minor has been presented to the final reviewer.
- Package, PTY, repository, e2e, distribution, installer, honesty-scan, and git-hygiene gates have fresh recorded evidence.
- Final whole-branch review and its single scoped re-review are resolved.
- The worktree contains no untracked generated output.
- Documentation describes only real I-harness capabilities.

## Copy-Paste Handoff Prompt

Use this prompt to start the controller agent:

```text
Continue M49 in D:\I-harness-main\.worktrees\m49 on branch m49. Tasks 1-5 are complete; do not re-dispatch them. Read, in order:

1. docs/superpowers/specs/2026-09-06-m49-grok-tui-parity-design.md
2. docs/superpowers/plans/2026-09-06-m49-grok-tui-parity.md
3. docs/superpowers/plans/2026-09-06-m49-remaining-tasks-execution.md
4. .superpowers/sdd/2026-09-06-m49-grok-tui-parity/progress.md

Use superpowers:using-superpowers, superpowers:using-git-worktrees, and superpowers:subagent-driven-development. Verify the linked m49 worktree and clean status, then resume at the first task without a "Task N: complete" ledger line, expected Task 6. Use the existing task-N-brief.md files. Execute Tasks 6-15 sequentially: one fresh implementer, report, immutable review package, fresh task reviewer, and reviewed fix loops. Never run parallel implementation agents, never let workers dispatch subagents, never touch the main checkout, and never merge/push/publish without explicit user approval. Preserve every Ruling and deferred finding in the ledger. Continue through Task 15, whole-branch review, verification, and finishing-a-development-branch.
```
