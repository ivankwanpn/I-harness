import { describe, expect, it } from "vitest"
import { makeSuccess } from "@i-harness/sdk"
import { createGatewayOutput } from "../src/output.ts"

function blockedSink() {
  const chunks: string[] = []
  const callbacks = new Set<() => void>()
  let endCount = 0
  let blocked = true
  return {
    chunks,
    get endCount() { return endCount },
    unblock() { blocked = false; for (const cb of [...callbacks]) cb() },
    sink: {
      write(chunk: string) { chunks.push(chunk); return !blocked },
      end() { endCount++ },
      onDrain(cb: () => void) { callbacks.add(cb); return () => { callbacks.delete(cb) } },
    },
  }
}

describe("gateway output lifecycle", () => {
  it("drains queued replies before ending normally", async () => {
    const transport = blockedSink()
    const output = createGatewayOutput(transport.sink, 1024, () => {})
    output.push(makeSuccess(1, { value: "first" }))
    output.push(makeSuccess(2, { value: "second" }))
    const finished = output.finish()
    expect(transport.endCount).toBe(0)
    transport.unblock()
    await finished
    expect(transport.endCount).toBe(1)
    expect(transport.chunks.map((chunk) => JSON.parse(chunk).id)).toEqual([1, 2])
  })

  it("signals the host to close when the output bound is exceeded", async () => {
    const transport = blockedSink()
    let terminal = 0
    const output = createGatewayOutput(transport.sink, 64, () => { terminal++ })
    output.push(makeSuccess(1, { value: "first" }))
    output.push(makeSuccess(2, { value: "x".repeat(80) }))
    expect(terminal).toBe(1)
    expect(transport.endCount).toBe(1)
    await output.finish()
    expect(transport.endCount).toBe(1)
  })
})
