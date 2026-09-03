// M36: WriterPump — drain-driven write pump, latest-only coalescing, zero-byte no-op.
import { describe, expect, it } from "vitest"
import { WriterPump } from "../src/output/index.ts"
import type { WriterLike } from "../src/output/index.ts"

class FakeStream implements WriterLike {
  writes: string[] = []
  returning = true
  drainCb: (() => void) | undefined

  write(s: string): boolean {
    this.writes.push(s)
    return this.returning
  }

  on(name: "drain", cb: () => void): void {
    expect(name).toBe("drain")
    this.drainCb = cb
  }

  drain(): void {
    this.drainCb?.()
  }
}

describe("WriterPump", () => {
  it("writes directly when the stream accepts", () => {
    const f = new FakeStream()
    const p = new WriterPump(f)
    let idle = 0
    p.onIdle(() => idle++)
    expect(idle).toBe(1) // idle at registration → fires immediately
    p.submit("hello")
    expect(f.writes).toEqual(["hello"])
    expect(p.stats()).toEqual({ bytesWritten: 5, frames: 1, pending: false })
  })

  it("empty submit is a no-op: frames not incremented, bytes unchanged", () => {
    const f = new FakeStream()
    const p = new WriterPump(f)
    p.submit("hello")
    const before = p.stats()
    p.submit("")
    p.submit("")
    expect(p.stats()).toEqual(before)
    expect(p.stats().frames).toBe(1)
    expect(p.stats().bytesWritten).toBe(5)
    expect(f.writes).toEqual(["hello"])
  })

  it("two rapid submits while busy → one drain write with the latest content", () => {
    const f = new FakeStream()
    f.returning = false
    const p = new WriterPump(f)
    p.submit("A")
    expect(p.stats().pending).toBe(true)
    p.submit("B")
    p.submit("C")
    expect(f.writes).toEqual(["A"])
    let idleFired = false
    p.onIdle(() => {
      idleFired = true
    })
    expect(idleFired).toBe(false) // still busy
    f.returning = true
    f.drain()
    expect(f.writes).toEqual(["A", "C"]) // one drain write, latest content only (B dropped)
    expect(p.stats()).toEqual({ bytesWritten: 2, frames: 3, pending: false })
    expect(idleFired).toBe(true)
  })

  it("drain with no new submit just clears the backpressure", () => {
    const f = new FakeStream()
    f.returning = false
    const p = new WriterPump(f)
    p.submit("A")
    f.returning = true
    f.drain()
    expect(f.writes).toEqual(["A"]) // nothing re-written
    expect(p.stats().pending).toBe(false)
  })

  it("continues on drain when the pooled write is also backpressured", () => {
    const f = new FakeStream()
    f.returning = false
    const p = new WriterPump(f)
    p.submit("A")
    p.submit("B")
    f.drain() // write("B") still returns false
    expect(f.writes).toEqual(["A", "B"])
    expect(p.stats().pending).toBe(true)
    p.submit("C")
    f.returning = true
    f.drain()
    expect(f.writes).toEqual(["A", "B", "C"])
    expect(p.stats()).toEqual({ bytesWritten: 3, frames: 3, pending: false })
  })

  it("acquires idleness exactly once per busy cycle", () => {
    const f = new FakeStream()
    f.returning = false
    const p = new WriterPump(f)
    p.submit("A")
    let fires = 0
    p.onIdle(() => fires++)
    f.returning = true
    f.drain()
    f.drain()
    expect(fires).toBe(1)
  })
})
