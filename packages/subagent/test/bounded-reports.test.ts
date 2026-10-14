import { expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createMockClient } from "@i-harness/llm-mock"
import { registerExec } from "@i-harness/exec"
import { registerSubagent, SHIPPING_REPORT_POLICY, createTaskRegistry, createNotificationDrain } from "../src/index.ts"

it("bounds aggregate reports and reconstructs owned multilingual results with digest cursors", async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  const sub = registerSubagent(ctx, tools, { parentSession: session, parentModel: createMockClient([]), exec: registerExec(ctx), resolveModel: async () => ({ status: "unconfigured", reason: "unused" }), reportPolicy: SHIPPING_REPORT_POLICY })
  const full = '中文🙂"\n'.repeat(8000)
  const ids: string[] = []
  for (let n = 0; n < 40; n++) {
    const t = sub.tasks.submit({ identity: { parentSessionId: "p", callEventSeq: n }, agentPath: `root/${n}`, description: "description".repeat(500), prompt: "go", agent: "general", delivery: "tool" })
    sub.tasks.terminalize({ taskId: t.id, outcome: "completed", resultText: full })
    ids.push(t.id)
    sub.jobs.registerJob("root", "subagent", `job ${n}`, `job-${n}`)
    sub.jobs.updateJob(`job-${n}`, { status: "completed", output: full })
    sub.table.add(t.agentPath, { path: t.agentPath, finalText: full, status: "completed", session: createSession(), controller: new AbortController(), mailbox: [], jobId: `job-${n}` })
  }
  const list = await tools.execute({ name: "list_agents", args: {} })
  expect(Buffer.byteLength(JSON.stringify(list.output))).toBeLessThanOrEqual(16384)
  expect(list.output).toHaveProperty("next_cursor")
  const listed: string[] = []
  let cursor: string | undefined
  do {
    const { output } = await tools.execute({ name: "list_agents", args: { cursor } }) as any
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(16384)
    listed.push(...output.agents.map((row: any) => row.path))
    cursor = output.next_cursor
  } while (cursor)
  expect(new Set(listed).size).toBe(40)
  expect(listed).toHaveLength(40)
  const changed = sub.table.get("root/0")!
  sub.table.update(changed.path, changed, { finalText: "changed generation" })
  await expect(tools.execute({ name: "list_agents", args: { cursor: (list.output as any).next_cursor } })).rejects.toThrow(/digest changed/)
  sub.table.update(changed.path, changed, { finalText: full })
  const waiting = await tools.execute({ name: "wait_agent", args: { target: "root/0" } })
  expect(Buffer.byteLength(JSON.stringify(waiting.output))).toBeLessThanOrEqual(16384)
  expect(waiting.output).toHaveProperty("full_result")
  const ref = (waiting.output as any).full_result
  const referenced = await tools.execute({ name: ref.tool, args: ref.args }) as any
  expect(referenced.output.text).toContain("中文")
  const many = await tools.execute({ name: "get_task_output", args: { task_ids: ids.slice(0, 20) } })
  expect(Buffer.byteLength(JSON.stringify(many.output))).toBeLessThanOrEqual(16384)
  let offset = 0, digest: string | undefined, reconstructed = ""
  for (;;) {
    const { output } = await tools.execute({ name: "get_task_output", args: { task_ids: [ids[0]], offset_bytes: offset, max_output_bytes: 4096, digest } })
    const page = output as { tasks: { resultText: string; digest: string; next_offset_bytes?: number; truncated: boolean }[] }
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(4096)
    const row = page.tasks[0]!
    expect(row.resultText).not.toContain("�")
    reconstructed += row.resultText
    digest = row.digest
    if (!row.truncated) break
    expect(row.next_offset_bytes).toBeGreaterThan(offset)
    offset = row.next_offset_bytes!
  }
  expect(reconstructed).toBe(full)
  await expect(tools.execute({ name: "get_task_output", args: { task_ids: ["foreign-task"] } })).rejects.toThrow("unknown task")
  await expect(tools.execute({ name: "get_task_output", args: { task_ids: [ids[0]], digest: "stale", offset_bytes: 5 } })).rejects.toThrow(/digest/)
  await sub.dispose()
})

