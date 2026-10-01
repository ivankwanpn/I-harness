import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createDurableSessionLoader, createSessionService } from "../../session-executor/src/index.ts"
import type { ModelClient, LLMRequest } from "@i-harness/llm-seam"
import type { ParentInputAdmission } from "@i-harness/subagent"
import { SYSTEM_INPUT_PLUGIN, type SessionEvent } from "@i-harness/core-session"

async function fixture(lead: ModelClient, child: ModelClient, parentNotify?: ParentInputAdmission, seed?: SessionEvent[]) {
  const root = await mkdtemp(join(tmpdir(), "team-completion-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "lead" })
  if (seed?.length) await coordinator.append("lead", seed)
  const service = createSessionService({
    workspace: root, model: lead, coordinator, sessionFor: createDurableSessionLoader(coordinator), team: {}, concurrentSessionTeams: true,
    roleSelectionFor: (role) => role === "teammate" ? { provider: "local", model: "fixture" } : undefined,
    allowSubagentModelSelection: true,
    ...(parentNotify ? { parentNotify } : {}),
    resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }),
    additionalTools: [{ name: "continue", description: "Continue the fixture", inputSchema: { type: "object" }, isReadOnly: true, execute: async () => ({ ok: true }) }],
  })
  const assembly = await service.assemblyFor("lead")
  const execute = (name: string, args: unknown) => assembly.tools.get(name)!.execute(args, { sessionId: "lead" })
  return { root, service, assembly, coordinator, execute, close: async () => { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) } }
}

async function assertColdDoesNotWake(root: string, marker: string) {
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  const seen: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { seen.push(request); yield { type: "text/chunk", text: "Unexpected wake" }; yield { type: "end" } } }
  const service = createSessionService({ workspace: root, model, coordinator, sessionFor: createDurableSessionLoader(coordinator), team: {}, concurrentSessionTeams: true })
  try {
    const assembly = await service.assemblyFor("lead")
    await assembly.drainParentNotifications?.()
    expect(assembly.inbox.pending().some((input) => input.text.includes(marker))).toBe(false)
    expect(seen).toEqual([])
  } finally { await service.close(); await coordinator.close() }
}

it("delivers initial and followup teammate finals exactly once to an idle Lead using real service admission", async () => {
  const seen: LLMRequest[] = []
  const lead: ModelClient = { async *stream(request) { seen.push(request); yield { type: "text/chunk", text: "Lead received result" }; yield { type: "end" } } }
  let childTurns = 0
  const child: ModelClient = { async *stream() { yield { type: "text/chunk", text: ++childTurns === 1 ? "TEAMMATE_INITIAL_OK" : "TEAMMATE_FOLLOWUP_OK" }; yield { type: "end" } } }
  const f = await fixture(lead, child)
  try {
    await f.execute("spawn_teammate", { name: "helper", description: "local fixture", prompt: "first", context: "fresh" })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(JSON.stringify(seen[0]!.messages)).toContain("TEAMMATE_INITIAL_OK")
    await vi.waitFor(() => expect(f.service.queueState("lead")).toEqual({ running: false, queued: 0 }))
    expect((await f.execute("list_members", {}) as { members: { name: string; status: string }[] }).members.find((member) => member.name === "helper")?.status).toBe("idle")
    await f.execute("team_followup_task", { target: "helper", message: "followup" })
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(JSON.stringify(seen[1]!.messages)).toContain("TEAMMATE_FOLLOWUP_OK")
    await vi.waitFor(() => expect(f.service.queueState("lead")).toEqual({ running: false, queued: 0 }))
    const admitted = f.assembly.session.events.filter((event) => event.type === "agent/input/admitted")
    expect(admitted.filter((event) => event.type === "agent/input/admitted" && event.text.includes("TEAMMATE_INITIAL_OK"))).toHaveLength(1)
    expect(admitted.filter((event) => event.type === "agent/input/admitted" && event.text.includes("TEAMMATE_FOLLOWUP_OK"))).toHaveLength(1)
    expect((await f.coordinator.snapshot!("lead")).session.events.filter((event) => event.type === "agent/input/admitted")).toHaveLength(2)
    expect(f.assembly.session.events.filter((event) => event.type === "user/message" && event.text.includes("TEAMMATE_")).map((event) => event.type === "user/message" ? event.source : undefined)).toEqual([
      { kind: "plugin", plugin: SYSTEM_INPUT_PLUGIN }, { kind: "plugin", plugin: SYSTEM_INPUT_PLUGIN },
    ])
  } finally { await f.close() }
})

