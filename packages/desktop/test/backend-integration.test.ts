import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeFrame, isRpcSuccess, makeRequest, type RpcMessage } from "@i-harness/sdk"
import { createDesktopHost } from "../../desktop-gateway/src/host.ts"
import { createWorkspaceCatalog } from "../src/main/workspaces.ts"
import { createProjectCatalog } from "../src/main/projects.ts"
import { createGlobalProviderSettings } from "../src/main/global-provider-settings.ts"
import { dispatchDesktopRequest, type DesktopIpcDependencies } from "../src/main/ipc.ts"
import { AttachmentDraftStore } from "../src/main/attachment-draft-store.ts"
import { createNotificationHistory } from "../src/main/notification-history.ts"
import { createServer } from "node:http"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-native-gateway-")); roots.push(root)
  const workspace = join(root, "workspace"), destination = join(root, "destination"), sessionDir = join(root, "sessions"), settingsPath = join(root, "settings.json")
  await mkdir(workspace); await mkdir(destination); await writeFile(settingsPath, JSON.stringify({ sandboxMode: "read-only", autoTitle: true }))
  const frames: RpcMessage[] = []
  let host = await createDesktopHost({ workspace, sessionDir, settingsPath, onWrite: frame => frames.push(frame) })
  let sequence = 0
  const request = async (method: string, params: unknown = {}) => {
    const id = ++sequence
    await host.handleLine(encodeFrame(makeRequest(id, method, params)))
    const reply = frames.find(frame => "id" in frame && frame.id === id)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  const info = await request("initialize") as { capabilities: Record<string, string[]> }
  const catalog = createWorkspaceCatalog(join(root, "workspaces.json")), entry = await catalog.open(workspace), other = await catalog.open(destination)
  const projects = createProjectCatalog(join(root, "projects.json"), catalog)
  const runtime = { client: { request, createSession: () => request("session/create") }, info }
  const otherFrames: RpcMessage[] = []
  const otherHost = await createDesktopHost({ workspace: destination, sessionDir: join(root, "other-sessions"), settingsPath, onWrite: frame => otherFrames.push(frame) })
  const otherRequest = async (method: string, params: unknown = {}) => {
    const id = ++sequence; await otherHost.handleLine(encodeFrame(makeRequest(id, method, params)))
    const reply = otherFrames.find(frame => "id" in frame && frame.id === id)
    if (!isRpcSuccess(reply)) throw new Error(JSON.stringify(reply))
    return reply.result
  }
  const otherInfo = await otherRequest("initialize") as { capabilities: Record<string, string[]> }
  const otherRuntime = { client: { request: otherRequest }, info: otherInfo }
  const globals = createGlobalProviderSettings(async () => ({ request }))
  const drafts = new AttachmentDraftStore(join(root, "drafts"))
  const dependencies = { catalog, projects, globalProviders: globals, drafts, notifications: createNotificationHistory(join(root, "notifications.json")), runtimes: { get: async (member: { id: string }) => member.id === other.id ? otherRuntime : runtime } } as unknown as DesktopIpcDependencies
  const restart = async (seed?: () => Promise<void>) => { await host.close(); await seed?.(); frames.length = 0; host = await createDesktopHost({ workspace, sessionDir, settingsPath, onWrite: frame => frames.push(frame) }); runtime.info = await request("initialize") as typeof info; dependencies.drafts = new AttachmentDraftStore(join(root, "drafts")) }
  return { root, workspace, destination, sessionDir, settingsPath, entry, other, restart, host: { ...host, close: async () => { await host.close(); await otherHost.close() } }, request, globals, dependencies, projects }
}

