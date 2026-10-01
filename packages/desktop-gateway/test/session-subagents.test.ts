import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionService, createDurableSessionLoader, type SessionService, type SessionAssembly, type SessionServiceOptions } from "@i-harness/session-executor"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { append, createSession } from "@i-harness/core-session"
import { createDesktopSubagents } from "../src/session-subagents.ts"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-subagent-catalog-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "parent", title: "Parent" })
  await coordinator.create({ sessionId: "other" })
  await coordinator.create({ sessionId: "fork", parentSession: "parent", origin: "fork" })
  for (const [id, parent] of [["normal", "parent"], ["team", "parent"], ["nested", "normal"], ["unrelated", "other"], ["fork-child", "fork"]]) {
    await coordinator.create({ sessionId: id, parentSession: parent, origin: "subagent", seedLength: 0 })
    await coordinator.append(id!, [{ type: "turn/start", seq: 0 }, { type: "user/message", seq: 1, text: `delegated ${id}` }, { type: "assistant/message", seq: 2, text: `${id} result` }, { type: "turn/end", seq: 3 }])
  }
  await coordinator.create({ sessionId: "review", parentSession: "parent", origin: "approval-review", seedLength: 0 })
  await coordinator.create({ sessionId: "legacy-review", parentSession: "parent", origin: "subagent", seedLength: 0 })
  await coordinator.append("legacy-review", [{ type: "user/message", seq: 0, text: 'An agent requests execution of a tool call. Decide: approve (execute now, never ask the user),\nallow (ask the user first), or deny (never execute).\n<request>x</request>\n<recent_context>x</recent_context>\nOutput STRICT JSON only' }])
  await coordinator.create({ sessionId: "legacy-review-child", parentSession: "legacy-review", origin: "subagent", seedLength: 0 })
  await coordinator.append("legacy-review-child", [{ type: "user/message", seq: 0, text: "internal descendant" }])
  await coordinator.putDocument("parent", { formatVersion: 1, roles: [], jobs: [], agentTable: [
    { path: "root/helper", sessionId: "normal", roleName: "explore", modelLabel: "local:small", status: "waiting", mailbox: [], jobId: "subagent-1", finalText: "normal result" },
    { path: "lead/teammate", sessionId: "team", roleName: "teammate", status: "waiting", mailbox: [], jobId: "subagent-2" },
  ] })
  const assemble = vi.fn(async () => { throw new Error("read must not activate a parent") })
  const service = { liveAssembly: () => undefined, liveSession: () => undefined, assemblyFor: assemble } as unknown as SessionService
  return { root, coordinator, service, assemble, close: async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }) } }
}

it("reads normal/team descendants and durable results after restart without activating an Agent, and hides reviewers/fork branches", async () => {
  const f = await fixture()
  try {
    await f.coordinator.close()
    const coordinator = createSessionCoordinator(createJsonlBackend(f.root))
    try {
      const catalog = createDesktopSubagents(coordinator, f.service)
      const result = await catalog.list("parent")
      expect(result.agents.map((row) => row.sessionId).sort()).toEqual(["nested", "normal", "team"])
      expect(result.agents.find((row) => row.sessionId === "normal")).toMatchObject({ path: "root/helper", roleName: "explore", modelLabel: "local:small", status: "completed", finalText: "normal result", live: false, canFollowup: false, canMessage: false, canInterrupt: false, canClose: false, controlReason: expect.any(String) })
      expect(await catalog.history("parent", "nested", { afterSeq: 0, limit: 2 })).toEqual({ events: [expect.objectContaining({ type: "turn/start", seq: 0 }), expect.objectContaining({ type: "user/message", seq: 1 })], nextSeq: 2 })
      expect(await catalog.history("parent", "normal", { afterSeq: Number.MAX_SAFE_INTEGER, limit: 1 })).toEqual({ events: [], nextSeq: 4 })
      expect(f.assemble).not.toHaveBeenCalled()
    } finally { await coordinator.close() }
  } finally { await f.close() }
})

