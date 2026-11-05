import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, nativePlanValidationFailure } from "@i-harness/core-tools"
import { createSession, decodeFactBatch } from "@i-harness/core-session"
import { createCodeModeBroker } from "../src/broker.ts"
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'

it('retains the real finalized managed result through uncertainty without redispatch or synthetic replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-code-'))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let effects = 0, finalizations = 0, conversions = 0, key: import('@i-harness/core-session').BatchKey | undefined
  ctx.on('tools/post-execute', () => { finalizations++ })
  tools.register({ name: 'read', description: 'read', inputSchema: { type: 'object' }, execute: async (_args, exec) => {
    const facts = (await backend.read(id)).events
    expect(facts.find(event => event.type === 'code/call')?.seq).toBe(exec.callEventSeq)
    expect(facts.some(event => event.type === 'code/dispatch')).toBe(true)
    effects++; return { toJSON() { conversions++; return { actual: 'result' } } }
  } })
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    const events = decodeFactBatch(args[3].bytes).events
    const outcome = await actual(...args)
    if (events.some(event => event.type === 'code/result')) { key = args[3].key; return { kind: 'unknown', key } }
    return outcome
  }
  const broker = createCodeModeBroker(ctx, tools, { session: document.view as any, sessionId: id, factOwner: document } as any)
  broker.startCell('cell')
  try {
    await expect(broker.invoke({ cellId: 'cell', invocationId: 'call', name: 'read', args: {}, origin: { sessionId: id, callId: 'outer' }, signal: new AbortController().signal })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect([effects, finalizations, conversions]).toEqual([1, 1, 1])
    expect(document.view.events.filter(event => event.type === 'code/result')).toEqual([])
    expect(key).toBeDefined()
    await document.reconcile(key!)
    await broker.dispose()
    const results = (await backend.read(id)).events.filter(event => event.type === 'code/result')
    expect(results).toEqual([{ type: 'code/result', cellId: 'cell', callId: 'call', name: 'read', output: { actual: 'result' }, seq: 2 }])
    expect([effects, finalizations, conversions]).toEqual([1, 1, 1])
  } finally { await broker.dispose().catch(() => {}); await coordinator.close().catch(() => {}) }
})

