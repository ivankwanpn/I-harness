import { describe, expect, it } from "vitest"
import { createSpillStore, spillNotice } from "../src/index.ts"
import { readFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, sep } from "node:path"

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
  // Regression (M21 final-review Fix 2): label 做 injective 段編碼——不可用 ../
  // 逃出 root，空白等字元也須被編碼。
  it("sanitizeSegment: traversal label stays inside root", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-spill-sanitize-"))
    const store = createSpillStore({ root })
    const p = await store.saveText("x", "../evil")
    // 路徑必須仍在 root 內（未逃逸到 root 的上層目錄）
    expect(p.startsWith(root + sep) || p === root).toBe(true)
    expect(readFileSync(p, "utf-8")).toBe("x")
    const segments = relative(root, p).split(sep)
    expect(segments).toHaveLength(1) // 單一檔案名，無中間路徑段
  })
  it("sanitizeSegment: space and slash in label are encoded", async () => {
    const root = mkdtempSync(join(tmpdir(), "i-harness-spill-space-"))
    const store = createSpillStore({ root })
    const p = await store.saveText("y", "a b")
    expect(relative(root, p)).not.toContain(" ")
    expect(p.startsWith(root)).toBe(true)
    const q = await store.saveText("z", "sub/dir")
    expect(relative(root, q)).not.toMatch(/[/\\]/) // "/" 被編碼 → 無子目錄
    expect(readFileSync(q, "utf-8")).toBe("z")
  })
})
