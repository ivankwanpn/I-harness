import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { append, createSession, deriveMessages } from "@i-harness/core-session"
import { registerCodeMode } from "../src/register.ts"

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
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZasAAAAASUVORK5CYII="
    const result = await tools.execute({ name: "code_exec", args: { code: `text(await tools.read({})); image({type:"image",mimeType:"image/png",data:"${png}"});` } })
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
  tools.register({ name: "read", description: "read", inputSchema: { type: "object" }, isReadOnly: true, execute: async () => 7 })
  ctx.on("tools/post-execute", call => { if ((call as { name: string }).name === "read") throw new Error("finalize failed") })
  const mount = registerCodeMode(ctx, tools, { session, config: { mode: "only" } })
  try {
    await expect(tools.execute({ name: "code_exec", args: { code: 'try { await tools.read({}); } catch {} text("pretend success");' } })).rejects.toMatchObject({ policyRefusal: true })
    expect(session.events.filter(e => e.type === "code/result")).toHaveLength(1)
  } finally { await mount.dispose() }
})
