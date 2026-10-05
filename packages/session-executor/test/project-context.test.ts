import { afterEach, expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { createSessionAssembly, type SessionProjectContext } from "../src/assembly.ts"
import { createSessionService } from "../src/service.ts"
import { rmWorkspaceSync } from "./helpers.ts"
import { createMockClient } from "@i-harness/llm-mock"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "../../session-persistence-jsonl/src/index.ts"
import { createDurableSessionLoader } from "../src/durable-session.ts"
import type { SubagentStateSnapshot } from "@i-harness/subagent"
import { append } from "@i-harness/core-session"
import type { WorkflowExecutor } from "@i-harness/workflow"

const fixtures: string[] = []
afterEach(() => { for (const fixture of fixtures.splice(0)) rmWorkspaceSync(fixture) })
function fixture() {
  // The unrelated folder must be outside the platform temp grant, so `tmpdir()`
  // is NOT usable here: the runner's private temp sits inside it, which would
  // make the denial assertions vacuous. `process.cwd()` is the package
  // directory — outside the temp grant, outside the workspace under test, and
  // present on every host. The Windows branch used to name the original
  // developer's `D:/agent-complete/playground`, so every `mkdtempSync` below
  // died with ENOENT on any other machine (measured 2026-10-05).
  const parent = process.cwd()
  const root = mkdtempSync(join(parent, "project-execution-")); fixtures.push(root)
  const a = join(root, "a"), b = join(root, "b"), c = join(root, "unrelated")
  for (const path of [a, b, c]) mkdirSync(path)
  return { root, a, b, c }
}
const quietModel: ModelClient = { async *stream() { yield { type: "text/chunk", text: "ok" }; yield { type: "end" } } }
async function waitFor(check: () => boolean | Promise<boolean>) {
  const until = Date.now() + 5_000
  while (!(await check())) { if (Date.now() >= until) throw new Error("project child did not finish"); await new Promise((resolve) => setTimeout(resolve, 20)) }
}

it("writes to another project folder without an extra approval and revokes a removed default cwd", async () => {
  const { a, b, c } = fixture()
  let context: SessionProjectContext = { id: "p", name: "Project One", roots: [a, b], primaryRoot: a }
  const assembly = await createSessionAssembly({ workspace: a, model: quietModel, sandbox: "workspace-write", projectContext: () => context })
  try {
    expect((await assembly.tools.execute({ name: "write", args: { path: join(b, "allowed.txt"), text: "second folder" } })).output).toMatchObject({ ok: true })
    expect(readFileSync(join(b, "allowed.txt"), "utf8")).toBe("second folder")
    const directWrite = assembly.tools.get("write")!
    const outside = await directWrite.execute({ path: join(c, "denied.txt"), text: "outside" }, {}) as { error?: string }
    expect(outside.error).toContain("SANDBOX_DENIED")
    expect(existsSync(join(c, "denied.txt"))).toBe(false)

    context = { ...context, roots: [b], primaryRoot: b }
    const removed = await directWrite.execute({ path: "old-cwd.txt", text: "removed" }, {}) as { error?: string }
    expect(removed.error).toContain("SANDBOX_DENIED")
    expect(existsSync(join(a, "old-cwd.txt"))).toBe(false)
    context = { ...context, roots: [b, c] }
    expect((await assembly.tools.execute({ name: "write", args: { path: join(c, "newly-added.txt"), text: "new project folder" } })).output).toMatchObject({ ok: true })
    expect(readFileSync(join(c, "newly-added.txt"), "utf8")).toBe("new project folder")
  } finally { await assembly.dispose() }
})

it("normal and rebuilt resident children inherit the live project scope for requests and writes", async () => {
  const { root, a, b, c } = fixture()
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "parent" })
  let context: SessionProjectContext = { id: "p", name: "Initial child project", roots: [a, b], primaryRoot: a }
  let target = join(b, "child-initial.txt")
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) {
    requests.push(request)
    yield* createMockClient([request.messages.at(-1)?.role === "tool" ? { role: "assistant", text: "child finished" } : { role: "assistant", toolCalls: [{ name: "write", args: { path: target, text: "child wrote current project" } }] }]).stream(request)
  } }
  const options = { workspace: a, sessionId: "parent", coordinator, model, approveAll: true, sandbox: "workspace-write" as const, projectContext: () => context,
    pluginAgents: [{ name: "project-child", description: "project worker", systemPrompt: "PROJECT_CHILD", tools: ["write"] }],
  }
  let assembly = await createSessionAssembly(options)
  try {
    const spawn = await assembly.tools.execute({ name: "spawn_agent", args: { task_name: "project-worker", agent_type: "project-child", message: "write initial file", fork_turns: "none", background: false } })
    const path = (spawn.output as { agent_path: string }).agent_path
    expect(readFileSync(target, "utf8")).toBe("child wrote current project")
    expect(requests.at(-1)!.systemPrompt).toContain("Initial child project")

    context = { ...context, name: "Live updated child project", roots: [c], primaryRoot: c }
    target = join(c, "child-live.txt")
    await assembly.tools.execute({ name: "followup_task", args: { target: path, message: "write next file" } })
    await waitFor(() => existsSync(target))
    await waitFor(async () => ((await coordinator.getDocument("parent")) as SubagentStateSnapshot)?.agentTable.some((entry) => entry.path === path && entry.status === "waiting") === true)
    expect(requests.at(-1)!.systemPrompt).toContain("Live updated child project")
    const restoredState = await coordinator.getDocument("parent") as SubagentStateSnapshot
    await assembly.dispose()

    context = { ...context, name: "Restored child project", roots: [b], primaryRoot: b }
    target = join(b, "child-restored.txt")
    assembly = await createSessionAssembly({ ...options, session: await createDurableSessionLoader(coordinator)("parent"), restoredState })
    await assembly.tools.execute({ name: "followup_task", args: { target: path, message: "resume and write current project file" } })
    await waitFor(() => existsSync(target))
    expect(requests.at(-1)!.systemPrompt).toContain("Restored child project")
    expect(requests.at(-1)!.systemPrompt).not.toContain(JSON.stringify(c))
  } finally { await assembly.dispose(); await coordinator.close() }
})

