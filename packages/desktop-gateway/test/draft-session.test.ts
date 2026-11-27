import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createCommitCoordinator, createOwnedLegacySessionStore } from "@i-harness/session-persistence/internal/commit"
import { asSessionCoordinator } from "@i-harness/session-persistence/internal/commit-facade"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createJsonlCommitCoordinator } from "../../session-persistence-jsonl/src/commit-coordinator.ts"
import { createDraftSession } from "../src/draft-session.ts"
import { createDesktopHost } from "../src/host.ts"

const token = "draft-token-12345678"
const cut = vi.hoisted(() => ({
  afterMissingDeletionReceipt: undefined as undefined | ((sessionId: string) => Promise<void>),
}))

vi.mock("@i-harness/session-persistence/internal/commit-facade", async importOriginal => {
  const actual = await importOriginal<typeof import("@i-harness/session-persistence/internal/commit-facade")>()
  return {
    ...actual,
    asSessionCoordinator(...args: Parameters<typeof actual.asSessionCoordinator>) {
      const facade = actual.asSessionCoordinator(...args)
      const deletionReceipt = facade.deletionReceipt!.bind(facade)
      facade.deletionReceipt = async id => {
        const receipt = await deletionReceipt(id)
        if (receipt === undefined && cut.afterMissingDeletionReceipt) await cut.afterMissingDeletionReceipt(id)
        return receipt
      }
      return facade
    },
  }
})

