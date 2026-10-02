import { describe, expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createSession } from "@i-harness/core-session"
import { createCodeModeBroker } from "../src/broker.ts"

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