it("rejects unrelated children, forks and reviewers before history or control can activate any runtime", async () => {
  const f = await fixture()
  const catalog = createDesktopSubagents(f.coordinator, f.service)
  try {
    for (const child of ["unrelated", "fork-child", "fork", "review", "legacy-review", "legacy-review-child", "parent"]) {
      await expect(catalog.history("parent", child)).rejects.toThrow(/unavailable|not.*subagent|scope/i)
      await expect(catalog.control("parent", child, { action: "followup", text: "must not reach unrelated agent" })).rejects.toThrow(/unavailable|not.*subagent|scope/i)
    }
    await expect(catalog.control("parent", "normal", { action: "followup", text: "cold control unavailable" })).rejects.toThrow(/runtime|active|unavailable/i)
    expect(f.assemble).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("keeps a scoped unavailable child visible when its transcript fails, without losing healthy siblings", async () => {
  const f = await fixture()
  const snapshot = f.coordinator.snapshot!.bind(f.coordinator)
  f.coordinator.snapshot = async (id) => { if (id === "team") throw new Error("transcript damaged"); return snapshot(id) }
  try {
    const catalog = createDesktopSubagents(f.coordinator, f.service)
    const result = await catalog.list("parent")
    expect(result.agents.find((row) => row.sessionId === "team")).toMatchObject({ status: "unavailable", live: false, canFollowup: false, error: expect.stringContaining("transcript damaged") })
    expect(result.errors).toContainEqual({ sessionId: "team", message: expect.stringContaining("transcript damaged") })
    expect(result.agents.find((row) => row.sessionId === "normal")?.status).toBe("completed")
    expect(f.assemble).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("retains named normal/team catalog rows after their live entries have been closed", async () => {
  const f = await fixture()
  try {
    await f.coordinator.putDocument("parent", { formatVersion: 1, roles: [], jobs: [], agentTable: [] })
    await f.coordinator.putDocument("task-parent", { formatVersion: 1, tasks: [{ childSessionId: "normal", agentPath: "root/named-helper", description: "Named helper", agent: "explore", status: "completed", resultText: "normal result" }], notifications: [] })
    const member = { id: "member-team", name: "named-teammate", description: "saved member", provider: "spawn", context: "fresh" as const, sessionId: "team" }
    await f.coordinator.append("parent", [{ type: "team/member", version: 1, seq: 0, teamId: "saved-team", member: { ...member, phase: "provisioning" } }, { type: "team/member", version: 1, seq: 1, teamId: "saved-team", member: { ...member, phase: "active" } }])
    const result = await createDesktopSubagents(f.coordinator, f.service).list("parent")
    expect(result.agents.find((row) => row.sessionId === "normal")).toMatchObject({ label: "Named helper", roleName: "explore", status: "completed", live: false, canFollowup: false })
    expect(result.agents.find((row) => row.sessionId === "team")).toMatchObject({ label: "named-teammate", roleName: "teammate", status: "completed", live: false, canFollowup: false })
  } finally { await f.close() }
})

it("does not label a newer interrupted followup completed because the original durable task already completed", async () => {
  const f = await fixture()
  try {
    await f.coordinator.putDocument("parent", { formatVersion: 1, roles: [], jobs: [], agentTable: [] })
    await f.coordinator.putDocument("task-parent", { formatVersion: 1, tasks: [{ childSessionId: "normal", agentPath: "root/helper", agent: "explore", status: "completed", resultText: "original result" }], notifications: [] })
    await f.coordinator.append("normal", [{ type: "turn/start", seq: 4 }, { type: "user/message", seq: 5, text: "newer interrupted followup" }])
    const row = (await createDesktopSubagents(f.coordinator, f.service).list("parent")).agents.find((entry) => entry.sessionId === "normal")
    expect(row).toMatchObject({ status: "unavailable", live: false, finalText: "normal result", canFollowup: false, error: expect.stringContaining("interrupted") })
  } finally { await f.close() }
})

it("honors the parent Plan Mode for followup/message while retaining interrupt/close controls", async () => {
  const f = await fixture()
  const tools = createToolRegistry(createContext()), session = createSession()
  append(session, { type: "plan/mode", mode: "on" })
  const mutate = vi.fn(async () => ({ ok: true }))
  for (const name of ["followup_task", "send_message", "interrupt_agent", "close_agent"]) tools.register({ name, description: "fixture", inputSchema: { type: "object" }, execute: mutate })
  const assembly = { tools, session, subagentState: () => ({ formatVersion: 1, agentTable: [{ path: "root/helper", sessionId: "normal", status: "running", mailbox: [] }], jobs: [], roles: [] }) } as unknown as SessionAssembly
  f.service.liveAssembly = () => assembly
  try {
    const catalog = createDesktopSubagents(f.coordinator, f.service)
    expect((await catalog.list("parent")).agents.find((row) => row.sessionId === "normal")).toMatchObject({ live: true, canFollowup: false, canMessage: false, canInterrupt: true, canClose: true, controlReason: expect.stringContaining("Plan Mode") })
    for (const action of ["followup", "message"] as const) await expect(catalog.control("parent", "normal", { action, text: "must stay plan-only" })).rejects.toThrow(/Plan Mode/)
    expect(mutate).not.toHaveBeenCalled()
    await catalog.control("parent", "normal", { action: "interrupt" })
    await catalog.control("parent", "normal", { action: "close" })
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(f.assemble).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("reports an old sequence-corrupt child as unavailable and refuses history without changing its raw log", async () => {
  const f = await fixture()
  try {
    await f.coordinator.create({ sessionId: "corrupt", parentSession: "parent", origin: "subagent", seedLength: 0 })
    await f.coordinator.append("corrupt", [
      { type: "turn/start", seq: 0 }, { type: "user/message", seq: 1, text: "corrupt child task" }, { type: "step/start", seq: 2 },
      { type: "step/end" }, { type: "turn/end" }, { type: "reasoning", seq: 3, text: "late stream" },
      { type: "assistant/message", seq: 4, text: "late final" }, { type: "turn/end", seq: 5 },
    ])
    const path = join(f.root, "corrupt.jsonl"), before = await readFile(path, "utf8")
    const catalog = createDesktopSubagents(f.coordinator, f.service)
    expect((await catalog.list("parent")).agents.find((row) => row.sessionId === "corrupt")).toMatchObject({ status: "unavailable", error: expect.stringContaining("sequence"), canFollowup: false })
    await expect(catalog.history("parent", "corrupt")).rejects.toThrow(/sequence/)
    expect(await readFile(path, "utf8")).toBe(before)
    expect(f.assemble).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("uses exact live SID-to-path authority for controls and refuses a detached runtime after a read", async () => {
  const f = await fixture()
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  const followup = vi.fn(async () => ({ delivered: true }))
  const close = vi.fn(async () => ({ previous_status: "waiting" }))
  const list = vi.fn(async () => ({ agents: [{ path: "root/helper", sessionId: "normal", roleName: "explore", status: "waiting" }, { path: "lead/teammate", sessionId: "team", roleName: "teammate", status: "running" }] }))
  for (const [name, execute] of [["list_agents", list], ["followup_task", followup], ["close_agent", close], ["team_followup_task", followup]]) tools.register({ name: name as string, description: "fixture", inputSchema: { type: "object" }, isReadOnly: name === "list_agents", execute: execute as typeof list })
  let mounted = true
  const assembly = { tools, session, subagentState: () => ({ formatVersion: 1, agentTable: [{ path: "root/helper", sessionId: "normal", roleName: "explore", status: "waiting", mailbox: [] }, { path: "lead/teammate", sessionId: "team", roleName: "teammate", status: "running", mailbox: [] }], jobs: [], roles: [] }) } as unknown as SessionAssembly
  f.service.liveAssembly = () => mounted ? assembly : undefined
  try {
    const catalog = createDesktopSubagents(f.coordinator, f.service)
    expect((await catalog.list("parent")).agents.find((row) => row.sessionId === "normal")).toMatchObject({ live: true, canFollowup: true, canClose: true, canInterrupt: false })
    expect(await catalog.control("parent", "normal", { action: "followup", text: "continue exactly this child" })).toMatchObject({ childSessionId: "normal", result: { delivered: true } })
    expect(followup).toHaveBeenCalledWith({ target: "root/helper", message: "continue exactly this child" }, expect.objectContaining({ sessionId: "parent" }))
    await catalog.control("parent", "team", { action: "followup", text: "team continuation" })
    expect(followup).toHaveBeenLastCalledWith({ target: "teammate", message: "team continuation" }, expect.objectContaining({ sessionId: "parent" }))
    mounted = false
    await expect(catalog.control("parent", "normal", { action: "close" })).rejects.toThrow(/runtime|active|unavailable/i)
    expect(close).not.toHaveBeenCalled()
    expect(f.assemble).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("refuses a child path replaced during the final lineage read instead of controlling the replacement", async () => {
  const f = await fixture()
  const tools = createToolRegistry(createContext())
  let entries = [{ path: "root/helper", sessionId: "normal", status: "waiting", mailbox: [] }]
  const followup = vi.fn(async () => ({ delivered: true }))
  tools.register({ name: "list_agents", description: "fixture", inputSchema: { type: "object" }, isReadOnly: true, execute: async () => ({ agents: entries }) })
  tools.register({ name: "followup_task", description: "fixture", inputSchema: { type: "object" }, execute: followup })
  const assembly = { tools, session: createSession(), subagentState: () => ({ formatVersion: 1, agentTable: entries, jobs: [], roles: [] }) } as unknown as SessionAssembly
  f.service.liveAssembly = () => assembly
  const profile = f.coordinator.profile.bind(f.coordinator)
  let reads = 0
  f.coordinator.profile = async (id) => {
    const result = await profile(id)
    if (id === "normal" && ++reads === 2) entries = [{ path: "root/helper", sessionId: "unrelated", status: "waiting", mailbox: [] }]
    return result
  }
  try {
    const catalog = createDesktopSubagents(f.coordinator, f.service)
    await expect(catalog.control("parent", "normal", { action: "followup", text: "only original child" })).rejects.toThrow(/runtime|active|unavailable/i)
    expect(followup).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it("drives normal and teammate followups through their real owning tools without assembling a child as a main chat", async () => {
  const f = await fixture()
  const parent: NonNullable<SessionServiceOptions["model"]> = { async *stream() { yield { type: "text/chunk", text: "parent done" }; yield { type: "end" } } }
  let turns = 0
  const child: NonNullable<SessionServiceOptions["model"]> = { async *stream() { yield { type: "text/chunk", text: `child-final-${++turns}` }; yield { type: "end" } } }
  const service = createSessionService({ workspace: f.root, coordinator: f.coordinator, sessionFor: createDurableSessionLoader(f.coordinator), model: parent, team: {}, concurrentSessionTeams: true, allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: "local", model: "fixture" }), resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }) })
  try {
    const assembly = await service.assemblyFor("parent")
    const normal = await assembly.tools.get("spawn_agent")!.execute({ task_name: "actual-normal", agent_type: "explore", message: "initial", fork_turns: "none", background: false }, { sessionId: "parent" }) as { agent_path: string }
    await assembly.tools.get("spawn_teammate")!.execute({ name: "actual-team", description: "team", prompt: "initial", context: "fresh" }, { sessionId: "parent" })
    const catalog = createDesktopSubagents(f.coordinator, service)
    await vi.waitFor(async () => expect((await catalog.list("parent")).agents.some((row) => row.path === "lead/actual-team" && row.status !== "running")).toBe(true))
    const before = await catalog.list("parent")
    const normalRow = before.agents.find((row) => row.path === normal.agent_path)!
    const teamRow = before.agents.find((row) => row.path === "lead/actual-team")!
    expect(normalRow.canFollowup).toBe(true); expect(teamRow.canFollowup).toBe(true)
    await catalog.control("parent", normalRow.sessionId, { action: "followup", text: "normal followup" })
    await vi.waitFor(() => expect(turns).toBeGreaterThanOrEqual(3))
    await catalog.control("parent", teamRow.sessionId, { action: "followup", text: "team followup" })
    await vi.waitFor(() => expect(turns).toBe(4))
    expect(service.liveAssembly(normalRow.sessionId)).toBeUndefined()
    expect(service.liveAssembly(teamRow.sessionId)).toBeUndefined()
    await vi.waitFor(async () => expect(JSON.stringify((await catalog.history("parent", teamRow.sessionId)).events)).toContain("team followup"))
  } finally { await service.close(); await f.close() }
}, 15000)
