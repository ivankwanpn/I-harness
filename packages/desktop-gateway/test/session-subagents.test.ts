import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSessionService, createDurableSessionLoader, type SessionService, type SessionAssembly, type SessionServiceOptions } from "@i-harness/session-executor"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { append, createSession, copyConversationData, decodeFactBatch } from "@i-harness/core-session"
import { createDesktopSubagents } from "../src/session-subagents.ts"
import { createAgentTable, createTaskRegistry, taskDocKey, type TaskProtocolDocument } from "@i-harness/subagent"
import { createChildObservation } from "../../session-executor/src/child-observation.ts"

it("real service pushes one committed child result after its actual receipt, with lineage checked before live access", async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-child-push-assembly-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { maxDelayMs: 60_000, lock: { enabled: true } })
  for (const sessionId of ['parent', 'other']) await coordinator.create({ sessionId })
  const resultEntered = Promise.withResolvers<void>(), releaseResult = Promise.withResolvers<void>()
  const childSecondRequest = Promise.withResolvers<void>(), releaseChild = Promise.withResolvers<void>()
  let childRequests = 0, parentRequests = 0, resultFrames = 0, finalizations = 0
  const child: NonNullable<SessionServiceOptions['model']> = controlledModel(request => ({ async *stream() {
    if (++childRequests === 1) yield { type: 'tool_call', call: { id: 'child-list', name: 'list_dir', args: { path: '.' } } }
    else { childSecondRequest.resolve(); await releaseChild.promise; yield { type: 'text/chunk', text: 'original child final' } }
    yield { type: 'end' }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const parent: NonNullable<SessionServiceOptions['model']> = controlledModel(request => ({ async *stream() {
    if (++parentRequests === 1) yield { type: 'tool_call', call: { name: 'wait_agent', args: { target: 'root/actual', timeout_ms: 300_000 } } }
    else yield { type: 'text/chunk', text: 'parent finished' }
    yield { type: 'end' }
  } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model: parent, approveAll: true, sandbox: 'danger-full-access',
    allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: 'fixture', model: 'child' }), resolveRoleModel: async () => ({ status: 'ready', binding: { client: child } }),
  })
  const assembly = await service.assemblyFor('parent')
  assembly.ctx.on('tools/post-execute', event => { if ((event as { name: string }).name === 'list_dir') finalizations++ })
  const actualAppend = backend.appendOwnedBatch!
  let childId = ''
  backend.appendOwnedBatch = async (...args) => {
    if (args[0].startsWith('child-') && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'tool/result' && event.callId === 'child-list')) {
      resultFrames++; childId = args[0]; resultEntered.resolve(); await releaseResult.promise
    }
    return actualAppend(...args)
  }
  const changed = vi.fn(), pushedResults: unknown[] = []
  const catalog = createDesktopSubagents(coordinator, service, { onChanged(id) {
    changed(id)
    const result = childId ? assembly.liveChildSession!(childId)?.events.find(event => event.type === 'tool/result' && event.callId === 'child-list') : undefined
    if (result && !pushedResults.includes(result)) pushedResults.push(result)
  } })
  let turn: Promise<unknown> | undefined
  try {
    await assembly.tools.get('spawn_agent')!.execute({ task_name: 'actual', agent_type: 'explore', message: 'read the workspace', background: true }, { sessionId: 'parent' })
    await resultEntered.promise
    expect(childRequests).toBe(1)
    turn = service.submit('parent', 'observe actual child', new AbortController().signal)
    await vi.waitFor(() => expect(assembly.session.events.some(event => event.type === 'tool/dispatch')).toBe(true))
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('parent'))
    expect(service.queueState('parent').running).toBe(true)
    expect(assembly.session.events.filter(event => event.type === 'tool/result' && event.name === 'wait_agent')).toHaveLength(0)
    const originalAccess = assembly.liveChildSession!, access = vi.fn(originalAccess)
    assembly.liveChildSession = access
    const flush = vi.spyOn(coordinator, 'flush'), assemble = vi.spyOn(service, 'assemblyFor')
    await expect(catalog.history('parent', childId)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(access).not.toHaveBeenCalled()
    expect(assembly.liveChildSession!(childId)!.events.some(event => event.type === 'tool/result' && event.callId === 'child-list')).toBe(false)
    expect((await backend.read(childId)).events.some(event => event.type === 'tool/result' && event.callId === 'child-list')).toBe(false)
    await expect(coordinator.snapshot!(childId)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(pushedResults).toEqual([])
    access.mockClear()
    await expect(catalog.history('other', childId)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(access).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled(); expect(assemble).not.toHaveBeenCalled()
    const requestsBefore = [parentRequests, childRequests]
    await expect(catalog.history('parent', childId)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect([parentRequests, childRequests]).toEqual(requestsBefore)
    releaseResult.resolve()
    await childSecondRequest.promise
    await vi.waitFor(() => expect(pushedResults).toHaveLength(1))
    const saved = (await coordinator.snapshot!(childId)).session
    const live = assembly.liveChildSession!(childId)!
    const result = live.events.filter(event => event.type === 'tool/result' && event.callId === 'child-list')
    expect(result).toHaveLength(1)
    expect(saved.events.filter(event => event.type === 'tool/result' && event.callId === 'child-list')).toEqual(result)
    flush.mockClear(); assemble.mockClear()
    const afterRequests = [parentRequests, childRequests]
    expect((await catalog.history('parent', childId)).events).toEqual(live.events)
    expect((await catalog.list('parent')).agents.find(row => row.sessionId === childId)).toMatchObject({ live: true, status: 'running', path: 'root/actual' })
    access.mockClear()
    await expect(catalog.history('other', childId)).rejects.toThrow(/scope/)
    expect(access).not.toHaveBeenCalled(); expect(flush).not.toHaveBeenCalled(); expect(assemble).not.toHaveBeenCalled()
    expect([parentRequests, childRequests]).toEqual(afterRequests)
    expect(service.liveSession(childId)).toBeUndefined(); expect(service.liveAssembly(childId)).toBeUndefined()
    expect([resultFrames, finalizations]).toEqual([1, 1])
    assembly.liveChildSession = originalAccess; flush.mockRestore(); assemble.mockRestore()
    releaseChild.resolve(); await turn
    expect(childRequests).toBe(2)
    expect((await catalog.history('parent', childId)).events.some(event => event.type === 'assistant/message' && event.text === 'original child final')).toBe(true)
  } finally {
    releaseResult.resolve(); releaseChild.resolve(); await turn?.catch(() => {})
    await catalog.close(); await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true })
  }
}, 15_000)
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-subagent-catalog-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
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
  const service = { liveAssembly: () => undefined, liveSession: () => undefined, assemblyFor: assemble, onAssembly: () => () => {} } as unknown as SessionService
  return { root, coordinator, service, assemble, close: async () => { await coordinator.close(); await rm(root, { recursive: true, force: true }) } }
}

