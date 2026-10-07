import { describe, expect, it } from "vitest"
import { FrameDecoder, StatusDecoder } from "../src/protocol.ts"

describe("private helper protocol", () => {
  it("retains split binary frames and requires output-end", () => {
    const decoder = new FrameDecoder()
    expect(decoder.push(Buffer.from([0, 3, 0]))).toEqual([])
    expect(decoder.push(Buffer.from([0, 0, 65, 66, 67, 3, 0, 0, 0, 0]))).toEqual([
      { channel: "stdout", data: Buffer.from("ABC") },
    ])
    expect(() => decoder.finish(false)).not.toThrow()
  })

  it("rejects corrupt, oversized and incomplete frames", () => {
    expect(() => new FrameDecoder().push(Buffer.from([9, 0, 0, 0, 0]))).toThrow()
    expect(() => new FrameDecoder().push(Buffer.from([0, 1, 64, 0, 0]))).toThrow()
    const decoder = new FrameDecoder()
    decoder.push(Buffer.from([0, 3, 0, 0, 0, 65]))
    expect(() => decoder.finish(false)).toThrow()
    expect(() => decoder.finish(true)).not.toThrow()
  })

  it("rejects invalid status version and oversized status line", () => {
    expect(() => new StatusDecoder().push(Buffer.from('{"version":2,"id":"x","type":"ack"}\n'))).toThrow()
    expect(() => new StatusDecoder().push(Buffer.alloc(65537, 65))).toThrow()
  })
})