it.each(["read-only", "danger-full-access"] as const)("keeps %s semantics across project roots", async (sandbox) => {
  const { a, b, c } = fixture()
  writeFileSync(join(b, "read.txt"), "second-folder content")
  const assembly = await createSessionAssembly({ workspace: a, model: quietModel, sandbox, projectContext: () => ({ id: "p", name: "Project One", roots: [a, b], primaryRoot: a }) })
  try {
    expect((await assembly.tools.execute({ name: "read", args: { path: join(b, "read.txt") } })).output).toEqual({ content: "second-folder content" })
    const target = join(sandbox === "read-only" ? b : c, "mode.txt")
    const output = await assembly.tools.get("write")!.execute({ path: target, text: "mode respects policy" }, {}) as { ok?: boolean; error?: string }
    if (sandbox === "read-only") {
      expect(output.error).toContain("SANDBOX_DENIED")
      expect(existsSync(target)).toBe(false)
    } else {
      expect(output.ok).toBe(true)
      expect(readFileSync(target, "utf8")).toBe("mode respects policy")
    }
  } finally { await assembly.dispose() }
})

it.each(["legacy", "binding"] as const)("passes session-local live project getters through the %s service construction path", async (path) => {
  const { a, b, c } = fixture()
  const contexts = new Map<string, SessionProjectContext>([["one", { id: "p1", name: "First Project", roots: [a, b], primaryRoot: a }], ["two", { id: "p2", name: "Second Project", roots: [c], primaryRoot: c }]])
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) { requests.push(request); yield { type: "text/chunk", text: "ok" }; yield { type: "end" } } }
  const service = createSessionService({ workspace: a, sandbox: "workspace-write", model,
    ...(path === "binding" ? { modelBindingFor: async () => ({ status: "ready" as const, binding: { model, providerId: "fixture", modelId: "fixture", label: "fixture" } }) } : {}),
    projectContextFor: async (id) => () => contexts.get(id),
  })
  try {
    await service.submit("one", "first turn", new AbortController().signal)
    expect(requests.at(-1)!.systemPrompt).toContain("First Project")
    expect(requests.at(-1)!.systemPrompt).toContain(JSON.stringify(b))
    contexts.set("one", { id: "p1", name: "Updated Project", roots: [b], primaryRoot: b })
    await service.submit("one", "second turn", new AbortController().signal)
    expect(requests.at(-1)!.systemPrompt).toContain("Updated Project")
    expect(requests.at(-1)!.systemPrompt).toContain("default working directory")
    expect(requests.at(-1)!.systemPrompt).toContain("absolute paths")
    await service.submit("two", "other project", new AbortController().signal)
    expect(requests.at(-1)!.systemPrompt).toContain("Second Project")
    expect(requests.at(-1)!.systemPrompt).not.toContain(JSON.stringify(b))
    const one = await service.assemblyFor("one")
    const result = await one.tools.get("write")!.execute({ path: join(c, "cross-project.txt"), text: "denied" }, {}) as { error?: string }
    expect(result.error).toContain("SANDBOX_DENIED")
    expect(existsSync(join(c, "cross-project.txt"))).toBe(false)
  } finally { await service.close() }
})