it.each(["R".repeat(65_536), "結果😀".repeat(8_000)])("delivers an oversized UTF-8 result summary and retains the full job output (%#)", async (output) => {
  const seen: LLMRequest[] = []
  const lead: ModelClient = { async *stream(request) { seen.push(request); yield { type: "text/chunk", text: "Lead received summary" }; yield { type: "end" } } }
  const child: ModelClient = { async *stream() { yield { type: "text/chunk", text: output }; yield { type: "end" } } }
  const f = await fixture(lead, child)
  try {
    await f.execute("spawn_teammate", { name: "helper", description: "large result", prompt: "first", context: "fresh" })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    const notification = f.assembly.session.events.find((event) => event.type === "agent/input/admitted")
    expect(notification?.type).toBe("agent/input/admitted")
    if (notification?.type !== "agent/input/admitted") throw new Error("missing notification")
    expect(Buffer.byteLength(notification.text, "utf8")).toBeLessThanOrEqual(65_536)
    expect(notification.text).toContain("Result truncated")
    const jobId = notification.text.match(/job_output\(\{job_id:"([^"]+)"\}\)/)?.[1]
    expect(jobId).toBeDefined()
    expect(notification.text).not.toContain("\uFFFD")
    expect(await f.execute("job_output", { job_id: jobId })).toEqual(expect.objectContaining({ status: "completed", text: `${output}\n[status: completed]` }))
  } finally { await f.close() }
})

it("retries durable Lead messages after publishing the cold assembly and does not deliver them twice", async () => {
  const seen: LLMRequest[] = []
  const lead: ModelClient = { async *stream(request) { seen.push(request); yield { type: "text/chunk", text: "Recovered Lead message" }; yield { type: "end" } } }
  const child: ModelClient = { async *stream() { throw new Error("recovery must not start a child"); yield { type: "end" } } }
  const f = await fixture(lead, child, undefined, [{ type: "team/message/queued", version: 1, seq: 0, teamId: "lead-cold", message: { id: "msg-cold", senderId: "child-old", senderName: "helper", targetId: "lead-cold", delivery: "quiet", content: "COLD_TEAM_RESULT" } }])
  try {
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(JSON.stringify(seen[0]!.messages)).toContain("COLD_TEAM_RESULT")
    await f.service.assemblyFor("lead")
    await vi.waitFor(() => expect(f.service.queueState("lead")).toEqual({ running: false, queued: 0 }))
    expect(seen).toHaveLength(1)
    expect(f.assembly.session.events.filter((event) => event.type === "agent/input/admitted" && event.text.includes("COLD_TEAM_RESULT"))).toHaveLength(1)
    expect(f.assembly.session.events.filter((event) => event.type === "subagent/inbox" && event.messageId === "msg-cold")).toHaveLength(1)
    expect((await f.coordinator.snapshot!("lead")).session.events.filter((event) => event.type === "team/message/delivered" && event.messageId === "msg-cold")).toHaveLength(1)
  } finally { await f.close() }
})

it("preserves an explicitly supplied parent admission adapter", async () => {
  const lead: ModelClient = { async *stream() { throw new Error("explicit adapter owns waking"); yield { type: "end" } } }
  const child: ModelClient = { async *stream() { yield { type: "text/chunk", text: "EXPLICIT_RESULT" }; yield { type: "end" } } }
  const parentNotify = { admit: vi.fn(async () => {}), wake: vi.fn() }
  const f = await fixture(lead, child, parentNotify)
  try {
    await f.execute("spawn_teammate", { name: "helper", description: "custom adapter", prompt: "first", context: "fresh" })
    await vi.waitFor(() => expect(parentNotify.admit).toHaveBeenCalledTimes(1))
    expect(parentNotify.admit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "lead", text: expect.stringContaining("EXPLICIT_RESULT") }))
    expect(parentNotify.wake).toHaveBeenCalledWith("lead")
    expect(f.assembly.inbox.pending()).toEqual([])
  } finally { await f.close() }
})

it("does not reawaken a disposed Lead when a child finishes during service close", async () => {
  let release!: () => void
  const held = new Promise<void>((done) => { release = done })
  const seen: LLMRequest[] = []
  const lead: ModelClient = { async *stream(request) { seen.push(request); yield { type: "text/chunk", text: "unexpected wake" }; yield { type: "end" } } }
  const child: ModelClient = { async *stream() { await held; yield { type: "text/chunk", text: "AFTER_CLOSE" }; yield { type: "end" } } }
  const f = await fixture(lead, child)
  try {
    await f.execute("spawn_teammate", { name: "helper", description: "close fixture", prompt: "first", context: "fresh" })
    const closing = f.service.close()
    release()
    await closing
    expect(seen).toEqual([])
    expect(f.assembly.session.events.filter((event) => event.type === "agent/input/admitted")).toEqual([])
  } finally { release(); await f.close() }
})

