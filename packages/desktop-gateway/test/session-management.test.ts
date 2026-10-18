import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import type { SessionService } from "@i-harness/session-executor"
import { createSessionManagement } from "../src/session-management.ts"
import { createConversationVisibility } from "../src/session-visibility.ts"
import { createProjectScopeBroker } from "../src/project-scope.ts"
import { mkdir } from "node:fs/promises"
import { readFile, writeFile } from "node:fs/promises"
import { createFileBackedSessionQuery, closeSessionQueries } from "@i-harness/session-query"
import { createDurableSessionLoader, createSessionAssembly } from "@i-harness/session-executor"
import { RewindRecorder, RewindStore } from "@i-harness/rewind"
import { sessionOwnedDocuments } from "../src/session-artifacts.ts"
import { desktopInputReceiptDocumentKey } from "../src/input.ts"
import { createSessionManagementFence } from "../src/session-management-fence.ts"
import { createSessionService } from '@i-harness/session-executor'
import { deriveMessages, type SessionEvent } from '@i-harness/core-session'

it('forks actual managed replacement history through Gateway management with no model calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f2-management-')); roots.push(root)
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  let sends = 0
  const service = createSessionService({ workspace: root, coordinator, model: controlledModel(request => ({ async *stream() { sends++; yield { type: 'end' } } } as import('@i-harness/llm-seam').ModelClient).stream(request)) })
  const { id } = await coordinator.create({ sessionId: 'parent' }), document = await coordinator.openManagedDocument(id)
  const inherited = { kind: 'inherited' as const, authority: 'observation' as const, scope: 'turn' as const, producer: 'session.seed' }
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'H', provenance: inherited },
    { type: 'step/start', seq: 2 }, { type: 'assistant/message', seq: 3, text: 'E' }, { type: 'step/end', seq: 4 }, { type: 'turn/end', seq: 5 },
    { type: 'compaction/replacement', version: 1, seq: 6, replacementId: 'management', text: 'S', coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }], insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } },
  ]
  try {
    expect(await document.importSeed(events)).toMatchObject({ kind: 'committed' })
    const original = await readFile(join(root, 'parent.jsonl'))
    const manager = createSessionManagement(coordinator, service, createConversationVisibility(coordinator))
    const result = await manager.mutate('parent', 'fork') as { sessionId: string }
    const child = await coordinator.openManagedDocument(result.sessionId)
    expect(deriveMessages(child.view).map(message => message.content)).toEqual(['H', 'S'])
    expect(child.view.header).toMatchObject({ parentSession: 'parent', seedLength: 7 })
    expect(await child.metadata.admit({ type: 'plan/mode', mode: 'on' })).toMatchObject({ kind: 'committed', receipt: { owner: { sessionId: result.sessionId } } })
    expect(sends).toBe(0); expect(await readFile(join(root, 'parent.jsonl'))).toEqual(original)
  } finally { await service.close(); await coordinator.close() }
})

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function setup(owned = false) {
  const root = await mkdtemp(join(tmpdir(), "session-management-")); roots.push(root)
  const coordinator = createSessionCoordinator(createJsonlBackend(root), owned ? { lock: { enabled: true } } : undefined)
  await coordinator.create({ sessionId: "s1", title: "First" })
  await coordinator.create({ sessionId: "s2", title: "Second" })
  const service = { queueState: () => ({ running: false, queued: 0 }), tasks: () => [] } as unknown as SessionService
  return { root, coordinator, service }
}

