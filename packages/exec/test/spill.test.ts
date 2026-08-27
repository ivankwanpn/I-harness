import { describe, expect, it } from "vitest"
import { OutputCollector } from "../src/spill.ts"
import { readFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("OutputCollector", () => {
  it("keeps everything under maxBytes (no spill)", () => {
    const c = new OutputCollector({ maxBytes: 100, spillRoot: mkdtempSync(join(tmpdir(), "i-harness-spill-")) })
    c.push(Buffer.from("hello"))
    const r = c.finalize()
    expect(r.text).toBe("hello")
    expect(r.spillPath).toBeUndefined()
    expect(r.truncated).toBe(false)
  })
  it("spills complete stream on overflow", () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-spill-"))
    const c = new OutputCollector({ maxBytes: 10, spillRoot: root, label: "test" })
    const chunk1 = Buffer.from("hello ") // 6
    const chunk2 = Buffer.from("world!") // 6 → total 12 > 10
    c.push(chunk1)
    c.push(chunk2)
    const r = c.finalize()
    expect(r.spillPath).toBeDefined()
    expect(r.truncated).toBe(true)
    // spill 檔是完整 stream（含 overflow 前 chunk）
    expect(readFileSync(r.spillPath!, "utf-8")).toBe("hello world!")
  })
  it("discards spill beyond maxSpillBytes (tail only)", () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-spill-"))
    const c = new OutputCollector({ maxBytes: 5, maxSpillBytes: 20, spillRoot: root, label: "t" })
    c.push(Buffer.from("0123456789")) // 10 > 5 → spill
    c.push(Buffer.from("abcdefghijklmnopqrstuvwxyz")) // +26 → total 36 > 20 → discard
    const r = c.finalize()
    expect(r.spillPath).toBeUndefined()
    expect(r.lossy).toBe(true) // 中間被丟（只保尾）
    expect(r.text.endsWith("uvwxyz")).toBe(true) // 尾保留
  })
})
