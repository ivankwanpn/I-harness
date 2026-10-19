import { expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { createCodeModeRuntime } from "../src/runtime.ts"
import type { CodeModeTextRetention, CodeModeTextRetentionResult } from "../src/types.ts"
import { createSession, Inbox } from "@i-harness/core-session"
import { userSteerForTool } from "@i-harness/core-tools"

/** Independent literal envelope fixture. The codec bytes are derived from the
 * expected text here, never from the product serializer. */
function retainedText(text: string, completeness: "complete" | "source-limited" = "complete"): CodeModeTextRetentionResult {
  const encoded = JSON.stringify(text)
  const id = createHash("sha256").update("cell:" + text).digest("hex")
  const revision = createHash("sha256").update("revision:" + text).digest("hex")
  return { kind: "ready", envelope: { version: 1, execution: { outcome: "succeeded", dispatch: "not-dispatched" }, preview: "", media: [],
    retention: { kind: "artifact", ref: { version: 1, id: "ctxv1_" + id, revision, codec: "json-utf8-v1",
      encodedBytes: Buffer.byteLength(encoded), contentDigest: createHash("sha256").update(encoded).digest("hex"), completeness } } } }
}

it("steer waits for detached retention while later output and store commit remain ordered", async () => {
  const session = createSession(), inbox = new Inbox(session), source = userSteerForTool({ session })
  const started = Promise.withResolvers<void>(), tool = Promise.withResolvers<unknown>(), spill = Promise.withResolvers<CodeModeTextRetentionResult>(), spilling = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>()
  const retained: string[] = [], order: string[] = []
  const r = createCodeModeRuntime({
    tools: () => [{ name: "held", description: "fixture", inputSchema: {} }],
    invoke: async () => { started.resolve(); return tool.promise },
    retainText: async input => { retained.push(input.text); spilling.resolve(); return spill.promise },
    commitStore: async () => { order.push("commit") },
    onEvent: event => { if (event.type === "closed") { order.push("closed"); closed.resolve() } },
  })
  try {
    let settled = false
    const observing = r.exec({ code: 'text("first".repeat(4000)); await tools.held({}); text("second"); store("memo","committed")', yield_time_ms: 60_000 }, {}, { userSteer: source }).then(out => { settled = true; return out })
    await started.promise
    inbox.admit({ inputId: "steer", text: "refocus", intent: "user", delivery: "steer" })
    await spilling.promise
    expect(settled).toBe(false)
    tool.resolve(null); await closed.promise; await Promise.resolve()
    expect(order).toEqual(["commit", "closed"])
    expect(settled).toBe(false)
    spill.resolve(retainedText("first".repeat(4000)))
    const first = await observing
    expect(first.status).toBe("running") // later output still needs its own cursor
    expect(first).not.toHaveProperty("yielded") // actual completion won during retention
    expect(retained).toEqual(["first".repeat(4000)])
    inbox.claimAtStepBoundary()
    const second = await r.wait({ cell_id: first.cellId })
    expect(second).toMatchObject({ status: "completed", text: "second" })
    expect((await r.exec({ code: 'text(load("memo"))' })).text).toBe("committed")
    // The second window is under the preview budget, so only the first is retained.
    expect(retained).toHaveLength(1)
  } finally { tool.resolve(null); spill.resolve({ kind: "unavailable", reason: "capture-canceled" }); await r.dispose() }
})

it("retains the full admitted Unicode text behind a bounded model preview and an artifact envelope", async () => {
  const retained: { text: string; status: string; complete: boolean }[] = []
  const r = createCodeModeRuntime({ tools: () => [], invoke: async () => null, retainText: async input => { retained.push({ text: input.text, status: input.status, complete: input.complete }); return retainedText(input.text) } })
  try {
    const out = await r.exec({ code: 'text("界🌏".repeat(8000));text("tail");' }, { sessionId: "owner" })
    expect(out.status).toBe("completed"); expect(out.truncated).toBe(true)
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(16 * 1024)
    const textRetention = (out as unknown as { textRetention: CodeModeTextRetention }).textRetention
    expect(textRetention).toMatchObject({ stored: true, complete: true, truncated: true, admittedBytes: 56005, sessionId: "owner", cellId: out.cellId })
    expect(textRetention.envelope?.retention).toMatchObject({ kind: "artifact", ref: { codec: "json-utf8-v1", completeness: "complete" } })
    expect(textRetention.envelope?.preview).toBe("")
    expect(textRetention).not.toHaveProperty("path"); expect(textRetention).not.toHaveProperty("contextRef")
    expect(retained).toEqual([{ text: "界🌏".repeat(8000) + "\ntail", status: "completed", complete: true }])
    // The whole model/archive descriptor stays bounded even for a huge body.
    expect(Buffer.byteLength(JSON.stringify(textRetention))).toBeLessThanOrEqual(64_000)
  } finally { await r.dispose() }
})

it("stores each consumed output window independently and reports source-limited text honestly", async () => {
  const retained: string[] = []
  const r = createCodeModeRuntime({ tools: () => [], invoke: async () => null, config: { maxResultBytes: 50000 }, retainText: async input => { retained.push(input.text); return retainedText(input.text, input.complete ? "complete" : "source-limited") } })
  try {
    const first = await r.exec({ code: 'text("first".repeat(4000));await yield_control();await new Promise(r=>setTimeout(r,80));text("x".repeat(60000));text("second".repeat(4000));' })
    expect(first.status).toBe("running")
    const second = await r.wait({ cell_id: first.cellId })
    expect(second.status).toBe("completed")
    expect(retained).toEqual(["first".repeat(4000), "second".repeat(4000)])
    const a = (first as unknown as { textRetention: CodeModeTextRetention }).textRetention
    const b = (second as unknown as { textRetention: CodeModeTextRetention }).textRetention
    expect(a.envelope?.retention).toMatchObject({ kind: "artifact", ref: { completeness: "complete" } })
    expect(b).toMatchObject({ complete: false, admittedBytes: 24000 })
    expect(b.envelope?.retention).toMatchObject({ kind: "artifact", ref: { completeness: "source-limited" } })
    expect(a.envelope?.retention.kind === "artifact" ? a.envelope.retention.ref.id : undefined)
      .not.toBe(b.envelope?.retention.kind === "artifact" ? b.envelope.retention.ref.id : undefined)
  } finally { await r.dispose() }
})

it("retains emitted text when a failure diagnostic consumes part of the model preview", async () => {
  const retained: string[] = []
  const r = createCodeModeRuntime({ tools: () => [], invoke: async () => null, retainText: async input => { retained.push(input.text); return retainedText(input.text) } })
  try {
    const out = await r.exec({ code: 'text("x".repeat(100));throw Error("e".repeat(60));', max_output_tokens: 32 })
    expect(out.status).toBe("failed")
    expect(out.textRetention).toMatchObject({ stored: true, complete: true, truncated: true, admittedBytes: 100 })
    expect(retained).toEqual(["x".repeat(100)])
    expect(Buffer.byteLength((out.error ?? "") + out.text)).toBeLessThanOrEqual(128)
  } finally { await r.dispose() }
})

it("drains a pending retention write on disposal and reports failed retention without failing the guest", async () => {
  let entered = false, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const r = createCodeModeRuntime({ tools: () => [], invoke: async () => null, retainText: async input => { entered = true; await held; return retainedText(input.text) } })
  const failed = createCodeModeRuntime({ tools: () => [], invoke: async () => null, retainText: async () => { throw Error("disk unavailable") } })
  try {
    const observing = r.exec({ code: 'text("x".repeat(20000));' })
    await vi.waitFor(() => expect(entered).toBe(true))
    let disposed = false
    const disposing = r.dispose().then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(disposed).toBe(false)
    release(); await disposing
    expect((await observing).textRetention?.stored).toBe(true)
    const out = await failed.exec({ code: 'text("x".repeat(20000));' })
    // A storage failure is an explicit non-durable disposition; it never
    // rewrites the guest execution outcome and never inlines the huge text.
    expect(out.error).toBeUndefined()
    expect(out.textRetention).toMatchObject({ stored: false, complete: false, truncated: true, unavailable: "storage-unknown" })
    expect(out.textRetention).not.toHaveProperty("path")
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(64_000)
  } finally { release(); await r.dispose(); await failed.dispose() }
})

it("reports a missing durable owner explicitly instead of writing a spill file", async () => {
  const r = createCodeModeRuntime({ tools: () => [], invoke: async () => null })
  try {
    const out = await r.exec({ code: 'text("x".repeat(20000));' })
    expect(out.textRetention).toMatchObject({ stored: false, complete: false, truncated: true, unavailable: "no-owner" })
    expect(out.textRetention).not.toHaveProperty("path")
  } finally { await r.dispose() }
})

it("keeps output produced during asynchronous retention available to the next observer", async () => {
  let entered = false, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const retained: string[] = []
  const r = createCodeModeRuntime({ tools: () => [], invoke: async () => null, retainText: async input => { retained.push(input.text); if (!entered) { entered = true; await held } return retainedText(input.text) } })
  try {
    const observing = r.exec({ code: 'text("first".repeat(4000));await yield_control();await new Promise(r=>setTimeout(r,80));text("second".repeat(4000));' })
    await vi.waitFor(() => expect(entered).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 150))
    release()
    const first = await observing
    expect(first.status).toBe("running")
    const second = await r.wait({ cell_id: first.cellId })
    expect(second.status).toBe("completed")
    // The model text stays bounded; the complete second window is retained.
    expect(second.text.length).toBeLessThan(24000)
    expect(second.text.startsWith("second")).toBe(true)
    expect(retained).toEqual(["first".repeat(4000), "second".repeat(4000)])
  } finally { release(); await r.dispose() }
})
