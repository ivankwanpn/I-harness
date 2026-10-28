import { withExecCallerScope, type NativeExecService } from '@i-harness/exec'
import { acquireAssemblyResultStore } from '../../session-executor/src/lifecycle/result-store.ts'
import { committedFactSeqs } from '@i-harness/core-session'
import { createHash } from 'node:crypto'
import { expect, it, vi } from "vitest"
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordFixture } from "./managed-fixture.ts"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createDurableSessionLoader, createSessionService } from "@i-harness/session-executor"
import { createDesktopExecution, createCodeModeSettings } from "../src/execution.ts"
import { createAgentProcesses } from "../src/agent-processes.ts"
import { createDesktopDiagnostics, probeExecutable } from "../src/environment-diagnostics.ts"

it.each(["tool", "code"] as const)("restores actual registered job_output snapshots from saved %s records without duplication or cold execution", async kind => {
  const root = await mkdtemp(join(tmpdir(), "ih-saved-job-dto-")), sessionDir = join(root, "sessions"), script = join(root, "output.cjs")
  let coordinator = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "s" }); await coordinator.create({ sessionId: "other" })
  await writeFile(script, 'process.stdout.write(process.argv[2] === "large" ? "QA_LIMIT_" + "x".repeat(150000) : "QA_JOB_OUTPUT\\n");process.stderr.write("QA_ERR\\n")')
  const live = createSessionService({ workspace: root, modelPolicy: "test-mock", approveAll: true, sandbox: "danger-full-access", codeMode: { mode: "mixed" }, coordinator, sessionFor: createDurableSessionLoader(coordinator) })
  const assembly = await live.assemblyFor("s"), shell = process.platform === "win32" ? "pwsh" : "bash"
  let callNumber = 0
  const envelopes = new Map<string, import('@i-harness/core-session').ResultEnvelope>()
  const direct = async (name: string, args: Record<string, unknown>, target = assembly, sessionId = "s") => {
    const callId = `actual-${++callNumber}`, action = target.factOwner.beginAction()
    let complete = false
    const source = action.registerSettlementSource(async () => { if (!complete) throw new Error('Fixture result requires recovery') })
    try {
      const seq = committedFactSeqs(await action.facts.tools.call({ type: 'tool/call', callId, name, args }))[0]
      const prepared = await target.tools.prepare({ name, args }, undefined, { sessionId, session: target.session, callId, callEventSeq: seq, settlementSource: source })
      const output = await target.tools.dispatch(prepared)
      const result = await target.tools.finalize(prepared, output)
      committedFactSeqs(await source.tools.captureResult({ type: 'tool/result', callId, name, ...(result.envelope ? { envelope: result.envelope } : { output: result.output }) }).admit())
      complete = true
      await source.close()
      if (result.envelope) envelopes.set(name, result.envelope)
      if (result.program?.kind !== 'value') throw new Error('Expected genuine program value')
      return result.program.value as Record<string, any>
    } finally { action.finish() }
  }
  const execute = async (name: string, args: Record<string, unknown>): Promise<Record<string, any>> => {
    if (kind === 'tool') return direct(name, args)
    const initial = await direct('code_exec', { code: `text(JSON.stringify(await tools.${name}(${JSON.stringify(args)})))`, yield_time_ms: 0 })
    const observation = initial.status === 'running' ? await direct('code_wait', { cell_id: initial.cell_id, yield_time_ms: 10000 }) : initial
    expect(observation.status).toBe('completed')
    const saved = assembly.session.events.findLast(event => event.type === 'code/result' && event.cellId === initial.cell_id && event.name === name)
    if (!saved || saved.type !== 'code/result' || saved.envelope?.retention.kind !== 'inline') throw new Error('Missing genuine inline Code Mode result envelope')
    envelopes.set(name, saved.envelope)
    expect(saved.output).toBeUndefined()
    const emitted = String(initial.text ?? '') + String(initial === observation ? '' : observation.text ?? '')
    expect(JSON.parse(emitted)).toEqual(saved.envelope.retention.value)
    return saved.envelope.retention.value as Record<string, any>
  }
  const command = (mode: string) => process.platform === "win32" ? `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}' '${mode}'` : `'${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' '${mode}'`
  let cold: ReturnType<typeof createSessionService> | undefined
  try {
    const small = await execute(shell, { command: command("small"), background: true }), smallId = String(small.job_id)
    const snapshot = await execute("job_output", { job_id: smallId, wait: true, timeout_ms: 5000 })
    expect(snapshot).toMatchObject({ text: "QA_JOB_OUTPUT\n", status: "completed", truncated: false, offset_bytes: 0, next_offset_bytes: 14, total_bytes: 14,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/), full_result: { tool: "context_output_read", access: "catalog-required" }, text_result: { tool: "job_output", args: { job_id: smallId, job_instance_id: small.native_job.instanceId, offset_bytes: 14 } } })
    expect(await execute("job_output", { job_id: smallId })).toEqual(snapshot)
    const large = await execute(shell, { command: command("large"), background: true }), largeId = String(large.job_id)
    const largeSnapshot = await execute("job_output", { job_id: largeId, wait: true, timeout_ms: 5000 })
    expect(largeSnapshot.status).toBe("completed"); expect(largeSnapshot.truncated).toBe(true)
    expect(Number(largeSnapshot.total_bytes)).toBe(150009)
    expect(largeSnapshot.digest).toBe(createHash("sha256").update("QA_LIMIT_" + "x".repeat(150000)).digest("hex"))
    expect(snapshot.digest).toBe(createHash("sha256").update("QA_JOB_OUTPUT\n").digest("hex"))
    expect(String(largeSnapshot.text).length).toBeGreaterThan(0)
    expect(String(largeSnapshot.text).length).toBeLessThan(131072)
    expect(largeSnapshot.full_result).toMatchObject({ tool: 'context_output_read', args: { ref: { codec: 'exec-frames-v1' } } })
    expect(largeSnapshot.text_result).toMatchObject({ tool: 'job_output', args: { job_id: largeId, digest: largeSnapshot.digest, job_instance_id: large.native_job.instanceId } })
    expect(largeSnapshot.full_result.args.viaCatalog).toBeUndefined()
    expect(envelopes.get('job_output')?.dependencies?.kind).toBe('artifact-set')
    const store = await acquireAssemblyResultStore({ workspace: root, coordinator, sessionId: 's' })
    try {
      if (!store.service) throw new Error('Expected original authenticated result store')
      const native = assembly.ctx.services.get<NativeExecService>('exec/service')!
      const original = native.getJobView(largeId).retained!
      expect(original.retention).toEqual({ kind: 'artifact', ref: largeSnapshot.full_result.args.ref })
      const recipient = await live.assemblyFor('other')
      const originalTool = assembly.tools.get('job_output')!
      recipient.tools.register({ name: 'j3_recipient', description: 'Trusted owner observation control', inputSchema: originalTool.inputSchema, isReadOnly: true,
        execute: (args, exec) => withExecCallerScope({ sessionId: 's' }, () => originalTool.execute(args, exec)) })
      const recipientValue = await direct('j3_recipient', { job_id: largeId }, recipient, 'other')
      expect(recipientValue.full_result.args.viaCatalog).toBeUndefined()
      const catalog = envelopes.get('j3_recipient')?.dependencies
      if (catalog?.kind !== 'artifact-set') throw new Error('Expected finalized recipient membership catalog')
      const catalogPage = await store.service.readResult({ sessionId: 'other' }, { ref: catalog.ref })
      if (catalogPage.data.kind !== 'text' || !catalogPage.eof) throw new Error('Expected bounded actual catalog')
      expect(JSON.parse(catalogPage.data.text).entries).toEqual([original])
      const ref = largeSnapshot.full_result.args.ref
      await expect(store.service.readExecResult({ sessionId: 'other' }, { ref })).rejects.toThrow()
      await expect(store.service.readExecResult({ sessionId: 'foreign' }, { ref, viaCatalog: catalog.ref })).rejects.toThrow()
      const decoded = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
      let cursor: import('@i-harness/core-session').ExecFrameCursor | undefined
      for (let pageNumber = 0; ; pageNumber++) {
        if (pageNumber > 30) throw new Error('finite raw fixture ceiling')
        const page = await store.service.readExecResult({ sessionId: 'other' }, { ref, viaCatalog: catalog.ref, cursor, maxBytes: 32768 })
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768)
        for (const part of page.frames) decoded[part.channel].push(Buffer.from(part.data, 'base64'))
        if (page.eof) break
        expect(page.nextCursor).not.toEqual(cursor); cursor = page.nextCursor!
      }
      const stdout = Buffer.concat(decoded.stdout), stderr = Buffer.concat(decoded.stderr)
      expect(stdout).toEqual(Buffer.from('QA_LIMIT_' + 'x'.repeat(150000)))
      expect(stderr).toEqual(Buffer.from('QA_ERR\n'))
      expect(largeSnapshot.stderr_total_bytes).toBe(7)
      expect(largeSnapshot.stderr_digest).toBe(createHash('sha256').update(stderr).digest('hex'))
      expect(largeSnapshot.digest).toBe(createHash('sha256').update(stdout).digest('hex'))
      expect(native.getJobView(largeId).retained).toEqual(original)
      const archive: Buffer[] = []; let archiveOffset = 0
      for (let n = 0; ; n++) {
        if (n > 30) throw new Error('finite archive fixture ceiling')
        const page = await store.service.readResult({ sessionId: 's' }, { ref, offset: archiveOffset })
        archive.push(page.data.kind === 'text' ? Buffer.from(page.data.text) : Buffer.from(page.data.base64, 'base64'))
        if (page.eof) break
        expect(page.nextOffset).toBeGreaterThan(archiveOffset); archiveOffset = page.nextOffset!
      }
      expect(createHash('sha256').update(Buffer.concat(archive)).digest('hex')).toBe(ref.contentDigest)
      let reconstructed = String(largeSnapshot.text), next = largeSnapshot.next_offset_bytes
      for (let n = 0; next < 150009; n++) {
        if (n > 30) throw new Error('finite text fixture ceiling')
        const page = await execute('job_output', { ...largeSnapshot.text_result.args, offset_bytes: next })
        expect(page.next_offset_bytes).toBeGreaterThan(next)
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(16384)
        reconstructed += page.text; next = page.next_offset_bytes
      }
      expect(Buffer.from(reconstructed)).toEqual(stdout)
    } finally { await store.release() }
    await recordFixture(assembly.factOwner, { type: "tool/call", callId: "wrong-launch", name: "list_dir", args: {} })
    await recordFixture(assembly.factOwner, { type: "tool/result", callId: "wrong-launch", name: shell, output: { ...small, job_id: "unmatched-job" } })
    await recordFixture(assembly.factOwner, { type: "tool/call", callId: "wrong-output", name: "list_dir", args: { job_id: smallId } })
    await recordFixture(assembly.factOwner, { type: "tool/result", callId: "wrong-output", name: "job_output", output: { ...snapshot, text: "unmatched output" } })
    await recordFixture(assembly.factOwner, { type: "tool/call", callId: "failed-output", name: "job_output", args: { job_id: smallId } })
    await recordFixture(assembly.factOwner, { type: "tool/result", callId: "failed-output", name: "job_output", output: { ...snapshot, text: "failed output" }, isError: true })
    await coordinator.flush("s"); await live.close(); await coordinator.close()
    coordinator = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } }); cold = createSessionService({ workspace: root, modelPolicy: "required" })
    const before = await readFile(join(sessionDir, "s.jsonl"), "utf8"), processes = createAgentProcesses(coordinator, cold)
    expect(await processes.jobOutput("s", smallId)).toEqual({ text: snapshot.text, truncated: false, ownerSessionId: "s", live: false })
    expect(await processes.jobOutput("s", largeId)).toEqual({ text: String(largeSnapshot.text), truncated: true, ownerSessionId: "s", live: false })
    expect((await processes.read("s")).jobs).toContainEqual(expect.objectContaining({ jobId: smallId, outputAvailable: true, status: "completed", live: false, canCancel: false }))
    await expect(processes.jobOutput("other", smallId)).rejects.toThrow(/unavailable.*owner/)
    await expect(processes.jobOutput("s", "unmatched-job")).rejects.toThrow(/unavailable.*owner/)
    await expect(processes.control("s", { action: "job/cancel", id: smallId })).rejects.toThrow(/live|cold/)
    expect(cold.hasAssembly("s")).toBe(false); expect(await readFile(join(sessionDir, "s.jsonl"), "utf8")).toBe(before)
  } finally { await cold?.close(); await live.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
}, 15000)

