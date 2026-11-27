import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { isRpcSuccess, type RpcMessage } from "@i-harness/sdk"
import { createSessionCoordinator } from "@i-harness/session-persistence"
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
  return { call, close: () => host.close(), sessionDir }
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
