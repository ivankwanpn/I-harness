import { expect, it, vi } from "vitest"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createSpillStore } from "@i-harness/output-retention"
import { createCodeModeRuntime } from "../src/runtime.ts"
import type { CodeModeRuntimeOptions } from "../src/types.ts"

it("retains full admitted Unicode text behind the bounded model preview and an owner-scoped reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-retention-"))
  const r = createCodeModeRuntime({ tools: () => [], invoke: async () => null, spillStore: createSpillStore({ root }) } as CodeModeRuntimeOptions)
  try {
    const out = await r.exec({ code: 'text("界🌏".repeat(8000));text("tail");' }, { sessionId: "owner" })
    expect(out.status).toBe("completed"); expect(out.truncated).toBe(true)
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(16 * 1024)
    const retained = (out as unknown as { textRetention: { path: string; stored: boolean; complete: boolean; truncated: boolean; admittedBytes: number; sessionId: string; cellId: string } }).textRetention
    expect(retained).toMatchObject({ stored: true, complete: true, truncated: true, admittedBytes: 56005, sessionId: "owner", cellId: out.cellId })
    expect(await readFile(retained.path, "utf8")).toBe("界🌏".repeat(8000) + "\ntail")
  } finally { await r.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("stores each consumed output window independently and reports transfer-refused text as incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-retention-windows-"))
  const r = createCodeModeRuntime({ tools: () => [], invoke: async () => null, config: { maxResultBytes: 50000 }, spillStore: createSpillStore({ root }) } as CodeModeRuntimeOptions)
  try {
    const first = await r.exec({ code: 'text("first".repeat(4000));await yield_control();await new Promise(r=>setTimeout(r,80));text("x".repeat(60000));text("second".repeat(4000));' })
    expect(first.status).toBe("running")
    const second = await r.wait({ cell_id: first.cellId })
    expect(second.status).toBe("completed")
    const a = (first as unknown as { textRetention: { path: string } }).textRetention
    const b = (second as unknown as { textRetention: { path: string; complete: boolean; admittedBytes: number } }).textRetention
    expect(await readFile(a.path, "utf8")).toBe("first".repeat(4000))
    expect(b).toMatchObject({ complete: false, admittedBytes: 24000 })
    expect(await readFile(b.path, "utf8")).toBe("second".repeat(4000))
    expect(a.path).not.toBe(b.path)
  } finally { await r.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("retains emitted text when a failure diagnostic consumes part of the model preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-retention-error-"))
  const r = createCodeModeRuntime({ tools: () => [], invoke: async () => null, spillStore: createSpillStore({ root }) })
  try {
    const out = await r.exec({ code: 'text("x".repeat(100));throw Error("e".repeat(60));', max_output_tokens: 32 })
    expect(out.status).toBe("failed")
    expect(out.textRetention).toMatchObject({ stored: true, complete: true, truncated: true, admittedBytes: 100 })
    expect(await readFile(out.textRetention!.path!, "utf8")).toBe("x".repeat(100))
    expect(Buffer.byteLength((out.error ?? "") + out.text)).toBeLessThanOrEqual(128)
  } finally { await r.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("drains a pending retention write on disposal and marks failed retention as unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-retention-drain-"))
  let entered = false, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const actual = createSpillStore({ root })
  const r = createCodeModeRuntime({ tools: () => [], invoke: async () => null, spillStore: { async saveText(text, label) { entered = true; await held; return actual.saveText(text, label) } } })
  const failed = createCodeModeRuntime({ tools: () => [], invoke: async () => null, spillStore: { async saveText() { throw Error("disk unavailable") } } })
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
    expect(out.error).toContain("disk unavailable")
    expect(out.textRetention).toMatchObject({ stored: false, complete: false, truncated: true })
    expect(out.textRetention?.path).toBeUndefined()
  } finally { release(); await r.dispose(); await failed.dispose(); await rm(root, { recursive: true, force: true }) }
})

it("keeps output produced during asynchronous retention available to the next observer", async () => {
  const root = await mkdtemp(join(tmpdir(), "ih-code-retention-late-"))
  let entered = false, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const actual = createSpillStore({ root })
  const r = createCodeModeRuntime({ tools: () => [], invoke: async () => null, spillStore: { async saveText(text, label) { if (!entered) { entered = true; await held } return actual.saveText(text, label) } } })
  try {
    const observing = r.exec({ code: 'text("first".repeat(4000));await yield_control();await new Promise(r=>setTimeout(r,80));text("second".repeat(4000));' })
    await vi.waitFor(() => expect(entered).toBe(true))
    await new Promise(resolve => setTimeout(resolve, 150))
    release()
    const first = await observing
    expect(first.status).toBe("running")
    expect(await readFile(first.textRetention!.path!, "utf8")).toBe("first".repeat(4000))
    const second = await r.wait({ cell_id: first.cellId })
    expect(second.status).toBe("completed")
    expect(await readFile(second.textRetention!.path!, "utf8")).toBe("second".repeat(4000))
  } finally { release(); await r.dispose(); await rm(root, { recursive: true, force: true }) }
})
