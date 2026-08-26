// TDD: createTeamTools — 10 team tools wired to roster/mailbox/task-board/activity
// (M19 Task 9).
//
// The stubs below are loosely typed (`as never`) because the test is about
// wiring (names + argument forwarding + return propagation), not the deps' real
// shapes, which are covered by their own tests (Tasks 5-8).
import { describe, expect, it } from "vitest"
import { createTeamTools, createActivity } from "../src/index.ts"
import type { TeamToolDeps } from "../src/index.ts"

const MEMBER = { id: "lead-1", name: "lead", role: "lead" as const, status: "running" as const, diagnostics: [] as string[] }

function tools(overrides?: Partial<TeamToolDeps>) {
  return createTeamTools({
    resolveCaller: () => ({ id: "lead-1", name: "lead", role: "lead" }),
    roster: {
      listMembers: () => [MEMBER],
      spawnTeammate: async (_c: unknown, n: string) => ({ id: "child-1", name: n, role: "teammate", status: "inactive", diagnostics: [] }),
      interrupt: async () => ({ previousStatus: "running" }),
    } as never,
    mailbox: {
      sendMessage: async () => ({ messageId: "msg-1", status: "accepted" }),
      recoverRoot: async () => {},
    } as never,
    taskBoard: {
      createTask: async () => ({ id: "t1", revision: 1, subject: "s", description: "d", status: "pending", blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }),
      getTask: async () => ({ id: "t1", revision: 1, subject: "s", description: "d", status: "pending", blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }),
      listTasks: async () => ({ tasks: [] }),
      updateTask: async () => ({ id: "t1", revision: 2, subject: "s", description: "d", status: "in_progress", blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [] }),
    } as never,
    activity: { waitForChange: async () => ({ timedOut: false }), notify: () => {}, close: () => {} } as never,
    ...overrides,
  } as never)
}

describe("createTeamTools", () => {
  it("registers 10 team tools", () => {
    const names = tools().map((t) => t.name)
    expect(names).toContain("spawn_teammate")
    expect(names).toContain("list_members")
    expect(names).toContain("send_message")
    expect(names).toContain("followup_task")
    expect(names).toContain("wait_agent")
    expect(names).toContain("interrupt_agent")
    expect(names).toContain("team_task_create")
    expect(names).toContain("team_task_list")
    expect(names).toContain("team_task_get")
    expect(names).toContain("team_task_update")
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

  it("wait_agent forwards timeout_ms and abortSignal, and noProgress result passes through", async () => {
    let seen: { caller: unknown; timeout?: number; signal?: AbortSignal; hasActivePeer?: () => boolean } | undefined
    const abortSignal = new AbortController().signal
    const t = tools({
      activity: {
        waitForChange: async (caller: unknown, timeoutMs?: number, signal?: AbortSignal, hasActivePeer?: () => boolean) => {
          seen = { caller, timeout: timeoutMs, signal, hasActivePeer }
          return { timedOut: false }
        },
        notify: () => {},
        close: () => {},
      } as never,
    }).find((x) => x.name === "wait_agent")!
    const out = await t.execute({ timeout_ms: 123 }, { abortSignal } as never)
    expect(out).toEqual({ timedOut: false })
    expect((seen!.caller as { id: string }).id).toBe("lead-1")
    expect(seen!.timeout).toBe(123)
    expect(seen!.signal).toBe(abortSignal)
    // noProgress check with the stub roster (only the caller itself active) → false
    expect(seen!.hasActivePeer!()).toBe(false)
  })

  it("wait_agent noProgress: real activity returns immediate noProgress when only the caller is active", async () => {
    // Real activity (small waitMinMs per Ruling 6) + stub roster with only the
    // lead pseudo-row: wait_agent must NOT wait a full 30s; it short-circuits
    // with noProgress because no OTHER member is running/provisioning.
    const act = createActivity({ waitMinMs: 10, waitMaxMs: 3_600_000, waitDefaultMs: 30_000 })
    const t = tools({ activity: act as never }).find((x) => x.name === "wait_agent")!
    const t0 = Date.now()
    const out = await t.execute({ timeout_ms: 30_000 }, {} as never)
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect((out as { timedOut: boolean }).timedOut).toBe(false)
    expect((out as { noProgress?: { reason: string } }).noProgress?.reason).toBe("no-active-peer")
  })
})