function observedRuntime(f: Awaited<ReturnType<typeof fixture>>) {
  const assemblies = new Map<string, SessionAssembly>()
  const hooks = new Set<(assembly: SessionAssembly) => void>()
  f.service.liveAssembly = id => assemblies.get(id)
  f.service.onAssembly = (hook, options) => { hooks.add(hook); if (options?.includeExisting) for (const assembly of assemblies.values()) hook(assembly); return () => { hooks.delete(hook) } }
  function mount(sessionId: string) {
    const table = createAgentTable(), monitor = createChildObservation(table)
    const assembly = { sessionId, session: createSession(), tools: createToolRegistry(createContext()), subagentState: () => ({ formatVersion: 1, jobs: [], roles: [], agentTable: [...table.entries().values()] }), liveChildSession: monitor.liveSession, onSubagentsChanged: monitor.subscribe } as unknown as SessionAssembly
    assemblies.set(sessionId, assembly)
    for (const hook of hooks) hook(assembly)
    return { assembly, table, monitor }
  }
  return { mount, hooks }
}

it("reads actual unflushed durable child history and catalog without any parent event or widened root authority", async () => {
  const f = await fixture(), runtime = observedRuntime(f), owner = runtime.mount("parent")
  const session = copyConversationData((await f.coordinator.snapshot!("normal")).session)
  owner.table.add("root/helper", { path: "root/helper", sessionId: "normal", session, status: "running", controller: new AbortController(), mailbox: [] })
  const catalog = createDesktopSubagents(f.coordinator, f.service)
  const flush = vi.spyOn(f.coordinator, "flush"), access = vi.fn(owner.assembly.liveChildSession!)
  owner.assembly.liveChildSession = access
  try {
    append(session, { type: "tool/result", name: "controlled", callId: "unflushed", output: "live result before turn end" })
    append(session, { type: "assistant/message", text: "live final before flush" })
    expect((await f.coordinator.snapshot!("normal")).session.events).toHaveLength(4)
    expect((await catalog.history("parent", "normal")).events.at(-2)).toMatchObject({ type: "tool/result", output: "live result before turn end", seq: 4 })
    expect((await catalog.list("parent")).agents.find(row => row.sessionId === "normal")).toMatchObject({ finalText: "live final before flush", status: "running", live: true })
    expect(owner.assembly.session.events).toHaveLength(0)
    access.mockClear()
    await expect(catalog.history("other", "normal")).rejects.toThrow(/scope/)
    expect(access).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
    expect(f.service.liveSession("normal")).toBeUndefined()
    expect(f.assemble).not.toHaveBeenCalled()
  } finally { await catalog.close(); owner.monitor.dispose(); await f.close() }
})

