import { expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { append, createSession, deriveMessages, Inbox } from "@i-harness/core-session"
import { registerCodeMode } from "../src/register.ts"
import { PNG } from '../../image-validation/test/fixtures.ts'
import { createShellTools } from '../../shell/src/index.ts'
import type { ExecCommand, ExecRunOptions, ExecService } from '../../exec/src/index.ts'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'

it('awaits actual managed startup interruption and every cell output/store/terminal receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-code-runtime-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  await coordinator.append(id, [{ type: 'code/cell', cellId: 'old', sessionId: id, state: 'started', seq: 0 }])
  const document = await coordinator.openManagedDocument(id), ctx = createContext(), tools = createToolRegistry(ctx)
  const mount = registerCodeMode(ctx, tools, { session: document.view as any, sessionId: id, factOwner: document, config: { mode: 'mixed' } } as any)
  try {
    await mount.ready!()
    expect(document.view.events.slice(0, 2).map(event => event.type === 'code/cell' ? event.state : event.type)).toEqual(['started', 'interrupted'])
    const result = await tools.get('code_exec')!.execute({ code: 'store("key", 7); text("actual output")', yield_time_ms: 60000 }, { session: document.view, sessionId: id })
    expect(result).not.toHaveProperty('error')
    expect(result).toMatchObject({ status: 'completed', text: 'actual output' })
    expect((await backend.read(id)).events.slice(2).map(event => event.type)).toEqual(['code/cell', 'code/output', 'code/store', 'code/cell'])
    expect((await backend.read(id)).events.at(-1)).toMatchObject({ type: 'code/cell', state: 'completed' })
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('retains actual guest completion across an unknown store receipt and Stop without fabricating a failed terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-code-store-unknown-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let bodies = 0, finalizations = 0, key: BatchKey | undefined, blocked=true
  tools.register({ name: 'probe', description: '', inputSchema: {}, execute: async () => { bodies++; return 7 } })
  ctx.on('tools/post-execute', () => { finalizations++ })
  const actual = backend.appendOwnedBatch!
  const reconcile=backend.reconcileOwnedBatch!
  backend.reconcileOwnedBatch=async(...args)=>blocked?{kind:'unknown',key:args[3].key}:reconcile(...args)
  backend.appendOwnedBatch = async (...args) => {
    const result = await actual(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'code/store')) { key = args[3].key; return { kind: 'unknown', key } }
    return result
  }
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  try {
    await mount.ready!()
    await expect(tools.get('code_exec')!.execute({ code: 'store("key", await tools.probe({})); text("actual output")', yield_time_ms: 5000 }, { session: document.view, sessionId: id })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect([bodies, finalizations]).toEqual([1, 1])
    expect(key).toBeDefined()
    await mount.cancel('human Stop after actual guest completion')
    await expect(mount.dispose()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(document.view.events.some(event => event.type === 'code/cell' && ['failed', 'terminated', 'completed'].includes(event.state))).toBe(false)
    blocked=false;await document.reconcile(key!)
    await mount.dispose()
    expect((await backend.read(id)).events.filter(event => event.type === 'code/cell').map(event => event.state)).toEqual(['started', 'completed'])
    expect((await backend.read(id)).events.filter(event => event.type === 'code/store')).toHaveLength(1)
    expect([bodies, finalizations]).toEqual([1, 1])
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('keeps a real terminated cell unavailable until its original terminal receipt is reconciled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-code-stop-receipt-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  const mount = registerCodeMode(ctx, tools, { session: document.view, sessionId: id, factOwner: document, config: { mode: 'mixed' } })
  let key: BatchKey | undefined, terminals = 0
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    const result = await actual(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'code/cell' && event.state === 'terminated')) { terminals++; key = args[3].key; return { kind: 'unknown', key } }
    return result
  }
  try {
    const running = await tools.get('code_exec')!.execute({ code: 'await new Promise(() => {})', yield_time_ms: 0 }, { session: document.view, sessionId: id }) as { cell_id: string }
    await expect(tools.get('code_wait')!.execute({ cell_id: running.cell_id, terminate: true, yield_time_ms: 5000 }, { session: document.view })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(document.view.events.filter(event => event.type === 'code/cell').map(event => event.state)).toEqual(['started'])
    expect(key).toBeDefined()
    await document.reconcile(key!)
    await mount.dispose()
    expect((await backend.read(id)).events.filter(event => event.type === 'code/cell').map(event => event.state)).toEqual(['started', 'terminated'])
    expect(terminals).toBe(1)
  } finally { await mount.dispose().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it("nested shell receives no steer promotion source and completes one original invocation", async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession(), inbox = new Inbox(session)
  const held = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>(), started = Promise.withResolvers<void>()
  let command: ExecCommand | undefined, options: ExecRunOptions | undefined
  const run = vi.fn((cmd: ExecCommand, opts?: ExecRunOptions) => { command = cmd; options = opts; started.resolve(); return held.promise })
  const exec = { run } as unknown as ExecService
  for (const tool of createShellTools({ exec })) tools.register(tool)
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: "mixed" } })
  try {
    const observing = tools.get("code_exec")!.execute({ code: 'text(await tools.pwsh({command:"echo fixture"}))', yield_time_ms: 60_000 }, { session })
    await started.promise
    expect(options?.promotionWake).toBeUndefined()
    inbox.admit({ inputId: "steer", text: "refocus", intent: "user", delivery: "steer" })
    const first = await observing as { cell_id: string }
    expect(first).toMatchObject({ status: "running", yielded: true, yield_reason: "user-steer", text: "" })
    expect(command!.abortSignal?.aborted).toBe(false)
    expect(session.events.filter(e => e.type === "code/result")).toHaveLength(0)
    inbox.claimAtStepBoundary()
    held.resolve({ stdout: "actual shell", stderr: "", exitCode: 0, timedOut: false })
    expect(await tools.get("code_wait")!.execute({ cell_id: first.cell_id }, { session })).toMatchObject({ status: "completed", text: expect.stringContaining("actual shell") })
    expect(run).toHaveBeenCalledOnce()
    const calls = session.events.filter(e => e.type === "code/call"), results = session.events.filter(e => e.type === "code/result")
    expect(calls).toHaveLength(1); expect(results).toHaveLength(1); expect(results[0]!.callId).toBe(calls[0]!.callId)
  } finally { held.resolve({ stdout: "cleanup", stderr: "", exitCode: 0, timedOut: false }); await mount.dispose() }
})

it("registered observers release repeatedly while an arbitrary nested tool retains its original result", async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession(), inbox = new Inbox(session)
  const held = Promise.withResolvers<string>(), started = Promise.withResolvers<void>()
  const body = vi.fn(async (_args, exec) => { expect(exec.resultConsumer).toBe("code"); expect(exec.session).toBe(session); started.resolve(); return held.promise })
  tools.register({ name: "held", description: "fixture", inputSchema: {}, execute: body })
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: "mixed" } })
  try {
    const observation = tools.get("code_exec")!.execute({ code: 'text(await tools.held({}))', yield_time_ms: 60_000 }, { session })
    await started.promise
    inbox.admit({ inputId: "first", text: "refocus", intent: "user", delivery: "steer" })
    const first = await observation as { cell_id: string }
    expect(first).toMatchObject({ status: "running", yielded: true, yield_reason: "user-steer" })
    inbox.claimAtStepBoundary()
    const observing = tools.get("code_wait")!.execute({ cell_id: first.cell_id, yield_time_ms: 60_000 }, { session })
    inbox.admit({ inputId: "second", text: "refocus again", intent: "user", delivery: "steer" })
    expect(await observing).toMatchObject({ cell_id: first.cell_id, status: "running", yielded: true, yield_reason: "user-steer" })
    expect(session.events.filter(e => e.type === "code/result")).toHaveLength(0)
    inbox.claimAtStepBoundary(); held.resolve("real value")
    expect(await tools.get("code_wait")!.execute({ cell_id: first.cell_id, yield_time_ms: 60_000 }, { session })).toMatchObject({ status: "completed", text: "real value" })
    expect(body).toHaveBeenCalledOnce()
    const calls = session.events.filter(e => e.type === "code/call"), results = session.events.filter(e => e.type === "code/result")
    expect(calls).toHaveLength(1); expect(results).toHaveLength(1); expect(results[0]!.callId).toBe(calls[0]!.callId)
  } finally { held.resolve("cleanup"); await mount.dispose() }
})

