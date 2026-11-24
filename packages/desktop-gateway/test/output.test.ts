import { describe, expect, it } from "vitest"
import { makeSuccess } from "@i-harness/sdk"
import { createDesktopHostOutput, createGatewayOutput } from "../src/output.ts"

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
  it("bounds the shared physical pipe across workspaces and reports a host-wide failure", async () => {
    const transport = blockedSink()
    let terminal = 0
    const output = createDesktopHostOutput(transport.sink, 180, () => { terminal++ })
    output.push({ type: "opened", workspaceId: "a" })
    output.push({ type: "data", workspaceId: "a", line: "a".repeat(55) })
    output.push({ type: "data", workspaceId: "b", line: "b".repeat(55) })
    expect(terminal).toBe(1)
    expect(JSON.parse(transport.chunks.at(-1)!)).toEqual({ type: "error", message: expect.stringContaining("overloaded") })
    await output.finish()
    expect(transport.endCount).toBe(1)
  })
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

  it("ends a pending drain and signals shutdown even when closing an overloaded pipe throws", async () => {
    const transport = blockedSink()
    let terminal = 0
    const output = createDesktopHostOutput({ ...transport.sink, end() { throw Error("Broken pipe") } }, 160, () => { terminal++ })
    output.push({ type: "opened", workspaceId: "first" })
    output.push({ type: "data", workspaceId: "first", line: "pending" })
    const drained = output.finish()
    output.push({ type: "data", workspaceId: "second", line: "x".repeat(160) })
    expect(terminal).toBe(1)
    await drained
  })
})