function setup() {
  const ctx = createContext(), tools = createToolRegistry(ctx), session = createSession()
  const call = (cellId: string, invocationId: string, name: string, args: unknown = {}) => ({ cellId, invocationId, name, args, origin: { sessionId: "parent", callId: "outer" }, signal: new AbortController().signal })
  return { ctx, tools, session, call }
}
describe("Code Mode nested effects", () => {
  it("checkpoints a nested dispatch before the actual tool body and hides records from model context", async () => {
    const f = setup(), order: string[] = []
    f.tools.register({ name: "write", description: "write", inputSchema: { type: "object" }, execute: async (_, exec) => { order.push("body"); expect(exec.sessionId).toBe("parent"); expect(exec.callId).toBe("nested-1"); return 7 } })
    const b = createCodeModeBroker(f.ctx, f.tools, { session: f.session, sessionId: "parent", flush: async () => { if (!order.length) expect(f.session.events.at(-1)?.type).toBe("code/dispatch"); order.push("flush") } })
    b.startCell("c")
    try {
      expect(await b.invoke(f.call("c", "nested-1", "write"))).toBe(7)
      expect(order).toEqual(["flush", "body"])
      expect(f.session.events.map(e => e.type)).toEqual(["code/call", "code/dispatch", "code/result"])
    } finally { await b.dispose() }
  })
  it("does not dispatch when persistence or policy refuses", async () => {
    const f = setup(); let writes = 0
    f.tools.register({ name: "write", description: "write", inputSchema: { type: "object" }, execute: async () => { writes++; return 1 } })
    const b = createCodeModeBroker(f.ctx, f.tools, { session: f.session, flush: async () => { throw new Error("disk failed") } }); b.startCell("c")
    try { await expect(b.invoke(f.call("c", "n", "write"))).rejects.toThrow("disk failed"); expect(writes).toBe(0) } finally { await expect(b.dispose()).rejects.toThrow("disk failed") }
  })
  it("refuses hidden, recursive and replaced tool bindings", async () => {
    const f = setup(); let effects = 0
    const tool = { name: "read", description: "read", inputSchema: { type: "object" }, execute: async () => { effects++; return 1 } }
    f.tools.register(tool); f.tools.register({ ...tool, name: "hidden", exposure: "hidden" }); f.tools.register({ ...tool, name: "code_exec" })
    const b = createCodeModeBroker(f.ctx, f.tools, { session: f.session }); b.startCell("c"); f.tools.unregister("read"); f.tools.register({ ...tool, execute: async () => { effects++; return 2 } })
    try {
      for (const name of ["read", "hidden", "code_exec"]) await expect(b.invoke(f.call("c", name, name))).rejects.toThrow(/unavailable|changed|allowed/i)
      expect(effects).toBe(0)
    } finally { await b.dispose() }
  })
  it("does not fabricate a second tool outcome when a post-tool hook fails", async () => {
    const f = setup()
    f.tools.register({ name: "read", description: "read", inputSchema: { type: "object" }, execute: async () => 7 })
    f.ctx.on("agent/post-tool", () => { throw new Error("post-hook failed") })
    const b = createCodeModeBroker(f.ctx, f.tools, { session: f.session }); b.startCell("c")
    try {
      await expect(b.invoke(f.call("c", "once", "read"))).rejects.toThrow("post-hook failed")
      expect(f.session.events.filter(e => e.type === "code/result")).toEqual([expect.objectContaining({ type: "code/result", callId: "once", output: 7 })])
    } finally { await b.dispose() }
  })
  it("parallelizes safe reads while an exclusive call forms a barrier", async () => {
    const f = setup(), order: string[] = [], releases = new Map<number, () => void>(), arrivals = new Map<number, () => void>()
    const arrived = (id: number) => new Promise<void>(resolve => arrivals.set(id, resolve))
    const body = async (args: unknown) => {
      const id = (args as { id: number }).id; order.push(`start-${id}`); arrivals.get(id)?.()
      await new Promise<void>(resolve => releases.set(id, resolve)); order.push(`end-${id}`); return id
    }
    const schema = { type: "object", properties: { id: { type: "integer" } }, required: ["id"] }
    f.tools.register({ name: "read", description: "read", inputSchema: schema, isConcurrencySafe: true, execute: body })
    f.tools.register({ name: "write", description: "write", inputSchema: schema, execute: body })
    const b = createCodeModeBroker(f.ctx, f.tools, { session: f.session, maxParallel: 3 }); b.startCell("c")
    const read2 = arrived(2), write3 = arrived(3), read4 = arrived(4)
    const a = b.invoke(f.call("c", "a", "read", { id: 1 })), c = b.invoke(f.call("c", "b", "read", { id: 2 })), d = b.invoke(f.call("c", "c", "write", { id: 3 })), e = b.invoke(f.call("c", "d", "read", { id: 4 }))
    try {
      await read2; expect(order).toEqual(["start-1", "start-2"])
      releases.get(1)!(); await a; expect(order).not.toContain("start-3")
      releases.get(2)!(); await c; await write3; expect(order).not.toContain("start-4")
      releases.get(3)!(); await d; await read4; releases.get(4)!(); expect(await e).toBe(4)
      expect(order).toEqual(["start-1", "start-2", "end-1", "end-2", "start-3", "end-3", "start-4", "end-4"])
    } finally { for (const release of releases.values()) release(); await Promise.allSettled([a, c, d, e]); await b.dispose() }
  })
  it("rechecks authority immediately after a checkpoint can revoke the tool", async () => {
    const f = setup(); let effects = 0, checkpoints = 0
    const tool = { name: "read", description: "read", inputSchema: { type: "object" }, execute: async () => { effects++; return 1 } }
    f.tools.register(tool)
    const b = createCodeModeBroker(f.ctx, f.tools, { session: f.session, flush: async () => { if (!checkpoints++) { f.tools.unregister("read"); f.tools.register({ ...tool, execute: async () => 2 }) } } }); b.startCell("c")
    try { await expect(b.invoke(f.call("c", "revoked", "read"))).rejects.toThrow(/binding changed/); expect(effects).toBe(0) }
    finally { await b.dispose() }
  })
  it("serializes post-execute hooks even when safe tool bodies overlap", async () => {
    const f = setup(); let activeHooks = 0, maxHooks = 0
    const hooks: string[] = []
    f.tools.register({ name: "read", description: "read", inputSchema: { type: "object" }, isConcurrencySafe: true, execute: async () => 1 })
    f.ctx.on("tools/post-execute", async () => { activeHooks++; maxHooks = Math.max(maxHooks, activeHooks); hooks.push("start"); await new Promise(resolve => setTimeout(resolve, 10)); hooks.push("end"); activeHooks-- })
    const b = createCodeModeBroker(f.ctx, f.tools, { session: f.session }); b.startCell("c")
    try {
      expect(await Promise.all([b.invoke(f.call("c", "one", "read")), b.invoke(f.call("c", "two", "read"))])).toEqual([1, 1])
      expect(maxHooks).toBe(1); expect(hooks).toEqual(["start", "end", "start", "end"])
    } finally { await b.dispose() }
  })
})

