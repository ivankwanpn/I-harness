import { describe, expect, it } from "vitest"
import { createTextDiff, renderUnifiedDiff } from "../src/index.ts"

describe("createTextDiff", () => {
  it("builds context-limited hunks with literal line numbers", () => {
    const before = ["a", "b", "c", "d", "e", "f"].join("\n")
    const after = ["a", "b", "C", "d", "e", "F"].join("\n")
    expect(createTextDiff("src/a.ts", before, after, { context: 1 })).toEqual({
      path: "src/a.ts",
      added: 2,
      deleted: 2,
      truncated: false,
      hunks: [
        expect.objectContaining({ oldStart: 2, newStart: 2 }),
        expect.objectContaining({ oldStart: 5, newStart: 5 }),
      ],
    })
  })

  it("marks large inputs truncated without throwing", () => {
    const huge = "x\n".repeat(50_001)
    const diff = createTextDiff("large.txt", huge, `${huge}tail\n`)
    expect(diff.truncated).toBe(true)
    expect(diff.hunks.length).toBeGreaterThan(0)
  })

  it("is a no-op when inputs are identical", () => {
    expect(createTextDiff("a.txt", "same\n", "same\n")).toEqual({
      path: "a.txt",
      hunks: [],
      added: 0,
      deleted: 0,
      truncated: false,
    })
  })

  it("preserves literal line numbers across the truncated tail window", () => {
    const lines = Array.from({ length: 50_001 }, (_, i) => `L${i}`)
    const before = lines.join("\n") + "\n"
    const after = before.replace("L50000", "CHANGED")
    const diff = createTextDiff("big.txt", before, after)
    expect(diff.truncated).toBe(true)
    const deleted = diff.hunks.flatMap((h) => h.lines).find((l) => l.kind === "delete" && l.text === "L50000")!
    expect(deleted.oldLine).toBe(50_001)
    expect(deleted.newLine).toBeUndefined()
  })

  it("treats CRLF as logical line endings", () => {
    const diff = createTextDiff("crlf.txt", "one\r\ntwo\r\n", "one\r\nTWO\r\n")
    expect(diff.added).toBe(1)
    expect(diff.deleted).toBe(1)
    expect(renderUnifiedDiff(diff)).not.toContain("\r")
    expect(renderUnifiedDiff(diff)).toContain("-two\n")
    expect(renderUnifiedDiff(diff)).toContain("+TWO\n")
  })

  it("keeps the no-newline marker on the annotated line", () => {
    const diff = createTextDiff("n.txt", "x\ny", "x\nz")
    const deleted = diff.hunks.flatMap((h) => h.lines).find((l) => l.kind === "delete")!
    expect(deleted.text).toBe("y")
    expect(deleted.noNewline).toBe(true)
    expect(renderUnifiedDiff(diff)).toContain("\\ No newline at end of file")
  })

  it("never blocks on unrelated huge inputs", () => {
    const a = Array.from({ length: 50_001 }, (_, i) => `A${i}`).join("\n")
    const b = Array.from({ length: 50_001 }, (_, i) => `B${i}`).join("\n")
    const diff = createTextDiff("huge.txt", a, b)
    expect(diff.truncated).toBe(true)
  }, 10_000)

  it("index-aligns truncated windows: no phantom deletions on asymmetric sizes", () => {
    const before = Array.from({ length: 15_000 }, (_, i) => `L${i}`).join("\n")
    const after = before + "\n" + Array.from({ length: 45_000 }, (_, i) => `N${i}`).join("\n")
    const diff = createTextDiff("a.txt", before, after)
    expect(diff.truncated).toBe(true)
    expect(diff.deleted).toBe(0)
    expect(diff.added).toBe(0)
    expect(diff.hunks).toEqual([])
  })

  it("index-aligns truncated windows when the after side is shorter", () => {
    const all = Array.from({ length: 60_000 }, (_, i) => `L${i}`).join("\n")
    const before = all
    const after = Array.from({ length: 15_000 }, (_, i) => `L${i}`).join("\n")
    const diff = createTextDiff("a.txt", before, after)
    expect(diff.truncated).toBe(true)
    expect(diff.deleted).toBe(0)
    expect(diff.added).toBe(0)
    expect(diff.hunks).toEqual([])
  })

  it("still reports a real tail append when the windows overlap", () => {
    const before = Array.from({ length: 60_000 }, (_, i) => `L${i}`).join("\n") + "\n"
    const after = before + Array.from({ length: 500 }, (_, i) => `E${i}`).join("\n") + "\n"
    const diff = createTextDiff("a.txt", before, after)
    expect(diff.truncated).toBe(true)
    expect(diff.added).toBe(500)
    // the append lines are reported as real additions (end-anchored windows
    // still show content that lies inside the overlap); a pure append has no
    // before-only content, so no deletion may be fabricated at the boundary
    expect(diff.hunks.some((h) => h.lines.some((l) => l.kind === "add" && l.text.startsWith("E")))).toBe(true)
    expect(diff.deleted).toBe(0)
  })

  it("reports a small pure append as additions only (no phantom deletions)", () => {
    const before = Array.from({ length: 60_000 }, (_, i) => `L${i}`).join("\n") + "\n"
    const after = before + Array.from({ length: 10 }, (_, i) => `E${i}`).join("\n") + "\n"
    const diff = createTextDiff("a.txt", before, after)
    expect(diff.truncated).toBe(true)
    expect(diff.added).toBe(10)
    expect(diff.deleted).toBe(0)
  })

  it("reports a pure truncation as deletions only (no phantom additions)", () => {
    const before = Array.from({ length: 60_000 }, (_, i) => `L${i}`).join("\n") + "\n"
    const after = Array.from({ length: 59_990 }, (_, i) => `L${i}`).join("\n") + "\n"
    const diff = createTextDiff("a.txt", before, after)
    expect(diff.truncated).toBe(true)
    expect(diff.added).toBe(0)
    expect(diff.deleted).toBe(10)
  })

  it("still reports a real modification inside the tail window", () => {
    const before = Array.from({ length: 60_000 }, (_, i) => `L${i}`).join("\n") + "\n"
    const after = before.replace("L55000\n", "X\n").replace("L55001\n", "X\n").replace("L55002\n", "X\n")
    const diff = createTextDiff("a.txt", before, after)
    expect(diff.truncated).toBe(true)
    expect(diff.added).toBe(3)
    expect(diff.deleted).toBe(3)
    const deleted = diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "delete")
    expect(deleted.map((l) => l.oldLine)).toEqual([55_001, 55_002, 55_003])
  })

  it("splits merged hunks without losing markers or line numbers", () => {
    const diff = createTextDiff("s.txt", "a\nb\nc\nd", "a\nB\nc\nD", { context: 1 })
    const deleted = diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind === "delete")
    expect(deleted.map((l) => [l.text, l.oldLine, l.noNewline ?? false])).toEqual([
      ["b", 2, false],
      ["d", 4, true],
    ])
    expect(diff.hunks.map((h) => h.oldStart)).toEqual([1, 4])
  })
})

describe("renderUnifiedDiff", () => {
  it("renders one unified patch from the structured result", () => {
    const diff = createTextDiff("a.txt", "old\n", "new\n")
    expect(renderUnifiedDiff(diff)).toContain("@@ -1,1 +1,1 @@")
    expect(renderUnifiedDiff(diff)).toContain("-old")
    expect(renderUnifiedDiff(diff)).toContain("+new")
  })

  it("uses \\n for every line regardless of input endings", () => {
    const diff = createTextDiff("a.txt", "one\r\ntwo\r\n", "one\r\nTWO\r\n")
    const rendered = renderUnifiedDiff(diff)
    expect(rendered).toMatch(/^--- a\/a\.txt\n\+\+\+ b\/a\.txt\n/)
    expect(rendered).not.toContain("\r")
  })
})
