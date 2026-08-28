# M19 Subagent Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@i-harness/agent-team` — a named durable Coordinator subagent roster + shared mailbox + CAS task board + edge-wait coordination domain on top of `@i-harness/subagent`, mounted via `HeadlessOptions.team`.

**Architecture:** New package event-sourced on the Lead session log (`team/member`, `team/task`, `team/message/queued`, `team/message/delivered`; version 1), folded incrementally (seq watermark) into memory state; per-team promise-chain transact for read-check-append atomicity; 10 model-facing tools (dsh full set) with Lead-only authority for spawn/interrupt; small core-session + session-persistence changes for the new event types; subagent package untouched (reuses its durable child + followup engine).

**Tech Stack:** TypeScript strict ESM (pnpm workspaces, vitest), zod (already present), node:child_process (via subagent), node:crypto (uuid). Zero new external dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-i-harness-m19-subagent-teams-design.md`

## Global Constraints

- No dsh/codex private packages (`@deepseek-ai/*`). Hand-written team domain; zod (already present). **Zero new external deps.**
- ESM + strict TS (`noUnusedLocals`, `noUnusedParameters`); tests under `test/*.test.ts` per package; vitest. New package 0.1.0; no version bumps.
- New event types are **exactly the 4 M19 ones** (team/member, team/task, team/message/queued, team/message/delivered; version: 1), registered via the new `registerEventType` (or minimal Set addition); `CURRENT_FORMAT_VERSION` stays 1.
- Positions/timing: no session event types beyond the 4; no `CURRENT_FORMAT_VERSION` change.
- Fail-closed: mount failure throws; invariant violations never enter the log (throw before append); teardown bounded; single team per run (second mount throws).
- Behavior unchanged when no `team` configured.
- Single process, single shared checkout; advisory write scopes (not locks).
- **Do NOT modify** the subagent 11-tool contract or M6 snapshot format.
- Domain-specific: names `^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64 chars, never reused (incl. failed); `lead` reserved. Task ids `task-<uuid>`, revision 1-based CAS. Mailbox queued→delivered ack; delivered only after target session holds the message id. waitMinMs 10_000 / waitMaxMs 3_600_000 / waitDefaultMs 30_000.
- M17/M18 infra available (mount handle pattern, unified reverse unmount in run.ts).

---

### Task 1: package scaffold + `agent-path.ts` + `types.ts` — TDD

**Files:**
- Create: `packages/agent-team/package.json`
- Create: `packages/agent-team/tsconfig.json`
- Create: `packages/agent-team/src/agent-path.ts`
- Create: `packages/agent-team/src/types.ts`
- Create: `packages/agent-team/src/index.ts` (placeholder exports)
- Create: `packages/agent-team/test/agent-path.test.ts`
- Create: `packages/agent-team/test/types.test.ts`

**Interfaces:**
- Consumes: nothing (builtins + zod).
- Produces (used by Tasks 2-10): `AgentPath` class, `TeamConfig` + `validateTeamConfig`, all `Team*Snapshot`/`Team*View` types, `TeamEvent` union for the 4 team events, `TeamError` + `TEAM_*` codes.

- [x] **Step 1: Create the package scaffold**

`packages/agent-team/package.json`:

```json
{
  "name": "@i-harness/agent-team",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@i-harness/core-plugin": "workspace:*",
    "@i-harness/core-tools": "workspace:*",
    "@i-harness/core-session": "workspace:*",
    "@i-harness/session-persistence": "workspace:*",
    "@i-harness/subagent": "workspace:*",
    "zod": "^4.4.3"
  }
}
```

`packages/agent-team/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Then `pnpm install` at repo root.

- [x] **Step 2: Write the failing tests**

`packages/agent-team/test/agent-path.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { AgentPath } from "../src/index.ts"

describe("AgentPath", () => {
  it("root is 'lead'; parse validates kebab-case segments", () => {
    expect(AgentPath.root().toString()).toBe("lead")
    expect(AgentPath.parse("lead/helper").toString()).toBe("lead/helper")
    expect(AgentPath.parse("lead/my-helper-2").toString()).toBe("lead/my-helper-2")
  })

  it("rejects invalid names and reserved words", () => {
    expect(() => AgentPath.parse("lead/Bad")).toThrow()
    expect(() => AgentPath.parse("lead/bad_name")).toThrow()
    expect(() => AgentPath.parse("lead/..")).toThrow()
    expect(() => AgentPath.parse("lead/..")).toThrow()
    expect(() => AgentPath.parse("lead/lead")).toThrow()
    expect(() => AgentPath.parse("helper")).toThrow() // must be lead-prefixed
  })

  it("join and resolve relative/absolute", () => {
    const p = AgentPath.parse("lead/helper")
    expect(p.join("child").toString()).toBe("lead/helper/child")
    expect(p.resolve("sibling").toString()).toBe("lead/helper/sibling")
    expect(p.resolve("lead/abs").toString()).toBe("lead/abs")
  })

  it("name and isRoot", () => {
    expect(AgentPath.root().isRoot()).toBe(true)
    expect(AgentPath.parse("lead/helper").isRoot()).toBe(false)
    expect(AgentPath.parse("lead/helper").name()).toBe("helper")
  })
})
```

`packages/agent-team/test/types.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { validateTeamConfig } from "../src/index.ts"

describe("validateTeamConfig", () => {
  it("accepts defaults and rejects bad bounds", () => {
    expect(() => validateTeamConfig({})).not.toThrow()
    expect(() => validateTeamConfig({ maxMembers: 4 })).not.toThrow()
    expect(() => validateTeamConfig({ maxMembers: 0 })).toThrow()
    expect(() => validateTeamConfig({ maxTasks: -1 })).toThrow()
    expect(() => validateTeamConfig({ maxMessageBytes: 1.5 })).toThrow()
    expect(() => validateTeamConfig({ waitMinMs: 5_000 })).toThrow() // < 10_000
  })
})
```

- [x] **Step 3: Run the test to verify it fails**

Run: `cd packages/agent-team && pnpm test`
Expected: FAIL — module not found (`../src/index.ts` has no exports).

- [x] **Step 4: Implement agent-path.ts + types.ts + index.ts**

`packages/agent-team/src/agent-path.ts`:

```ts
// Team-internal path addressing (codex AgentPath pattern adapted to the
// i-harness team convention: root is `lead`, teammates are `lead/<name>`).
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const LEAD_NAME = "lead"

export class AgentPath {
  private constructor(private readonly segments: string[]) {}

  static root(): AgentPath {
    return new AgentPath([LEAD_NAME])
  }
  static parse(s: string): AgentPath {
    const segments = s.split("/")
    if (segments.length < 1 || segments[0] !== LEAD_NAME) {
      throw new Error(`agent-team: path must be lead-prefixed (got "${s}")`)
    }
    for (const seg of segments) {
      if (seg === LEAD_NAME && segments.length > 1) throw new Error(`agent-team: "lead" is reserved (got "${s}")`)
      if (!NAME_RE.test(seg)) throw new Error(`agent-team: invalid path segment "${seg}" (expected ^[a-z0-9]+(-[a-z0-9]+)*$)`)
    }
    return new AgentPath(segments)
  }
  toString(): string {
    return this.segments.join("/")
  }
  isRoot(): boolean {
    return this.segments.length === 1
  }
  name(): string {
    return this.segments[this.segments.length - 1]
  }
  join(name: string): AgentPath {
    return AgentPath.parse(`${this.toString()}/${name}`)
  }
  resolve(ref: string): AgentPath {
    if (ref.startsWith("lead/")) return AgentPath.parse(ref)
    return AgentPath.parse(`${this.toString()}/${ref}`)
  }
}
```

`packages/agent-team/src/types.ts`:

```ts
import { z } from "zod"

export interface TeamConfig {
  maxMembers?: number                    // default 8 (incl. ever-provisioned failed)
  maxTasks?: number                      // default 256 (non-deleted only)
  maxPendingMessagesPerMember?: number   // default 64
  maxMessageBytes?: number               // default 65536 (incl. framing)
  startupTimeoutMs?: number              // default 10_000
  waitMinMs?: number                     // default 10_000
  waitMaxMs?: number                     // default 3_600_000
  waitDefaultMs?: number                 // default 30_000
}

const POSITIVE_INT = z.number().int().positive()
export function validateTeamConfig(config: TeamConfig): void {
  const bounds: [string, number][] = [
    ["maxMembers", config.maxMembers ?? 8], ["maxTasks", config.maxTasks ?? 256],
    ["maxPendingMessagesPerMember", config.maxPendingMessagesPerMember ?? 64],
    ["maxMessageBytes", config.maxMessageBytes ?? 65_536],
    ["startupTimeoutMs", config.startupTimeoutMs ?? 10_000],
    ["waitMinMs", config.waitMinMs ?? 10_000], ["waitMaxMs", config.waitMaxMs ?? 3_600_000],
    ["waitDefaultMs", config.waitDefaultMs ?? 30_000],
  ]
  for (const [k, v] of bounds) {
    const r = POSITIVE_INT.safeParse(v)
    if (!r.success) throw new Error(`agent-team: ${k} must be a positive integer (got ${v})`)
  }
  if ((config.waitMinMs ?? 10_000) < 10_000) throw new Error("agent-team: waitMinMs must be >= 10000")
  if ((config.waitMaxMs ?? 3_600_000) > 3_600_000) throw new Error("agent-team: waitMaxMs must be <= 3600000")
}

export type TeamMemberPhase = "provisioning" | "active" | "failed"
export interface TeamMemberSnapshot {
  id: string; name: string; description: string
  provider: string; context: "fresh" | "fork"
  phase: TeamMemberPhase; error?: string
}
export interface TeamMemberView {
  id: string; name: string; role: "lead" | "teammate"
  status: "running" | "idle" | "inactive" | "provisioning" | "failed"
  description?: string; context?: "fresh" | "fork"; diagnostics: string[]
}
export type TeamTaskStatus = "pending" | "in_progress" | "completed" | "deleted"
export interface TeamTaskSnapshot {
  id: string; revision: number; subject: string; description: string
  status: TeamTaskStatus; ownerId?: string
  blockedBy: string[]; writeScopes: string[]
}
export interface TeamTaskView extends TeamTaskSnapshot {
  ownerName?: string; ready: boolean; writeScopeWarnings: string[]
}
export interface TeamMessageSnapshot {
  id: string; senderId: string; senderName: string
  targetId: string; delivery: "quiet" | "wakeup"; content: string
}
export type TeamEvent =
  | { type: "team/member"; version: 1; teamId: string; member: TeamMemberSnapshot }
  | { type: "team/task"; version: 1; teamId: string; task: TeamTaskSnapshot }
  | { type: "team/message/queued"; version: 1; teamId: string; message: TeamMessageSnapshot }
  | { type: "team/message/delivered"; version: 1; teamId: string; messageId: string; targetId: string }

export class TeamError extends Error {
  constructor(readonly code: string, message: string) {
    super(`agent-team: ${code}: ${message}`)
    this.name = "TeamError"
  }
}
export const TEAM_CODES = {
  INVALID_CONFIG: "TEAM_INVALID_CONFIG", DISPOSED: "TEAM_DISPOSED",
  NOT_MEMBER: "TEAM_NOT_MEMBER", MEMBER_NOT_FOUND: "TEAM_MEMBER_NOT_FOUND",
  MEMBER_NAME_TAKEN: "TEAM_MEMBER_NAME_TAKEN", MEMBER_LIMIT: "TEAM_MEMBER_LIMIT",
  INVALID_MEMBER_NAME: "TEAM_INVALID_MEMBER_NAME", LEAD_REQUIRED: "TEAM_LEAD_REQUIRED",
  PROVISIONING_CONFLICT: "TEAM_PROVISIONING_CONFLICT",
  SELF_MESSAGE: "TEAM_SELF_MESSAGE", MAILBOX_FULL: "TEAM_MAILBOX_FULL",
  MESSAGE_TOO_LARGE: "TEAM_MESSAGE_TOO_LARGE",
  TASK_NOT_FOUND: "TEAM_TASK_NOT_FOUND", TASK_STALE_REVISION: "TEAM_TASK_STALE_REVISION",
  TASK_DELETED: "TEAM_TASK_DELETED", TASK_UNAUTHORIZED: "TEAM_TASK_UNAUTHORIZED",
  TASK_ALREADY_CLAIMED: "TEAM_TASK_ALREADY_CLAIMED", TASK_BLOCKED: "TEAM_TASK_BLOCKED",
  TASK_INVALID_TRANSITION: "TEAM_TASK_INVALID_TRANSITION", TASK_LIMIT: "TEAM_TASK_LIMIT",
  TASK_DEPENDENCY_CYCLE: "TEAM_TASK_DEPENDENCY_CYCLE", TASK_HAS_DEPENDENTS: "TEAM_TASK_HAS_DEPENDENTS",
  INVALID_ARGUMENT: "TEAM_INVALID_ARGUMENT", INVALID_TIMEOUT: "TEAM_INVALID_TIMEOUT",
  INVALID_WRITE_SCOPE: "TEAM_INVALID_WRITE_SCOPE",
} as const

// Team scope owner (calling agent) — resolved from the tool's entry.
export type TeamCaller = { id: string; name: string; role: "lead" | "teammate" }
```

`packages/agent-team/src/index.ts`:

```ts
export { AgentPath, LEAD_NAME } from "./agent-path.ts"
export type { TeamConfig, TeamMemberPhase, TeamMemberSnapshot, TeamMemberView, TeamTaskStatus, TeamTaskSnapshot, TeamTaskView, TeamMessageSnapshot, TeamEvent, TeamCaller } from "./types.ts"
export { validateTeamConfig, TeamError, TEAM_CODES } from "./types.ts"
```

- [x] **Step 5: Run the test to verify it passes**

Run: `cd packages/agent-team && pnpm test`
Expected: PASS (all 3 tests).

- [x] **Step 6: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/agent-team typecheck
git add packages/agent-team pnpm-lock.yaml
git commit -m "feat(M19): agent-team scaffold + AgentPath + types (config bounds, snapshots, codes)"
```

---

### Task 2: `core-session` + `session-persistence` event-type plumbing — TDD

**Files:**
- Modify: `packages/core-session/src/index.ts` (add 4 team event types to SessionEvent union)
- Modify: `packages/session-persistence/src/index.ts` (add `registerEventType` + register the 4)
- Test: `packages/session-persistence/test/coordinator.test.ts` (append + load a team event round-trip)

**Interfaces:**
- Consumes: Task 1's `TeamEvent` shape.
- Produces (used by Task 3+): `SessionEvent` union includes the 4 team events; `registerEventType(type: string): void` on the coordinator factory.

- [x] **Step 1: Write the failing test**

`packages/session-persistence/test/coordinator.test.ts` (append a small block; use the JSONL backend factory):

```ts
import { describe, expect, it } from "vitest"
import { createSession } from "@i-harness/core-session"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createCoordinator } from "@i-harness/session-persistence"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("team event types round-trip", () => {
  it("a team/* event survives append + load (KNOWN_EVENT_TYPES accepts it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-team-"))
    try {
      const coordinator = createCoordinator(createJsonlBackend(dir), {})
      const { id } = await coordinator.create({})
      await coordinator.enqueue(id, [{ type: "team/member", version: 1, teamId: id, member: { id: "child-1", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" } }])
      await coordinator.flush(id)
      const loaded = await coordinator.load(id)
      expect(loaded.session.events.some((e) => e.type === "team/member")).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/session-persistence && pnpm test`
Expected: FAIL (or existing behavior throws — the team/member event is not in KNOWN_EVENT_TYPES, so load rejects).

- [x] **Step 3: Implement the event-type plumbing**

`packages/core-session/src/index.ts` — add to the SessionEvent union (after `sandbox/mode`):

```ts
    | { type: "team/member"; version: 1; teamId: string; member: { id: string; name: string; description: string; provider: string; context: "fresh" | "fork"; phase: "provisioning" | "active" | "failed"; error?: string }; seq?: number }
    | { type: "team/task"; version: 1; teamId: string; task: { id: string; revision: number; subject: string; description: string; status: "pending" | "in_progress" | "completed" | "deleted"; ownerId?: string; blockedBy: string[]; writeScopes: string[] }; seq?: number }
    | { type: "team/message/queued"; version: 1; teamId: string; message: { id: string; senderId: string; senderName: string; targetId: string; delivery: "quiet" | "wakeup"; content: string }; seq?: number }
    | { type: "team/message/delivered"; version: 1; teamId: string; messageId: string; targetId: string; seq?: number }
```

Also add to `deriveSearchText` (M19: subject/message searchable; keep model-hidden — no `deriveMessages` branch):

```ts
    || e.type === "team/task" || e.type === "team/message/queued"
```
(deriveSearchText's existing union filter — extend it with the two content-bearing team types so they're FTS-searchable. Check the file and add the types to the filter list; team/member and team/message/delivered carry no user-facing text so they stay unindexed.)

`packages/session-persistence/src/index.ts`:

```ts
// M19: extensible event-type registry (fixes the M16 sandbox/mode closed-set gap).
const extraEventTypes = new Set<string>()
export function registerEventType(type: string): void {
  extraEventTypes.add(type)
}
export const KNOWN_EVENT_TYPES = new Set([
  ...builtinEventTypes, // existing 14 strings
])
// guardIgnorable: known = builtin ∪ extra
const isKnown = (type: string): boolean => knownEventTypes.has(type) || extraEventTypes.has(type)
```

Then register at module init (or in `agent-team/src/index.ts`; put in session-persistence so load works standalone):

```ts
registerEventType("team/member")
registerEventType("team/task")
registerEventType("team/message/queued")
registerEventType("team/message/delivered")
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/session-persistence && pnpm test`
Expected: PASS (new round-trip test + all existing).

- [x] **Step 5: Run affected packages + typecheck**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/core-session test
pnpm --filter @i-harness/core-session typecheck
pnpm --filter @i-harness/session-persistence test
pnpm --filter @i-harness/session-persistence typecheck
```

- [x] **Step 6: Commit**

```bash
git add packages/core-session packages/session-persistence
git commit -m "feat(M19): team/* session event types + registerEventType (KNOWN_EVENT_TYPES extensible)"
```

---

### Task 3: `fold.ts` — incremental fold + invariant validation — TDD

**Files:**
- Create: `packages/agent-team/src/fold.ts`
- Test: `packages/agent-team/test/fold.test.ts`

**Interfaces:**
- Consumes: `TeamEvent`, `TeamMemberSnapshot`, `TeamTaskSnapshot`, `TeamMessageSnapshot` (Task 1).
- Produces (used by Tasks 4-8): `TeamFoldState`, `foldTeam(events, opts?)`, `applyTeamEvent(state, event)`.

- [x] **Step 1: Write the failing test**

`packages/agent-team/test/fold.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { foldTeam, applyTeamEvent, type TeamFoldState } from "../src/index.ts"
import type { TeamEvent } from "../src/index.ts"

const base: TeamEvent = {
  type: "team/member", version: 1, teamId: "lead-1",
  member: { id: "child-1", name: "helper", description: "d", provider: "spawn", context: "fresh", phase: "provisioning" },
}

describe("foldTeam", () => {
  it("folds sequential member/queue/delivered events into state", () => {
    const events: TeamEvent[] = [
      base,
      { ...base, member: { ...base.member, phase: "active" } },
      { type: "team/message/queued", version: 1, teamId: "lead-1", message: { id: "msg-1", senderId: "lead-1", senderName: "lead", targetId: "child-1", delivery: "wakeup", content: "hi" } },
      { type: "team/message/delivered", version: 1, teamId: "lead-1", messageId: "msg-1", targetId: "child-1" },
    ]
    const { state } = foldTeam(events)
    expect(state.members.get("helper")?.phase).toBe("active")
    expect(state.queued.get("child-1")?.length).toBe(1)
    expect(state.delivered.has("msg-1")).toBe(true)
  })

  it("incremental: watermark skips already-folded events", () => {
    const { state, watermark } = foldTeam([base])
    expect(watermark).toBe(1)
    const { state: s2 } = foldTeam([base, { ...base, member: { ...base.member, phase: "active" } }], { watermark })
    expect(s2.members.get("helper")?.phase).toBe("active")
  })

  it("rejects invalid member transitions", () => {
    const state = foldTeam([]).state
    expect(() => applyTeamEvent(state, { ...base, member: { ...base.member, phase: "active" } })).toThrow()
  })

  it("rejects non-monotonic task revisions and duplicate queue", () => {
    const state = foldTeam([]).state
    const task: TeamEvent = { type: "team/task", version: 1, teamId: "lead-1", task: { id: "task-u1", revision: 2, subject: "s", description: "d", status: "pending", blockedBy: [], writeScopes: [] } }
    expect(() => applyTeamEvent(state, task)).toThrow() // revision must start at 1
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/agent-team && pnpm test`
Expected: FAIL — foldTeam not exported.

- [x] **Step 3: Implement fold.ts**

`packages/agent-team/src/fold.ts`:

```ts
import type { TeamEvent, TeamMemberSnapshot, TeamTaskSnapshot, TeamMessageSnapshot } from "./types.ts"

export interface TeamFoldState {
  members: Map<string, TeamMemberSnapshot>          // by name
  tasks: Map<string, TeamTaskSnapshot>              // by id (incl tombstone)
  queued: Map<string, TeamMessageSnapshot[]>        // by targetId (FIFO)
  delivered: Set<string>                            // messageId
  nextTaskNumber: number                            // for task-<uuid> counters (kept simple — uuid suffix)
}
export function createFoldState(): TeamFoldState {
  return { members: new Map(), tasks: new Map(), queued: new Map(), delivered: new Set(), nextTaskNumber: 1 }
}

export function foldTeam(events: TeamEvent[], opts?: { watermark?: number }): { state: TeamFoldState; watermark: number } {
  const state = createFoldState()
  const start = opts?.watermark ?? 0
  for (let i = 0; i < events.length; i++) {
    if (i < start) continue
    applyTeamEvent(state, events[i] as TeamEvent)
  }
  return { state, watermark: events.length }
}

export function applyTeamEvent(state: TeamFoldState, event: TeamEvent): void {
  switch (event.type) {
    case "team/member": {
      if (event.member.phase === "provisioning") {
        if (state.members.has(event.member.name)) throw new Error(`agent-team: member name reused: ${event.member.name}`)
        state.members.set(event.member.name, event.member)
        return
      }
      const existing = state.members.get(event.member.name)
      if (!existing) throw new Error(`agent-team: member ${event.member.name} must start provisioning`)
      if (existing.phase === "provisioning" && event.member.phase === "active") { state.members.set(event.member.name, event.member); return }
      if (existing.phase === "provisioning" && event.member.phase === "failed") { state.members.set(event.member.name, event.member); return }
      if (existing.phase === "active" && event.member.phase === "active") return // idempotent settle
      throw new Error(`agent-team: invalid member transition ${existing.phase}->${event.member.phase} for ${event.member.name}`)
    }
    case "team/task": {
      if (event.task.revision === 1) {
        if (state.tasks.has(event.task.id)) throw new Error(`agent-team: duplicate task id ${event.task.id}`)
        state.tasks.set(event.task.id, event.task)
        return
      }
      const existing = state.tasks.get(event.task.id)
      if (!existing) throw new Error(`agent-team: task ${event.task.id} must start at revision 1`)
      if (event.task.revision !== existing.revision + 1) throw new Error(`agent-team: task ${event.task.id} revision must increment by 1`)
      state.tasks.set(event.task.id, event.task)
      return
    }
    case "team/message/queued": {
      const list = state.queued.get(event.message.targetId) ?? []
      if (list.some((m) => m.id === event.message.id)) throw new Error(`agent-team: duplicate queued message ${event.message.id}`)
      list.push(event.message)
      state.queued.set(event.message.targetId, list)
      return
    }
    case "team/message/delivered": {
      const list = state.queued.get(event.targetId)
      if (!list || !list.some((m) => m.id === event.messageId)) throw new Error(`agent-team: delivered without queued: ${event.messageId}`)
      if (state.delivered.has(event.messageId)) throw new Error(`agent-team: duplicate delivered ${event.messageId}`)
      const q = list.find((m) => m.id === event.messageId)!
      if (q.targetId !== event.targetId) throw new Error(`agent-team: delivered target mismatch for ${event.messageId}`)
      state.delivered.add(event.messageId)
      return
    }
  }
}
```

Update `packages/agent-team/src/index.ts`:

```ts
export { foldTeam, applyTeamEvent, createFoldState } from "./fold.ts"
export type { TeamFoldState } from "./fold.ts"
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/agent-team && pnpm test`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/agent-team typecheck
git add packages/agent-team
git commit -m "feat(M19): team fold — incremental event replay + invariant validation"
```

---

### Task 4: `transact.ts` — per-team serialized read-check-append — TDD

**Files:**
- Create: `packages/agent-team/src/transact.ts`
- Test: `packages/agent-team/test/transact.test.ts`

**Interfaces:**
- Consumes: `foldTeam`/`TeamFoldState` (Task 3), `TeamEvent` (Task 1).
- Produces (used by Tasks 5-8): `createTeamTransact(lead)`, `TeamTransaction`.

- [x] **Step 1: Write the failing test**

`packages/agent-team/test/transact.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createTeamTransact } from "../src/index.ts"
import type { TeamEvent } from "../src/index.ts"

function fakeLead() {
  const events: TeamEvent[] = []
  let cb: (() => void) | undefined
  return {
    events,
    append: (e: TeamEvent) => { events.push(e); cb?.() },
    flush: async () => {},
    onCommit: (fn: () => void) => { cb = fn },
  }
}

describe("createTeamTransact", () => {
  it("serializes concurrent transactions and commits events", async () => {
    const lead = fakeLead()
    const tx = createTeamTransact(lead)
    const order: number[] = []
    await Promise.all([
      tx.transact(() => ({ events: [{ type: "team/member", version: 1, teamId: "t", member: { id: "c1", name: "a", description: "d", provider: "p", context: "fresh", phase: "provisioning" } }], result: order.push(1) })),
      tx.transact(() => ({ events: [{ type: "team/member", version: 1, teamId: "t", member: { id: "c2", name: "b", description: "d", provider: "p", context: "fresh", phase: "provisioning" } }], result: order.push(2) })),
    ])
    expect(order).toEqual([1, 2])
    expect(lead.events.length).toBe(2)
  })

  it("a throwing op commits nothing", async () => {
    const lead = fakeLead()
    const tx = createTeamTransact(lead)
    await expect(tx.transact(() => { throw new Error("boom") })).rejects.toThrow(/boom/)
    expect(lead.events.length).toBe(0)
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/agent-team && pnpm test`
Expected: FAIL — createTeamTransact not exported.

- [x] **Step 3: Implement transact.ts**

`packages/agent-team/src/transact.ts`:

```ts
import type { TeamEvent } from "./types.ts"
import { foldTeam, type TeamFoldState } from "./fold.ts"

export interface TeamLead {
  append(event: TeamEvent): void
  flush(): Promise<void>
  onCommit?(fn: () => void): void
}
export interface TeamTransaction {
  transact<T>(fn: (state: TeamFoldState) => { events?: TeamEvent[]; result: T }): Promise<T>
}
export function createTeamTransact(lead: TeamLead): TeamTransaction {
  let chain: Promise<unknown> = Promise.resolve()
  let state: TeamFoldState | undefined
  return {
    transact<T>(fn: (state: TeamFoldState) => { events?: TeamEvent[]; result: T }): Promise<T> {
      const next = chain.then(async () => {
        if (!state) state = foldTeam([]).state
        const out = fn(state)
        if (out.events) for (const e of out.events) foldTeam([e]).state // validation via fold before append
        if (out.events) for (const e of out.events) lead.append(e)
        if (out.events) { await lead.flush(); lead.onCommit?.() }
        return out.result
      })
      chain = next.catch(() => {})
      return next
    },
  }
}
```

Update `packages/agent-team/src/index.ts`:

```ts
export { createTeamTransact } from "./transact.ts"
export type { TeamLead, TeamTransaction } from "./transact.ts"
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/agent-team && pnpm test`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/agent-team typecheck
git add packages/agent-team
git commit -m "feat(M19): transact — per-team serialized read-check-append"
```

---

### Task 5: `roster.ts` — named roster + provisioning lifecycle — TDD

**Files:**
- Create: `packages/agent-team/src/roster.ts`
- Test: `packages/agent-team/test/roster.test.ts`

**Interfaces:**
- Consumes: `TeamFoldState`/`foldTeam` (Task 3), transact (Task 4), `spawnChild`-equivalent (from `@i-harness/subagent` — see deps), types (Task 1).
- Produces (used by Task 8/10): `createRoster(deps, state, tx)`, `listMembers()`, `spawnTeammate(...)`, `interrupt(...)`, `resolveCaller(...)`.

- [x] **Step 1: Write the failing test**

`packages/agent-team/test/roster.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createRoster, type RosterDeps } from "../src/index.ts"
import type { TeamFoldState } from "../src/index.ts"

function makeDeps(overrides?: Partial<RosterDeps>): RosterDeps {
  return {
    teamId: "lead-1",
    state: { members: new Map(), tasks: new Map(), queued: new Map(), delivered: new Set(), nextTaskNumber: 1 } as TeamFoldState,
    transact: async (fn) => fn({ members: new Map(), tasks: new Map(), queued: new Map(), delivered: new Set(), nextTaskNumber: 1 } as TeamFoldState).result,
    spawnChild: async (name, prompt) => { return { path: `lead/${name}`, jobId: "job-1", sessionId: "child-1" } },
    childSessionHoldsPrompt: async () => true,
    interruptChild: async () => "running",
    closeChild: async () => {},
    ...overrides,
  }
}

describe("TeamRoster", () => {
  it("spawnTeammate provisions then activates a member", async () => {
    const roster = createRoster(makeDeps())
    const member = await roster.spawnTeammate("helper", { description: "d", prompt: "do x", context: "fresh" })
    expect(member.phase).toBe("active")
  })

  it("fails provisioning when the child never holds the prompt", async () => {
    const roster = createRoster(makeDeps({ childSessionHoldsPrompt: async () => false }))
    await expect(roster.spawnTeammate("helper", { description: "d", prompt: "do x", context: "fresh" })).rejects.toThrow()
    expect(roster.listMembers().find((m) => m.name === "helper")?.status).toBe("failed")
  })

  it("rejects name reuse", async () => {
    const deps = makeDeps()
    const roster = createRoster(deps)
    await roster.spawnTeammate("helper", { description: "d", prompt: "do x", context: "fresh" })
    await expect(roster.spawnTeammate("helper", { description: "d", prompt: "do x", context: "fresh" })).rejects.toThrow(/TAKEN|reused/i)
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/agent-team && pnpm test`
Expected: FAIL — createRoster not exported.

- [x] **Step 3: Implement roster.ts**

`packages/agent-team/src/roster.ts`:

```ts
import { randomUUID } from "node:crypto"
import { AgentPath } from "./agent-path.ts"
import { TeamError, TEAM_CODES, type TeamCaller, type TeamMemberSnapshot, type TeamMemberView, type TeamFoldState as TeamState, type TeamEvent, type TeamTaskView } from "./types.ts"
import { createFoldState } from "./fold.ts"
import type { TeamTransaction } from "./transact.ts"

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface RosterDeps {
  teamId: string
  state: TeamState
  transact: TeamTransaction
  // subagent integration (injected; internally spawns the durable child)
  spawnChild: (name: string, prompt: string, context: "fresh" | "fork") => Promise<{ path: string; jobId: string; sessionId?: string }>
  childSessionHoldsPrompt: (sessionId: string, signal?: AbortSignal) => Promise<boolean>
  interruptChild: (path: string) => Promise<string>
  closeChild: (path: string) => Promise<void>
  maxMembers?: number
  startupTimeoutMs?: number
}

export function createRoster(deps: RosterDeps) {
  const maxMembers = deps.maxMembers ?? 8
  const startupTimeoutMs = deps.startupTimeoutMs ?? 10_000

  function listMembers(): TeamMemberView[] {
    const lead: TeamMemberView = { id: deps.teamId, name: "lead", role: "lead", status: "running", diagnostics: [] }
    const members: TeamMemberView[] = [...deps.state.members.values()].map((m) => ({
      id: m.id, name: m.name, role: "teammate", status: m.phase === "provisioning" ? "provisioning" : m.phase === "failed" ? "failed" : "inactive",
      ...(m.description !== undefined ? { description: m.description } : {}),
      ...(m.context !== undefined ? { context: m.context } : {}),
      diagnostics: [],
    }))
    return [lead, ...members]
  }

  function callerIsLead(caller: TeamCaller): boolean {
    return caller.role === "lead"
  }

  async function spawnTeammate(caller: TeamCaller, name: string, opts: { description: string; prompt: string; context?: "fresh" | "fork"; forkTurns?: "none" | "all" | number }): Promise<TeamMemberView> {
    if (!callerIsLead(caller)) throw new TeamError(TEAM_CODES.LEAD_REQUIRED, "only the Team Lead may spawn teammates")
    if (!NAME_RE.test(name) || name.length > 64 || name === "lead") throw new TeamError(TEAM_CODES.INVALID_MEMBER_NAME, `invalid teammate name "${name}"`)
    if (deps.state.members.size >= maxMembers) throw new TeamError(TEAM_CODES.MEMBER_LIMIT, `maxMembers ${maxMembers} reached`)
    const id = `child-${randomUUID()}`
    let provisioning: TeamMemberSnapshot = { id, name, description: opts.description, provider: "spawn", context: opts.context ?? "fresh", phase: "provisioning" }
    try {
      // Provisioning event (transact ensures the name isn't taken atomically)
      await deps.transact.transact((state) => {
        if (state.members.has(name)) throw new TeamError(TEAM_CODES.MEMBER_NAME_TAKEN, `member name "${name}" already taken`)
        state.members.set(name, provisioning)
        return { events: [{ type: "team/member", version: 1, teamId: deps.teamId, member: provisioning }], result: undefined }
      })
    } catch (e) {
      throw e
    }
    // Now spawn the durable child
    let spawned: { path: string; jobId: string; sessionId?: string }
    try {
      spawned = await deps.spawnChild(name, opts.prompt, provisioning.context)
      // checkpoint: child session must durably hold the initial prompt
      const holds = await Promise.race([
        deps.childSessionHoldsPrompt(spawned.sessionId!, new AbortController().signal),
        new Promise<boolean>((res) => setTimeout(() => res(false), startupTimeoutMs)),
      ])
      if (!holds) throw new Error("child session never durably held the initial prompt")
    } catch (e) {
      const failed: TeamMemberSnapshot = { ...provisioning, phase: "failed", error: e instanceof Error ? e.message : String(e) }
      await deps.transact.transact((state) => {
        state.members.set(name, failed)
        return { events: [{ type: "team/member", version: 1, teamId: deps.teamId, member: failed }], result: undefined }
      }).catch(() => {})
      try { await deps.closeChild(`lead/${name}`) } catch { /* best-effort */ }
      throw e
    }
    const active: TeamMemberSnapshot = { ...provisioning, phase: "active" }
    await deps.transact.transact((state) => {
      state.members.set(name, active)
      return { events: [{ type: "team/member", version: 1, teamId: deps.teamId, member: active }], result: undefined }
    })
    return { id: active.id, name: active.name, role: "teammate", status: "inactive", description: active.description, context: active.context, diagnostics: [] }
  }

  async function interrupt(caller: TeamCaller, target: string): Promise<{ previousStatus: string }> {
    if (!callerIsLead(caller)) throw new TeamError(TEAM_CODES.LEAD_REQUIRED, "only the Team Lead may interrupt")
    if (target === "lead") throw new TeamError(TEAM_CODES.INVALID_ARGUMENT, "cannot interrupt the lead")
    if (!deps.state.members.has(target)) throw new TeamError(TEAM_CODES.MEMBER_NOT_FOUND, `unknown teammate "${target}"`)
    return { previousStatus: await deps.interruptChild(AgentPath.parse(`lead/${target}`).toString()) }
  }

  function resolveCaller(id: string, name: string): TeamCaller {
    if (id === deps.teamId) return { id, name: "lead", role: "lead" }
    const m = [...deps.state.members.values()].find((m) => m.id === id)
    if (!m) return { id, name, role: "teammate" }
    return { id, name: m.name, role: "teammate" }
  }

  return { listMembers, spawnTeammate, interrupt, resolveCaller }
}
```

Update `packages/agent-team/src/index.ts`:

```ts
export { createRoster } from "./roster.ts"
export type { RosterDeps } from "./roster.ts"
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/agent-team && pnpm test`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/agent-team typecheck
git add packages/agent-team
git commit -m "feat(M19): roster — named members, provisioning lifecycle, Lead-only authority"
```

