// G1 (M37b): approval/question bridge — fake SessionService + REAL
// core-plugin ctx harness (createContext): the seam is registered against the
// ctx, so the answerer/provider are read back exactly as core-tools would
// call them. Covers: stream emission order + surface mapping, answerApproval
// resolution, question answer round-trip (and malformed → reject),
// attachApproval forwarding, and listSessionsFromStore over a temp jsonl
// store (direct backend.create/append — read-only listing never locks).

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import type { SessionAssembly } from "@i-harness/session-executor"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import {
  attachApproval,
  createApprovalBridge,
  listSessionsFromStore,
} from "../src/backend/approval.ts"
import type { ApprovalBridge } from "../src/backend/approval.ts"
import type { BackendClient } from "../src/contracts.ts"

const tmp = (): string => mkdtempSync(join(tmpdir(), "ih-tui-approval-"))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Fake SessionService: fires one assembly immediately (a live assembly exists
 * — the TUI attaches after open()) and exposes its real plugin ctx. */
interface FakeService {
  ctx: ReturnType<typeof createContext>
  onAssembly: (hook: (a: SessionAssembly) => void) => () => void
  assemblyFor: (id: string) => Promise<SessionAssembly>
}

function fakeService(): FakeService {
  const ctx = createContext()
  return {
    ctx,
    onAssembly: (hook) => {
      hook({ ctx } as unknown as SessionAssembly)
      return () => {}
    },
    assemblyFor: async () => ({ ctx } as unknown as SessionAssembly),
  }
}

const answererOf = (ctx: ReturnType<typeof createContext>) =>
  ctx.services.get<(req: { name: string; reason: string }) => Promise<boolean>>("approval/answerer")

const providerOf = (ctx: ReturnType<typeof createContext>) =>
  ctx.services.get<{ ask(q: { id: string; prompt: string; options?: string[] }): Promise<string> }>("questions/provider")

const req = (): { name: string; reason: string; command?: string; argv?: string[] } => ({
  name: "bash",
  reason: "dangerous command requires approval: rm -rf node_modules",
  command: "rm -rf node_modules",
  argv: ["rm", "-rf", "node_modules"],
})

describe("createApprovalBridge — approval seam", () => {
  it("onAssembly registers the answerer; requests stream in order as PermissionSurface", async () => {
    const service = fakeService()
    const bridge = createApprovalBridge(service)
    const answerer = answererOf(service.ctx)

    const p1 = answerer(req())
    const p2 = answerer({ name: "write", reason: "write target outside workspace" })
    const it = bridge.approvals()[Symbol.asyncIterator]()
    await sleep(30) // BATCH_MS window elapses
    const s1 = (await it.next()).value
    expect(s1).toMatchObject({
      kind: "bash",
      title: "rm -rf node_modules",
      freeform: true,
      scopes: ["rm -rf node_modules"],
    })
    expect(typeof s1.id).toBe("string")
    expect(s1.detail).toContain("dangerous command requires approval")
    const s2 = (await it.next()).value
    expect(s2).toMatchObject({ kind: "edit", id: expect.any(String) })
    expect(s2.title).toBe("Allow Edit?")

    // answerApproval resolves the parked request (fail-closed: unknown id no-op).
    await bridge.answerApproval(s1.id, { approved: true })
    await expect(p1).resolves.toBe(true)
    await bridge.answerApproval(s2.id, { approved: false })
    await expect(p2).resolves.toBe(false)
  })

  it("never/reject verdicts map to { approved: false } via the boolean seam", async () => {
    const service = fakeService()
    const bridge = createApprovalBridge(service)
    const answerer = answererOf(service.ctx)
    const p = answerer(req())
    await sleep(30)
    const it = bridge.approvals()[Symbol.asyncIterator]()
    const surface = (await it.next()).value
    // reject feedback: the seam is boolean-only (ApprovalDecision has no
    // scope/feedback fields — the host keeps them as its record; the decision
    // that reaches the tool is a plain deny).
    await bridge.answerApproval(surface.id, { approved: false }, { feedback: "do not, it deletes deps" })
    await expect(p).resolves.toBe(false)
  })

  it("answerApproval on an unknown/stale id is a no-op (timeout already decided)", async () => {
    const service = fakeService()
    const bridge = createApprovalBridge(service)
    await expect(bridge.answerApproval("not-a-pending-id", { approved: true })).resolves.toBeUndefined()
  })

  it("mcp requests get `all tools from {Server}` scopes", async () => {
    const service = fakeService()
    const bridge = createApprovalBridge(service)
    const answerer = answererOf(service.ctx)
    const p = answerer({ name: "mcp_brave_search", reason: "tool requires approval" })
    await sleep(30)
    const it = bridge.approvals()[Symbol.asyncIterator]()
    const surface = (await it.next()).value
    expect(surface.kind).toBe("mcp")
    expect(surface.title).toBe("Allow mcp_brave_search?")
    expect(surface.scopes).toContain("all tools from brave")
    expect(surface.scopes).toContain("brave search")
    await bridge.answerApproval(surface.id, { approved: false })
    await expect(p).resolves.toBe(false)
  })
})

