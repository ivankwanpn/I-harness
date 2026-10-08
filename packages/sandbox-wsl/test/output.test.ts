import { expect, it } from "vitest"
import { OutputBuffer } from "../src/transport.ts"

it("retains bytes for one late consumer, including binary output", async () => {
  const queue = new OutputBuffer(8, () => {})
  queue.push({ channel: "stdout", data: Buffer.from([0, 255]) })
  queue.finish()
  const values = []
  for await (const value of queue.output) values.push(value)
  expect(values).toEqual([{ channel: "stdout", data: Buffer.from([0, 255]) }])
})

it("bounds retained output and cancels once on overflow while counting discarded bytes", async () => {
  let cancelled = 0
  const queue = new OutputBuffer(3, () => { cancelled++ })
  queue.push({ channel: "stdout", data: Buffer.from("abc") })
  queue.push({ channel: "stderr", data: Buffer.from("de") })
  queue.push({ channel: "stdout", data: Buffer.from("f") })
  queue.finish()
  const values = []
  for await (const value of queue.output) values.push(value)
  expect(values).toEqual([])
  expect(cancelled).toBe(1)
  expect(queue.diagnostics()).toEqual({ outputAbandoned: true, discardedOutputBytes: 6 })
})

it("bounds frame overhead when a producer emits many tiny chunks", () => {
  let cancelled = 0
  const queue = new OutputBuffer(1024 * 1024, () => { cancelled++ })
  for (let index = 0; index < 1025; index++) queue.push({ channel: "stdout", data: Buffer.from("x") })
  expect(cancelled).toBe(1)
  expect(queue.diagnostics()).toEqual({ outputAbandoned: true, discardedOutputBytes: 1025 })
})
