import { expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { append } from "@i-harness/core-session"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import { createDesktopExecution, createCodeModeSettings } from "../src/execution.ts"
import { createAgentProcesses } from "../src/agent-processes.ts"
import { createDesktopDiagnostics, probeExecutable } from "../src/environment-diagnostics.ts"

it.each(["tool", "code"] as const)("restores actual registered job_output snapshots from saved %s records without duplication or cold execution", async kind => {
  const root = await mkdtemp(join(tmpdir(), "ih-saved-job-dto-")), sessionDir = join(root, "sessions"), script = join(root, "output.cjs")
  let coordinator = createSessionCoordinator(createJsonlBackend(sessionDir))
  await coordinator.create({ sessionId: "s" }); await coordinator.create({ sessionId: "other" })
  await writeFile(script, 'process.stdout.write(process.argv[2] === "large" ? "QA_LIMIT_" + "x".repeat(150000) : "QA_JOB_OUTPUT\\n")')
  const live = createSessionService({ workspace: root, modelPolicy: "test-mock", approveAll: true, sandbox: "danger-full-access", codeMode: { mode: "mixed" }, coordinator, sessionFor: createDurableSessionLoader(coordinator) })
  const assembly = await live.assemblyFor("s"), shell = process.platform === "win32" ? "pwsh" : "bash"
  let callNumber = 0
  const execute = async (name: string, args: Record<string, unknown>) => {
    if (kind === "tool") {
      const callId = `actual-${++callNumber}`
      append(assembly.session, { type: "tool/call", callId, name, args })
      const result = await assembly.tools.execute({ name, args })
      append(assembly.session, { type: "tool/result", callId, name, output: result.output })
      return result.output as Record<string, unknown>
    }
    const result = await assembly.tools.execute({ name: "code_exec", args: { code: `await tools.${name}(${JSON.stringify(args)})`, yield_time_ms: 0 } })
    const initial = result.output as { cell_id: string; status: string }
    const observation = initial.status === "running" ? (await assembly.tools.execute({ name: "code_wait", args: { cell_id: initial.cell_id, yield_time_ms: 10000 } })).output as { status: string } : initial
    expect(observation.status).toBe("completed")
    const saved = assembly.session.events.findLast(event => event.type === "code/result" && event.cellId === initial.cell_id && event.name === name)
    if (!saved || saved.type !== "code/result") throw new Error("Missing actual registry result")
    return saved.output as Record<string, unknown>
  }
  const command = (mode: string) => process.platform === "win32" ? `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}' '${mode}'` : `'${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' '${mode}'`
  let cold: ReturnType<typeof createSessionService> | undefined
  try {
    const small = await execute(shell, { command: command("small"), background: true }), smallId = String(small.job_id)
    const snapshot = await execute("job_output", { job_id: smallId, wait: true, timeout_ms: 5000 })
    expect(snapshot).toEqual({ text: "QA_JOB_OUTPUT\n\n[status: completed]", status: "completed" })
    expect(await execute("job_output", { job_id: smallId })).toEqual(snapshot)
    const large = await execute(shell, { command: command("large"), background: true }), largeId = String(large.job_id)
    const largeSnapshot = await execute("job_output", { job_id: largeId, wait: true, timeout_ms: 5000 })
    expect(largeSnapshot.status).toBe("completed"); expect(String(largeSnapshot.text).length).toBeGreaterThan(131072)
    append(assembly.session, { type: "tool/call", callId: "wrong-launch", name: "list_dir", args: {} })
    append(assembly.session, { type: "tool/result", callId: "wrong-launch", name: shell, output: { ...small, job_id: "unmatched-job" } })
    append(assembly.session, { type: "tool/call", callId: "wrong-output", name: "list_dir", args: { job_id: smallId } })
    append(assembly.session, { type: "tool/result", callId: "wrong-output", name: "job_output", output: { ...snapshot, text: "unmatched output" } })
    append(assembly.session, { type: "tool/call", callId: "failed-output", name: "job_output", args: { job_id: smallId } })
    append(assembly.session, { type: "tool/result", callId: "failed-output", name: "job_output", output: { ...snapshot, text: "failed output" }, isError: true })
    await coordinator.flush("s"); await live.close(); await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(sessionDir)); cold = createSessionService({ workspace: root, modelPolicy: "required" })
    const before = await readFile(join(sessionDir, "s.jsonl"), "utf8"), processes = createAgentProcesses(coordinator, cold)
    expect(await processes.jobOutput("s", smallId)).toEqual({ text: snapshot.text, truncated: false, ownerSessionId: "s", live: false })
    expect(await processes.jobOutput("s", largeId)).toEqual({ text: String(largeSnapshot.text).slice(0, 131072), truncated: true, ownerSessionId: "s", live: false })
    expect((await processes.read("s")).jobs).toContainEqual(expect.objectContaining({ jobId: smallId, outputAvailable: true, status: "completed", live: false, canCancel: false }))
    await expect(processes.jobOutput("other", smallId)).rejects.toThrow(/unavailable.*owner/)
    await expect(processes.jobOutput("s", "unmatched-job")).rejects.toThrow(/unavailable.*owner/)
    await expect(processes.control("s", { action: "job/cancel", id: smallId })).rejects.toThrow(/live|cold/)
    expect(cold.hasAssembly("s")).toBe(false); expect(await readFile(join(sessionDir, "s.jsonl"), "utf8")).toBe(before)
  } finally { await cold?.close(); await live.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 15000)

it("projects saved tool/code PTYs and partial output after restart without an assembly or log writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-saved-pty-")), sessionDir = join(root, "sessions")
  let coordinator = createSessionCoordinator(createJsonlBackend(sessionDir))
  await coordinator.create({ sessionId: "cold" }); await coordinator.create({ sessionId: "other" })
  const session = await createDurableSessionLoader(coordinator)("cold")
  append(session, { type: "tool/call", callId: "open", name: "terminal_open", args: { command: "node", cols: 90, rows: 25 } })
  append(session, { type: "tool/result", callId: "open", name: "terminal_open", output: { id: "saved-pty", pid: 123, cols: 90, rows: 25 } })
  append(session, { type: "code/call", cellId: "cell", callId: "read", name: "terminal_read", args: { id: "saved-pty", offset: 100 } })
  append(session, { type: "code/result", cellId: "cell", callId: "read", name: "terminal_read", output: { id: "saved-pty", data: "saved output", nextOffset: 112, status: "running", truncated: false, dropped: true } })
  append(session, { type: "code/call", cellId: "cell", callId: "spawn", name: "process_spawn", args: { command: "pwsh" } })
  append(session, { type: "code/result", cellId: "cell", callId: "spawn", name: "process_spawn", output: { id: "no-output", pid: 456, cols: 80, rows: 24 } })
  await coordinator.flush("cold"); await coordinator.close()
  coordinator = createSessionCoordinator(createJsonlBackend(sessionDir))
  const service = createSessionService({ workspace: root, modelPolicy: "required" })
  const bytes = async () => { const files = (await readdir(sessionDir)).filter(name => name.endsWith(".jsonl")); return Promise.all(files.map(async name => [name, await readFile(join(sessionDir, name), "utf8")])) }
  const before = await bytes()
  try {
    const processes = createAgentProcesses(coordinator, service), view = await processes.read("cold")
    expect(view.terminals).toContainEqual(expect.objectContaining({ id: "saved-pty", ownerSessionId: "cold", command: "node", pid: 123, cols: 90, rows: 25, live: false, canControl: false, outputAvailable: true }))
    expect(view.terminals).toContainEqual(expect.objectContaining({ id: "no-output", live: false, canControl: false, outputAvailable: false }))
    expect(await processes.terminalOutput("cold", "saved-pty")).toMatchObject({ live: false, text: "saved output", dropped: true, reason: expect.any(String) })
    await expect(processes.terminalOutput("other", "saved-pty")).rejects.toThrow(/unavailable|owner/)
    await expect(processes.terminalOutput("cold", "no-output")).rejects.toThrow(/output unavailable/)
    for (const command of [{ action: "read", id: "saved-pty" }, { action: "send", id: "saved-pty", data: "x" }, { action: "close", id: "saved-pty" }, { action: "resize", id: "saved-pty", cols: 80, rows: 24 }, { action: "signal", id: "saved-pty", signal: "TERM" }]) await expect(processes.control("cold", command)).rejects.toThrow(/live|cold/)
    expect(service.hasAssembly("cold")).toBe(false); expect(await bytes()).toEqual(before)
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("reads actual nested cell history and stops its live owner while a model observer is waiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-execution-ui-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "owned" }); await coordinator.create({ sessionId: "other" })
  let modelCalls = 0
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), codeMode: { mode: "mixed" }, sandbox: "danger-full-access", model: { async *stream() { modelCalls++; yield { type: "end" } } } })
  const view = createDesktopExecution(coordinator, service)
  try {
    const assembly = await service.assemblyFor("owned")
    const result = await assembly.tools.execute({ name: "code_exec", args: { code: 'text(await tools.list_dir({path:"."})); await yield_control(); await new Promise(resolve => setTimeout(resolve, 20000));', yield_time_ms: 1000 } })
    const cellId = (result.output as { cell_id: string }).cell_id
    const read = await view.read("owned")
    expect(read.cells[0]).toMatchObject({ id: cellId, live: true, canTerminate: true })
    expect(read.cells[0]!.calls[0]).toMatchObject({ name: "list_dir", dispatched: true })
    expect(read.cells[0]!.output).not.toHaveLength(0)
    await expect(view.stop("other", cellId)).rejects.toThrow(/live|owner|cold/i)
    const observer = assembly.tools.execute({ name: "code_wait", args: { cell_id: cellId, yield_time_ms: 20000 } })
    await new Promise(resolve => setTimeout(resolve, 25))
    await view.stop("owned", cellId)
    expect((await observer).output).toMatchObject({ status: "terminated" })
    await coordinator.flush("owned"); await service.closeSession("owned")
    const cold = await view.read("owned")
    expect(cold.cells[0]).toMatchObject({ live: false, canTerminate: false, status: "terminated" })
    await expect(view.stop("owned", cellId)).rejects.toThrow(/live|cold/i)
    expect(service.hasAssembly("owned")).toBe(false)
    expect(modelCalls).toBe(0)
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 15000)

