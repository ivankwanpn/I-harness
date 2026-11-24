import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { expect, it, vi } from "vitest"
import { dispatchDesktopRequest } from "../src/main/ipc.ts"
import { projectRuntimeContexts, scopedProject } from "../src/main/project-runtime.ts"
import { createProjectCatalog } from "../src/main/projects.ts"
import { createWorkspaceRuntimeManager } from "../src/main/sdk-runtime.ts"
import { createWorkspaceCatalog } from "../src/main/workspaces.ts"
import { createDesktopWorktrees } from "../src/main/worktrees.ts"

const exec = promisify(execFile)
const git = async (root: string, ...args: string[]) => (await exec("git", args, { cwd: root, windowsHide: true })).stdout.trim()

it("routes two real linked worktree conversations to their own files and Git index and restores their project binding", async () => {
  const profile = await mkdtemp(join(tmpdir(), "ih-worktree-e2e-"))
  const root = join(profile, "repo"), dir = join(profile, "checkouts"), config = join(profile, "config")
  const workspacesFile = join(profile, "workspaces.json"), projectsFile = join(profile, "projects.json")
  const previous = process.env.IH_CONFIG_DIR
  const previousKey = process.env.IH_TEST_WORKTREE_MODEL_KEY
  process.env.IH_CONFIG_DIR = config
  process.env.IH_TEST_WORKTREE_MODEL_KEY = "local-fixture-only"
  let callsInFlight = 0
  let maxCallsInFlight = 0
  const bothStarted = Promise.withResolvers<void>()
  const model = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const transcript = JSON.stringify(input.input)
      const label = transcript.includes("write-alpha-fixture") ? "alpha" : "beta"
      const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.writeHead(200, { "content-type": "text/event-stream" })
      if (transcript.includes("function_call_output")) {
        send({ type: "response.output_text.delta", delta: `Finished ${label}` })
      } else {
        maxCallsInFlight = Math.max(maxCallsInFlight, ++callsInFlight)
        if (callsInFlight === 2) bothStarted.resolve()
        await bothStarted.promise
        const item = { type: "function_call", id: "tool-" + label, call_id: "call-" + label, name: "write",
          arguments: JSON.stringify({ path: "agent.txt", text: label }) }
        send({ type: "response.output_item.added", output_index: 0, item })
        send({ type: "response.output_item.done", output_index: 0, item })
        callsInFlight--
      }
      send({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 7 } } })
      res.end()
    } catch { res.destroy() }
  })
  let manager: ReturnType<typeof createWorkspaceRuntimeManager> | undefined
  let worktrees: ReturnType<typeof createDesktopWorktrees> | undefined
  function openProfile() {
    const catalog = createWorkspaceCatalog(workspacesFile)
    const projects = createProjectCatalog(projectsFile, catalog)
    const treeOwner = worktrees = createDesktopWorktrees(dir, catalog, projects)
    const runtimes = manager = createWorkspaceRuntimeManager({
      sessionsRoot: join(profile, "sessions"),
      projectContexts: () => projectRuntimeContexts(projects, catalog),
      async projectContextsForWorkspace(id, contexts) {
        const workspace = catalog.get(id)
        if (workspace?.worktree) await treeOwner.assertWorktree(workspace)
        return contexts.map(context => scopedProject(context, workspace))
      },
    })
    const dependencies = { catalog, projects, runtimes, worktrees: treeOwner }
    return { ...dependencies, request: (input: unknown) => dispatchDesktopRequest(input, dependencies) }
  }
  try {
    await Promise.all([mkdir(root), mkdir(config)])
    model.listen(0, "127.0.0.1")
    await once(model, "listening")
    const port = (model.address() as {port: number}).port
    await writeFile(join(config, "settings.json"), JSON.stringify({
      sandboxMode: "danger-full-access", approvalMode: "full-access", autoTitle: false, compaction: { auto: false },
      llm: { providers: { local: { baseURL: `http://127.0.0.1:${port}`, protocol: "openai-responses",
        apiKeyEnv: "IH_TEST_WORKTREE_MODEL_KEY", models: [{ id: "local-model", contextWindow: 32000 }] } }, defaultModel: { provider: "local", model: "local-model" } },
    }))
    await git(root, "init", "-q")
    await writeFile(join(root, "same.txt"), "original")
    await git(root, "add", "--", "same.txt")
    await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "initial")
    let app = openProfile()
    const source = await app.catalog.open(root)
    const project = await app.projects.save({ name: "Project", workspaceIds: [source.id], primaryWorkspaceId: source.id })
    const selection = { kind: "session/create", workspaceId: source.id, projectId: project.id, worktree: { mode: "create" } } as const
    const register = app.catalog.registerWorktree!
    app.catalog.registerWorktree = vi.fn(register).mockRejectedValueOnce(new Error("catalog write interrupted"))
    await expect(app.request({ ...selection, clientToken: "first-draft-token" })).rejects.toThrow("catalog write interrupted")
    app.catalog.registerWorktree = register
    expect(await readdir(dir)).toHaveLength(1)
    const [a, retry, b] = await Promise.all(["first-draft-token", "first-draft-token", "other-draft-token"].map(async clientToken =>
      await app.request({ ...selection, clientToken }) as { workspaceId: string; sessionId: string }))
    expect(a).toEqual(retry)
    expect(b.workspaceId).not.toBe(a.workspaceId)
    expect(await readdir(dir)).toHaveLength(2)
    expect(await app.request({ kind: "workspace/sandbox/state", workspaceId: source.id })).toMatchObject({ mode: "danger-full-access" })
    expect(await app.request({ kind: "workspace/sandbox/state", workspaceId: a.workspaceId })).toMatchObject({ mode: "workspace-write" })
    expect(await app.request({ kind: "desktop/agent-settings/state", workspaceId: b.workspaceId })).toMatchObject({
      isolatedWorktree: true, effective: { sandboxMode: "workspace-write", approvalMode: "dangerous" },
    })
    await expect(app.request({ kind: "desktop/agent-settings/configure", workspaceId: b.workspaceId, patch: { approvalMode: "full-access" } }))
      .rejects.toThrow(/Full access is unavailable/)
    const [aPath, bPath] = [a, b].map(target => app.catalog.get(target.workspaceId)!.path)

    await Promise.all([a, b].map(async (target, index) => {
      const ref = { workspaceId: target.workspaceId, path: "same.txt" }
      const authority = { ...target, projectId: project.id }
      const roots = await app.request({ kind: "desktop/project-files/roots", ...authority })
      expect(roots).toEqual({ projectId: project.id, roots: [{ workspaceId: target.workspaceId, label: app.catalog.get(target.workspaceId)!.label }] })
      const contents = await app.request({ kind: "desktop/project-files/read", ...authority, ref }) as { revision: string }
      expect(await app.request({ kind: "desktop/project-files/save", ...authority, ref, expectedRevision: contents.revision, text: index ? "beta" : "alpha" })).toMatchObject({ kind: "saved" })
      await expect(app.request({ kind: "desktop/project-files/save", ...authority, ref: { ...ref, workspaceId: index ? a.workspaceId : b.workspaceId },
        expectedRevision: contents.revision, text: "wrong worktree" })).rejects.toThrow(/not a current project member/)
      expect(await app.request({ kind: "desktop/review/stage", workspaceId: target.workspaceId, path: "same.txt" })).toEqual({ kind: "ok" })
    }))
    expect(await readFile(join(root, "same.txt"), "utf8")).toBe("original")
    expect(await git(aPath!, "show", ":same.txt")).toBe("alpha")
    expect(await git(bPath!, "show", ":same.txt")).toBe("beta")
    expect(await git(root, "show", ":same.txt")).toBe("original")
    await Promise.all([a, b].map((target, index) => app.request({ kind: "session/prompt", ...target,
      prompt: index ? "write-beta-fixture" : "write-alpha-fixture" })))
    expect(maxCallsInFlight).toBe(2)
    expect(await readFile(join(aPath!, "agent.txt"), "utf8")).toBe("alpha")
    expect(await readFile(join(bPath!, "agent.txt"), "utf8")).toBe("beta")
    await expect(readFile(join(root, "agent.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    await expect(app.projects.save({ name: "Broad", workspaceIds: [a.workspaceId, b.workspaceId] })).rejects.toThrow(/known folder workspaces/)
    expect(await app.worktrees.describe(a.workspaceId)).toMatchObject({ path: aPath!.replaceAll("\\", "/"), dirty: true })

    const imported = join(profile, "Imported")
    await git(root, "worktree", "add", "-b", "external", "--", imported, "HEAD")
    const importRequest = { ...selection, clientToken: "import-draft-token", worktree: { mode: "existing", path: imported } } as const
    const external = await app.request(importRequest) as { workspaceId: string; sessionId: string }
    expect(app.catalog.get(external.workspaceId)?.path).toBe(await realpath(imported))
    expect(app.catalog.get(external.workspaceId)?.worktree?.kind).toBe("imported")
    await app.request({ kind: "desktop/worktrees/offer", workspaceId: external.workspaceId, projectId: project.id, offered: false })
    expect(await app.request(importRequest)).toEqual(external)
    await expect(app.request({ ...selection, clientToken: "no-new-conversation", worktree: { mode: "existing", path: imported } })).rejects.toThrow(/Enable the linked worktree/)
    expect(await readFile(join(imported, "same.txt"), "utf8")).toBe("original")
    await app.runtimes.invalidate!(external.workspaceId)
    const moved = join(profile, "Moved")
    await git(root, "worktree", "move", "--", imported, moved)
    await expect(app.request({ kind: "desktop/worktrees/state", workspaceId: external.workspaceId })).rejects.toThrow()
    expect(await app.request({ kind: "desktop/worktrees/relink", workspaceId: external.workspaceId })).toMatchObject({
      id: external.workspaceId, path: await realpath(moved), worktree: { kind: "imported", offered: false },
    })
    expect(await app.request(importRequest)).toEqual(external)
    await expect(app.request({ ...importRequest, worktree: { mode: "existing", path: moved } })).rejects.toThrow(/original request/)
    await app.worktrees.close()
    await app.runtimes.close()
    app = openProfile()
    for (const target of [a, b]) {
      expect(await app.request({ kind: "desktop/session/project/state", ...target })).toMatchObject({ projectId: project.id, sessionId: target.sessionId })
      expect(await app.request({ kind: "desktop/project-files/roots", ...target, projectId: project.id })).toMatchObject({ roots: [{ workspaceId: target.workspaceId }] })
    }
    expect(await app.request({ kind: "desktop/session/project/state", ...external })).toMatchObject({ projectId: project.id, sessionId: external.sessionId })
    expect(await app.request(importRequest)).toEqual(external)
    expect(await app.request({ ...selection, clientToken: "first-draft-token" })).toEqual(a)
    expect(await readdir(dir)).toHaveLength(2)
  } finally {
    bothStarted.resolve()
    model.closeAllConnections()
    model.close()
    await worktrees?.close()
    await manager?.close()
    if (previous === undefined) delete process.env.IH_CONFIG_DIR
    else process.env.IH_CONFIG_DIR = previous
    if (previousKey === undefined) delete process.env.IH_TEST_WORKTREE_MODEL_KEY
    else process.env.IH_TEST_WORKTREE_MODEL_KEY = previousKey
    const fixture = await realpath(profile)
    if (dirname(fixture) !== await realpath(tmpdir())) throw new Error("Refusing to remove a path outside test storage")
    await rm(fixture, { force: true, recursive: true })
  }
}, 120_000)