async function createWorkspace(root: string, name: string, sessionStore: "jsonl" | "commit-log") {
  const path = join(root, name), sessionDir = join(path, "sessions")
  await mkdir(path, { recursive: true })
  const frames: RpcMessage[] = []
  const host = await createDesktopHost({ workspace: path, sessionDir, settingsPath: join(root, "settings.json"),
    sessionStore, onWrite: frame => frames.push(frame) })
  let serial = 0
  async function call(method: string, params: Record<string, unknown> = {}) {
    const id = ++serial
    await host.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
    const reply = frames.find(frame => "id" in frame && frame.id === id)
    if (!reply) throw new Error("Missing reply for " + method)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  try { await call("initialize") } catch (error) { await host.close(); throw error }
  return { call, close: () => host.close(), sessionDir, frames }
}

it("deduplicates explicit draft creation across concurrent retries and host restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-draft-session-"))
  let coordinator = createSessionCoordinator(createJsonlBackend(root))
  try {
    await coordinator.create({ sessionId: "unrelated" })
    const lookup = vi.spyOn(coordinator, "list")
    const create = createDraftSession(coordinator)
    const [first, retry] = await Promise.all([create(token), create(token)])
    expect(first.sessionId).toBe(retry.sessionId)
    expect(lookup).toHaveBeenCalledExactlyOnceWith(undefined, first.sessionId)
    await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(root))
    expect(await createDraftSession(coordinator)(token)).toEqual(first)
    expect(await coordinator.list()).toEqual(expect.arrayContaining(["unrelated", first.sessionId]))
    await expect(createDraftSession(coordinator)("short")).rejects.toThrow(/token/)
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it.each(["create", "flush"] as const)("shares a %s failure and revalidates the original draft on retry", async operation => {
  const root = await mkdtemp(join(tmpdir(), "ih-draft-retry-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(root))
  try {
    const failure = new Error("controlled " + operation + " failure")
    const createSession = vi.spyOn(coordinator, "create")
    const flush = vi.spyOn(coordinator, "flush")
    const profile = vi.spyOn(coordinator, "profile")
    if (operation === "create") createSession.mockRejectedValueOnce(failure)
    else flush.mockRejectedValueOnce(failure)
    const create = createDraftSession(coordinator)
    const rejected = { status: "rejected", reason: failure }
    expect(await Promise.allSettled([create(token), create(token)])).toEqual([rejected, rejected])

    const retry = await create(token)
    expect(createSession).toHaveBeenCalledTimes(operation === "create" ? 2 : 1)
    expect(flush).toHaveBeenCalledTimes(operation === "flush" ? 2 : 1)
    if (operation === "flush") expect(profile).toHaveBeenCalledExactlyOnceWith(retry.sessionId)
    else expect(profile).not.toHaveBeenCalled()
    expect(await coordinator.list()).toEqual([retry.sessionId])
  } finally { await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("shares creation within a workspace host and preserves separate owners and old stored receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-draft-host-"))
  const hosts = new Set<Awaited<ReturnType<typeof createWorkspace>>>()
  async function workspace(name: string, sessionStore: "jsonl" | "commit-log") {
    const host = await createWorkspace(root, name, sessionStore)
    hosts.add(host)
    const close = async () => { await host.close(); hosts.delete(host) }
    return { call: host.call, close }
  }
  try {
    const left = await workspace("left", "jsonl")
    const right = await workspace("right", "commit-log")
    const results = await Promise.all([
      left.call("session/create", { clientToken: token }), left.call("session/create", { clientToken: token }),
      right.call("session/create", { clientToken: token }), right.call("session/create", { clientToken: token }),
    ])
    const { sessionId } = results[0] as { sessionId: string }
    expect(results).toEqual(Array(4).fill({ sessionId }))
    expect(await right.call("session/history", { sessionId, afterSeq: 0, limit: 1 })).toMatchObject({ events: [] })

    await left.call("desktop/session/manage", { sessionId, action: "archive" })
    await expect(left.call("session/create", { clientToken: token })).rejects.toThrow("Draft session is archived")
    expect(await right.call("session/create", { clientToken: token })).toEqual({ sessionId })
    await left.call("desktop/session/manage", { sessionId, action: "restore" })
    await left.close()

    const reopened = await workspace("left", "commit-log")
    expect(await reopened.call("session/create", { clientToken: token })).toEqual({ sessionId })
    expect(await reopened.call("desktop/session/batch", { command: { action: "delete", sessionIds: [sessionId] } }))
      .toMatchObject({ results: [{ sessionId, ok: true }] })
    await expect(reopened.call("session/create", { clientToken: token })).rejects.toThrow(/deleted|deletion/i)
    expect(await right.call("session/create", { clientToken: token })).toEqual({ sessionId })
  } finally {
    await Promise.all([...hosts].map(host => host.close()))
    await rm(root, { recursive: true, force: true })
  }
})

it("refuses a draft when another writer deleted its session after the absence checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-draft-deletion-race-"))
  const host = await createWorkspace(root, "workspace", "commit-log")
  const writer = createJsonlCommitCoordinator(host.sessionDir, { lock: { enabled: true, lockRoot: host.sessionDir } })
  const sessionId = "desktop-draft-" + createHash("sha256").update(token).digest("hex")
  const entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>()
  cut.afterMissingDeletionReceipt = async id => {
    if (id !== sessionId) return
    entered.resolve()
    await resume.promise
  }
  const draft = host.call("session/create", { clientToken: token })
    .then(result => ({ result }), error => ({ error }))
  try {
    await Promise.race([entered.promise, draft.then(() => { throw new Error("Draft returned before checking deletion") })])
    await writer.create({ sessionId })
    await writer.deleteOwnedSession(sessionId, { documents: [], files: [] })
    const deletion = await writer.deletionReceipt(sessionId)
    expect(deletion).toBeDefined()
    resume.resolve()

    expect(await draft).toMatchObject({ error: expect.any(Error) })
    expect(await writer.deletionReceipt(sessionId)).toEqual(deletion)
    expect(await writer.list(undefined, sessionId)).toEqual([])
    await expect(host.call("session/create", { clientToken: token })).rejects.toThrow(/deleted|deletion/i)

    await writer.create({ sessionId, title: "Explicit new incarnation" })
    expect((await writer.profile(sessionId)).meta.title).toBe("Explicit new incarnation")
  } finally {
    resume.resolve()
    await draft
    cut.afterMissingDeletionReceipt = undefined
    await Promise.all([host.close(), writer.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it("publishes a draft only after its Task document is durable, then admits a real turn after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-draft-task-birth-"))
  const sessionDir = join(root, "workspace", "sessions")
  const sessionId = "desktop-draft-" + createHash("sha256").update(token).digest("hex")
  await mkdir(sessionDir, { recursive: true })
  const entered = Promise.withResolvers<void>(), taskWrite = Promise.withResolvers<void>()
  void taskWrite.promise.catch(() => {})
  const failure = new Error("controlled Task namespace failure")
  const nativeLegacy = createOwnedLegacySessionStore(createJsonlBackend(sessionDir, { fixedCapabilities: true }),
    { lock: { enabled: true, lockRoot: sessionDir } })
  const first = createCommitCoordinator({ root: sessionDir, legacy: {
    ...nativeLegacy,
    withDocuments(keys, work) {
      if (keys.length === 1 && keys[0] === `task-${sessionId}`) {
        entered.resolve()
        return taskWrite.promise.then(() => nativeLegacy.withDocuments!(keys, work))
      }
      return nativeLegacy.withDocuments!(keys, work)
    },
  } })
  const creating = createDraftSession(asSessionCoordinator(first))(token)
  const failed = expect(creating).rejects.toBe(failure)
  let requests = 0
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Receive the loopback request. */ }
    requests++
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.write('data: ' + JSON.stringify({ type: "response.output_text.delta", delta: "Recovered draft answer" }) + '\n\n')
    response.end('data: ' + JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 6 } } }) + '\n\n')
  })
  try {
    try {
      await Promise.race([entered.promise, creating.then(() => { throw new Error("Draft returned before Task initialization") })])
      expect(await first.list(undefined, sessionId)).toEqual([])
    } finally {
      taskWrite.reject(failure)
      try { await failed } finally { await first.close() }
    }

    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing loopback address")
    const selection = { provider: "fixture", model: "fixture" }
    await writeFile(join(root, "settings.json"), JSON.stringify({
      autoTitle: false, sandboxMode: "read-only", approvalMode: "dangerous", codeMode: { mode: "off" }, compaction: { auto: false },
      llm: { defaultModel: selection, providers: { fixture: { protocol: "openai-responses", baseURL: `http://127.0.0.1:${address.port}`,
        apiKeyEnv: "IH_DRAFT_BIRTH_FIXTURE", models: [{ id: "fixture", contextWindow: 128000 }] } } },
    }))
    await writeFile(join(root, "credentials.json"), JSON.stringify({ refs: { IH_DRAFT_BIRTH_FIXTURE: "loopback-only" } }))
    const host = await createWorkspace(root, "workspace", "commit-log")
    try {
      expect(await host.call("session/create", { clientToken: token })).toEqual({ sessionId })
      const workspace = join(root, "workspace")
      const project = { id: "fixture", name: "Draft birth fixture", roots: [workspace], primaryRoot: workspace }
      await host.call("desktop/project/sync", { projects: [project] })
      await host.call("desktop/session/project/bind", { sessionId, projectId: project.id })
      await host.call("session/model/set", { sessionId, selection })
      expect(await host.call("desktop/session/input/submit", { sessionId, text: "New draft prompt", delivery: "queue", clientToken: "draft-birth-input" }))
        .toMatchObject({ accepted: true })
      await vi.waitFor(() => expect(host.frames).toContainEqual(expect.objectContaining({ method: "session/event", params:
        expect.objectContaining({ sessionId, event: expect.objectContaining({ type: "turn/end" }) }) })), { timeout: 5000 })
      expect(await host.call("session/history", { sessionId, afterSeq: 0, limit: 100 })).toMatchObject({ events: expect.arrayContaining([
        expect.objectContaining({ type: "assistant/message", text: "Recovered draft answer" }),
        expect.objectContaining({ type: "turn/end" }),
      ]) })
      expect(requests).toBe(1)
    } finally { await host.close() }
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 10000)