it.each(["marker failure", "crash window"])("recovers native deletion from authoritative JSONL proof after fresh restart: %s", async failure => {
  const f = await fixture(), native = (value: unknown) => dispatchDesktopRequest(value, f.dependencies)
  try {
    const { sessionId } = await f.request("session/create") as { sessionId: string }
    const sibling = await f.request("session/create") as { sessionId: string }
    const scope = { workspaceId: f.entry.id, identity: sessionId }, siblingScope = { ...scope, identity: sibling.sessionId }, newTaskScope = { ...scope, identity: "new-task:unassigned" }
    const draft = { prompt: "orphan secret prompt", references: ["source.txt"], images: [{ id: 1, mediaType: "image/png", dataBase64: "AQID" }], texts: [{ id: 2, name: "secret.txt", text: "secret attachment" }], contextRefs: [{ kind: "file", workspaceId: f.entry.id, path: "source.txt", label: "source" }] }
    await writeFile(join(f.workspace, "source.txt"), "source survives")
    await native({ kind: "desktop/draft/save", scope, expectedRevision: null, draft })
    const siblingSaved = await native({ kind: "desktop/draft/save", scope: siblingScope, expectedRevision: null, draft })
    const newTaskSaved = await native({ kind: "desktop/draft/save", scope: newTaskScope, expectedRevision: null, draft })
    const command = { action: "delete", sessionIds: [sessionId] }, request = { kind: "desktop/session/batch", workspaceId: f.entry.id, confirmed: true, command }
    if (failure === "marker failure") {
      const store = f.dependencies.drafts!, retire = store.retire.bind(store), blocker = join(f.root, "drafts", "retired")
      const fail = vi.spyOn(store, "retire").mockImplementationOnce(async value => { await writeFile(blocker, "filesystem unavailable"); return retire(value) })
      expect(await native(request)).toMatchObject({ results: [{ sessionId, ok: false, sessionDeleted: true }] })
      fail.mockRestore(); await unlink(blocker)
    } else {
      // Equivalent to power interruption after gateway success and before native retirement.
      expect(await f.request("desktop/session/batch", { command })).toMatchObject({ results: [{ sessionId, ok: true }] })
    }
    await f.restart()
    expect((await f.dependencies.drafts!.load(scope)).draft?.prompt).toBe("orphan secret prompt")
    expect(await native(request)).toMatchObject({ results: [{ sessionId, ok: true }] })
    expect(await f.dependencies.drafts!.load(scope)).toEqual({ revision: null, draft: null })
    expect(await native({ kind: "desktop/draft/load", scope: siblingScope })).toEqual(siblingSaved)
    expect(await native({ kind: "desktop/draft/load", scope: newTaskScope })).toEqual(newTaskSaved)
    expect(await readFile(join(f.workspace, "source.txt"), "utf8")).toBe("source survives")
    await expect(native({ kind: "desktop/draft/save", scope, expectedRevision: null, draft })).rejects.toThrow(/conversation unavailable/)
  } finally { vi.restoreAllMocks(); await f.globals.close(); await f.host.close() }
})

it("preserves draft payloads and refuses missing, busy, hidden and other-workspace deletion IDs", async () => {
  const f = await fixture(), native = (value: unknown) => dispatchDesktopRequest(value, f.dependencies)
  try {
    const busy = await f.request("session/create") as { sessionId: string }, hidden = await f.request("session/create") as { sessionId: string }
    const remoteRuntime = await f.dependencies.runtimes.get(f.dependencies.catalog.get(f.other.id)!)
    const remote = await remoteRuntime.client.request("session/create", {}) as { sessionId: string }
    const draft = { prompt: "preserve me", references: [], images: [], texts: [], contextRefs: [] }
    const scopes = [{ workspaceId: f.entry.id, identity: busy.sessionId }, { workspaceId: f.entry.id, identity: hidden.sessionId }, { workspaceId: f.other.id, identity: remote.sessionId }]
    const saved = await Promise.all(scopes.map(scope => native({ kind: "desktop/draft/save", scope, expectedRevision: null, draft })))
    await f.restart(async () => {
      const backend = createJsonlBackend(f.sessionDir)
      await backend.append(busy.sessionId, [{ type: "turn/start", seq: 0 }])
      await backend.updateMeta(hidden.sessionId, { origin: "subagent", parentSession: busy.sessionId })
    })
    const result = await native({ kind: "desktop/session/batch", workspaceId: f.entry.id, confirmed: true, command: { action: "delete", sessionIds: [busy.sessionId, hidden.sessionId, remote.sessionId, "missing"] } }) as { results: { ok: boolean }[] }
    expect(result.results).toHaveLength(4); expect(result.results.every(row => !row.ok)).toBe(true)
    for (let i = 0; i < scopes.length; i++) { expect(await f.dependencies.drafts!.isRetired(scopes[i]!)).toBe(false); expect(await f.dependencies.drafts!.load(scopes[i]!)).toEqual(saved[i]) }
  } finally { await f.globals.close(); await f.host.close() }
})