it("uses the real registry policy even when guest code catches a refused write", async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession(); let writes = 0
  tools.register({ name: "write", description: "write", inputSchema: { type: "object" }, execute: async () => { writes++; return 1 } })
  ctx.on("tools/pre-execute", (call) => (call as { name: string }).name === "write" ? { kind: "deny", reason: "denied by test policy" } : call)
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: "mixed" } })
  try {
    await expect(tools.execute({ name: "code_exec", args: { code: 'searchTools("write"); describeTool("write"); try { await tools.write({}); } catch {} text("pretend success");' } })).rejects.toMatchObject({ policyRefusal: true })
    expect(writes).toBe(0)
    expect(session.events.some(e => e.type === "code/result" && e.isError)).toBe(true)
    expect(deriveMessages(session)).toEqual([])
  } finally { await mount.dispose() }
})

it("keeps Code Mode-only model exposure separate from actual tool execution and emitted images", async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  tools.register({ name: "read", description: "read", inputSchema: { type: "object" }, isReadOnly: true, execute: async () => "actual file" })
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: "only" } })
  try {
    expect(mount.schemas().map(s => s.name)).toEqual(["code_exec", "code_status", "code_wait"])
    const png = PNG
    const result = await tools.execute({ name: "code_exec", args: { code: `text(await tools.read({})); image({type:"image",mimeType:"image/png",data:"${png}"});`, yield_time_ms: 5000 } })
    expect(result.output).toMatchObject({ status: "completed", text: "actual file", images: [{ mediaType: "image/png", dataBase64: png }] })
    expect((result.output as { items: unknown[] }).items).not.toEqual(expect.arrayContaining([expect.objectContaining({ image: expect.objectContaining({ dataBase64: png }) })]))
  } finally { await mount.dispose() }
})

