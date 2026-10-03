import { expect, it, vi } from "vitest"
import { createCodeModeRuntime } from "../src/runtime.ts"

it("terminates one cell independently of its model observer and drains only its nested producers", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let aborted = false
  const runtime = createCodeModeRuntime({ tools: () => [{ name: "held", description: "test", inputSchema: { type: "object" } }], invoke: async call => {
    call.signal.addEventListener("abort", () => { aborted = true }, { once: true })
    await held; return "done"
  } })
  try {
    expect(typeof runtime.terminate).toBe("function")
    const cell = await runtime.exec({ code: "await tools.held({});", yield_time_ms: 1000 })
    const other = await runtime.exec({ code: "await yield_control(); await new Promise(r=>setTimeout(r,20000));", yield_time_ms: 1000 })
    const observer = runtime.wait({ cell_id: cell.cellId, yield_time_ms: 20000 })
    let drained = false
    const stopped = runtime.terminate(cell.cellId).then(() => { drained = true })
    await vi.waitFor(() => expect(aborted).toBe(true))
    expect(drained).toBe(false)
    expect(await observer).toMatchObject({ status: "terminated" })
    release(); await stopped
    expect(await runtime.wait({ cell_id: other.cellId, yield_time_ms: 0 })).toMatchObject({ status: "running" })
    await expect(runtime.terminate("unrelated")).rejects.toThrow(/unavailable|unknown/i)
  } finally { release(); await runtime.dispose() }
}, 10000)