it("persists providers and auto-title through native configuration routes with no conversation or selected folder", async () => {
  const f = await fixture()
  const native = (value: unknown) => dispatchDesktopRequest(value, { ...f.dependencies, catalog: { ...f.dependencies.catalog, get: () => undefined } })
  try {
    expect(await f.request("session/list")).toEqual({ sessions: [] })
    await native({ kind: "desktop/global-provider/mutate", command: { action: "provider/create", id: "fixture-local", fields: { protocol: "openai-responses", baseURL: "https://example.invalid" } } })
    await native({ kind: "desktop/global-provider/mutate", command: { action: "model/add", id: "fixture-local", model: "fixture-model", fields: { contextWindow: 8192 } } })
    expect(await native({ kind: "desktop/global-preferences/state" })).toEqual({ enabled: true })
    expect(await native({ kind: "desktop/global-preferences/configure", autoTitle: false })).toEqual({ enabled: false })
    const directory = await native({ kind: "desktop/global-provider/directory" })
    expect(directory).toEqual(expect.arrayContaining([expect.objectContaining({ id: "fixture-local", models: [expect.objectContaining({ id: "fixture-model" })] })]))
    expect(JSON.parse(await readFile(f.settingsPath, "utf8"))).toMatchObject({ autoTitle: false, llm: { providers: { "fixture-local": expect.anything() } } })
    expect(await f.request("session/list")).toEqual({ sessions: [] })
    await writeFile(f.settingsPath, "{ corrupt")
    expect(await native({ kind: "desktop/global-preferences/state" })).toEqual({ enabled: false })
    await expect(native({ kind: "desktop/global-preferences/configure", autoTitle: true })).rejects.toThrow(/settings document/i)
  } finally { await f.globals.close(); await f.host.close() }
})

