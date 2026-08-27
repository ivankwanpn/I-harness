import { describe, expect, it } from "vitest"
import { writeFileAtomic } from "../src/atomic.ts"
import { readFile } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("writeFileAtomic", () => {
  it("writes content atomically (no partial)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-atomic-"))
    const p = join(dir, "sub", "file.txt") // parent missing → mkdir recursive
    await writeFileAtomic(p, "hello")
    expect(await readFile(p, "utf-8")).toBe("hello")
    // no temp residue
    const entries = await import("node:fs/promises").then((m) => m.readdir(join(dir, "sub")))
    expect(entries).toEqual(["file.txt"])
  })
  it("overwrites existing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i-harness-atomic-"))
    const p = join(dir, "f.txt")
    await writeFileAtomic(p, "one")
    await writeFileAtomic(p, "two")
    expect(await readFile(p, "utf-8")).toBe("two")
  })
})