describe("session navigation metadata", () => {
  it("refuses hidden or currently unavailable deletion receipts and never treats missing sessions as deleted", async () => {
    const { root, coordinator, service } = await setup()
    await coordinator.create({ sessionId: "hidden", origin: "subagent", parentSession: "s1" })
    await coordinator.deleteOwnedSession!("hidden", { documents: [] })
    await coordinator.deleteOwnedSession!("s2", { documents: [] })
    const options = { workspace: root, sessionDir: root, pendingInteractions: async () => [], drainSession: async () => {} }
    const manager = createSessionManagement(coordinator, service, createConversationVisibility(coordinator), options)
    await expect(manager.mutate("hidden", "delete")).rejects.toThrow(/unavailable/)
    const unavailable = createSessionManagement(coordinator, service, async () => false, options)
    await expect(unavailable.mutate("s2", "delete")).rejects.toThrow(/unavailable/)
    const liveService = { ...service, liveAssembly: () => ({ liveResources: () => ({ codeCells: [], terminals: [{ status: "running" }] }) }) } as unknown as SessionService
    const live = createSessionManagement(coordinator, liveService, createConversationVisibility(coordinator), options)
    await expect(live.mutate("s2", "delete")).rejects.toThrow(/active.*process/)
    await expect(manager.mutate("missing", "delete")).rejects.toThrow()
    await coordinator.close()
  })
  it("refuses an actual yielded cell or live owned PTY even with an idle runtime queue", async () => {
    const { root, coordinator, service } = await setup(true)
    const session = await createDurableSessionLoader(coordinator)("s1")
    const heldCell = Promise.withResolvers<void>()
    const assembly = await createSessionAssembly({ workspace: root, sessionId: "s1", coordinator, session, modelPolicy: "test-mock", sandbox: "danger-full-access", codeMode: { mode: "mixed" },
      additionalTools: [{ name: "fixture_hold", description: "Held real producer", isReadOnly: true, inputSchema: { type: "object", properties: {} }, execute: async () => { await heldCell.promise; return "done" } }] })
    const runtime = { ...service, liveAssembly: () => assembly } as unknown as SessionService
    const manager = createSessionManagement(coordinator, runtime, createConversationVisibility(coordinator), { workspace: root, sessionDir: root, pendingInteractions: async () => [], drainSession: async () => { await assembly.dispose() } })
    try {
      const result = await assembly.tools.execute({ name: "code_exec", args: { code: 'text(await tools.fixture_hold({}));', yield_time_ms: 0 } })
      const cell = result.output as { cell_id: string }
      await expect(manager.mutate("s1", "delete")).rejects.toThrow(/active.*cell|process/i)
      heldCell.resolve()
      await assembly.tools.execute({ name: "code_wait", args: { cell_id: cell.cell_id, yield_time_ms: 2000 } })
      const terminal = assembly.ctx.services.get<import("@i-harness/terminal").TerminalService>("terminal/service")!
      const child = await (await import("@i-harness/exec")).withExecCallerScope({ sessionId: "s1" }, () => terminal.open({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: root }, { sessionId: "s1" }))
      expect(assembly.liveResources!().terminals).toEqual([expect.objectContaining({ id: child.id, ownerSessionId: "s1", status: "running" })])
      await expect(manager.mutate("s1", "delete")).rejects.toThrow(/active.*cell|process/i)
      const exited = terminal.waitExited(child.id)
      await terminal.close(child.id, { sessionId: "s1" }); await exited
      expect(await coordinator.profile("s1")).toBeDefined()
    } finally { heldCell.resolve(); await assembly.dispose(); await coordinator.close() }
  })
  it("permanently removes only an idle visible session and its exact artifacts and reconciles search", async () => {
    const { root, coordinator, service } = await setup()
    const manager = createSessionManagement(coordinator, service, createConversationVisibility(coordinator), { workspace: root, sessionDir: root, pendingInteractions: async () => [], drainSession: async () => {} })
    await coordinator.append("s1", [{ type: "user/message", seq: 0, text: "needle deletion" }])
    const query = createFileBackedSessionQuery({ storeRoot: root })
    expect(await query.search("needle")).toHaveLength(1)
    await coordinator.putDocument("s1", { formatVersion: 1, jobs: [], agentTable: [], roles: [] })
    await coordinator.putDocument("task-s1", { formatVersion: 1, tasks: [], notifications: [] })
    await coordinator.putDocument("session-title/s1", { title: "First" })
    await manager.mutate("s1", "pin")
    await coordinator.putDocument(desktopInputReceiptDocumentKey("s1"), { version: 1, sessionId: "s1", receipts: {} })
    await coordinator.putDocument(desktopInputReceiptDocumentKey("s2"), { version: 1, sessionId: "s2", receipts: {} })
    const rewind = new RewindStore({ root, workspace: root, sessionId: "s1" })
    await mkdir(join(root, "rewind", "s1"), { recursive: true })
    await writeFile(rewind.metaFile, JSON.stringify({ version: 1, workspace: root }))
    const blob = await rewind.writeBlob(Buffer.from("preimage"))
    await rewind.appendPoint({ turnIndex: 0, anchorSeq: 0, promptPreview: "needle", files: [{ path: "source.txt", status: "modified", preBlob: blob }] })
    const siblingRewind = new RewindStore({ root, workspace: root, sessionId: "s2" })
    await mkdir(join(root, "rewind", "s2"), { recursive: true })
    await writeFile(siblingRewind.metaFile, JSON.stringify({ version: 1, workspace: root }))
    const siblingBlob = await siblingRewind.writeBlob(Buffer.from("sibling preimage"))
    await writeFile(join(root, "rewind", "s1", "user-notes.txt"), "unknown artifact survives")
    await writeFile(join(root, "source.txt"), "source")
    try {
      expect(typeof manager.batch).toBe("function")
      const result = await manager.batch({ action: "delete", sessionIds: ["s1", "missing"] })
      expect(result.results).toEqual([{ sessionId: "s1", ok: true }, { sessionId: "missing", ok: false, error: expect.any(String) }])
      expect(await coordinator.list()).toEqual(["s2"])
      expect(await coordinator.getDocument("s1")).toBeUndefined()
      expect(await coordinator.getDocument("task-s1")).toBeUndefined()
      expect(await coordinator.getDocument("session-title/s1")).toBeUndefined()
      for (const key of sessionOwnedDocuments("s1")) expect(await coordinator.getDocument(key)).toBeUndefined()
      expect(await coordinator.getDocument(desktopInputReceiptDocumentKey("s2"))).toMatchObject({ sessionId: "s2" })
      await expect(readFile(rewind.pointsFile)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(rewind.readBlob(blob)).rejects.toThrow(/not found/)
      expect(Buffer.from(await siblingRewind.readBlob(siblingBlob)).toString()).toBe("sibling preimage")
      expect(await readFile(join(root, "rewind", "s1", "user-notes.txt"), "utf8")).toBe("unknown artifact survives")
      expect(await readFile(join(root, "source.txt"), "utf8")).toBe("source")
      expect(await query.search("needle")).toEqual([])
    } finally { closeSessionQueries(); await coordinator.close() }
  })
  it("refuses durable pending inputs, task outbox, interactions and descendants even when runtime queue is empty", async () => {
    const { root, coordinator, service } = await setup()
    const manager = createSessionManagement(coordinator, service, createConversationVisibility(coordinator), { workspace: root, sessionDir: root, pendingInteractions: async () => [], drainSession: async () => {} })
    try {
      await coordinator.append("s1", [{ type: "agent/input/admitted", version: 1, seq: 0, inputId: "i", text: "pending", delivery: "queue", intent: "user" }])
      await expect(manager.mutate("s1", "delete")).rejects.toThrow(/pending/i)
      await coordinator.append("s1", [{ type: "agent/input/cancelled", version: 1, seq: 1, inputId: "i" }])
      await coordinator.putDocument("task-s1", { formatVersion: 1, tasks: [], notifications: [{ status: "pending" }] })
      await expect(manager.mutate("s1", "delete")).rejects.toThrow(/outbox|pending/i)
      await coordinator.putDocument("task-s1", { formatVersion: 1, tasks: [], notifications: [] })
      await coordinator.create({ sessionId: "hidden", origin: "subagent", parentSession: "s1" })
      await expect(manager.mutate("s1", "delete")).rejects.toThrow(/descendant/i)
      await expect(manager.mutate("hidden", "delete")).rejects.toThrow(/unavailable/i)
      expect(await coordinator.profile("s2")).toBeDefined()
      const pending = createSessionManagement(coordinator, service, createConversationVisibility(coordinator), { workspace: root, sessionDir: root, pendingInteractions: async () => [{ requestId: "pending" }], drainSession: async () => {} })
      await expect(pending.mutate("s2", "delete")).rejects.toThrow(/pending interactions/)
      const goal = createSessionManagement(coordinator, service, createConversationVisibility(coordinator), { workspace: root, sessionDir: root, activeWork: async () => true, pendingInteractions: async () => [], drainSession: async () => {} })
      await expect(goal.mutate("s2", "delete")).rejects.toThrow(/active workflow/)
    } finally { await coordinator.close() }
  })
  it("moves idle grouping by expected owner, preserves original execution folder, and remains sticky after restart", async () => {
    const { root, coordinator } = await setup()
    const destination = join(root, "destination"); await mkdir(destination)
    const broker = createProjectScopeBroker(coordinator, root, async () => true, { assertIdle: async () => {} })
    await broker.configure({ id: "p1", name: "Source", roots: [root], primaryRoot: root })
    await broker.configure({ id: "p2", name: "Destination", roots: [destination], primaryRoot: destination })
    await broker.bind("s1", "p1")
    await coordinator.append("s1", [{ type: "user/message", seq: 0, text: "retained conversation" }])
    try {
      expect(typeof broker.move).toBe("function")
      await expect(broker.move("s1", "wrong", "p2")).rejects.toThrow(/owner|changed/i)
      expect(await broker.move("s1", "p1", "p2")).toMatchObject({ sessionId: "s1", projectId: "p2", executionWorkspace: root })
      expect((await broker.forSession("s1"))()?.roots).toEqual([destination])
      await expect(broker.bind("s1", "p1")).rejects.toThrow(/explicit move/)
      await coordinator.create({ sessionId: "descendant", origin: "subagent", parentSession: "s2" })
      await expect(broker.move("s2", undefined, "p2")).rejects.toThrow(/descendant/)
      await coordinator.close()
      const restored = createSessionCoordinator(createJsonlBackend(root))
      try {
        const restarted = createProjectScopeBroker(restored, root)
        expect(await restarted.projectFor("s1")).toBe("p2")
        expect((await restored.snapshot!("s1")).session.events).toEqual([{ type: "user/message", seq: 0, text: "retained conversation" }])
      } finally { await restored.close() }
    } finally { await coordinator.close() }
  })
  it("rejects a move from a cached stale owner in another broker", async () => {
    const { root, coordinator } = await setup()
    const options = { assertIdle: async () => {} }
    const first = createProjectScopeBroker(coordinator, root, async () => true, options)
    const stale = createProjectScopeBroker(coordinator, root, async () => true, options)
    for (const broker of [first, stale]) for (const id of ["p1", "p2"]) await broker.configure({ id, name: id, roots: [root], primaryRoot: root })
    await first.bind("s1", "p1")
    expect(await stale.projectFor("s1")).toBe("p1")
    try {
      await first.move("s1", "p1", "p2")
      await expect(stale.move("s1", "p1", undefined)).rejects.toThrow(/owner changed/)
      expect(await createProjectScopeBroker(coordinator, root).projectFor("s1")).toBe("p2")
    } finally { await coordinator.close() }
  })
  it("forks a completed conversation visibly and persists its project owner without cached SDK authority", async () => {
    const { root, coordinator, service } = await setup(true)
    const second = join(root, "second"); await mkdir(second)
    const broker = createProjectScopeBroker(coordinator, root)
    await broker.configure({ id: "p1", name: "Both folders", roots: [root, second], primaryRoot: root })
    await broker.bind("s1", "p1")
    const manager = createSessionManagement(coordinator, service, async () => true, { projectFor: broker.projectFor, onFork: broker.inherit })
    try {
      await expect(manager.mutate("s1", "fork")).rejects.toThrow(/completed turn/)
      expect(await coordinator.list()).toHaveLength(2)
      await coordinator.closeManagedDocument('s1')
      await coordinator.releaseOwnership('s1')
      await coordinator.append("s1", [
        { type: "turn/start", seq: 0 }, { type: "user/message", seq: 1, text: "first task" },
        { type: "assistant/message", seq: 2, text: "done" }, { type: "turn/end", seq: 3 },
      ])
      const forked = await manager.mutate("s1", "fork")
      expect(await coordinator.list()).toContain(forked.sessionId)
      expect((await manager.navigation())[forked.sessionId]).toEqual({ pinned: false, unread: false, projectId: "p1" })
      expect((await broker.forSession(forked.sessionId))()?.roots).toEqual([root, second])
      await manager.mutate(forked.sessionId, "archive")
      expect(await manager.archived()).toEqual([expect.objectContaining({ id: forked.sessionId, projectId: "p1" })])
    } finally { await coordinator.close() }
  })
  it("persists independent pin/read choices after coordinator restart without conversation events", async () => {
    const { root, coordinator, service } = await setup()
    const manager = createSessionManagement(coordinator, service)
    await Promise.all([manager.mutate("s1", "pin"), manager.mutate("s1", "unread")])
    expect(await manager.navigation()).toEqual({ s1: { pinned: true, unread: true }, s2: { pinned: false, unread: false } })
    expect((await coordinator.snapshot!("s1")).session.events).toEqual([])
    await coordinator.close()
    const reloaded = createSessionCoordinator(createJsonlBackend(root))
    try {
      const restarted = createSessionManagement(reloaded, service)
      expect((await restarted.navigation()).s1).toEqual({ pinned: true, unread: true })
      await restarted.mutate("s1", "read")
      await restarted.mutate("s1", "unpin")
      expect((await restarted.navigation()).s1).toEqual({ pinned: false, unread: false })
    } finally { await reloaded.close() }
  })

  it("hides internal reviewers from metadata and rejects direct actions against them", async () => {
    const { coordinator, service } = await setup()
    await coordinator.create({ sessionId: "reviewer", origin: "approval-review", archived: true })
    const manager = createSessionManagement(coordinator, service, createConversationVisibility(coordinator))
    try {
      expect(await manager.navigation()).not.toHaveProperty("reviewer")
      expect(await manager.archived()).toEqual([])
      await expect(manager.mutate("reviewer", "pin")).rejects.toThrow(/unavailable/)
      await expect(manager.mutate("reviewer", "restore")).rejects.toThrow(/unavailable/)
      await expect(manager.mutate("missing", "pin")).rejects.toThrow()
    } finally { await coordinator.close() }
  })

  it("allows navigation choices during execution and keeps structural changes guarded", async () => {
    const { coordinator } = await setup()
    const busy = { queueState: () => ({ running: true, queued: 1 }), tasks: () => [] } as unknown as SessionService
    const manager = createSessionManagement(coordinator, busy)
    try {
      await manager.mutate("s1", "pin")
      await manager.mutate("s1", "unread")
      expect((await manager.navigation()).s1).toEqual({ pinned: true, unread: true })
      await expect(manager.mutate("s1", "archive")).rejects.toThrow("busy")
      await expect(manager.mutate("s1", "rename", "New")).rejects.toThrow("busy")
      await expect(manager.mutate("s1", "fork")).rejects.toThrow("busy")
    } finally { await coordinator.close() }
  })

  it("validates actions and rename text before saving any metadata", async () => {
    const { coordinator, service } = await setup()
    const manager = createSessionManagement(coordinator, service)
    try {
      await expect(manager.mutate("s1", "invalid" as never)).rejects.toThrow(/Invalid/)
      await expect(manager.mutate("s1", "rename", " ")).rejects.toThrow(/title/)
      await manager.mutate("s1", "rename", "  New name  ")
      expect((await coordinator.profile("s1")).meta.title).toBe("New name")
      await manager.mutate("s1", "archive")
      expect(await manager.archived()).toMatchObject([{ id: "s1", title: "New name" }])
      expect((await manager.navigation()).s1).toEqual({ pinned: false, unread: false })
      await manager.mutate("s1", "restore")
      expect(await manager.archived()).toEqual([])
    } finally { await coordinator.close() }
  })
})

it("archives an idle reusable child without changing its durable state", async () => {
  const { coordinator, service } = await setup()
  try {
    await coordinator.create({ sessionId: "idle-child", origin: "subagent", parentSession: "s1" })
    await coordinator.append("idle-child", [{ type: "turn/start", seq: 0 }, { type: "turn/end", seq: 1 }])
    const saved = { formatVersion: 1, jobs: [{ status: "completed" }], agentTable: [{ path: "root/child", sessionId: "idle-child", status: "waiting", mailbox: [] }], roles: [] }
    await coordinator.putDocument("s1", saved)
    await createSessionManagement(coordinator, service).mutate("s1", "archive")
    expect((await coordinator.profile("s1")).meta.archived).toBe(true)
    expect(await coordinator.getDocument("s1")).toEqual(saved)
  } finally { await coordinator.close() }
})
it.each(["inbox", "turn", "mailbox", "cell", "missing"])("keeps reusable-child archive blocked by %s", async (blocker: string) => {
  const { coordinator, service } = await setup()
  try {
    if (blocker !== "missing") {
      await coordinator.create({ sessionId: "idle-child", origin: "subagent", parentSession: "s1" })
      await coordinator.append("idle-child", [{ type: "turn/start", seq: 0 }, ...(blocker === "turn" ? [] : [{ type: "turn/end", seq: 1 }]),
        ...(blocker === "inbox" ? [{ type: "subagent/inbox", seq: 2, from: "root", message: "pending" }] : []),
        ...(blocker === "cell" ? [{ type: "code/cell", seq: 2, cellId: "c", state: "started", source: "" }] : [])] as never)
    }
    await coordinator.putDocument("s1", { formatVersion: 1, jobs: [], agentTable: [{ path: "root/child", sessionId: "idle-child", status: "waiting", mailbox: blocker === "mailbox" ? ["pending"] : [] }], roles: [] })
    await expect(createSessionManagement(coordinator, service).mutate("s1", "archive")).rejects.toThrow()
    expect((await coordinator.profile("s1")).meta.archived).not.toBe(true)
  } finally { await coordinator.close() }
})
it.each([undefined, "Named conversation"])("archives a settled cold recording and retains its recovery evidence regardless of title %s", async (title: string | undefined) => {
  const { root, coordinator, service } = await setup()
  let reopened: ReturnType<typeof createSessionCoordinator> | undefined
  try {
    await coordinator.create({ sessionId: "rewind-title", ...(title ? { title } : {}) })
    await coordinator.append("rewind-title", [{ type: "user/message", seq: 0, text: "interrupted recording" }, { type: "turn/start", seq: 1 }, { type: "turn/end", seq: 2 }])
    const store = new RewindStore({ root, workspace: root, sessionId: "rewind-title" })
    const recorder = new RewindRecorder({ store, workspace: root })
    recorder.begin(0, "interrupted recording")
    const taken = recorder.take("source.txt", Buffer.from("before"))
    await writeFile(join(root, "source.txt"), "after")
    await recorder.flush()
    const pending = await store.readPending()
    await coordinator.close()
    reopened = createSessionCoordinator(createJsonlBackend(root))
    await createSessionManagement(reopened, service, undefined, { workspace: root, sessionDir: root }).mutate("rewind-title", "archive")
    expect((await reopened.profile("rewind-title")).meta.archived).toBe(true)
    expect((await reopened.snapshot!("rewind-title")).session.events).toHaveLength(3)
    expect(await store.readPending()).toBeNull()
    expect(await store.readOrphans()).toEqual([{ ...pending, recoveredAt: expect.any(Number) }])
    expect(Buffer.from(await store.readBlob(taken.blobId!)).toString()).toBe("before")
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("after")
    expect(await store.readPoints()).toEqual([])
  } finally { await reopened?.close(); await coordinator.close() }
})

it("keeps an unresolved live recorder guarded even when its runtime queue is idle", async () => {
  const { root, coordinator, service } = await setup()
  const store = new RewindStore({ root, workspace: root, sessionId: "s1" })
  const recorder = new RewindRecorder({ store, workspace: root })
  recorder.begin(0, "live recording")
  const taken = recorder.take("source.txt", Buffer.from("before"))
  await recorder.flush()
  const pending = await store.readPending()
  const live = { ...service, liveAssembly: () => ({ liveResources: () => ({ codeCells: [], terminals: [] }), rewind: { store, recorder, drain: async () => {} } }) } as unknown as SessionService
  try {
    await expect(createSessionManagement(coordinator, live, undefined, { workspace: root, sessionDir: root }).mutate("s1", "archive")).rejects.toThrow("Session has a pending rewind recording")
    expect(await store.readPending()).toEqual(pending)
    expect(await store.readOrphans()).toEqual([])
    expect(Buffer.from(await store.readBlob(taken.blobId!)).toString()).toBe("before")
    expect((await coordinator.profile("s1")).meta.archived).not.toBe(true)
  } finally { await coordinator.close() }
})

it("refuses recovery while another coordinator owns the cold session", async () => {
  const { root, coordinator, service } = await setup()
  const store = new RewindStore({ root, workspace: root, sessionId: "s1" })
  const pending = { version: 1 as const, anchorSeq: 0, promptPreview: "owned recording", startedAt: 1, entries: [] }
  await store.writePending(pending)
  await coordinator.close()
  const options = { lock: { enabled: true, lockRoot: root } }
  const owner = createSessionCoordinator(createJsonlBackend(root), options)
  const managerCoordinator = createSessionCoordinator(createJsonlBackend(root), options)
  await owner.adoptOwnership("s1")
  try {
    await expect(createSessionManagement(managerCoordinator, service, undefined, { workspace: root, sessionDir: root }).mutate("s1", "archive")).rejects.toThrow()
    expect(await store.readPending()).toEqual(pending)
    expect(await store.readOrphans()).toEqual([])
    expect((await owner.profile("s1")).meta.archived).not.toBe(true)
  } finally { await managerCoordinator.close(); await owner.close() }
})

it.each(["input", "turn"])("preserves a cold recording while durable %s work is unresolved", async (blocker: string) => {
  const { root, coordinator, service } = await setup()
  const store = new RewindStore({ root, workspace: root, sessionId: "s1" })
  const pending = { version: 1 as const, anchorSeq: 0, promptPreview: "unfinished work", startedAt: 1, entries: [] }
  await store.writePending(pending)
  await coordinator.append("s1", blocker === "input"
    ? [{ type: "agent/input/admitted", version: 1, seq: 0, inputId: "unresolved", text: "pending", delivery: "queue", intent: "user" }]
    : [{ type: "turn/start", seq: 0 }])
  try {
    await expect(createSessionManagement(coordinator, service, undefined, { workspace: root, sessionDir: root }).mutate("s1", "archive")).rejects.toThrow(/pending|unfinished/)
    expect(await store.readPending()).toEqual(pending)
    expect(await store.readOrphans()).toEqual([])
    expect((await coordinator.profile("s1")).meta.archived).not.toBe(true)
  } finally { await coordinator.close() }
})

it("waits for admitted writers and refuses their newly pending work before recovering a cold recording", async () => {
  const { root, coordinator, service } = await setup()
  const fence = createSessionManagementFence()
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const store = new RewindStore({ root, workspace: root, sessionId: "s1" })
  const pending = { version: 1 as const, anchorSeq: 0, promptPreview: "cold recording", startedAt: 1, entries: [] }
  await store.writePending(pending)
  const writer = fence.run("s1", async () => {
    entered.resolve()
    await release.promise
    await coordinator.append("s1", [{ type: "agent/input/admitted", version: 1, seq: 0, inputId: "late-input", text: "still pending", delivery: "queue", intent: "user" }])
  })
  await entered.promise
  const archive = createSessionManagement(coordinator, service, undefined, { workspace: root, sessionDir: root, fence }).mutate("s1", "archive")
  void archive.catch(() => {})
  try {
    await vi.waitFor(() => expect(() => fence.assertOpen("s1")).toThrow(/management/))
    expect(await store.readOrphans()).toEqual([])
    expect(await store.readPending()).toEqual(pending)
    release.resolve()
    await writer
    await expect(archive).rejects.toThrow("pending durable inputs")
    expect(await store.readPending()).toEqual(pending)
    expect(await store.readOrphans()).toEqual([])
    expect((await coordinator.profile("s1")).meta.archived).not.toBe(true)
  } finally { release.resolve(); await Promise.allSettled([writer, archive]); await coordinator.close() }
})

it("awaits the live rewind finalizer before judging a settled turn's sidecar", async () => {
  const { root, coordinator, service } = await setup()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const store = new RewindStore({ root, workspace: root, sessionId: "s1" })
  await store.writePending({ version: 1, anchorSeq: 0, promptPreview: "done", startedAt: 1, entries: [] })
  const finalized = gate.then(() => store.appendPoint({ turnIndex: 0, anchorSeq: 0, promptPreview: "done", files: [] }))
  const drain = vi.fn(() => finalized)
  const live = { ...service, liveAssembly: () => ({ liveResources: () => ({ codeCells: [], terminals: [] }), rewind: { drain } }) } as unknown as SessionService
  const archive = createSessionManagement(coordinator, live, undefined, { workspace: root, sessionDir: root }).mutate("s1", "archive")
  void archive.catch(() => {})
  try {
    await vi.waitFor(() => expect(drain).toHaveBeenCalled())
    expect((await coordinator.profile("s1")).meta.archived).not.toBe(true)
    release()
    await archive
    expect((await coordinator.profile("s1")).meta.archived).toBe(true)
  } finally { release(); await Promise.allSettled([archive, finalized]); await coordinator.close() }
})

it("keeps archive blocked by a reusable child's terminal owned by the parent runtime", async () => {
  const { coordinator, service } = await setup()
  try {
    await coordinator.create({ sessionId: "idle-child", origin: "subagent", parentSession: "s1" })
    await coordinator.append("idle-child", [{ type: "turn/start", seq: 0 }, { type: "turn/end", seq: 1 }])
    await coordinator.putDocument("s1", { formatVersion: 1, jobs: [], agentTable: [{ path: "root/child", sessionId: "idle-child", status: "waiting", mailbox: [] }], roles: [] })
    const live = { ...service, liveAssembly: (id: string) => id === "s1" ? { liveResources: (owner?: string) => ({ codeCells: [], terminals: owner === "idle-child" ? [{ status: "running" }] : [] }) } : undefined } as unknown as SessionService
    await expect(createSessionManagement(coordinator, live).mutate("s1", "archive")).rejects.toThrow("active Code Mode cells or processes")
  } finally { await coordinator.close() }
})
