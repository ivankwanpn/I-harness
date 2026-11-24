import { once } from "node:events"
import { Writable } from "node:stream"
import { expect, it, vi } from "vitest"
import { decodeFrame, encodeFrame, makeRequest, SERVER_OVERLOAD } from "@i-harness/sdk"
import type { DesktopHostCommand } from "@i-harness/desktop-gateway/src/host-protocol.ts"
import { createHostCommandWriter } from "../src/main/host-command-writer.ts"

const request = (workspaceId: string, id: number, text: string): DesktopHostCommand => ({
  type: "data", workspaceId, line: encodeFrame(makeRequest(id, "session/prompt", { text })).trimEnd(),
})

function stalledPipe() {
  const frames: DesktopHostCommand[] = []
  let resume!: () => void
  const sink = new Writable({
    highWaterMark: 32,
    write(chunk: Buffer, _encoding, done) {
      frames.push(JSON.parse(chunk.toString("utf8")))
      if (frames.length === 1) resume = done
      else done()
    },
  })
  return { sink, frames, resume: () => resume() }
}

it("delivers a large in-flight prompt, a sibling request, control frames and EOF in order", async () => {
  const { sink, frames, resume } = stalledPipe()
  const reply = vi.fn()
  const writer = createHostCommandWriter(sink, reply)
  const expected: DesktopHostCommand[] = [
    request("a", 1, "a".repeat(3 * 1024 * 1024)),
    request("b", 1, "small"),
    { type: "ping" }, { type: "close", workspaceId: "a" }, { type: "shutdown" },
  ]
  const finished = once(sink, "finish")
  for (const frame of expected) writer.send(frame)
  writer.end()
  expect(frames).toHaveLength(1)
  expect(reply).not.toHaveBeenCalled()
  resume()
  await finished
  expect(frames).toEqual(expected)
})

it("rejects only the request over the waiting-byte bound and resumes normal admission after drain", async () => {
  const { sink, frames, resume } = stalledPipe()
  const reply = vi.fn()
  const writer = createHostCommandWriter(sink, reply, 256)
  const first = request("a", 1, "a".repeat(1000)), queued = request("b", 1, "small")
  writer.send(first)
  writer.send(queued)
  writer.send(request("a", 2, "b".repeat(300)))
  expect(reply).toHaveBeenCalledOnce()
  const [id, line] = reply.mock.calls[0]!
  expect(id).toBe("a")
  expect(decodeFrame(line)).toMatchObject({ id: 2, error: { code: SERVER_OVERLOAD, data: { retryable: true } } })
  const drained = once(sink, "drain")
  resume()
  await drained
  const retry = request("a", 3, "b".repeat(300))
  writer.send(retry)
  const finished = once(sink, "finish")
  writer.end()
  await finished
  expect(frames).toEqual([first, queued, retry])
})