it("keeps active cell IDs discoverable when compaction removes their outer result", async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  const mount = registerCodeMode(ctx, tools, { session, sessionId: "parent", config: { mode: "only" } })
  try {
    const before = mount.schemas()
    const result = await tools.execute({ name: "code_exec", args: { code: "await new Promise(() => {});", yield_time_ms: 0 } })
    const out = result.output as { cell_id: string; status: string }
    expect(out.status).toBe("running")
    append(session, { type: "compaction/reset", removedSeqs: session.events.flatMap(e => e.seq === undefined ? [] : [e.seq]) })
    expect(mount.schemas()).toEqual(before)
    expect((await tools.execute({ name: "code_status", args: {} })).output).toEqual({ cells: [{ id: out.cell_id, status: "running" }] })
    expect(mount.liveCells?.()).toEqual([{ id: out.cell_id, status: "running" }])
    await tools.execute({ name: "code_wait", args: { cell_id: out.cell_id, terminate: true } })
    expect(mount.schemas()).toEqual(before)
    expect((await tools.execute({ name: "code_status", args: {} })).output).toEqual({ cells: [] })
  } finally { await mount.dispose() }
})

it.each(["mixed", "only"] as const)("keeps %s descriptions concise and deferred tools discoverable without promotion", async mode => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  tools.register({ name: "direct.read", description: "DIRECT_DESCRIPTION_MARKER", inputSchema: { type: "object", properties: { DIRECT_SCHEMA_MARKER: { type: "string" } } }, execute: async () => 1 })
  tools.register({ name: "deferred.read", description: "DEFERRED_DESCRIPTION_MARKER", exposure: "deferred", inputSchema: { type: "object", properties: { DEFERRED_SCHEMA_MARKER: { type: "string" } } }, execute: async () => 2 })
  tools.register({ name: "hidden.read", description: "HIDDEN_DESCRIPTION_MARKER", exposure: "hidden", inputSchema: { type: "object" }, execute: async () => 3 })
  const mount = registerCodeMode(ctx, tools, { session, config: { mode } })
  try {
    const description = mount.schemas().find(s => s.name === "code_exec")!.description
    expect(description).not.toContain("DEFERRED_SCHEMA_MARKER")
    expect(description).not.toContain("HIDDEN_DESCRIPTION_MARKER")
    if (mode === "mixed") {
      expect(description).not.toContain("DIRECT_DESCRIPTION_MARKER")
      expect(description).not.toContain("DIRECT_SCHEMA_MARKER")
    } else expect(description).toContain("DIRECT_SCHEMA_MARKER")
    const result = await tools.execute({ name: "code_exec", args: { code: 'text(searchTools("deferred_read")); text(describeTool("deferred_read").inputSchema); text(await tools.deferred_read({})); text(ALL_TOOLS.map(t=>t.name)); for(const name of ["hidden.read","missing","code_exec","code_wait","code_status"]) { try {describeTool(name)} catch(e) {text(e.message)} }' } })
    const output = result.output as { status: string; text: string }
    expect(output.status).toBe("completed")
    expect(output.text).toContain('"name":"deferred.read"')
    expect(output.text).toContain('"alias":"deferred_read"')
    expect(output.text).toContain("DEFERRED_SCHEMA_MARKER")
    expect(output.text).toContain('\n2\n["direct.read","deferred.read"]\n')
    expect(output.text.match(/Tool not found/g)).toHaveLength(5)
    expect(tools.schemas().map(s => s.name)).not.toContain("deferred.read")
  } finally { await mount.dispose() }
})

it("keeps selected only-mode declarations inside the existing total description cap", async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: "only" } })
  try {
    const guideBytes = Buffer.byteLength(mount.schemas().find(schema => schema.name === "code_exec")!.description)
    tools.register({ name: "budget", description: "x".repeat(24000 - guideBytes - 48), inputSchema: { type: "object" }, execute: async () => 1 })
    expect(Buffer.byteLength(mount.schemas().find(schema => schema.name === "code_exec")!.description)).toBeLessThanOrEqual(24000)
  } finally { await mount.dispose() }
})

it("does not allow guest catch to hide failure in the host finalization stage", async () => {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  let effects = 0, finalizations = 0
  tools.register({ name: "read", description: "read", inputSchema: { type: "object" }, isReadOnly: true, execute: async () => { effects++; return 7 } })
  ctx.on("tools/post-execute", call => { if ((call as { name: string }).name === "read") { finalizations++; throw new Error("finalize failed") } })
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: "only" } })
  try {
    await expect(tools.execute({ name: "code_exec", args: { code: 'try { await tools.read({}); } catch {} text("pretend success");' } })).rejects.toMatchObject({ policyRefusal: true })
    expect(session.events.filter(e => e.type === "code/result")).toHaveLength(0)
    await expect(mount.dispose()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    await expect(mount.dispose()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect([effects, finalizations]).toEqual([1, 1])
  } finally { await mount.dispose().catch(() => {}) }
})