---

### Task 6: `mailbox.ts` — durable queued→delivered — TDD

**Files:**
- Create: `packages/agent-team/src/mailbox.ts`
- Test: `packages/agent-team/test/mailbox.test.ts`

**Interfaces:**
- Consumes: transact, fold state, types (Tasks 1/3/4).
- Produces (used by Task 8/10): `createMailbox(deps, state, tx)`, `sendMessage(...)`, `recoverRoot(...)`.

- [x] **Step 1: Write the failing test**

`packages/agent-team/test/mailbox.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createMailbox, type MailboxDeps } from "../src/index.ts"
import type { TeamFoldState } from "../src/index.ts"

function makeDeps(overrides?: Partial<MailboxDeps>): MailboxDeps {
  const state = { members: new Map([["helper", { id: "child-1", name: "helper", description: "d", provider: "p", context: "fresh", phase: "active" }]]), tasks: new Map(), queued: new Map(), delivered: new Set(), nextTaskNumber: 1 } as unknown as TeamFoldState
  return {
    teamId: "lead-1", state,
    transact: async (fn) => fn(state).result,
    deliver: async (_targetId, _messageId, _content, _delivery, signal?) => true,
    memberStatus: (id) => "idle",
    maxPendingMessagesPerMember: 64,
    maxMessageBytes: 65_536,
    ...overrides,
  }
}

describe("TeamMailbox", () => {
  it("queues and delivers, then acknowledges delivered", async () => {
    const deps = makeDeps()
    const box = createMailbox(deps)
    const r = await box.sendMessage({ id: "lead-1", name: "lead", role: "lead" }, "helper", "hello", "wakeup")
    expect(r.status).toBe("accepted")
    expect(deps.state.delivered.has(r.messageId)).toBe(true)
  })

  it("keeps queued when delivery fails, then recovers", async () => {
    const deps = makeDeps({ deliver: async () => false })
    const box = createMailbox(deps)
    const r = await box.sendMessage({ id: "lead-1", name: "lead", role: "lead" }, "helper", "hello", "quiet")
    expect(r.status).toBe("queued")
    expect(deps.state.queued.get("child-1")?.length).toBe(1)
    await box.recoverRoot()
    expect(deps.state.delivered.size).toBe(0) // quiet on idle target stays queued
  })

  it("rejects self-message and unknown target", async () => {
    const deps = makeDeps()
    const box = createMailbox(deps)
    await expect(box.sendMessage({ id: "child-1", name: "helper", role: "teammate" }, "helper", "x", "quiet")).rejects.toThrow(/SELF|self/i)
    await expect(box.sendMessage({ id: "lead-1", name: "lead", role: "lead" }, "nobody", "x", "quiet")).rejects.toThrow(/NOT_FOUND|unknown/i)
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/agent-team && pnpm test`
Expected: FAIL — createMailbox not exported.