it("mounts cold execution reads, real move/deletion and native authorized draft CAS", async () => {
  const f = await fixture(), native = (value: unknown) => dispatchDesktopRequest(value, f.dependencies)
  try {
    const caps = await native({ kind: "desktop/capabilities", workspaceId: f.entry.id })
    expect(caps).toMatchObject({ "desktop-drafts": ["1"], "desktop-code-mode-settings": ["1"], "desktop-execution": ["1"], "desktop-agent-processes": ["1"], "desktop-environment-diagnostics": ["1"], "desktop-approval-rules": ["1"] })
    const { sessionId } = await f.request("session/create") as { sessionId: string }
    const scope = { workspaceId: f.entry.id, identity: sessionId }, draft = { prompt: "unsent", references: ["same.txt"], images: [{ id: 1, mediaType: "image/png", dataBase64: "AQID" }], texts: [{ id: 2, name: "snapshot.txt", text: "unsent attachment" }], contextRefs: [{ kind: "file", workspaceId: f.entry.id, path: "same.txt", label: "source" }] }
    expect(await native({ kind: "desktop/draft/load", scope })).toEqual({ revision: null, draft: null })
    const saved = await native({ kind: "desktop/draft/save", scope, expectedRevision: null, draft }) as { revision: string }
    const sibling = await f.request("session/create") as { sessionId: string }
    const siblingScope = { ...scope, identity: sibling.sessionId }, newTaskScope = { ...scope, identity: "new-task:unassigned" }
    const siblingSaved = await native({ kind: "desktop/draft/save", scope: siblingScope, expectedRevision: null, draft })
    const newTaskSaved = await native({ kind: "desktop/draft/save", scope: newTaskScope, expectedRevision: null, draft })
    await expect(native({ kind: "desktop/draft/save", scope, expectedRevision: null, draft })).rejects.toThrow(/revision conflict/)
    expect(await native({ kind: "desktop/draft/load", scope })).toMatchObject({ revision: saved.revision, draft })
    expect(await native({ kind: "desktop/code-mode/configure", workspaceId: f.entry.id, sessionId, patch: { mode: "mixed" } })).toMatchObject({ saved: { mode: "mixed" }, live: false })
    expect(await native({ kind: "desktop/session/execution/read", workspaceId: f.entry.id, sessionId })).toMatchObject({ live: false, cells: [] })
    expect(await native({ kind: "desktop/environment/diagnostics", workspaceId: f.entry.id, sessionId })).toMatchObject({ live: false, tools: [] })
    expect(await native({ kind: "desktop/session/processes/read", workspaceId: f.entry.id, sessionId })).toMatchObject({ live: false, terminals: [] })
    await expect(native({ kind: "desktop/session/processes/terminal-output", workspaceId: f.entry.id, sessionId, id: "missing-pty" })).rejects.toThrow(/Saved terminal output unavailable/)
    await expect(native({ kind: "desktop/session/execution/stop", workspaceId: f.entry.id, sessionId, cellId: "saved-cell" })).rejects.toThrow(/live execution owner/)
    const project = await f.projects.save({ name: "Destination", workspaceIds: [f.other.id] })
    await writeFile(join(f.workspace, "same.txt"), "source"); await writeFile(join(f.destination, "same.txt"), "destination")
    const moved = await native({ kind: "desktop/session/batch", workspaceId: f.entry.id, confirmed: true, command: { action: "move", sessionIds: [sessionId], projectId: project.id, expectedOwners: { [sessionId]: null } } })
    expect(moved).toMatchObject({ results: [{ sessionId, ok: true, projectId: project.id, executionWorkspace: f.workspace }] })
    expect(await native({ kind: "desktop/session/project/state", workspaceId: f.entry.id, sessionId })).toMatchObject({ projectId: project.id })
    const selection = { workspaceId: f.entry.id, sessionId }
    expect(await native({ kind: "desktop/project-files/roots", ...selection })).toMatchObject({ roots: [{ workspaceId: f.other.id }], projectId: project.id })
    await expect(native({ kind: "desktop/project-files/read", ...selection, ref: { workspaceId: f.entry.id, path: "same.txt" } })).rejects.toThrow(/current project member/)
    const target = { workspaceId: f.other.id, path: "same.txt" }
    const file = await native({ kind: "desktop/project-files/read", ...selection, ref: target }) as { revision: string; text: string }
    expect(file.text).toBe("destination")
    await native({ kind: "desktop/project-files/save", ...selection, ref: target, text: "changed destination", expectedRevision: file.revision })
    expect(await readFile(join(f.workspace, "same.txt"), "utf8")).toBe("source")
    expect(await readFile(join(f.destination, "same.txt"), "utf8")).toBe("changed destination")
    await expect(native({ kind: "desktop/session/batch", workspaceId: f.entry.id, command: { action: "delete", sessionIds: [sessionId] } })).rejects.toThrow(/confirmation/)
    expect(await native({ kind: "desktop/session/batch", workspaceId: f.entry.id, confirmed: true, command: { action: "delete", sessionIds: [sessionId, "missing-session"] } })).toMatchObject({ results: [{ sessionId, ok: true }, { sessionId: "missing-session", ok: false }] })
    expect(await new AttachmentDraftStore(join(f.root, "drafts")).load(scope)).toEqual({ revision: null, draft: null })
    await expect(f.dependencies.drafts!.clear(scope, saved.revision)).rejects.toThrow(/retired/)
    expect(await native({ kind: "desktop/draft/load", scope: siblingScope })).toEqual(siblingSaved); expect(await native({ kind: "desktop/draft/load", scope: newTaskScope })).toEqual(newTaskSaved)
    await expect(native({ kind: "desktop/draft/load", scope })).rejects.toThrow(/conversation unavailable/)
    await expect(f.request("desktop/session/input/resume", { sessionId })).rejects.toThrow(/deleted/)
    await expect(native({ kind: "desktop/notifications/target", workspaceId: f.entry.id, sessionId })).rejects.toThrow()
  } finally { await f.globals.close(); await f.host.close() }
})

it("reports native cleanup failure and retries from its durable deletion receipt after restart", async () => {
  const f = await fixture(), native = (value: unknown) => dispatchDesktopRequest(value, f.dependencies)
  try {
    const { sessionId } = await f.request("session/create") as { sessionId: string }
    const scope = { workspaceId: f.entry.id, identity: sessionId }
    await native({ kind: "desktop/draft/save", scope, expectedRevision: null, draft: { prompt: "deleted", images: [], texts: [], references: [], contextRefs: [] } })
    const store = f.dependencies.drafts!, retire = store.retire.bind(store)
    const fail = vi.spyOn(store, "retire").mockImplementationOnce(async value => { await retire(value); throw new Error("directory sync failed") })
    const request = { kind: "desktop/session/batch", workspaceId: f.entry.id, confirmed: true, command: { action: "delete", sessionIds: [sessionId] } }
    expect(await native(request)).toMatchObject({ results: [{ sessionId, ok: false, sessionDeleted: true, error: expect.stringContaining("directory sync failed") }] })
    fail.mockRestore(); f.dependencies.drafts = new AttachmentDraftStore(join(f.root, "drafts"))
    expect(await native(request)).toMatchObject({ results: [{ sessionId, ok: true }] })
    expect(await f.dependencies.drafts.load(scope)).toEqual({ revision: null, draft: null })
  } finally { await f.globals.close(); await f.host.close() }
})