describe("createApprovalBridge — question seam", () => {
  it("provider.ask streams a QuestionQuestion; answerQuestion resolves with the value", async () => {
    const service = fakeService()
    const bridge = createApprovalBridge(service)
    const provider = providerOf(service.ctx)

    const p = provider.ask({ id: "q1", prompt: "Pick a fruit\n\nchoose one", options: ["Apple", "Banana"] })
    await sleep(30)
    const it = bridge.questions()[Symbol.asyncIterator]()
    const q = (await it.next()).value
    expect(q).toMatchObject({
      label: "Pick a fruit",
      description: "choose one",
      options: [{ key: "1", label: "Apple" }, { key: "2", label: "Banana" }],
      multi: false,
      freeform: true,
    })
    expect(typeof q.id).toBe("string")
    await bridge.answerQuestion(q.id, { value: "Apple" })
    await expect(p).resolves.toBe("Apple")
  })

  it("malformed answer (non-string value) rejects the ask — never fabricate", async () => {
    const service = fakeService()
    const bridge = createApprovalBridge(service)
    const provider = providerOf(service.ctx)
    const p = provider.ask({ id: "q2", prompt: "how many?", options: ["1", "2"] })
    await sleep(30)
    const it = bridge.questions()[Symbol.asyncIterator]()
    const q = (await it.next()).value
    await bridge.answerQuestion(q.id, { value: 5 as never })
    await expect(p).rejects.toThrow(/malformed/)
  })
})

describe("attachApproval — BackendClient extension (contracts.ts untouched)", () => {
  it("forwards every backend method explicitly and composes the bridge streams", async () => {
    const calls: string[] = []
    const backend: BackendClient = {
      listSessions: async () => { calls.push("listSessions"); return [] },
      open: async () => { calls.push("open") },
      submit: async () => { calls.push("submit") },
      steer: async () => { calls.push("steer") },
      cancel: async () => { calls.push("cancel") },
      events: async function* () { calls.push("events") },
      seqCursor: () => { calls.push("seqCursor"); return 0 },
      replay: async () => { calls.push("replay"); return [] },
      status: () => { calls.push("status"); return { running: false, queued: 0 } },
      close: async () => { calls.push("close") },
    }
    const bridge: ApprovalBridge = {
      approvals: async function* () {}, // never yields (no bridge events)
      answerApproval: async () => { calls.push("answerApproval") },
      questions: async function* () {},
      answerQuestion: async () => { calls.push("answerQuestion") },
    }
    const client = attachApproval(backend, bridge)
    await client.submit("hi")
    await client.open("s1")
    expect(calls).toEqual(["submit", "open"])
    await client.answerApproval("a1", { approved: true })
    expect(calls).toContain("answerApproval")
  })
})

describe("listSessionsFromStore — read-only jsonl enumeration", () => {
  it("lists real sessions with title/updatedAt/turnCount; skips doc sidecars", async () => {
    const dir = tmp()
    const backend = createJsonlBackend(dir)
    const meta = (sessionId: string, title: string) => ({
      formatVersion: 1,
      sessionId,
      createdAt: new Date().toISOString(),
      title,
    })
    await backend.create("s1", meta("s1", "one"))
    await backend.append("s1", [
      { type: "turn/start" },
      { type: "user/message", text: "hi" },
      { type: "turn/end" },
    ])
    await backend.create("s2", meta("s2", "two"))
    await backend.append("s2", [{ type: "turn/start" }])
    // a document sidecar is NOT a session (list filters `*.doc.jsonl`)
    await backend.putDocument("session-title/s1", { title: "one" })

    const sessions = await listSessionsFromStore(dir)
    expect(sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"])
    const s1 = sessions.find((s) => s.id === "s1")!
    expect(s1.title).toBe("one")
    expect(s1.turnCount).toBe(1)
    expect(s1.updatedAt).toBeGreaterThan(0)
    expect(sessions.find((s) => s.id === "s2")).toMatchObject({ title: "two", turnCount: 1 })
  })

  it("returns [] for an empty/absent store", async () => {
    const sessions = await listSessionsFromStore(join(tmp(), "nope"))
    expect(sessions).toEqual([])
  })
})