it("feeds a busy Lead at its next step and suppresses late completions after cancellation", async () => {
  let releaseLead!: () => void
  const holdLead = new Promise<void>((done) => { releaseLead = done })
  const seen: LLMRequest[] = []
  const lead: ModelClient = { async *stream(request) {
    seen.push(request)
    if (seen.length === 1) { await holdLead; yield { type: "tool_call", call: { id: "next", name: "continue", args: {} } } }
    else {
      if (seen.length >= 3) await new Promise<void>((done) => { if (request.signal?.aborted) done(); else request.signal?.addEventListener("abort", () => done(), { once: true }) })
      yield { type: "text/chunk", text: "Lead received result" }
    }
    yield { type: "end" }
  } }
  let releaseChild!: () => void
  const holdChild = new Promise<void>((done) => { releaseChild = done })
  let turns = 0
  const child: ModelClient = { async *stream() { if (++turns > 1) await holdChild; yield { type: "text/chunk", text: turns === 1 ? "BUSY_RESULT_OK" : "CANCELLED_LATE_RESULT" }; yield { type: "end" } } }
  const f = await fixture(lead, child)
  try {
    const run = f.service.submit("lead", "lead task", new AbortController().signal)
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    await f.execute("spawn_teammate", { name: "helper", description: "busy fixture", prompt: "first", context: "fresh" })
    await vi.waitFor(() => expect(f.assembly.inbox.pending().some((input) => input.text.includes("BUSY_RESULT_OK"))).toBe(true))
    releaseLead(); await run
    await vi.waitFor(() => expect(f.service.queueState("lead")).toEqual({ running: false, queued: 0 }))
    expect(seen).toHaveLength(2)
    expect(JSON.stringify(seen[1]!.messages)).toContain("BUSY_RESULT_OK")
    expect(f.assembly.session.events.find((event) => event.type === "user/message" && event.text === "lead task")).toEqual(expect.not.objectContaining({ source: expect.anything() }))
    const cancelled = f.service.submit("lead", "cancel this turn", new AbortController().signal)
    const cancelledResult = cancelled.catch(() => {})
    await vi.waitFor(() => expect(seen).toHaveLength(3))
    await f.execute("team_followup_task", { target: "helper", message: "delayed followup" })
    expect(f.service.cancelRunning?.("lead").cancelled).toBe(true)
    await cancelledResult
    await f.service.submit("lead", "an already cancelled input must not resume notifications", AbortSignal.abort())
    const before = seen.length
    releaseChild()
    await vi.waitFor(() => expect(f.assembly.session.events.some((event) => event.type === "team/message/queued" && event.message.content.includes("CANCELLED_LATE_RESULT"))).toBe(true))
    expect(f.assembly.inbox.pending().some((input) => input.text.includes("CANCELLED_LATE_RESULT"))).toBe(false)
    expect(seen).toHaveLength(before)
    const late = f.assembly.session.events.find((event) => event.type === "team/message/queued" && event.message.content.includes("CANCELLED_LATE_RESULT"))
    await vi.waitFor(() => expect(f.assembly.session.events.some((event) => event.type === "team/message/delivered" && late?.type === "team/message/queued" && event.messageId === late.message.id)).toBe(true))
    await f.service.close(); await f.coordinator.close()
    await assertColdDoesNotWake(f.root, "CANCELLED_LATE_RESULT")
  } finally { releaseLead(); releaseChild(); await f.close() }
})

it("cancels an admitted notification if Stop arrives during its persistence flush and prevents restart delivery", async () => {
  const seen: LLMRequest[] = []
  const lead: ModelClient = { async *stream(request) {
    seen.push(request)
    await new Promise<void>((done) => { if (request.signal?.aborted) done(); else request.signal?.addEventListener("abort", () => done(), { once: true }) })
    yield { type: "end" }
  } }
  const child: ModelClient = { async *stream() { yield { type: "text/chunk", text: "STOP_DURING_FLUSH" }; yield { type: "end" } } }
  const f = await fixture(lead, child)
  let release!: () => void
  const held = new Promise<void>((done) => { release = done })
  let flushing = false
  const originalFlush = f.coordinator.flush.bind(f.coordinator)
  f.coordinator.flush = async (sessionId) => {
    if (!flushing && f.assembly.inbox.pending().some((input) => input.text.includes("STOP_DURING_FLUSH"))) { flushing = true; await held }
    await originalFlush(sessionId)
  }
  try {
    const run = f.service.submit("lead", "active parent", new AbortController().signal).catch(() => {})
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    await f.execute("spawn_teammate", { name: "helper", description: "flush fixture", prompt: "first", context: "fresh" })
    await vi.waitFor(() => expect(flushing).toBe(true))
    expect(f.service.cancelRunning?.("lead").cancelled).toBe(true)
    await run
    release()
    await vi.waitFor(() => expect(f.assembly.inbox.pending().some((input) => input.text.includes("STOP_DURING_FLUSH"))).toBe(false))
    const notification = f.assembly.session.events.find((event) => event.type === "agent/input/admitted" && event.text.includes("STOP_DURING_FLUSH"))
    expect(f.assembly.session.events.some((event) => event.type === "agent/input/cancelled" && notification?.type === "agent/input/admitted" && event.inputId === notification.inputId)).toBe(true)
    await vi.waitFor(() => expect(f.assembly.session.events.some((event) => event.type === "team/message/delivered")).toBe(true))
    expect(seen).toHaveLength(1)
    await f.service.close(); await f.coordinator.close()
    await assertColdDoesNotWake(f.root, "STOP_DURING_FLUSH")
  } finally { release(); await f.close() }
})