it("keeps saved running cells read only and bounds paginated cell content without mounting", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-cold-execution-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "cold" })
  const session = await createDurableSessionLoader(coordinator)("cold")
  append(session, { type: "code/cell", cellId: "old", sessionId: "cold", state: "started", source: "saved source" })
  append(session, { type: "code/output", cellId: "old", content: { type: "text", text: "x".repeat(150000) } })
  await coordinator.flush("cold")
  const service = createSessionService({ workspace: root, modelPolicy: "required" })
  try {
    const read = await createDesktopExecution(coordinator, service).read("cold", { limit: 1 })
    expect(read.cells[0]).toMatchObject({ status: "started", live: false, canTerminate: false, truncated: true })
    expect(JSON.stringify(read).length).toBeLessThan(140000)
    expect(service.hasAssembly("cold")).toBe(false)
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("does not promise cancellation when a custom Code Mode mount has no owner stop capability", async () => {
  const service = createSessionService({ workspace: tmpdir(), modelPolicy: "test-mock", codeMode: { mode: "mixed" }, codeModeFactory: (_ctx, tools) => ({ schemas: () => tools.schemas(), liveCells: () => [], cancel: async () => {}, dispose: async () => {} }) })
  try { expect((await service.assemblyFor("custom")).stopCodeCell).toBeUndefined() }
  finally { await service.close() }
})

it("saves mode under the settings lease, preserving provider fields and current runtime mode", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-mode-settings-"))
  const path = join(root, "settings.json")
  await writeFile(path, JSON.stringify({ codeMode: { mode: "mixed", maxActiveCells: 2 }, agentShell: "auto", llm: { defaultModel: { provider: "fixture", model: "x" } } }))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s" })
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", codeMode: { mode: "mixed" } })
  try {
    await service.assemblyFor("s")
    const settings = createCodeModeSettings(path, service)
    expect(await settings.configure({ mode: "only" }, "s")).toMatchObject({ saved: { mode: "only", maxActiveCells: 2 }, effective: "mixed", live: true })
    expect(settings.resolve().mode).toBe("only")
    await expect(settings.configure({ mode: "bogus" })).rejects.toThrow(/mode/i)
    await expect(settings.configure({ mode: "off", command: "anything" })).rejects.toThrow(/field|setting/i)
    const { SettingsStore } = await import("@i-harness/settings")
    const store = new SettingsStore({ path }); await store.load()
    expect(store.get().llm.defaultModel).toEqual({ provider: "fixture", model: "x" })
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it("controls actual owner PTY through role/hooks/sandbox registry and rejects cold or unrelated IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-owned-pty-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s" }); await coordinator.create({ sessionId: "other" })
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", approveAll: true, sandbox: "danger-full-access", coordinator, sessionFor: createDurableSessionLoader(coordinator) })
  const processes = createAgentProcesses(coordinator, service)
  try {
    const assembly = await service.assemblyFor("s")
    const call = await assembly.tools.prepare({ name: "terminal_open", args: { command: process.execPath, args: ["-e", "process.stdin.on('data',d=>process.stdout.write('echo:'+d));setInterval(()=>{},1000)"] } }, undefined, { sessionId: "s" })
    const opened = await assembly.tools.dispatch(call) as { id: string }
    expect((await processes.read("s")).terminals[0]).toMatchObject({ id: opened.id, ownerSessionId: "s", live: true })
    await expect(processes.control("other", { action: "read", id: opened.id })).rejects.toThrow(/live|owner|cold/i)
    await processes.control("s", { action: "send", id: opened.id, data: "hello\n" })
    await vi.waitFor(async () => expect(await processes.control("s", { action: "read", id: opened.id })).toMatchObject({ data: expect.stringContaining("hello") }))
    service.updateSandboxMode("read-only")
    await expect(processes.control("s", { action: "send", id: opened.id, data: "forbidden\n" })).rejects.toThrow(/refus|sandbox|read-only/i)
    await expect(processes.control("s", { action: "send", id: opened.id, data: "x", sandbox_permissions: "require_escalated" })).rejects.toThrow(/unsupported/i)
    assembly.tools.unregister("terminal_read")
    await expect(processes.control("s", { action: "read", id: opened.id })).rejects.toThrow(/unknown tool/i)
    let denyRole = true
    assembly.ctx.on("tools/pre-execute", () => denyRole ? { kind: "deny", reason: "role denied" } : undefined)
    await expect(processes.control("s", { action: "resize", id: opened.id, cols: 90, rows: 25 })).rejects.toThrow(/role denied/i)
    denyRole = false
    const terminal = assembly.ctx.services.get<import("@i-harness/terminal").TerminalService>("terminal/service")!
    const exited = terminal.waitExited(opened.id)
    await processes.control("s", { action: "close", id: opened.id })
    await exited
    await expect(processes.control("s", { action: "signal", id: opened.id, signal: "TERM" })).rejects.toThrow(/owner|live/i)
    await service.closeSession("s")
    await expect(processes.control("s", { action: "send", id: opened.id, data: "x" })).rejects.toThrow(/live|cold/i)
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 15000)

it("reports actual executable versions and missing/unavailable probes without a shell or Agent", async () => {
  expect(await probeExecutable("node", process.execPath, ["--version"])).toMatchObject({ status: "available", version: expect.stringMatching(/^v\d/) })
  expect(await probeExecutable("missing", join(tmpdir(), "ih-no-such-executable"), ["--version"])).toMatchObject({ status: "not-installed" })
  expect(await probeExecutable("exit", process.execPath, ["-e", "process.exit(9)"])).toMatchObject({ status: "unavailable" })
  const service = createSessionService({ workspace: tmpdir(), modelPolicy: "required" })
  const diagnostics = createDesktopDiagnostics(service, { shell: { state: async () => ({ selected: "cmd", options: [], error: "unavailable shell" }) } })
  try { expect(await diagnostics.read("cold")).toMatchObject({ live: false, tools: [], shell: { error: "unavailable shell" } }); expect(service.hasAssembly("cold")).toBe(false) }
  finally { await service.close() }
})

it("shows and cancels actual background shell jobs through the current execution registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-process-jobs-"))
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")))
  await coordinator.create({ sessionId: "s" }); await coordinator.create({ sessionId: "other" })
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", approveAll: true, sandbox: "danger-full-access", coordinator, sessionFor: createDurableSessionLoader(coordinator) })
  const processes = createAgentProcesses(coordinator, service)
  try {
    const assembly = await service.assemblyFor("s")
    const command = process.platform === "win32" ? `& '${process.execPath.replaceAll("'", "''")}' -e 'console.log("fixture-output");setTimeout(()=>{},5000)'` : `'${process.execPath}' -e 'console.log("fixture-output");setTimeout(()=>{},5000)'`
    const result = await assembly.tools.execute({ name: process.platform === "win32" ? "pwsh" : "bash", args: { command, background: true } })
    const id = (result.output as { job_id: string }).job_id
    expect(id).toBeTruthy()
    append(assembly.session, { type: "tool/call", callId: "shell-fixture", name: process.platform === "win32" ? "pwsh" : "bash", args: { command, background: true } })
    append(assembly.session, { type: "tool/result", callId: "shell-fixture", name: process.platform === "win32" ? "pwsh" : "bash", output: result.output })
    expect((await processes.read("s")).jobs).toContainEqual(expect.objectContaining({ jobId: id, ownerSessionId: "s", live: true, canCancel: true }))
    await vi.waitFor(async () => expect(await processes.jobOutput("s", id)).toMatchObject({ text: expect.stringContaining("fixture-output") }), { timeout: 5000, interval: 50 })
    const captured = await processes.jobOutput("s", id)
    append(assembly.session, { type: "tool/call", callId: "job-output-fixture", name: "job_output", args: { job_id: id } })
    append(assembly.session, { type: "tool/result", callId: "job-output-fixture", name: "job_output", output: { stdout: captured.text, stderr: "", status: "running" } })
    await expect(processes.control("other", { action: "job/cancel", id })).rejects.toThrow(/live|owner/i)
    await processes.control("s", { action: "job/cancel", id })
    await vi.waitFor(async () => expect((await processes.read("s")).jobs.find(job => job.jobId === id)).toMatchObject({ status: "killed", canCancel: false }))
    await service.closeSession("s")
    expect((await processes.read("s")).jobs.find(job => job.jobId === id)).toMatchObject({ live: false, canCancel: false, status: "running" })
    expect(await processes.jobOutput("s", id)).toMatchObject({ live: false, text: expect.stringContaining("fixture-output") })
    expect(service.hasAssembly("s")).toBe(false)
    await expect(processes.control("s", { action: "job/cancel", id })).rejects.toThrow(/live|cold/i)
  } finally { await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) }
}, 15000)