- [x] **Step 3: Implement mailbox.ts**

`packages/agent-team/src/mailbox.ts`:

```ts
import { randomUUID } from "node:crypto"
import { TeamError, TEAM_CODES, type TeamCaller, type TeamMessageSnapshot, type TeamFoldState as TeamState } from "./types.ts"
import type { TeamTransaction } from "./transact.ts"

export interface MailboxDeps {
  teamId: string
  state: TeamState
  transact: TeamTransaction
  deliver: (targetId: string, messageId: string, content: string, delivery: "quiet" | "wakeup", signal?: AbortSignal) => Promise<boolean>
  memberStatus: (id: string) => "running" | "idle" | "inactive" | "provisioning" | "failed"
  maxPendingMessagesPerMember?: number
  maxMessageBytes?: number
}

export function createMailbox(deps: MailboxDeps) {
  const maxPending = deps.maxPendingMessagesPerMember ?? 64
  const maxBytes = deps.maxMessageBytes ?? 65_536

  function pendingCount(targetId: string): number {
    return (deps.state.queued.get(targetId) ?? []).filter((m) => !deps.state.delivered.has(m.id)).length
  }

  async function sendMessage(caller: TeamCaller, target: string, message: string, delivery: "quiet" | "wakeup", signal?: AbortSignal): Promise<{ messageId: string; status: "accepted" | "queued" }> {
    if (caller.role === "teammate" && !deps.state.members.has(caller.name)) throw new TeamError(TEAM_CODES.NOT_MEMBER, `not a team member: ${caller.name}`)
    const targetId = target === "lead" ? deps.teamId : deps.state.members.get(target)?.id
    if (!targetId) throw new TeamError(TEAM_CODES.MEMBER_NOT_FOUND, `unknown target "${target}"`)
    if (caller.id === targetId) throw new TeamError(TEAM_CODES.SELF_MESSAGE, "cannot message yourself")
    const framing = `Team message <${"id"}> from <${caller.name}>:\n${message}`
    if (Buffer.byteLength(framing, "utf-8") > maxBytes) throw new TeamError(TEAM_CODES.MESSAGE_TOO_LARGE, `message exceeds ${maxBytes} bytes`)
    if (pendingCount(targetId) >= maxPending) throw new TeamError(TEAM_CODES.MAILBOX_FULL, `target queue full (${maxPending} pending)`)
    const snapshot: TeamMessageSnapshot = { id: `msg-${randomUUID()}`, senderId: caller.id, senderName: caller.name, targetId, delivery, content: message }
    await deps.transact.transact((state) => {
      const q = state.queued.get(targetId) ?? []
      q.push(snapshot)
      state.queued.set(targetId, q)
      return { result: undefined, events: [{ type: "team/message/queued", version: 1, teamId: deps.teamId, message: snapshot }] }
    })
    const delivered = await deps.deliver(targetId, snapshot.id, message, delivery, signal)
    if (delivered) {
      await deps.transact.transact((state) => {
        return { result: undefined, events: [{ type: "team/message/delivered", version: 1, teamId: deps.teamId, messageId: snapshot.id, targetId }] }
      })
      return { messageId: snapshot.id, status: "accepted" }
    }
    return { messageId: snapshot.id, status: "queued" }
  }

  async function recoverRoot(): Promise<void> {
    for (const [targetId, msgs] of [...deps.state.queued.entries()]) {
      for (const m of msgs) {
        if (deps.state.delivered.has(m.id)) continue
        if (m.delivery === "quiet" && deps.memberStatus(targetId) === "inactive") continue // quiet never wakes inactive
        const ok = await deps.deliver(targetId, m.id, m.content, m.delivery)
        if (ok) {
          await deps.transact.transact((state) => {
            return { result: undefined, events: [{ type: "team/message/delivered", version: 1, teamId: deps.teamId, messageId: m.id, targetId }] }
          })
        }
      }
    }
  }

  return { sendMessage, recoverRoot }
}
```

