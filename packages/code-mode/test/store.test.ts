import { expect, it, vi } from "vitest"
import { append, createSession, deriveMessages, type Session } from "@i-harness/core-session"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createCodeModeRuntime } from "../src/runtime.ts"
import { registerCodeMode } from "../src/register.ts"
import type { CodeModeRuntimeOptions } from "../src/types.ts"

const runtime = (options: Partial<CodeModeRuntimeOptions> = {}) => createCodeModeRuntime({ tools: () => [], invoke: async () => null, ...options })
const mount = (session: Session, sessionId = "owner", flush?: () => Promise<void>) => {
  const ctx = createContext(), tools = createToolRegistry(ctx)
  return { tools, code: registerCodeMode(ctx, tools, { session, sessionId, config: { mode: "only" }, flush }) }
}
const run = async (tools: ReturnType<typeof createToolRegistry>, code: string) => (await tools.execute({ name: "code_exec", args: { code } })).output as { status: string; text: string; error?: string }

it("restores committed JSON after disposal and excludes failed, terminated and foreign writes", async () => {
  const session = createSession()
  let current = mount(session)
  try {
    expect(await run(current.tools, 'store("value",{nested:[7]});globalThis.secret=99;')).toMatchObject({ status: "completed" })
    expect(await run(current.tools, 'store("value",{nested:[8]});throw Error("failure");')).toMatchObject({ status: "failed" })
    const pending = (await current.tools.execute({ name: "code_exec", args: { code: 'store("value",{nested:[9]});await new Promise(()=>{});', yield_time_ms: 0 } })).output as { cell_id: string }
    await current.tools.execute({ name: "code_wait", args: { cell_id: pending.cell_id, terminate: true } })
    await current.code.dispose()
    const foreign = mount(session, "foreign")
    try { await run(foreign.tools, 'store("value","foreign");') } finally { await foreign.code.dispose() }
    current = mount(session)
    expect(await run(current.tools, 'text(load("value"));text(typeof secret);')).toMatchObject({ status: "completed", text: '{"nested":[7]}\nundefined' })
    const writes = session.events.filter(e => e.type === "code/store" as string) as unknown as Array<{ version: number; sessionId: string; writes: unknown }>
    expect(writes).toEqual([
      expect.objectContaining({ version: 1, sessionId: "owner", writes: [["value", { nested: [7] }]] }),
      expect.objectContaining({ version: 1, sessionId: "foreign", writes: [["value", "foreign"]] }),
    ])
    expect(deriveMessages(session)).toEqual([])
  } finally { await current.code.dispose() }
})

it("uses the admitted owner for restore when the mount has no configured session ID", async () => {
  const session = createSession(), ctx = createContext(), tools = createToolRegistry(ctx)
  let code = registerCodeMode(ctx, tools, { session, config: { mode: "only" } })
  const execute = (source: string, sessionId: string) => tools.get("code_exec")!.execute({ code: source }, { sessionId })
  try {
    await execute('store("value",7);', "first")
    expect(await execute('text(load("value"));', "first")).toMatchObject({ text: "7" })
    expect(await execute('text(load("value"));store("value",8);', "second")).toMatchObject({ text: "undefined" })
    expect(await execute('text(load("value"));', "first")).toMatchObject({ text: "7" })
    expect(await execute('text(load("value"));', "second")).toMatchObject({ text: "8" })
    await code.dispose(); code = registerCodeMode(ctx, tools, { session, config: { mode: "only" } })
    expect(await execute('text(load("value"));', "first")).toMatchObject({ text: "7" })
    expect(await execute('text(load("value"));', "second")).toMatchObject({ text: "8" })
  } finally { await code.dispose() }
})