it("projects saved tool/code PTYs and partial output after restart without an assembly or log writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-saved-pty-")), sessionDir = join(root, "sessions")
  let coordinator = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "cold" }); await coordinator.create({ sessionId: "other" })
  const document = await coordinator.openManagedDocument("cold")
  await recordFixture(document, { type: "tool/call", callId: "open", name: "terminal_open", args: { command: "node", cols: 90, rows: 25 } })
  await recordFixture(document, { type: "tool/result", callId: "open", name: "terminal_open", output: { id: "saved-pty", pid: 123, cols: 90, rows: 25 } })
  await recordFixture(document, { type: "code/call", cellId: "cell", callId: "read", name: "terminal_read", args: { id: "saved-pty", offset: 100 } })
  await recordFixture(document, { type: "code/result", cellId: "cell", callId: "read", name: "terminal_read", output: { id: "saved-pty", data: "saved output", nextOffset: 112, status: "running", truncated: false, dropped: true } })
  await recordFixture(document, { type: "code/call", cellId: "cell", callId: "spawn", name: "process_spawn", args: { command: "pwsh" } })
  await recordFixture(document, { type: "code/result", cellId: "cell", callId: "spawn", name: "process_spawn", output: { id: "no-output", pid: 456, cols: 80, rows: 24 } })
  await coordinator.flush("cold"); await coordinator.close()
  coordinator = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } })
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
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "owned" }); await coordinator.create({ sessionId: "other" })
  let modelCalls = 0
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), codeMode: { mode: "mixed" }, sandbox: "danger-full-access", model: { async *stream() { modelCalls++; yield { type: "end" } } } })
  const view = createDesktopExecution(coordinator, service)
  try {
    const assembly = await service.assemblyFor("owned")
    const result = await assembly.tools.execute({ name: "code_exec", args: { code: 'text(await tools.list_dir({path:"."})); await yield_control(); await new Promise(resolve => setTimeout(resolve, 20000));', yield_time_ms: 1000 } })
    const cellId = (result.output as { cell_id: string }).cell_id
    // Yielded guest execution can precede the output fact's normal receipt.
    // Keep inspection read-only and wait for the existing committed surface.
    const read = await vi.waitFor(async () => {
      const read = await view.read('owned')
      expect(read.cells[0]!.output).not.toHaveLength(0)
      return read
    })
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
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "cold" })
  const document = await coordinator.openManagedDocument("cold")
  await recordFixture(document, { type: "code/cell", cellId: "old", sessionId: "cold", state: "started", source: "saved source" })
  await recordFixture(document, { type: "code/output", cellId: "old", content: { type: "text", text: "x".repeat(150000) } })
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
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } })
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
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } })
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
    const narrowingCall = await assembly.tools.prepare({ name: "terminal_open", args: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] } }, undefined, { sessionId: "s" })
    const narrowed = await assembly.tools.dispatch(narrowingCall) as { id: string }
    await service.updateSandboxMode("read-only")
    expect(terminal.list().find(view => view.id === narrowed.id)?.settlement).toMatchObject({ kind: "settled", treeEmpty: true, ioSettled: true, resourcesReleased: true })
    await expect(processes.control("s", { action: "send", id: narrowed.id, data: "forbidden\n" })).rejects.toThrow(/refus|sandbox|read-only|live|owner/i)
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
  const coordinator = createSessionCoordinator(createJsonlBackend(join(root, "sessions")), { lock: { enabled: true } })
  await coordinator.create({ sessionId: "s" }); await coordinator.create({ sessionId: "other" })
  const service = createSessionService({ workspace: root, modelPolicy: "test-mock", approveAll: true, sandbox: "danger-full-access", coordinator, sessionFor: createDurableSessionLoader(coordinator) })
  const processes = createAgentProcesses(coordinator, service)
  try {
    const assembly = await service.assemblyFor("s")
    // Windows PowerShell strips nested quotes from native -e arguments. A
    // source file keeps this an actual live-job test on both PS5 and PS7.
    // Stay alive for owner cancellation, with a fail-safe if cleanup fails.
    const script = join(root, "cancel-fixture.cjs")
    await writeFile(script, 'console.log("fixture-output");setInterval(()=>{},1000);setTimeout(()=>process.exit(99),30000)')
    const quote = (value: string) => process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`
    const command = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(script)}`
    const result = await assembly.tools.execute({ name: process.platform === "win32" ? "pwsh" : "bash", args: { command, background: true } })
    const id = (result.output as { job_id: string }).job_id
    expect(id).toBeTruthy()
    await recordFixture(assembly.factOwner, { type: "tool/call", callId: "shell-fixture", name: process.platform === "win32" ? "pwsh" : "bash", args: { command, background: true } })
    await recordFixture(assembly.factOwner, { type: "tool/result", callId: "shell-fixture", name: process.platform === "win32" ? "pwsh" : "bash", output: result.output })
    expect((await processes.read("s")).jobs).toContainEqual(expect.objectContaining({ jobId: id, ownerSessionId: "s", live: true, canCancel: true }))
    await vi.waitFor(async () => expect(await processes.jobOutput("s", id)).toMatchObject({ text: expect.stringContaining("fixture-output") }), { timeout: 5000, interval: 50 })
    const captured = await processes.jobOutput("s", id)
    expect(captured.text).not.toMatch(/ReferenceError|SyntaxError/)
    expect((await processes.read("s")).jobs).toContainEqual(expect.objectContaining({ jobId: id, live: true, canCancel: true }))
    await recordFixture(assembly.factOwner, { type: "tool/call", callId: "job-output-fixture", name: "job_output", args: { job_id: id } })
    await recordFixture(assembly.factOwner, { type: "tool/result", callId: "job-output-fixture", name: "job_output", output: { stdout: captured.text, stderr: "", status: "running" } })
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