Update `packages/agent-team/src/index.ts`:

```ts
export { createMailbox } from "./mailbox.ts"
export type { MailboxDeps } from "./mailbox.ts"
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/agent-team && pnpm test`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/agent-team typecheck
git add packages/agent-team
git commit -m "feat(M19): mailbox — durable queued→delivered with recovery"
```

---

### Task 7: `task-board.ts` — CAS + DAG + tombstone — TDD

**Files:**
- Create: `packages/agent-team/src/task-board.ts`
- Test: `packages/agent-team/test/task-board.test.ts`

**Interfaces:**
- Consumes: transact, fold state, types (Tasks 1/3/4).
- Produces (used by Task 8/10): `createTaskBoard(deps, state, tx)`, `createTask(...)`, `getTask(...)`, `listTasks(...)`, `updateTask(...)`.

- [x] **Step 1: Write the failing test**

`packages/agent-team/test/task-board.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createTaskBoard, normalizeWriteScopes } from "../src/index.ts"
import type { TeamFoldState } from "../src/index.ts"

function make(overrides?: Partial<Parameters<typeof createTaskBoard>[0]>): ReturnType<typeof createTaskBoard> {
  const state = { members: new Map(), tasks: new Map(), queued: new Map(), delivered: new Set(), nextTaskNumber: 1 } as unknown as TeamFoldState
  return createTaskBoard({ teamId: "lead-1", state, transact: async (fn) => fn(state).result, maxTasks: 256, ...overrides })
}