it("reads restored Session replacements and validates sequence invariants on the selected live Session", async () => {
  const f = await fixture(), owner = observedRuntime(f).mount("parent")
  const stub = createSession(), row = { path: "root/helper", sessionId: "normal", session: stub, status: "waiting" as const, controller: new AbortController(), mailbox: [] }
  owner.table.add(row.path, row)
  const catalog = createDesktopSubagents(f.coordinator, f.service)
  try {
    expect((await catalog.history("parent", "normal")).events).toEqual([])
    const restored = copyConversationData((await f.coordinator.snapshot!("normal")).session)
    owner.table.update(row.path, row, { session: restored })
    append(restored, { type: "tool/result", name: "controlled", callId: "restored", output: "restored live result" })
    expect((await catalog.history("parent", "normal")).events.at(-1)).toMatchObject({ output: "restored live result" })
    restored.events[0]!.seq = 9
    await expect(catalog.history("parent", "normal")).rejects.toThrow(/sequence/)
    expect((await catalog.list("parent")).agents.find(row => row.sessionId === "normal")).toMatchObject({ live: false, status: "unavailable", error: expect.stringContaining("sequence") })
  } finally { await catalog.close(); owner.monitor.dispose(); await f.close() }
})

it("reads lineage-validated intermediate owner history from its root registry", async () => {
  const f = await fixture(), owner = observedRuntime(f).mount("parent")
  const session = copyConversationData((await f.coordinator.snapshot!("normal")).session)
  owner.table.add("root/helper", { path: "root/helper", sessionId: "normal", session, status: "waiting", controller: new AbortController(), mailbox: [] })
  const member = { id: "live-member", name: "Live nested member", description: "live", provider: "spawn", context: "fresh" as const, sessionId: "nested" }
  append(session, { type: "team/member", version: 1, teamId: "live-team", member: { ...member, phase: "provisioning" } })
  append(session, { type: "team/member", version: 1, teamId: "live-team", member: { ...member, phase: "active" } })
  const catalog = createDesktopSubagents(f.coordinator, f.service)
  try {
    expect((await catalog.list("parent")).agents.find(row => row.sessionId === "nested")).toMatchObject({ label: "Live nested member", roleName: "teammate" })
  } finally { await catalog.close(); owner.monitor.dispose(); await f.close() }
})

it("coalesces 100 child changes into one root invalidation and has no idle timer", async () => {
  const f = await fixture(), runtime = observedRuntime(f), owner = runtime.mount("parent")
  vi.useFakeTimers()
  const changed = vi.fn(), catalog = createDesktopSubagents(f.coordinator, f.service, { onChanged: changed })
  try {
    vi.advanceTimersByTime(50); changed.mockClear()
    expect(vi.getTimerCount()).toBe(0)
    const session = createSession()
    owner.table.add("root/new", { path: "root/new", sessionId: "new", session, status: "running", controller: new AbortController(), mailbox: [] })
    for (let i = 0; i < 100; i++) append(session, { type: "user/message", text: `durable-${i}` })
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(49); expect(changed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); expect(changed).toHaveBeenCalledExactlyOnceWith("parent")
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10000); expect(changed).toHaveBeenCalledOnce()
  } finally { await catalog.close(); owner.monitor.dispose(); vi.useRealTimers(); await f.close() }
})