it("project tools read images and search an additional root using its absolute path", async () => {
  const { a, b } = fixture()
  writeFileSync(join(b, "needle.txt"), "multi-root-needle")
  writeFileSync(join(b, "image.png"), Buffer.from([1, 2, 3]))
  const assembly = await createSessionAssembly({ workspace: a, model: quietModel, sandbox: "read-only", projectContext: () => ({ id: "p", name: "Read project", roots: [a, b], primaryRoot: a }) })
  try {
    expect((await assembly.tools.execute({ name: "read_image", args: { path: join(b, "image.png") } })).output).toMatchObject({ images: [{ mediaType: "image/png", dataBase64: "AQID" }] })
    expect((await assembly.tools.get("glob")!.execute({ pattern: "*.txt", path: b }, {}))).toMatchObject({ matches: ["needle.txt"] })
    expect((await assembly.tools.get("grep")!.execute({ pattern: "multi-root-needle", path: b }, {}))).toMatchObject({ matches: [{ path: join(b, "needle.txt").replaceAll("\\", "/"), line: 1, text: "multi-root-needle" }] })
  } finally { await assembly.dispose() }
}, 30_000)

it("the selected shell receives current project roots and refuses removed cwd and unrelated writes", async () => {
  const { a, b, c } = fixture()
  let context: SessionProjectContext = { id: "p", name: "Shell project", roots: [a, b], primaryRoot: a }
  const powershell = join(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const commandFor = (path: string, text: string) => process.platform === "win32"
    ? `[IO.File]::WriteAllText('${path.replaceAll("'", "''")}', '${text}')`
    : `printf '%s' '${text}' > '${path.replaceAll("'", "'\\''")}'`
  const assembly = await createSessionAssembly({ workspace: a, model: quietModel, approveAll: true, sandbox: "workspace-write", projectContext: () => context,
    agentShell: () => process.platform === "win32" ? { id: "powershell", label: "PowerShell", command: powershell, dialect: "powershell" } : { id: "sh", label: "sh", command: "/bin/sh", dialect: "posix" },
  })
  try {
    const tool = assembly.tools.get("shell")!
    const allowed = join(b, "shell.txt")
    expect(await tool.execute({ command: commandFor(allowed, "first") }, {})).toMatchObject({ exitCode: 0 })
    expect(readFileSync(allowed, "utf8")).toBe("first")
    await tool.execute({ command: commandFor(join(c, "outside.txt"), "outside") }, {})
    expect(existsSync(join(c, "outside.txt"))).toBe(false)
    context = { ...context, roots: [b], primaryRoot: b }
    expect(await tool.execute({ command: commandFor(allowed, "updated") }, {})).toMatchObject({ exitCode: 0 })
    expect(readFileSync(allowed, "utf8")).toBe("updated")
    await tool.execute({ command: commandFor("removed-cwd.txt", "removed") }, {})
    expect(existsSync(join(a, "removed-cwd.txt"))).toBe(false)
    append(assembly.session, { type: "sandbox/mode", mode: "read-only" })
    await tool.execute({ command: commandFor(allowed, "read-only attempt") }, {})
    expect(readFileSync(allowed, "utf8")).toBe("updated")
  } finally { await assembly.dispose() }
}, 30_000)

it("a teammate receives the same live project context as its parent", async () => {
  const { root, a, b } = fixture()
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "team-parent" })
  const requests: LLMRequest[] = []
  const cassette = createMockClient([
    { role: "assistant", toolCalls: [{ name: "spawn_teammate", args: { name: "helper", description: "project worker", prompt: "read project folders" } }] },
    { role: "assistant", text: "done" }, { role: "assistant", text: "done" },
  ])
  const model: ModelClient = { async *stream(request) { requests.push(request); yield* cassette.stream(request) } }
  const assembly = await createSessionAssembly({ workspace: a, sessionId: "team-parent", coordinator, model, approveAll: true, team: {}, projectContext: () => ({ id: "p", name: "Teammate Project", roots: [a, b], primaryRoot: a }) })
  try {
    await assembly.agent.run("delegate project work")
    await waitFor(() => requests.some((request) => request.systemPrompt.includes("You are a teammate in an agent team.")))
    const child = requests.find((request) => request.systemPrompt.includes("You are a teammate in an agent team."))!
    expect(child.systemPrompt).toContain("Teammate Project")
    expect(child.systemPrompt).toContain(JSON.stringify(b))
  } finally { await assembly.dispose(); await coordinator.close() }
})

