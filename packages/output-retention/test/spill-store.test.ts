import { describe, expect, it } from "vitest"
import { createSpillStore, spillNotice } from "../src/index.ts"
import { readFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("spill helpers", () => {
  it("spillNotice formats correctly", () => {
    expect(spillNotice(1234, "C:/spill/f.log")).toBe(
      "(Omitted 1234 bytes. Full result stored at: C:/spill/f.log. Use read with offset/limit, or grep this path to search within it.)",
    )
  })
  it("createSpillStore saves full text and returns path", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-spill-notice-"))
    const store = createSpillStore({ root })
    const p = await store.saveText("full content here", "bash")
    expect(p.startsWith(root)).toBe(true)
    expect(p).toContain("bash")
    expect(readFileSync(p, "utf-8")).toBe("full content here")
  })
})