it("replaces root subscriptions, invalidates a closing root once, and disconnects pending gateway work", async () => {
  const f = await fixture(), runtime = observedRuntime(f)
  vi.useFakeTimers()
  const changed = vi.fn(), catalog = createDesktopSubagents(f.coordinator, f.service, { onChanged: changed })
  const first = runtime.mount("parent"), unrelated = runtime.mount("other")
  try {
    vi.advanceTimersByTime(50); changed.mockClear()
    const firstSession = createSession()
    first.table.add("root/old", { path: "root/old", sessionId: "old", session: firstSession, status: "running", controller: new AbortController(), mailbox: [] })
    const next = runtime.mount("parent")
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(50); changed.mockClear()
    append(firstSession, { type: "user/message", text: "stale parent" })
    first.monitor.dispose()
    expect(vi.getTimerCount()).toBe(0)
    next.monitor.dispose(); next.monitor.dispose()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(50)
    expect(changed).toHaveBeenCalledExactlyOnceWith("parent")
    changed.mockClear()
    unrelated.table.add("other/child", { path: "other/child", sessionId: "unrelated", session: createSession(), status: "running", controller: new AbortController(), mailbox: [] })
    vi.advanceTimersByTime(50)
    expect(changed).toHaveBeenCalledExactlyOnceWith("other")
    changed.mockClear()
    unrelated.table.update("other/child", unrelated.table.get("other/child")!, { status: "waiting" })
    await catalog.close()
    expect(vi.getTimerCount()).toBe(0)
    expect(runtime.hooks.size).toBe(0)
    unrelated.monitor.dispose()
    vi.advanceTimersByTime(1000)
    expect(changed).not.toHaveBeenCalled()
  } finally { await catalog.close(); first.monitor.dispose(); unrelated.monitor.dispose(); vi.useRealTimers(); await f.close() }
})

it("coalesces control and child lifecycle invalidations and isolates failed notification consumers", async () => {
  const f = await fixture(), owner = observedRuntime(f).mount("parent")
  const row = { path: "root/helper", sessionId: "normal", session: createSession(), status: "waiting" as const, controller: new AbortController(), mailbox: [] }
  owner.table.add(row.path, row)
  owner.assembly.tools.register({ name: "followup_task", description: "controlled", inputSchema: {}, execute: async () => { owner.table.update(row.path, row, { status: "waiting" }); return { accepted: true } } })
  vi.useFakeTimers()
  const changed = vi.fn(() => { throw new Error("detached Desktop") })
  const catalog = createDesktopSubagents(f.coordinator, f.service, { onChanged: changed })
  try {
    expect(() => vi.advanceTimersByTime(50)).not.toThrow(); changed.mockClear()
    await expect(catalog.control("parent", "normal", { action: "followup", text: "next" })).resolves.toMatchObject({ result: { accepted: true } })
    expect(vi.getTimerCount()).toBe(1)
    expect(() => vi.advanceTimersByTime(50)).not.toThrow()
    expect(changed).toHaveBeenCalledExactlyOnceWith("parent")
    expect(vi.getTimerCount()).toBe(0)
  } finally { await catalog.close(); owner.monitor.dispose(); vi.useRealTimers(); await f.close() }
})