it("fences a native save authorized from a navigation reply captured before permanent deletion", async () => {
  const f = await fixture(), native = (value: unknown) => dispatchDesktopRequest(value, f.dependencies)
  const authorized = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  try {
    const { sessionId } = await f.request("session/create") as { sessionId: string }
    const scope = { workspaceId: f.entry.id, identity: sessionId }, draft = { prompt: "before deletion", references: [], images: [], texts: [], contextRefs: [] }
    const saved = await native({ kind: "desktop/draft/save", scope, expectedRevision: null, draft }) as { revision: string }
    const get = f.dependencies.runtimes.get.bind(f.dependencies.runtimes)
    const capture = vi.spyOn(f.dependencies.runtimes, "get").mockImplementation(async workspace => {
      const runtime = await get(workspace)
      return { ...runtime, client: { ...runtime.client, request: async (method: string, params: unknown, timeout?: number) => {
        const reply = await runtime.client.request(method, params, timeout)
        if (method === "desktop/session/navigation/state") { authorized.resolve(); await release.promise }
        return reply
      } } as typeof runtime.client }
    })
    const late = native({ kind: "desktop/draft/save", scope, expectedRevision: saved.revision, draft: { ...draft, prompt: "late payload" } })
    const observed = late.catch(error => error)
    await authorized.promise
    expect(await native({ kind: "desktop/session/batch", workspaceId: f.entry.id, confirmed: true, command: { action: "delete", sessionIds: [sessionId] } })).toMatchObject({ results: [{ sessionId, ok: true }] })
    release.resolve(); expect(String(await observed)).toMatch(/retired/)
    capture.mockRestore()
    expect(await new AttachmentDraftStore(join(f.root, "drafts")).load(scope)).toEqual({ revision: null, draft: null })
  } finally { release.resolve(); vi.restoreAllMocks(); await f.globals.close(); await f.host.close() }
})

it("consults the latest saved auto-title preference on real host turns using a local fixture model", async () => {
  const f = await fixture(), native = (value: unknown) => dispatchDesktopRequest(value, f.dependencies)
  let calls = 0
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain the local fixture request */ }
    calls++
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end('data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Fixture title"},"finish_reason":null}]}\n\ndata: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  try {
    await f.request("desktop/provider/mutate", { action: "provider/create", id: "local-fixture", fields: { protocol: "openai-completions", baseURL: `http://127.0.0.1:${address.port}` } })
    await f.request("desktop/provider/mutate", { action: "key/set", id: "local-fixture", value: "fixture-no-provider-fee" })
    await f.request("desktop/provider/mutate", { action: "model/add", id: "local-fixture", model: "fixture-model", fields: { contextWindow: 32000, maxTokens: 4096 } })
    await f.request("desktop/provider/mutate", { action: "default/set", id: "local-fixture", model: "fixture-model" })
    const first = await f.request("session/create") as { sessionId: string }
    await native({ kind: "desktop/global-preferences/configure", autoTitle: false })
    await f.request("session/prompt", { sessionId: first.sessionId, prompt: "A local title fixture" })
    expect(calls).toBe(1)
    await native({ kind: "desktop/global-preferences/configure", autoTitle: true })
    const second = await f.request("session/create") as { sessionId: string }
    await f.request("session/prompt", { sessionId: second.sessionId, prompt: "Another local title fixture" })
    expect(calls).toBe(3)
    const list = await f.request("session/list") as { sessions: { id: string; title?: string }[] }
    expect(list.sessions.find(row => row.id === second.sessionId)?.title).toBe("Fixture title")
    expect(list.sessions.find(row => row.id === first.sessionId)?.title).toBeUndefined()
  } finally { await f.globals.close(); await f.host.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