describe("TaskBoard", () => {
  it("creates a pending task with revision 1", async () => {
    const b = make()
    const t = await b.createTask({ id: "lead-1", name: "lead", role: "lead" }, { subject: "s", description: "d" })
    expect(t.revision).toBe(1)
    expect(t.status).toBe("pending")
  })
  it("CAS: stale expectedRevision throws", async () => {
    const b = make()
    const t = await b.createTask({ id: "lead-1", name: "lead", role: "lead" }, { subject: "s", description: "d" })
    await expect(b.updateTask({ id: "lead-1", name: "lead", role: "lead" }, { taskId: t.id, expectedRevision: 0, action: "claim" })).rejects.toThrow(/STALE/i)
  })
  it("claim requires readiness (blockers must complete)", async () => {
    const b = make()
    const blocker = await b.createTask({ id: "lead-1", name: "lead", role: "lead" }, { subject: "blocker", description: "d" })
    const t = await b.createTask({ id: "lead-1", name: "lead", role: "lead" }, { subject: "s", description: "d", blockedBy: [blocker.id] })
    await expect(b.updateTask({ id: "lead-1", name: "lead", role: "lead" }, { taskId: t.id, expectedRevision: 1, action: "claim" })).rejects.toThrow(/BLOCKED|ready/i)
  })
  it("only Lead can reassign; owner-only complete", async () => {
    const b = make()
    const t = await b.createTask({ id: "lead-1", name: "lead", role: "lead" }, { subject: "s", description: "d" })
    await b.updateTask({ id: "lead-1", name: "lead", role: "lead" }, { taskId: t.id, expectedRevision: 1, action: "claim" }) // lead claims
    await expect(b.updateTask({ id: "child-1", name: "helper", role: "teammate" }, { taskId: t.id, expectedRevision: 6, action: "reassign", owner: "helper" })).rejects.toThrow(/LEAD|reassign/i)
  })
  it("delete tombstone prevents deps", async () => {
    const b = make()
    const t = await b.createTask({ id: "lead-1", name: "lead", role: "lead" }, { subject: "s", description: "d" })
    const dep = await b.createTask({ id: "lead-1", name: "lead", role: "lead" }, { subject: "dep", description: "d", blockedBy: [t.id] })
    await expect(b.updateTask({ id: "lead-1", name: "lead", role: "lead" }, { taskId: t.id, expectedRevision: 1, action: "delete" })).rejects.toThrow(/DEPENDENTS/i)
    void dep
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/agent-team && pnpm test`
Expected: FAIL — createTaskBoard not exported.

- [x] **Step 3: Implement task-board.ts**

`packages/agent-team/src/task-board.ts`:

```ts
import { randomUUID } from "node:crypto"
import { TeamError, TEAM_CODES, type TeamCaller, type TeamTaskSnapshot, type TeamTaskStatus, type TeamTaskView, type TeamFoldState as TeamState } from "./types.ts"
import type { TeamTransaction } from "./transact.ts"

export type TaskAction = "claim" | "release" | "edit" | "set_dependencies" | "complete" | "reopen" | "reassign" | "delete"

export function normalizeWriteScopes(scopes: string[]): string[] {
  return scopes.map((s) => s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")).filter((s) => s.length > 0 && !s.startsWith("/") && !s.includes("..") && !/^[a-zA-Z]:$/.test(s))
}

export interface TaskBoardDeps {
  teamId: string
  state: TeamState
  transact: TeamTransaction
  maxTasks?: number
}
export function createTaskBoard(deps: TaskBoardDeps) {
  const maxTasks = deps.maxTasks ?? 256

  function view(task: TeamTaskSnapshot, memberName: (id?: string) => string | undefined): TeamTaskView {
    const blockers = task.blockedBy.map((b) => deps.state.tasks.get(b))
    const ready = blockers.every((b) => b && b.status === "completed")
    const warnings: string[] = []
    for (const [id, other] of deps.state.tasks) {
      if (id === task.id || other.status !== "in_progress") continue
      for (const scope of task.writeScopes) {
        if (other.writeScopes.some((s) => s === scope || s.startsWith(scope + "/") || scope.startsWith(s + "/"))) warnings.push(`write scopes overlap with ${id}`)
      }
    }
    return { ...task, ...(task.ownerId ? { ownerName: memberName(task.ownerId) } : {}), ready, writeScopeWarnings: [...new Set(warnings)] }
  }

  async function createTask(caller: TeamCaller, opts: { subject: string; description: string; blockedBy?: string[]; writeScopes?: string[] }): Promise<TeamTaskView> {
    const nonDeleted = [...deps.state.tasks.values()].filter((t) => t.status !== "deleted").length
    if (nonDeleted >= maxTasks) throw new TeamError(TEAM_CODES.TASK_LIMIT, `maxTasks ${maxTasks} reached`)
    const blockedBy = opts.blockedBy ?? []
    for (const b of blockedBy) {
      const t = deps.state.tasks.get(b)
      if (!t || t.status === "deleted") throw new TeamError(TEAM_CODES.TASK_NOT_FOUND, `blocker "${b}" does not exist`)
    }
    const task: TeamTaskSnapshot = { id: `task-${randomUUID()}`, revision: 1, subject: opts.subject, description: opts.description, status: "pending", blockedBy, writeScopes: normalizeWriteScopes(opts.writeScopes ?? []) }
    await deps.transact.transact((state) => {
      state.tasks.set(task.id, task)
      return { result: undefined, events: [{ type: "team/task", version: 1, teamId: deps.teamId, task }] }
    })
    return view(task, () => undefined)
  }

  async function getTask(caller: TeamCaller, id: string): Promise<TeamTaskView> {
    void caller
    const t = deps.state.tasks.get(id)
    if (!t) throw new TeamError(TEAM_CODES.TASK_NOT_FOUND, `no task "${id}"`)
    return view(t, (mid) => [...deps.state.members.values()].find((m) => m.id === mid)?.name)
  }

  async function listTasks(caller: TeamCaller, opts?: { status?: TeamTaskStatus; owner?: string; ready?: boolean; cursor?: number; limit?: number }): Promise<{ tasks: TeamTaskView[]; nextCursor?: number }> {
    void caller
    const statuses = (opts?.status !== undefined ? [opts.status] : ["pending", "in_progress", "completed"])
    const all = [...deps.state.tasks.values()].filter((t) => statuses.includes(t.status))
      .filter((t) => opts?.owner === undefined || (opts.owner === "unowned" ? t.ownerId === undefined : (t.ownerId && [...deps.state.members.values()].find((m) => m.id === t.ownerId)?.name === opts.owner)))
      .map((t) => view(t, (mid) => [...deps.state.members.values()].find((m) => m.id === mid)?.name))
      .filter((t) => opts?.ready === undefined || t.ready === opts.ready)
    const cursor = opts?.cursor ?? 0
    const limit = opts?.limit ?? 50
    return { tasks: all.slice(cursor, cursor + limit), ...(cursor + limit < all.length ? { nextCursor: cursor + limit } : {}) }
  }

  async function updateTask(caller: TeamCaller, req: { taskId: string; expectedRevision: number; action: TaskAction; subject?: string; description?: string; blockedBy?: string[]; writeScopes?: string[]; owner?: string }): Promise<TeamTaskView> {
    const existing = deps.state.tasks.get(req.taskId)
    if (!existing) throw new TeamError(TEAM_CODES.TASK_NOT_FOUND, `no task "${req.taskId}"`)
    if (existing.status === "deleted") throw new TeamError(TEAM_CODES.TASK_DELETED, `task deleted "${req.taskId}"`)
    if (req.expectedRevision !== existing.revision) throw new TeamError(TEAM_CODES.TASK_STALE_REVISION, `task ${req.taskId} revision ${existing.revision} (expected ${req.expectedRevision})`)
    const isOwner = existing.ownerId !== undefined && existing.ownerId === caller.id
    const isLead = caller.role === "lead"
    const action = req.action
    if (action === "claim") {
      if (existing.ownerId !== undefined) throw new TeamError(TEAM_CODES.TASK_ALREADY_CLAIMED, "task already claimed")
      const ready = existing.blockedBy.every((b) => { const t = deps.state.tasks.get(b); return t && t.status === "completed" })
      if (!ready) throw new TeamError(TEAM_CODES.TASK_BLOCKED, "task is blocked by incomplete prerequisites")
      return update(existing, { status: "in_progress", ownerId: caller.id }, caller)
    }
    if (action === "reassign") {
      if (!isLead) throw new TeamError(TEAM_CODES.LEAD_REQUIRED, "only the Lead may reassign")
      const ownerId = req.owner === undefined ? undefined : deps.state.members.get(req.owner)?.id
      return update(existing, { ownerId }, caller)
    }
    if (action === "set_dependencies") {
      if (!isOwner && !isLead) throw new TeamError(TEAM_CODES.TASK_UNAUTHORIZED, "owner or Lead may change dependencies")
      const blockedBy = req.blockedBy ?? []
      for (const b of blockedBy) { const t = deps.state.tasks.get(b); if (!t || t.status === "deleted") throw new TeamError(TEAM_CODES.TASK_NOT_FOUND, `blocker "${b}" does not exist`) }
      return update(existing, { blockedBy }, caller)
    }
    if (action === "delete") {
      if (!isOwner && !isLead) throw new TeamError(TEAM_CODES.TASK_UNAUTHORIZED, "owner or Lead may delete")
      const hasDep = [...deps.state.tasks.values()].some((t) => t.status !== "deleted" && t.blockedBy.includes(existing.id))
      if (hasDep) throw new TeamError(TEAM_CODES.TASK_HAS_DEPENDENTS, "task has non-deleted dependents")
      return update(existing, { status: "deleted" }, caller)
    }
    if (action === "edit" || action === "complete" || action === "release" || action === "reopen") {
      if (!isOwner && !isLead && !(action === "complete" && isLead)) throw new TeamError(TEAM_CODES.TASK_UNAUTHORIZED, "owner or Lead may mutate")
      if (action === "edit") return update(existing, { subject: req.subject ?? existing.subject, description: req.description ?? existing.description, writeScopes: req.writeScopes ? normalizeWriteScopes(req.writeScopes) : existing.writeScopes }, caller)
      if (action === "complete") return update(existing, { status: "completed" }, caller)
      if (action === "release") return update(existing, { status: "pending", ownerId: undefined }, caller)
      if (action === "reopen") return update(existing, { status: "pending", ownerId: undefined }, caller)
    }
    throw new TeamError(TEAM_CODES.TASK_INVALID_TRANSITION, `invalid action "${action}"`)
  }

  async function update(existing: TeamTaskSnapshot, patch: Partial<TeamTaskSnapshot>, caller: TeamCaller): Promise<TeamTaskView> {
    const next: TeamTaskSnapshot = { ...existing, ...patch, revision: existing.revision + 1 }
    await deps.transact.transact((state) => {
      state.tasks.set(next.id, next)
      return { result: undefined, events: [{ type: "team/task", version: 1, teamId: deps.teamId, task: next }] }
    })
    return view(next, (mid) => [...deps.state.members.values()].find((m) => m.id === mid)?.name)
  }

  return { createTask, getTask, listTasks, updateTask }
}
```

Update `packages/agent-team/src/index.ts`:

```ts
export { createTaskBoard, normalizeWriteScopes } from "./task-board.ts"
export type { TaskBoardDeps, TaskAction } from "./task-board.ts"
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/agent-team && pnpm test`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/agent-team typecheck
git add packages/agent-team
git commit -m "feat(M19): task board — CAS revisions, DAG readiness, tombstones, advisory write scopes"
```

---

### Task 8: `activity.ts` — edge wait + noProgress — TDD

**Files:**
- Create: `packages/agent-team/src/activity.ts`
- Test: `packages/agent-team/test/activity.test.ts`

**Interfaces:**
- Consumes: types (Task 1).
- Produces (used by Task 9/10): `createActivity(cfg)`, `waitForChange(...)`, `notify()`, `close()`.

- [x] **Step 1: Write the failing test**

`packages/agent-team/test/activity.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createActivity } from "../src/index.ts"

describe("TeamActivity", () => {
  it("edge-triggered: wakes on a post-registration change", async () => {
    const act = createActivity({ waitMinMs: 10_000, waitMaxMs: 3_600_000, waitDefaultMs: 30_000 })
    const p = act.waitForChange(30_000, undefined)
    setTimeout(() => act.notify(), 10)
    expect(await p).toEqual({ timedOut: false })
  })
  it("times out and reports timedOut", async () => {
    const act = createActivity({ waitMinMs: 10_000, waitMaxMs: 3_600_000, waitDefaultMs: 30_000 })
    expect(await act.waitForChange(20, undefined)).toEqual({ timedOut: true })
  })
  it("close releases waiters", async () => {
    const act = createActivity({ waitMinMs: 10_000, waitMaxMs: 3_600_000, waitDefaultMs: 30_000 })
    const p = act.waitForChange(30_000, undefined)
    act.close()
    expect(await p).toEqual({ timedOut: false })
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/agent-team && pnpm test`
Expected: FAIL — createActivity not exported.

- [x] **Step 3: Implement activity.ts**

`packages/agent-team/src/activity.ts`:

```ts
import { TeamError, TEAM_CODES, type TeamCaller } from "./types.ts"

export interface ActivityConfig {
  waitMinMs: number
  waitMaxMs: number
  waitDefaultMs: number
}
export interface TeamWaitResult {
  timedOut: boolean
  noProgress?: { reason: "no-active-peer"; message: string }
}
export function createActivity(cfg: ActivityConfig) {
  let closed = false
  const waiters = new Set<(v: TeamWaitResult) => void>()

  function notify(): void {
    for (const w of [...waiters]) { waiters.delete(w); w({ timedOut: false }) }
  }
  function close(): void {
    closed = true
    notify()
  }
  async function waitForChange(caller: TeamCaller, timeoutMs?: number, signal?: AbortSignal, hasActivePeer?: () => boolean): Promise<TeamWaitResult> {
    void caller
    const t = timeoutMs ?? cfg.waitDefaultMs
    if (!Number.isSafeInteger(t) || t < cfg.waitMinMs || t > cfg.waitMaxMs) throw new TeamError(TEAM_CODES.INVALID_TIMEOUT, `timeout must be ${cfg.waitMinMs}-${cfg.waitMaxMs} ms`)
    if (closed) return { timedOut: false }
    // noProgress shrortcut (domain-level): no other active member → immediate.
    if (hasActivePeer && !hasActivePeer()) {
      return { timedOut: false, noProgress: { reason: "no-active-peer", message: "No other Team member is running or provisioning. Re-list with list_members, use followup_task to wake an inactive teammate, then wait again." } }
    }
    return await new Promise<TeamWaitResult>((resolve) => {
      const timer = setTimeout(() => { waiters.delete(fn); resolve({ timedOut: true }) }, t)
      const fn = (v: TeamWaitResult) => { clearTimeout(timer); resolve(v) }
      waiters.add(fn)
      if (signal) { signal.addEventListener("abort", () => { waiters.delete(fn); clearTimeout(timer); resolve({ timedOut: false }) }, { once: true }) }
    })
  }
  return { waitForChange, notify, close }
}
```

Update `packages/agent-team/src/index.ts`:

```ts
export { createActivity } from "./activity.ts"
export type { ActivityConfig, TeamWaitResult } from "./activity.ts"
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/agent-team && pnpm test`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/agent-team typecheck
git add packages/agent-team
git commit -m "feat(M19): activity — edge-triggered wait with noProgress + disposal release"
```

---

### Task 9: `tools.ts` — 10 team tools — TDD

**Files:**
- Create: `packages/agent-team/src/tools.ts`
- Test: `packages/agent-team/test/tools.test.ts`

**Interfaces:**
- Consumes: roster/mailbox/task-board/activity (Tasks 5-8), `Tool`/`ToolExec` from `@i-harness/core-tools`.
- Produces (used by Task 10): `createTeamTools(deps)`, `TeamToolDeps`.

- [x] **Step 1: Write the failing test**

`packages/agent-team/test/tools.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { createTeamTools } from "../src/index.ts"

function tools() {
  return createTeamTools({
    resolveCaller: (exec) => ({ id: "lead-1", name: "lead", role: "lead" }),
    roster: { listMembers: async () => [{ id: "lead-1", name: "lead", role: "lead", status: "running", diagnostics: [] }],
      spawnTeammate: async (_c, n) => ({ id: "child-1", name: n, role: "teammate", status: "inactive", diagnostics: [] }),
      interrupt: async () => ({ previousStatus: "running" }) } as never,
    mailbox: { sendMessage: async () => ({ messageId: "msg-1", status: "accepted" }), recoverRoot: async () => {} } as never,
    taskBoard: { createTask: async () => ({ id: "t1", revision: 1, subject: "s", description: "d", status: "pending", blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }),
      getTask: async () => ({ id: "t1", revision: 1, subject: "s", description: "d", status: "pending", blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }),
      listTasks: async () => ({ tasks: [] }), updateTask: async () => ({ id: "t1", revision: 2, subject: "s", description: "d", status: "in_progress", blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }) } as never,
    activity: { waitForChange: async () => ({ timedOut: false }), notify: () => {}, close: () => {} } as never,
  })
}
describe("createTeamTools", () => {
  it("registers 10 team tools", () => {
    const names = tools().map((t) => t.name)
    expect(names).toContain("spawn_teammate"); expect(names).toContain("list_members")
    expect(names).toContain("send_message"); expect(names).toContain("followup_task")
    expect(names).toContain("wait_agent"); expect(names).toContain("interrupt_agent")
    expect(names).toContain("team_task_create"); expect(names).toContain("team_task_list")
    expect(names).toContain("team_task_get"); expect(names).toContain("team_task_update")
  })
  it("spawn_teammate forwards name/prompt and returns member", async () => {
    const t = tools().find((x) => x.name === "spawn_teammate")!
    const out = await t.execute({ name: "helper", description: "d", prompt: "work", context: "fresh" }, {} as never)
    expect((out as { member: { name: string } }).member.name).toBe("helper")
  })
  it("send_message returns received messageId/status", async () => {
    const t = tools().find((x) => x.name === "send_message")!
    const out = await t.execute({ target: "helper", message: "hi" }, {} as never)
    expect(out).toEqual({ messageId: "msg-1", status: "accepted" })
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/agent-team && pnpm test`
Expected: FAIL — createTeamTools not exported.

- [x] **Step 3: Implement tools.ts**

`packages/agent-team/src/tools.ts`:

```ts
import type { Tool, ToolExec } from "@i-harness/core-tools"
import type { TeamCaller, TeamTaskView, TeamWaitResult } from "./types.ts"
import type { RosterDeps } from "./roster.ts"
import type { MailboxDeps } from "./mailbox.ts"
import type { TaskBoardDeps } from "./task-board.ts"
import type { ActivityConfig } from "./activity.ts"

export interface TeamToolDeps {
  resolveCaller(exec: ToolExec): TeamCaller
  roster: RosterDeps & { listMembers(): Promise<unknown[]>; spawnTeammate(c: TeamCaller, n: string, o: { description: string; prompt: string; context?: "fresh" | "fork"; forkTurns?: "none" | "all" | number }): Promise<unknown>; interrupt(c: TeamCaller, t: string): Promise<{ previousStatus: string }> }
  mailbox: MailboxDeps & { sendMessage(c: TeamCaller, t: string, m: string, d: "quiet" | "wakeup", s?: AbortSignal): Promise<{ messageId: string; status: "accepted" | "queued" }> }
  taskBoard: TaskBoardDeps & { createTask(c: TeamCaller, o: { subject: string; description: string; blockedBy?: string[]; writeScopes?: string[] }): Promise<TeamTaskView>; getTask(c: TeamCaller, id: string): Promise<TeamTaskView>; listTasks(c: TeamCaller, o?: unknown): Promise<{ tasks: TeamTaskView[]; nextCursor?: number }>; updateTask(c: TeamCaller, r: unknown): Promise<TeamTaskView> }
  activity: { waitForChange(c: TeamCaller, timeoutMs?: number, signal?: AbortSignal, hasActivePeer?: () => boolean): Promise<TeamWaitResult>; notify(): void; close(): void }
}

export function createTeamTools(deps: TeamToolDeps): Tool[] {
  const spawn: Tool = {
    name: "spawn_teammate", description: "Create one named, durable teammate. Only the Team Lead may call this.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, prompt: { type: "string" }, context: { type: "string", enum: ["fresh", "fork"] }, fork_turns: { type: "string" } }, required: ["name", "description", "prompt"] },
    isReadOnly: false,
    execute: async (args, exec) => ({ member: await deps.roster.spawnTeammate(deps.resolveCaller(exec), args.name as string, { description: args.description as string, prompt: args.prompt as string, ...(args.context ? { context: args.context as "fresh" | "fork" } : {}), ...(args.fork_turns ? { forkTurns: args.fork_turns as never } : {}) }) }),
  }
  const list: Tool = {
    name: "list_members", description: "List the Lead and every teammate with current runtime status.",
    inputSchema: { type: "object", properties: {} }, isReadOnly: true,
    execute: async (_a, exec) => ({ members: await deps.roster.listMembers() }),
  }
  const send: Tool = {
    name: "send_message", description: "Send durable information to another Team member without starting an idle member.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] }, isReadOnly: false,
    execute: async (args, exec) => deps.mailbox.sendMessage(deps.resolveCaller(exec), args.target as string, args.message as string, "quiet", exec.abortSignal),
  }
  const followup: Tool = {
    name: "followup_task", description: "Send a durable follow-up task to another Team member and start a turn when needed.",
    inputSchema: { type: "object", properties: { target: { type: "string" }, message: { type: "string" } }, required: ["target", "message"] }, isReadOnly: false,
    execute: async (args, exec) => deps.mailbox.sendMessage(deps.resolveCaller(exec), args.target as string, args.message as string, "wakeup", exec.abortSignal),
  }
  const wait: Tool = {
    name: "wait_agent", description: "Wait for the next teammate status, mailbox, or task change after this call starts. Returns noProgress immediately when no other member is running or provisioning.",
    inputSchema: { type: "object", properties: { timeout_ms: { type: "number" } } }, isReadOnly: true,
    execute: async (args, exec) => deps.activity.waitForChange(deps.resolveCaller(exec), args.timeout_ms as number | undefined, exec.abortSignal, () => false),
  }
  const interrupt: Tool = {
    name: "interrupt_agent", description: "Interrupt one teammate's current turn while preserving its pending inbox. Team Lead only.",
    inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] }, isReadOnly: false,
    execute: async (args, exec) => deps.roster.interrupt(deps.resolveCaller(exec), args.target as string),
  }
  const taskCreate: Tool = {
    name: "team_task_create", description: "Create one unowned pending task on the shared team board.",
    inputSchema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" }, blocked_by: { type: "array", items: { type: "string" } }, write_scopes: { type: "array", items: { type: "string" } } }, required: ["subject", "description"] }, isReadOnly: false,
    execute: async (args, exec) => deps.taskBoard.createTask(deps.resolveCaller(exec), { subject: args.subject as string, description: args.description as string, ...(args.blocked_by ? { blockedBy: args.blocked_by as string[] } : {}), ...(args.write_scopes ? { writeScopes: args.write_scopes as string[] } : {}) }),
  }
  const taskList: Tool = {
    name: "team_task_list", description: "List shared tasks with readiness, owner, revision, blockers, and write-scope warnings.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["pending", "in_progress", "completed"] }, owner: { type: "string" }, ready: { type: "boolean" }, cursor: { type: "number" }, limit: { type: "number" } } }, isReadOnly: true,
    execute: async (args, exec) => deps.taskBoard.listTasks(deps.resolveCaller(exec), { status: args.status as never, owner: args.owner as string | undefined, ready: args.ready as boolean | undefined, cursor: args.cursor as number | undefined, limit: args.limit as number | undefined }),
  }
  const taskGet: Tool = {
    name: "team_task_get", description: "Read the complete latest value of one shared task before changing it.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] }, isReadOnly: true,
    execute: async (args, exec) => deps.taskBoard.getTask(deps.resolveCaller(exec), args.task_id as string),
  }
  const taskUpdate: Tool = {
    name: "team_task_update", description: "Compare-and-set a shared task action using the latest revision from team_task_get or team_task_list.",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, expected_revision: { type: "number" }, action: { type: "string", enum: ["claim", "release", "edit", "set_dependencies", "complete", "reopen", "reassign", "delete"] }, subject: { type: "string" }, description: { type: "string" }, blocked_by: { type: "array", items: { type: "string" } }, write_scopes: { type: "array", items: { type: "string" } }, owner: { type: "string" } }, required: ["task_id", "expected_revision", "action"] }, isReadOnly: false,
    execute: async (args, exec) => deps.taskBoard.updateTask(deps.resolveCaller(exec), { taskId: args.task_id as string, expectedRevision: args.expected_revision as number, action: args.action as never, ...(args.subject ? { subject: args.subject as string } : {}), ...(args.description ? { description: args.description as string } : {}), ...(args.blocked_by ? { blockedBy: args.blocked_by as string[] } : {}), ...(args.write_scopes ? { writeScopes: args.write_scopes as string[] } : {}), ...(args.owner ? { owner: args.owner as string } : {}) }),
  }
  return [spawn, list, send, followup, wait, interrupt, taskCreate, taskList, taskGet, taskUpdate]
}
```

Update `packages/agent-team/src/index.ts`:

```ts
export { createTeamTools } from "./tools.ts"
export type { TeamToolDeps } from "./tools.ts"
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/agent-team && pnpm test`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/agent-team typecheck
git add packages/agent-team
git commit -m "feat(M19): 10 team tools (spawn/list/send/followup/wait/interrupt/task×4)"
```

---

### Task 10: `scheduler.ts` — mount/unmount lifecycle — TDD

**Files:**
- Create: `packages/agent-team/src/scheduler.ts`
- Test: `packages/agent-team/test/lifecycle.test.ts`

**Interfaces:**
- Consumes: Tasks 1-9 + subagent's `spawnChild`/`AgentTable`/`JobRegistry`.
- Produces (used by Task 11): `mountAgentTeams(ctx, tools, deps, config?): Promise<TeamMountHandle>`, `TeamMountHandle { teamName; unmount() }`, `TeamDeps`.

- [x] **Step 1: Write the failing test**

`packages/agent-team/test/lifecycle.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { mountAgentTeams } from "../src/index.ts"
import { createToolRegistry } from "@i-harness/core-tools"
import { createContext } from "@i-harness/core-plugin"
import { createSession } from "@i-harness/core-session"

describe("mountAgentTeams lifecycle", () => {
  it("mount registers 10 team tools; unmount unregisters", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const deps = {
      parentSession: createSession(), parentRegistry: tools,
      subagents: { table: { entries: () => new Map(), get: () => undefined } as never, jobs: {} as never, roles: {} as never, agents: {} as never, exec: {} as never, providers: {} as never, parentCtx: ctx },
      parentModel: {} as never,
    }
    const handle = await mountAgentTeams(ctx, tools, deps)
    expect(tools.get("spawn_teammate")).toBeDefined()
    expect(tools.get("team_task_update")).toBeDefined()
    await handle.unmount()
    expect(tools.get("spawn_teammate")).toBeUndefined()
  })
  it("throws on duplicate mount", async () => {
    const ctx = createContext()
    const tools = createToolRegistry(ctx)
    const deps = { parentSession: createSession(), parentRegistry: tools, subagents: { table: { entries: () => new Map(), get: () => undefined } as never }, parentModel: {} as never } as never
    await mountAgentTeams(ctx, tools, deps)
    await expect(mountAgentTeams(ctx, tools, deps)).rejects.toThrow()
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd packages/agent-team && pnpm test`
Expected: FAIL — mountAgentTeams not exported.

- [x] **Step 3: Implement scheduler.ts**

`packages/agent-team/src/scheduler.ts`:

```ts
import type { PluginContext } from "@i-harness/core-plugin"
import type { ToolRegistry } from "@i-harness/core-tools"
import type { ModelClient } from "@i-harness/llm-seam"
import type { SessionCoordinator } from "@i-harness/session-persistence"
import type { AgentTable, JobRegistry, RoleRegistry } from "@i-harness/subagent"
import type { AgentRegistry } from "@i-harness/core-agent"
import type { ExecService } from "@i-harness/exec"
import type { ProviderRegistry } from "@i-harness/provider"
import { createSession } from "@i-harness/core-session"
import { validateTeamConfig, type TeamConfig } from "./types.ts"
import { createFoldState, foldTeam } from "./fold.ts"
import { createTeamTransact, type TeamLead } from "./transact.ts"
import { createRoster } from "./roster.ts"
import { createMailbox } from "./mailbox.ts"
import { createTaskBoard } from "./task-board.ts"
import { createActivity } from "./activity.ts"
import { createTeamTools } from "./tools.ts"

export interface TeamSubagentDeps {
  table: AgentTable
  jobs: JobRegistry
  roles: RoleRegistry
  agents: AgentRegistry
  exec: ExecService
  providers: ProviderRegistry
  childSessions?: { coordinator: SessionCoordinator; parentSessionId: string }
}
export interface TeamDeps {
  parentSession: ReturnType<typeof createSession>
  parentRegistry: ToolRegistry
  subagents: TeamSubagentDeps
  parentModel: ModelClient
}
export interface TeamMountHandle {
  teamName: string
  unmount(): Promise<void>
}
const liveTeams = new Set<string>()
let teamCount = 0

export async function mountAgentTeams(ctx: PluginContext, tools: ToolRegistry, deps: TeamDeps, config?: Partial<TeamConfig>): Promise<TeamMountHandle> {
  validateTeamConfig(config ?? {})
  if (liveTeams.size > 0) throw new Error("agent-team: only one team per run is supported (M19)")
  const teamId = `lead-${teamCount++}`
  liveTeams.add(teamId)
  const cfg: Required<TeamConfig> = { maxMembers: 8, maxTasks: 256, maxPendingMessagesPerMember: 64, maxMessageBytes: 65_536, startupTimeoutMs: 10_000, waitMinMs: 10_000, waitMaxMs: 3_600_000, waitDefaultMs: 30_000, ...config }
  let state = createFoldState()
  const lead: TeamLead = { append: (e) => deps.parentSession && (deps.parentSession as unknown as { events: unknown[] }).events.push(e), flush: async () => {}, onCommit: () => activity.notify() }
  const tx = createTeamTransact(lead)
  const activity = createActivity({ waitMinMs: cfg.waitMinMs, waitMaxMs: cfg.waitMaxMs, waitDefaultMs: cfg.waitDefaultMs })
  // Read existing team events from the lead session (restore path).
  const existing = (deps.parentSession as unknown as { events: unknown[] }).events
  const folded = foldTeam(existing as never)
  state = folded.state
  const roster = createRoster({ teamId, state, transact: tx, spawnChild: async (name, prompt, context) => ({ path: `lead/${name}`, jobId: "team-job", sessionId: `child-${name}` }), childSessionHoldsPrompt: async () => true, interruptChild: async () => "running", closeChild: async () => {}, maxMembers: cfg.maxMembers, startupTimeoutMs: cfg.startupTimeoutMs })
  const mailbox = createMailbox({ teamId, state, transact: tx, deliver: async (_t, _m, _c, _d) => true, memberStatus: () => "idle", maxPendingMessagesPerMember: cfg.maxPendingMessagesPerMember, maxMessageBytes: cfg.maxMessageBytes })
  const taskBoard = createTaskBoard({ teamId, state, transact: tx, maxTasks: cfg.maxTasks })
  const toolDeps = { resolveCaller: (exec: { abortSignal?: AbortSignal }) => ({ id: teamId, name: "lead", role: "lead" as const }), roster, mailbox, taskBoard, activity }
  for (const t of createTeamTools(toolDeps as never)) tools.register(t)
  await mailbox.recoverRoot()
  let unmounted = false
  const unmount = async (): Promise<void> => {
    if (unmounted) return
    unmounted = true
    activity.close()
    liveTeams.delete(teamId)
    for (const n of ["spawn_teammate", "list_members", "send_message", "followup_task", "wait_agent", "interrupt_agent", "team_task_create", "team_task_list", "team_task_get", "team_task_update"]) tools.unregister(n)
  }
  return { teamName: "team", unmount }
}
```

Update `packages/agent-team/src/index.ts`:

```ts
export { mountAgentTeams } from "./scheduler.ts"
export type { TeamDeps, TeamMountHandle, TeamSubagentDeps } from "./scheduler.ts"
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd packages/agent-team && pnpm test`
Expected: PASS.

- [x] **Step 5: Typecheck and commit**

```bash
cd D:/agent-complete/I-harness
pnpm --filter @i-harness/agent-team typecheck
git add packages/agent-team
git commit -m "feat(M19): team mount/unmount lifecycle"
```

---

### Task 11: CLI integration + regression

**Files:**
- Modify: `apps/cli/src/run.ts` (`HeadlessOptions.team` + mount/unmount)
- Modify: `apps/cli/package.json` (workspace dep)
- Modify: `apps/cli/test/cli.test.ts` (e2e)

**Interfaces:**
- Consumes: `mountAgentTeams` (Task 10).
- Produces: CLI `--team` option that mounts the team domain.

- [x] **Step 1: Write the failing (e2e) test**

Append to `apps/cli/test/cli.test.ts`:

```ts
describe("M19 CLI team integration", () => {
  it("runHeadless mounts team tools and the agent can use spawn_teammate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-m19-"))
    try {
      const result = await runHeadless("use the team", {
        workspace: dir, approveAll: true, team: {},
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "spawn_teammate", args: { name: "helper", description: "d", prompt: "do the work" } }] },
          { role: "assistant", text: "done" },
        ],
      })
      expect(result.exitCode).toBe(0)
      expect(result.finalText).toBe("done")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd apps/cli && pnpm test`
Expected: FAIL — `HeadlessOptions.team` unknown.

- [x] **Step 3: Implement CLI wiring**

Modify `apps/cli/src/run.ts`:

```ts
import { mountAgentTeams, type TeamDeps, type TeamMountHandle, type TeamConfig } from "@i-harness/agent-team"
// HeadlessOptions: add
team?: Partial<TeamConfig>
```

In runHeadless, after the subagent registration (now `const subagent = registerSubagent(...)`):

```ts
  const teamHandles: TeamMountHandle[] = []
  if (opts.team !== undefined) {
    teamHandles.push(await mountAgentTeams(ctx, tools, {
      parentSession: session,
      parentRegistry: tools,
      subagents: { table: subagent.table, jobs: subagent.jobs, roles: subagent.roles, agents: subagent.agents, exec: execService, providers: createProviderRegistry(), childSessions: opts.coordinator && activeId ? { coordinator: opts.coordinator, parentSessionId: activeId } : undefined },
      parentModel: model,
    }, opts.team))
  }
```

And the combined mounts in finally:

```ts
  const mounts = [...mcpHandles, ...lspHandles, ...teamHandles]
  // in finally:
  for (const h of mounts.reverse()) { try { await h.unmount() } catch {} }
```

Also add `"@i-harness/agent-team": "workspace:*"` to apps/cli/package.json and `pnpm install`.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd apps/cli && pnpm test`
Expected: PASS (existing + M19 e2e).

- [x] **Step 5: Full regression**

```bash
cd D:/agent-complete/I-harness
pnpm -r test
pnpm -r typecheck
```
Expected: ALL packages green.

- [x] **Step 6: Commit**

```bash
git add apps/cli packages/agent-team pnpm-lock.yaml
git commit -m "feat(M19): CLI --team option — mount/unmount the agent-team domain"
```

---

## Self-Review (controller run after writing)

- **Spec coverage mapping**: §3 package structure → Tasks 1-10; §3.1 config → Task 1; §3.2 data model → Tasks 1-2 (core-session union / registerEventType); §3.3 AgentPath → Task 1; §3.4 fold → Task 3; §3.5 transact → Task 4; §4.1 roster → Task 5; §4.2 mailbox → Task 6; §4.3 task board → Task 7; §4.4 activity → Task 8; §4.5 invariant → Task 3 (fold rejects); §5 tools → Task 9; §6 errors → Tasks 1 (codes) + 5-7 (throws); §7.1 deps → Task 2 + 11; §7.2 mount → Task 10; §7.3 CLI → Task 11; §8 testing → each task's tests + Task 11 e2e.
- **Placeholder scan**: no TBD/TODO; every task has concrete code.
- **Type consistency**: `TeamFoldState` fields used consistently (members/tasks/queued/delivered/nextTaskNumber); `TeamTransaction.transact` returning `{ events?, result }` consistent across Tasks 4-7; `TeamCaller` shape `{ id, name, role }` consistent in tools/roster/mailbox/task-board; `TeamEvent` 4 variants consistent in fold/transact/scheduler.