it("unsubscribes already attached assemblies and clears timers when initial hook setup fails", async () => {
  const f = await fixture(), runtime = observedRuntime(f), first = runtime.mount("parent"), second = runtime.mount("other")
  const off = vi.fn()
  first.assembly.onSubagentsChanged = () => off
  second.assembly.onSubagentsChanged = () => { throw new Error("attach failed") }
  vi.useFakeTimers()
  try {
    expect(() => createDesktopSubagents(f.coordinator, f.service)).toThrow("attach failed")
    expect(off).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally { first.monitor.dispose(); second.monitor.dispose(); vi.useRealTimers(); await f.close() }
})

it("closes observations immediately while draining an already executing control write", async () => {
  const f = await fixture(), owner = observedRuntime(f).mount("parent")
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  owner.table.add("root/helper", { path: "root/helper", sessionId: "normal", session: createSession(), status: "waiting", controller: new AbortController(), mailbox: [] })
  owner.assembly.tools.register({ name: "followup_task", description: "controlled", inputSchema: {}, execute: async () => { entered(); await gate; return { completed: true } } })
  const changed = vi.fn(), catalog = createDesktopSubagents(f.coordinator, f.service, { onChanged: changed })
  try {
    const write = catalog.control("parent", "normal", { action: "followup", text: "controlled write" })
    await started
    let drained = false
    const close = catalog.close().then(() => { drained = true })
    changed.mockClear()
    await Promise.resolve()
    expect(drained).toBe(false)
    await expect(catalog.history("parent", "normal")).rejects.toThrow(/closed/)
    release()
    await expect(write).resolves.toMatchObject({ result: { completed: true } })
    await close
    expect(drained).toBe(true)
    expect(changed).not.toHaveBeenCalled()
  } finally { release(); await catalog.close(); owner.monitor.dispose(); await f.close() }
})

it("detaches an old observer when its root is replaced by a host without the optional child observation seam", async () => {
  const f = await fixture(), runtime = observedRuntime(f), old = runtime.mount("parent")
  const subscribe = old.assembly.onSubagentsChanged!, off = vi.fn()
  old.assembly.onSubagentsChanged = listener => { const unsubscribe = subscribe(listener); return () => { off(); unsubscribe() } }
  vi.useFakeTimers()
  const changed = vi.fn(), catalog = createDesktopSubagents(f.coordinator, f.service, { onChanged: changed })
  try {
    vi.advanceTimersByTime(50); changed.mockClear()
    old.table.add("root/child", { path: "root/child", sessionId: "normal", session: createSession(), status: "running", controller: new AbortController(), mailbox: [] })
    const replacement = { sessionId: "parent" } as SessionAssembly
    f.service.liveAssembly = () => replacement
    for (const hook of runtime.hooks) hook(replacement)
    expect(off).toHaveBeenCalledOnce()
    old.monitor.dispose()
    vi.advanceTimersByTime(50)
    expect(changed).toHaveBeenCalledExactlyOnceWith("parent")
    changed.mockClear()
    old.table.add("root/stale", { path: "root/stale", sessionId: "stale", session: createSession(), status: "running", controller: new AbortController(), mailbox: [] })
    expect(vi.getTimerCount()).toBe(0)
  } finally { await catalog.close(); old.monitor.dispose(); vi.useRealTimers(); await f.close() }
})

it("reads normal/team descendants and durable results after restart without activating an Agent, and hides reviewers/fork branches", async () => {
  const f = await fixture()
  try {
    await f.coordinator.close()
    const coordinator = createSessionCoordinator(createJsonlBackend(f.root), { lock: { enabled: true } })
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
    await f.coordinator.putDocument("task-parent", { formatVersion: 1, tasks: [{ childSessionId: "normal", agentPath: "root/named-helper", description: "Named helper", agent: "explore", modelLabel: "deepseek:deepseek-flash", status: "completed", resultText: "normal result" }], notifications: [] })
    const member = { id: "member-team", name: "named-teammate", description: "saved member", provider: "spawn", context: "fresh" as const, sessionId: "team" }
    await f.coordinator.append("parent", [{ type: "team/member", version: 1, seq: 0, teamId: "saved-team", member: { ...member, phase: "provisioning" } }, { type: "team/member", version: 1, seq: 1, teamId: "saved-team", member: { ...member, phase: "active" } }])
    const result = await createDesktopSubagents(f.coordinator, f.service).list("parent")
    expect(result.agents.find((row) => row.sessionId === "normal")).toMatchObject({ label: "Named helper", roleName: "explore", modelLabel: "deepseek:deepseek-flash", status: "completed", live: false, canFollowup: false })
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

it.each([
  { liveStatus: "running", currentError: undefined, expectedStatus: "running" },
  { liveStatus: "waiting", currentError: undefined, expectedStatus: "waiting" },
  { liveStatus: undefined, currentError: undefined, expectedStatus: "completed" },
  { liveStatus: "waiting", currentError: "retry failed", expectedStatus: "waiting" },
  { liveStatus: undefined, currentError: "retry failed", expectedStatus: "completed" },
])("uses the current registry error after a retry ($liveStatus, $currentError)", async ({ liveStatus, currentError, expectedStatus }) => {
  const f = await fixture()
  try {
    const entry = { path: "root/helper", sessionId: "normal", roleName: "explore", mailbox: [], finalText: "recovered" }
    await f.coordinator.putDocument("task-parent", { formatVersion: 1, tasks: [{ childSessionId: "normal", agentPath: entry.path, status: "error", error: "original task failed" }], notifications: [] })
    await f.coordinator.putDocument("parent", { formatVersion: 1, roles: [], jobs: [], agentTable: [{ ...entry, status: "waiting", ...(liveStatus ? { error: "stale saved error" } : currentError ? { error: currentError } : {}) }] })
    if (liveStatus) {
      const assembly = { tools: createToolRegistry(createContext()), session: createSession(), subagentState: () => ({ formatVersion: 1, roles: [], jobs: [], agentTable: [{ ...entry, status: liveStatus, ...(currentError ? { error: currentError } : {}) }] }) } as unknown as SessionAssembly
      f.service.liveAssembly = () => assembly
    }
    const row = (await createDesktopSubagents(f.coordinator, f.service).list("parent")).agents.find((agent) => agent.sessionId === "normal")
    expect(row).toMatchObject({ status: expectedStatus, finalText: "recovered", live: Boolean(liveStatus) })
    expect(row?.error).toBe(currentError)
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
    const legacyEvents = [
      { type: "turn/start", seq: 0 }, { type: "user/message", seq: 1, text: "corrupt child task" }, { type: "step/start", seq: 2 },
      { type: "step/end" }, { type: "turn/end" }, { type: "reasoning", seq: 3, text: "late stream" },
      { type: "assistant/message", seq: 4, text: "late final" }, { type: "turn/end", seq: 5 },
    ]
    // This deliberately invalid historical file cannot be created through a
    // current atomic writer. Preserve the old raw sequence-corruption input.
    const path = join(f.root, "corrupt.jsonl")
    const header = JSON.parse((await readFile(path, 'utf8')).split('\n')[0]!)
    delete header.journal
    await writeFile(path, JSON.stringify({ ...header, formatVersion: 4 }) + '\n' + legacyEvents.map(event => JSON.stringify(event)).join('\n') + '\n')
    const before = await readFile(path, "utf8")
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
  const parent: NonNullable<SessionServiceOptions["model"]> = controlledModel(request => ({ async *stream() { yield { type: "text/chunk", text: "parent done" }; yield { type: "end" } } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  let turns = 0
  const child: NonNullable<SessionServiceOptions["model"]> = controlledModel(request => ({ async *stream() { yield { type: "text/chunk", text: `child-final-${++turns}` }; yield { type: "end" } } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const service = createSessionService({ workspace: f.root, coordinator: f.coordinator, sessionFor: createDurableSessionLoader(f.coordinator), model: parent, team: {}, concurrentSessionTeams: true, allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: "local", model: "fixture" }), resolveRoleModel: async () => ({ status: "ready", binding: { client: child } }) })
  const catalog = createDesktopSubagents(f.coordinator, service)
  try {
    const assembly = await service.assemblyFor("parent")
    const normal = await assembly.tools.get("spawn_agent")!.execute({ task_name: "actual-normal", agent_type: "explore", message: "initial", fork_turns: "none", background: false }, { sessionId: "parent" }) as { agent_path: string }
    await assembly.tools.get("spawn_teammate")!.execute({ name: "actual-team", description: "team", prompt: "initial", context: "fresh" }, { sessionId: "parent" })
    const settleOwnedTurn = async (path: string, finalText: string) => {
      // Both root/ and lead/ entries belong to this parent's shared registry.
      // Wait on that owner, then flush the actual child log before catalog reads.
      const result = await assembly.tools.get("wait_agent")!.execute({ target: path }, { sessionId: "parent" }) as { path: string; status: string; timed_out: boolean; finalText?: string; error?: string }
      expect(result).toMatchObject({ path, status: "waiting", timed_out: false, finalText })
      expect(result.error).toBeUndefined()
      const owned = assembly.subagentState().agentTable.find(row => row.path === path)!
      expect(owned).toMatchObject({ path, sessionId: expect.any(String), jobId: expect.any(String) })
      const output = await assembly.tools.get("job_output")!.execute({ job_id: owned.jobId! }, { sessionId: "parent" }) as { status: string }
      expect(output.status).toBe("completed")
      await f.coordinator.flush(owned.sessionId!)
      await f.coordinator.flush("parent")
    }
    await settleOwnedTurn(normal.agent_path, "child-final-1")
    await settleOwnedTurn("lead/actual-team", "child-final-2")
    const before = await catalog.list("parent")
    await vi.waitFor(() => expect(before.agents.some(row => row.path === "lead/actual-team" && row.status !== "running")).toBe(true))
    const normalRow = before.agents.find((row) => row.path === normal.agent_path)!
    const teamRow = before.agents.find((row) => row.path === "lead/actual-team")!
    expect(normalRow.canFollowup).toBe(true); expect(teamRow.canFollowup).toBe(true)
    await catalog.control("parent", normalRow.sessionId, { action: "followup", text: "normal followup" })
    await settleOwnedTurn(normal.agent_path, "child-final-3")
    await vi.waitFor(() => expect(turns).toBeGreaterThanOrEqual(3))
    await catalog.control("parent", teamRow.sessionId, { action: "followup", text: "team followup" })
    await settleOwnedTurn("lead/actual-team", "child-final-4")
    await vi.waitFor(() => expect(turns).toBe(4))
    expect(service.liveAssembly(normalRow.sessionId)).toBeUndefined()
    expect(service.liveAssembly(teamRow.sessionId)).toBeUndefined()
    const history = await catalog.history("parent", teamRow.sessionId)
    await vi.waitFor(() => expect(JSON.stringify(history.events)).toContain("team followup"))
  } finally { await catalog.close(); await service.close(); await f.close() }
}, 15000)

it("restores a completed closed child's actual model from its JSONL task document and exposes it in the cold catalog", async () => {
  const f = await fixture()
  const model: NonNullable<SessionServiceOptions["model"]> = controlledModel(request => ({ async *stream() { yield { type: "text/chunk", text: "done" }; yield { type: "end" } } } as import('@i-harness/llm-seam').ModelClient).stream(request))
  const service = createSessionService({ workspace: f.root, coordinator: f.coordinator, sessionFor: createDurableSessionLoader(f.coordinator), model, allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: "deepseek", model: "deepseek-flash" }), resolveRoleModel: async () => ({ status: "ready", binding: { client: model } }) })
  let reader: ReturnType<typeof createSessionCoordinator> | undefined
  try {
    const assembly = await service.assemblyFor("parent")
    const spawned = await assembly.tools.get("spawn_agent")!.execute({ message: "inspect", task_name: "model-proof", agent_type: "explore", background: false }, { sessionId: "parent" }) as { task_id: string; agent_path: string }
    const owned = assembly.subagentState().agentTable.find(row => row.path === spawned.agent_path)!
    expect(owned.modelLabel).toBe("deepseek:deepseek-flash")
    await assembly.tools.get("close_agent")!.execute({ target: spawned.agent_path }, { sessionId: "parent" })
    expect(assembly.subagentState().agentTable.some(row => row.path === spawned.agent_path)).toBe(false)
    await service.close()
    await f.coordinator.flush(owned.sessionId!)
    reader = createSessionCoordinator(createJsonlBackend(f.root), { lock: { enabled: true } })
    const doc = await reader.getDocument(taskDocKey("parent")) as TaskProtocolDocument
    const restored = createTaskRegistry()
    restored.restore(doc)
    expect(restored.get(spawned.task_id)).toMatchObject({ status: "completed", modelLabel: "deepseek:deepseek-flash" })
    const catalog = await createDesktopSubagents(reader, f.service).list("parent")
    expect(catalog.agents.find(row => row.sessionId === owned.sessionId)).toMatchObject({ status: "completed", live: false, roleName: "explore", modelLabel: "deepseek:deepseek-flash" })
    expect(f.assemble).not.toHaveBeenCalled()
  } finally { await reader?.close(); await service.close(); await f.close() }
}, 15000)