it("replays the current rewind-visible store both live and after restart while compaction keeps state", async () => {
  const session = createSession()
  let current = mount(session)
  try {
    await run(current.tools, 'store("value",1);')
    const anchor = session.events.length
    await run(current.tools, 'store("value",2);store("discarded",true);')
    append(session, { type: "rewind/point", version: 1, targetTurn: 1, anchorSeq: anchor, mode: "conversation", fileOps: [] })
    expect(await run(current.tools, 'text(load("value"));text(load("discarded"));')).toMatchObject({ text: "1\nundefined" })
    append(session, { type: "compaction/reset", removedSeqs: session.events.map(e => e.seq!) })
    await current.code.dispose(); current = mount(session)
    expect(await run(current.tools, 'text(load("value"));text(load("discarded"));')).toMatchObject({ text: "1\nundefined" })
  } finally { await current.code.dispose() }
})

it("waits for asynchronous commit durability before publishing success and surfaces failure without changing state", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let entered = false, reject = false
  const saved: Array<[string, unknown]> = [["value", 1]]
  const r = runtime({
    restoreStore: () => saved,
    commitStore: async ({ writes }: { writes: Array<[string, unknown]> }) => {
      entered = true; await held
      if (reject) throw Error("durability failed")
      saved.splice(0, saved.length, ...writes)
    },
  } as Partial<CodeModeRuntimeOptions>)
  try {
    const first = await r.exec({ code: 'store("value",2);', yield_time_ms: 0 })
    await vi.waitFor(() => expect(entered).toBe(true))
    expect((await r.wait({ cell_id: first.cellId, yield_time_ms: 0 })).status).toBe("running")
    expect((await r.exec({ code: 'text(load("value"));' })).text).toBe("1")
    release()
    expect((await r.wait({ cell_id: first.cellId })).status).toBe("completed")
    reject = true
    const failed = await r.exec({ code: 'store("value",3);' })
    expect(failed.status).toBe("failed"); expect(failed.error).toContain("durability failed")
    expect((await r.exec({ code: 'text(load("value"));' })).text).toBe("2")
  } finally { release(); await r.dispose() }
})

it("serializes concurrent durable commits and validates the latest merged state before calling persistence", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let entered = false
  const saved = new Map<string, unknown>(), order: unknown[] = []
  const r = runtime({ config: { maxStoreBytes: 100 }, restoreStore: () => [...saved], commitStore: async ({ writes }: { writes: Array<[string, unknown]> }) => {
    if (!entered) { entered = true; await held }
    order.push(writes)
    for (const [key, value] of writes) saved.set(key, value)
  } } as Partial<CodeModeRuntimeOptions>)
  try {
    const first = await r.exec({ code: 'store("first","a".repeat(40));', yield_time_ms: 0 })
    await vi.waitFor(() => expect(entered).toBe(true))
    const second = await r.exec({ code: 'store("second","b".repeat(40));', yield_time_ms: 0 })
    const third = await r.exec({ code: 'store("order","last");', yield_time_ms: 0 })
    release()
    expect((await r.wait({ cell_id: first.cellId })).status).toBe("completed")
    expect((await r.wait({ cell_id: second.cellId })).status).toBe("failed")
    expect((await r.wait({ cell_id: third.cellId })).status).toBe("completed")
    expect(order).toEqual([[["first", "a".repeat(40)]], [["order", "last"]]])
    expect((await r.exec({ code: 'text(load("first").length);text(load("second"));text(load("order"));' })).text).toBe("40\nundefined\nlast")
  } finally { release(); await r.dispose() }
})

it("does not publish or restore a store write when its flush fails", async () => {
  const session = createSession()
  const current = mount(session, "owner", async () => { throw Error("flush failed") })
  try {
    const failed = await run(current.tools, 'store("value",7);')
    expect(failed.status).toBe("failed"); expect(failed.error).toContain("flush failed")
    expect(await run(current.tools, 'text(load("value"));')).toMatchObject({ text: "undefined" })
    const restored = mount(createSessionFrom(session), "owner")
    try { expect(await run(restored.tools, 'text(load("value"));')).toMatchObject({ text: "undefined" }) } finally { await restored.code.dispose() }
  } finally { await current.code.dispose().catch(() => {}) }
})

