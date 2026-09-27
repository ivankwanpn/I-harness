# Desktop conversation work state

## Problem

The backend already persists `todo/write` whole-list snapshots and `goal/change` whole-goal snapshots. Desktop currently renders only generic timeline activity labels for both. Queue and subagent tasks appear in the right **任務** pane, but the current Todo list and goal are not readable there. A projection from the bounded timeline window would lose older snapshots in long conversations.

## Contract

- A selected conversation can read its authoritative Todo list and goal without a model call. A cold saved conversation works too. The Desktop gateway uses the existing `@i-harness/todo` and `@i-harness/goal` folds over the complete live or loaded session log; it does not add another state store or mutation path.
- `desktop/session/work-state` takes one validated `sessionId` and returns `{ todos: TodoItem[] | null, goal: GoalView | null }`. `null` Todos means no `todo/write` snapshot; `[]` means the Agent explicitly cleared the list. The capability is advertised only when the handler is wired.
- The renderer asks through its known workspace and session IPC boundary. Initial load and a new `todo/write` or `goal/change` event refresh the state. Selection changes and overlapping reads cannot replace a newer state. A read error remains visible; it is never rendered as an empty list.
- The existing **任務** pane presents the current Todo progress and items above queue/subagent tasks. Long lists use a bounded focus page around the in-progress or first unfinished item, with controls to reach the remainder. Item order and status are preserved. A compact goal banner above the conversation shows the objective and the actual active/paused/complete phase. These are read-only because the owning Agent tools perform mutations.
- No claim is made about planning rounds, provider usage, paid model calls, or a background scheduler. The display is session-local.

## Constraints and verification

- Work in `D:\frontend-test` only, never stage the user-edited `packages/desktop/electron.vite.config.ts`, never push GitHub, and use `D:\agent-complete\playground` for interactive filesystem/model tests.
- Provider account usage/reset/OAuth remains deferred. Do not create a browser-control or shortcut/data-statistics settings page.
- Gateway tests cover cold/no-model reads, last-wins Todo, explicit clearing, and goal transitions. Desktop tests cover scoped IPC, live refresh, long-list navigation, goal phases, and no-state/error distinctions. Packaged Electron receives a real session state in playground for visual QA, then leaves no active test session. Run affected suites, full gates, typecheck and local package.