it("keeps the old incomplete birth readable while refusing to replay its draft creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-old-incomplete-task-birth-"))
  const sessionDir = join(root, "workspace", "sessions")
  const sessionId = "desktop-draft-" + createHash("sha256").update(token).digest("hex")
  const generation = join(sessionDir, sessionId, "session.v15.jsonl")
  await mkdir(sessionDir, { recursive: true })
  const stored = createCommitCoordinator({ root: sessionDir })
  try {
    await stored.create({ sessionId })
    const withoutInitialTask = asSessionCoordinator(stored, { taskDocument: {
      validator: { validate() { throw new Error("This facade did not require an initial Task document") } },
    } })
    expect(await createDraftSession(withoutInitialTask)(token)).toEqual({ sessionId })
    expect(await stored.getDocument(`task-${sessionId}`)).toBeUndefined()
  } finally { await stored.close() }
  const before = await readFile(generation)
  try {
    const host = await createWorkspace(root, "workspace", "commit-log")
    try {
      expect(await host.call("session/history", { sessionId, afterSeq: 0, limit: 1 })).toMatchObject({ events: [] })
      await expect(host.call("session/create", { clientToken: token })).rejects.toThrow("Draft session creation is incomplete: required Task document is missing")
      expect(await readFile(generation)).toEqual(before)
    } finally { await host.close() }
    const reopened = createCommitCoordinator({ root: sessionDir })
    try { expect(await reopened.getDocument(`task-${sessionId}`)).toBeUndefined() }
    finally { await reopened.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