it("keeps completion pending until its terminal flush and suppresses candidates after an owner stop", async () => {
  const session = createSession()
  let release!: () => void, flushes = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const current = mount(session, "owner", async () => { if (++flushes === 2) await held })
  try {
    const first = (await current.tools.execute({ name: "code_exec", args: { code: 'store("value",7);', yield_time_ms: 0 } })).output as { cell_id: string; status: string }
    await vi.waitFor(() => expect(flushes).toBe(2))
    expect((await current.tools.execute({ name: "code_wait", args: { cell_id: first.cell_id, yield_time_ms: 0 } })).output).toMatchObject({ status: "running" })
    expect((await current.tools.execute({ name: "code_status", args: {} })).output).toMatchObject({ cells: [{ id: first.cell_id }] })
    const stopped = current.code.terminateCell!(first.cell_id)
    release(); await stopped
    expect((await current.tools.execute({ name: "code_wait", args: { cell_id: first.cell_id } })).output).toMatchObject({ status: "terminated" })
    expect(await run(current.tools, 'text(load("value"));')).toMatchObject({ text: "undefined" })
    const restored = mount(createSessionFrom(session), "owner")
    try { expect(await run(restored.tools, 'text(load("value"));')).toMatchObject({ text: "undefined" }) } finally { await restored.code.dispose() }
  } finally { release(); await current.code.dispose() }
})

it("a failed completion flush overrides a persisted store candidate and completed marker", async () => {
  const session = createSession()
  let flushes = 0
  const current = mount(session, "owner", async () => { if (++flushes === 2) throw Error("terminal flush failed") })
  try {
    const failed = await run(current.tools, 'store("value",7);')
    expect(failed).toMatchObject({ status: "failed", error: expect.stringContaining("terminal flush failed") })
    expect(await run(current.tools, 'text(load("value"));')).toMatchObject({ text: "undefined" })
    const restored = mount(createSessionFrom(session), "owner")
    try { expect(await run(restored.tools, 'text(load("value"));')).toMatchObject({ text: "undefined" }) } finally { await restored.code.dispose() }
  } finally { await current.code.dispose() }
})

it("validates restored JSON bounds and refuses non-JSON guest writes", async () => {
  const oversized = runtime({ config: { maxStoreBytes: 64 }, restoreStore: () => [["x", "x".repeat(100)]] } as Partial<CodeModeRuntimeOptions>)
  const malformed = runtime({ restoreStore: () => [["x", NaN]] } as Partial<CodeModeRuntimeOptions>)
  const r = runtime()
  try {
    await expect(oversized.exec({ code: 'text(load("x"));' })).rejects.toThrow(/store.*limit/i)
    await expect(malformed.exec({ code: 'text(load("x"));' })).rejects.toThrow(/JSON/i)
    for (const value of ["NaN", "Infinity", "undefined", "()=>1", "{value:undefined}"]) {
      expect((await r.exec({ code: `store("invalid",${value});` })).status).toBe("failed")
    }
    expect((await r.exec({ code: 'text(load("invalid"));' })).text).toBe("undefined")
  } finally { await oversized.dispose(); await malformed.dispose(); await r.dispose() }
})

function createSessionFrom(session: Session): Session {
  const restored = createSession()
  restored.events.push(...JSON.parse(JSON.stringify(session.events)))
  return restored
}

it("captures each owner's admission store before an asynchronous start hook can interleave", async () => {
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const r = runtime({ restoreStore: origin => [["value", origin.sessionId!]], onEvent: event => {
    if (event.type === "started" && event.origin.sessionId === "A") { entered(); return held }
  } })
  try {
    const a = r.exec({ code: 'text(load("value"));' }, { sessionId: "A" })
    await started
    expect((await r.exec({ code: 'text(load("value"));' }, { sessionId: "B" })).text).toBe("B")
    release()
    expect((await a).text).toBe("A")
  } finally { release(); await r.dispose() }
})