it("allows a project write outside the rewind folder and discloses that restore cannot capture it", async () => {
  const { root, a, b } = fixture()
  const requests: LLMRequest[] = []
  const target = join(b, "untracked.txt")
  const cassette = createMockClient([{ role: "assistant", toolCalls: [{ name: "write", args: { path: target, text: "valid project write" } }] }, { role: "assistant", text: "done" }])
  const model: ModelClient = { async *stream(request) { requests.push(request); yield* cassette.stream(request) } }
  const assembly = await createSessionAssembly({ workspace: a, sessionId: "rewind-project", rewindStoreRoot: join(root, "rewind-store"), model, sandbox: "workspace-write", projectContext: () => ({ id: "p", name: "Rewind project", roots: [a, b], primaryRoot: a }) })
  try {
    await assembly.agent.run("write to the second project folder")
    expect(readFileSync(target, "utf8")).toBe("valid project write")
    expect(requests.at(-1)!.systemPrompt).toContain("outside its restore coverage")
    await waitFor(async () => (await assembly.rewind!.store.readPoints()).length > 0)
    expect((await assembly.rewind!.store.readPoints())[0]!.files).toEqual([])
  } finally { await assembly.dispose() }
})

it("background workflow commands enforce current project membership instead of running unconfined", async () => {
  const { a, b, c } = fixture()
  let context: SessionProjectContext = { id: "p", name: "Background project", roots: [a, b], primaryRoot: a }
  const assembly = await createSessionAssembly({ workspace: a, model: quietModel, sandbox: "workspace-write", projectContext: () => context })
  const token = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  const command = (path: string, value: string) => [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(path)}, ${JSON.stringify(value)})`].map(token).join(" ")
  try {
    const workflow = assembly.ctx.services.get<WorkflowExecutor>("workflow/executor")
    async function run(path: string, value: string) {
      const { jobId } = workflow.runWorkflow({ name: "project-write", description: "write a project file", steps: [{ name: "write", command: command(path, value) }] }, {})
      await waitFor(() => workflow.getOutput(jobId).status !== "running")
      return workflow.getOutput(jobId)
    }
    expect(await run(join(b, "workflow.txt"), "allowed")).toMatchObject({ status: "completed" })
    expect(await run(join(c, "outside-workflow.txt"), "outside")).toMatchObject({ status: "error" })
    expect(existsSync(join(c, "outside-workflow.txt"))).toBe(false)
    context = { ...context, roots: [a] }
    expect(await run(join(b, "workflow.txt"), "removed")).toMatchObject({ status: "error" })
    expect(readFileSync(join(b, "workflow.txt"), "utf8")).toBe("allowed")
  } finally { await assembly.dispose() }
}, 30_000)