it("actual followup changes a job digest and stale result/list pages refuse mixed generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-result-pages-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "parent" })
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  const first = "FIRST 中文🙂".repeat(4000), second = "SECOND 中文🙂".repeat(5000)
  const sub = registerSubagent(ctx, tools, { parentSession: session, parentModel: createMockClient([{ role: "assistant", text: first }, { role: "assistant", text: second }]), exec: registerExec(ctx), resolveModel: async () => ({ status: "unconfigured", reason: "unused" }), reportPolicy: SHIPPING_REPORT_POLICY, persist: { coordinator, stateId: "parent", parentSessionId: "parent" } })
  try {
    await sub.ready
    sub.roles.register({ name: "bare", description: "controlled no-tool fixture", systemPrompt: "Answer", tools: [] })
    const spawned = (await tools.execute({ name: "spawn_agent", args: { task_name: "worker", message: "go", agent_type: "bare", background: false } })).output as any
    const page = (await tools.execute({ name: "job_output", args: { job_id: spawned.job_id, offset_bytes: 0, max_output_bytes: 4096 } })).output as any
    expect(page.truncated).toBe(true)
    await tools.execute({ name: "followup_task", args: { target: "root/worker", message: "next" } })
    await vi.waitFor(() => expect(sub.jobs.read(spawned.job_id).output).toBe(second))
    await expect(tools.execute({ name: "job_output", args: { job_id: spawned.job_id, offset_bytes: page.next_offset_bytes, digest: page.digest } })).rejects.toThrow(/digest changed/)
    const next = (await tools.execute({ name: "job_output", args: { job_id: spawned.job_id } })).output as any
    expect(next.digest).not.toBe(page.digest)
    expect(next.text).toContain("SECOND")
    const legacyCtx = createContext(), legacyTools = createToolRegistry(legacyCtx)
    const legacy = registerSubagent(legacyCtx, legacyTools, { parentSession: createSession(), parentModel: createMockClient([]), exec: registerExec(legacyCtx), resolveModel: async () => ({ status: "unconfigured", reason: "unused" }) })
    const job = legacy.jobs.registerJob("root", "subagent", "legacy")
    legacy.jobs.updateJob(job.id, { status: "completed", output: first })
    expect((await legacyTools.execute({ name: "job_output", args: { job_id: job.id } })).output).toEqual({ text: `${first}\n[status: completed]`, status: "completed" })
    await legacy.dispose()
  } finally { await sub.dispose(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("strict owned task documents precede a bounded parent notice while full UI presentation remains available", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const documents: any[] = [], admissions: any[] = []
  let wakes = 0
  const coordinator = { putDocumentStrict: async (_: string, data: unknown) => { await held; documents.push(data) }, putDocument: async () => {} } as any
  const tasks = createTaskRegistry({ coordinator, stateId: "owned", reportPolicy: SHIPPING_REPORT_POLICY })
  const full = '中文🙂"\n'.repeat(10000)
  const t = tasks.submit({ identity: { parentSessionId: "p" }, agentPath: "root/a", description: "description".repeat(600), prompt: "go", agent: "general", delivery: "parent" })
  tasks.terminalize({ taskId: t.id, outcome: "completed", resultText: full })
  const drain = createNotificationDrain({ tasks, reportPolicy: SHIPPING_REPORT_POLICY, admit: { admit: async input => { expect(documents.some(doc => doc.tasks.some((row: any) => row.resultText === full))).toBe(true); admissions.push(input) }, wake: () => { wakes++ } } })
  const delivery = drain.drain()
  await Promise.resolve(); expect(admissions).toHaveLength(0)
  release(); await delivery
  expect(wakes).toBe(1)
  expect(Buffer.byteLength(admissions[0].text)).toBeLessThanOrEqual(16384)
  expect(admissions[0].text).toContain("durable")
  expect(admissions[0].display.body).toBe(full)
  expect(tasks.get(t.id)).toMatchObject({ retention: "durable", outcome: "completed" })
})

it("retains a completed outcome and suppresses parent admission until strict retention succeeds", async () => {
  let release!: () => void
  let fail = false
  const held = new Promise<void>(resolve => { release = resolve })
  const coordinator = { putDocumentStrict: async () => { await held; if (fail) throw new Error("disk full") }, putDocument: async () => {} } as any
  let wakes = 0, admissions = 0
  const tasks = createTaskRegistry({ coordinator, stateId: "owned", reportPolicy: SHIPPING_REPORT_POLICY })
  const drain = createNotificationDrain({ tasks, reportPolicy: SHIPPING_REPORT_POLICY, admit: { admit: async () => { admissions++ }, wake: () => { wakes++ } } })
  const t = tasks.submit({ identity: { parentSessionId: "p" }, agentPath: "root/a", description: "a", prompt: "go", agent: "general", delivery: "parent" })
  tasks.terminalize({ taskId: t.id, outcome: "completed", resultText: "side effect actually completed" })
  const delivery = drain.drain()
  await Promise.resolve()
  expect(wakes).toBe(0)
  expect(admissions).toBe(0)
  fail = true; release()
  await expect(delivery).rejects.toThrow("disk full")
  expect(wakes).toBe(0)
  expect(tasks.get(t.id)).toMatchObject({ outcome: "completed", resultText: "side effect actually completed", retention: "failed" })
  expect(tasks.notifications()[0]).toMatchObject({ status: "error" })
})

it("many overlapping completion drains admit each bounded preview once with honest memory references", async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), admitted: string[] = []
  const sub = registerSubagent(ctx, tools, { parentSession: createSession(), parentModel: createMockClient([]), exec: registerExec(ctx), resolveModel: async () => ({ status: "unconfigured", reason: "unused" }), reportPolicy: SHIPPING_REPORT_POLICY,
    parentNotify: { admit: async input => { await Promise.resolve(); admitted.push(input.text) }, wake: () => {} },
  })
  for (let n = 0; n < 30; n++) {
    const task = sub.tasks.submit({ identity: { parentSessionId: "p", callEventSeq: n }, agentPath: `root/${n}`, description: `task ${n}` + "\u0000".repeat(3000), prompt: "go", agent: "general", delivery: "parent" })
    sub.tasks.terminalize({ taskId: task.id, outcome: "completed", resultText: '\u0000結果🙂"\n'.repeat(10000) })
  }
  await vi.waitFor(() => expect(admitted).toHaveLength(30))
  expect(new Set(admitted.map(text => text.match(/<task id="([^"]+)"/)?.[1])).size).toBe(30)
  for (const text of admitted) { expect(Buffer.byteLength(JSON.stringify(text))).toBeLessThanOrEqual(16384); expect(text).toContain("memory"); expect(text).not.toContain("durable") }
  await sub.dispose()
})

it("missing strict persistence capability never labels a completed owned result durable", async () => {
  const tasks = createTaskRegistry({ coordinator: { putDocument: async () => {} } as any, stateId: "owned", reportPolicy: SHIPPING_REPORT_POLICY })
  const task = tasks.submit({ identity: { parentSessionId: "p" }, agentPath: "root/no-strict", description: "owned", prompt: "go", agent: "general", delivery: "tool" })
  tasks.terminalize({ taskId: task.id, outcome: "completed", resultText: "actually completed" })
  await expect(tasks.retainResult(task.id)).rejects.toThrow("Strict result retention is unavailable")
  expect(tasks.get(task.id)).toMatchObject({ outcome: "completed", resultText: "actually completed", retention: "failed" })
})

it("a real completed child tool is never replayed when its full task document retention fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "child-retention-failure-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  await coordinator.create({ sessionId: "parent" })
  const strict = coordinator.putDocumentStrict!.bind(coordinator)
  coordinator.putDocumentStrict = async (key, data) => {
    if (key === "task-parent" && (data as any).tasks.some((task: any) => task.outcome === "completed")) throw new Error("owned result disk full")
    return strict(key, data)
  }
  const ctx = createContext(), tools = createToolRegistry(ctx), admissions: string[] = []
  let sideeffects = 0, modelCalls = 0
  tools.register({ name: "effect", description: "controlled effect", inputSchema: {}, execute: async () => { sideeffects++; return { committed: true } } })
  const model = { async *stream() {
    modelCalls++
    if (modelCalls === 1) yield { type: "tool_call" as const, call: { id: "effect-once", name: "effect", args: {} } }
    else yield { type: "text/chunk" as const, text: "effect actually completed" }
    yield { type: "end" as const }
  } }
  const sub = registerSubagent(ctx, tools, { parentSession: createSession(), parentModel: model, exec: registerExec(ctx), resolveModel: async () => ({ status: "unconfigured", reason: "unused" }), reportPolicy: SHIPPING_REPORT_POLICY, persist: { coordinator, stateId: "parent", parentSessionId: "parent" }, parentNotify: { admit: async input => { admissions.push(input.text) }, wake: () => {} } })
  try {
    await sub.ready
    sub.roles.register({ name: "effect-worker", description: "controlled worker", systemPrompt: "Use effect then report", tools: ["effect"] })
    const spawned = (await tools.execute({ name: "spawn_agent", args: { message: "go", task_name: "effect", agent_type: "effect-worker" } })).output as any
    await vi.waitFor(() => expect(sub.tasks.get(spawned.task_id)).toMatchObject({ outcome: "completed", resultText: "effect actually completed", retention: "failed" }))
    await vi.waitFor(() => expect(sub.tasks.notifications()[0]?.status).toBe("error"))
    expect(admissions).toHaveLength(0)
    expect(sideeffects).toBe(1); expect(modelCalls).toBe(2)
    const inspected = (await tools.execute({ name: "get_task_output", args: { task_ids: [spawned.task_id] } })).output as any
    expect(inspected.tasks[0]).toMatchObject({ outcome: "completed", resultText: "effect actually completed", full_result: { retention: "failed", retention_error: "owned result disk full" } })
    const task = sub.tasks.get(spawned.task_id)!
    await coordinator.flush(task.childSessionId!)
    expect((await coordinator.load(task.childSessionId!)).session.events.some(event => event.type === "tool/result" && (event.output as any).committed === true)).toBe(true)
    expect(sideeffects).toBe(1)
  } finally { await sub.dispose(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
