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