it('returns a native capture failure to the guest without dispatch', async () => {
  const f = setup(), failure = { error: 'bad patch', code: 'FS_EDIT_NOT_FOUND' }
  let effects = 0
  f.tools.register({ name: 'patch', description: '', inputSchema: {}, captureNativePlan() { throw nativePlanValidationFailure(failure) }, execute: async () => { effects++; return 'unexpected' } })
  const broker = createCodeModeBroker(f.ctx, f.tools, { session: f.session }); broker.startCell('c')
  try {
    expect(await broker.invoke(f.call('c', 'bad', 'patch'))).toEqual(failure)
    expect(effects).toBe(0)
    expect(f.session.events.filter(e => e.type === 'code/dispatch')).toEqual([])
    expect(f.session.events.filter(e => e.type === 'code/result')).toMatchObject([{ callId: 'bad', output: failure }])
  } finally { await broker.dispose() }
})

it('rejects a nominal plan error from a dispatched body and records its real execution', async () => {
  const f = setup(), failure = nativePlanValidationFailure({ error: 'nested capture failed after effect', code: 'FS_EDIT_NOT_FOUND' })
  let effects = 0
  const executions: unknown[] = [], captureSynthetic = f.tools.captureSyntheticResult!.bind(f.tools)
  f.tools.captureSyntheticResult = (context, output, execution) => { executions.push(execution); return captureSynthetic(context, output, execution) }
  f.tools.register({ name: 'write', description: '', inputSchema: {}, execute: async () => { effects++; throw failure } })
  const broker = createCodeModeBroker(f.ctx, f.tools, { session: f.session }); broker.startCell('c')
  try {
    const outcome = await broker.invoke(f.call('c', 'body-error', 'write')).then(value => ({ value }), error => ({ error }))
    expect(effects).toBe(1)
    expect(outcome).toEqual({ error: failure })
    expect(f.session.events.filter(e => e.type === 'code/dispatch')).toHaveLength(1)
    expect(executions).toEqual([{ outcome: 'failed', dispatch: 'dispatched' }])
    expect(f.session.events.filter(e => e.type === 'code/result')).toMatchObject([{ callId: 'body-error', output: { code: 'TOOL_FAILED', error: failure.message } }])
  } finally { await broker.dispose() }
})

it('keeps a real body output under recovery when finalization throws a nominal plan error', async () => {
  const f = setup(), failure = nativePlanValidationFailure({ error: 'finalizer failure', code: 'FS_EDIT_NOT_FOUND' })
  let effects = 0
  const syntheticOutputs: unknown[] = [], captureSynthetic = f.tools.captureSyntheticResult!.bind(f.tools)
  f.tools.captureSyntheticResult = (context, output, execution) => { syntheticOutputs.push(output); return captureSynthetic(context, output, execution) }
  f.tools.register({ name: 'write', description: '', inputSchema: {}, execute: async () => { effects++; return { actual: 'completed body' } } })
  f.ctx.on('tools/post-execute', () => { throw failure })
  const broker = createCodeModeBroker(f.ctx, f.tools, { session: f.session }); broker.startCell('c')
  try {
    const outcome = await broker.invoke(f.call('c', 'finalizer-error', 'write')).then(value => ({ value }), error => ({ error }))
    expect(effects).toBe(1)
    expect(outcome).toMatchObject({ error: { code: 'FACT_RECOVERY_REQUIRED' } })
    expect(f.session.events.filter(e => e.type === 'code/dispatch')).toHaveLength(1)
    expect(f.session.events.filter(e => e.type === 'code/result')).toEqual([])
    expect(syntheticOutputs).toEqual([])
    await expect(broker.dispose()).rejects.toBe(failure)
    expect(effects).toBe(1)
  } finally { await broker.dispose().catch(() => {}) }
})
