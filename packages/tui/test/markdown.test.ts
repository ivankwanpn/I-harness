// @i-harness/tui — M38b G1 markdown checkpoint rendering + hljs highlighting.
// Pure renderer tests + one scrollback-engine integration pair. The engine
// surface is already covered by scrollback.test.ts — the regression cases
// here pin the EXACT plain-text fallback (no markdown structure → plainRows).

import { describe, expect, it } from "vitest"
import type { DisplayLine } from "../src/contracts.ts"
import {
  MarkdownCheckpointer,
  markdownRows,
  partsToRows,
  renderMarkdown,
} from "../src/render/markdown.ts"
import { classToStyle, highlightCode, plainCodeRows } from "../src/render/highlight.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"

const txt = (row: Array<{ text: string }>): string => row.map((r) => r.text).join("")

/* ---------------------------------------------------------------- goldens */

describe("renderMarkdown full render goldens", () => {
  it("headings h1–h6: colored rows, no `#` marker rows", () => {
    const rows = markdownRows("# A\n## B\n### C\n#### D\n##### E\n###### F", true)
    expect(rows.map((r) => txt(r))).toEqual(["A", "B", "C", "D", "E", "F"])
    expect(rows.map((r) => r[0].style)).toEqual([
      "md-h1", "md-h2", "md-h3", "md-h4", "md-h5", "md-h6",
    ])
  })

  it("bold/em/underline/codespan run styles", () => {
    const rows = markdownRows("**bold** and *em* and `code`", true)
    expect(rows).toHaveLength(1)
    expect(rows[0].map((r) => [r.text, r.style])).toEqual([
      ["bold", "md-strong"],
      [" and ", "text"],
      ["em", "md-em"],
      [" and ", "text"],
      ["code", "md-code-text"],
    ])
    expect(rows[0][4].codeBg).toBe(true)
  })

  it("list: ` • ` bullet per item", () => {
    const rows = markdownRows("- a\n- b", true)
    expect(rows.map((r) => txt(r))).toEqual([" • a", " • b"])
    expect(rows[0][0]).toEqual({ text: " • ", style: "text" })
  })

  it("task list: ✓/□ glyphs with md-task-* styles", () => {
    const rows = markdownRows("- [x] done\n- [ ] todo", true)
    expect(rows.map((r) => txt(r))).toEqual(["✓ done", "□ todo"])
    expect(rows[0][0].style).toBe("md-task-checked")
    expect(rows[1][0].style).toBe("md-task-unchecked")
  })

  it("blockquote: `│ ` prefix per line, muted", () => {
    const rows = markdownRows("> quoted\n> second", true)
    expect(rows.map((r) => txt(r))).toEqual(["│ quoted", "│ second"])
    expect(rows[0][0]).toEqual({ text: "│ ", style: "md-muted" })
  })

  it("hr: `───` muted row", () => {
    const rows = markdownRows("---", true)
    expect(rows).toEqual([[{ text: "───", style: "md-muted" }]])
  })

  it("table: box-art header/sep/data rows", () => {
    const rows = markdownRows("| a | b |\n|---|---|\n| x | y |", true)
    expect(rows).toHaveLength(3)
    expect(txt(rows[0])).toBe("│ a │ b │")
    expect(txt(rows[2])).toBe("│ x │ y │")
    expect(txt(rows[1]).includes("─┼─")).toBe(true)
  })

  it("code fence: fence markers HIDDEN, body highlighted, every run on codeBg", () => {
    const rows = markdownRows("```python\nprint(1)\n```", true)
    expect(rows.map((r) => txt(r))).toEqual(["print(1)"])
    // no ``` anywhere — markers never reach the scrollback
    expect(rows.map((r) => txt(r)).join("").includes("```")).toBe(false)
    expect(rows[0].some((r) => r.style === "md-code")).toBe(true) // hljs-built_in → md-code
    expect(rows[0].some((r) => r.style === "accent-assistant")).toBe(true) // hljs-number
    for (const r of rows[0]) expect(r.codeBg).toBe(true)
  })

  it("unterminated fence body stays plain md-code-text on codeBg", () => {
    const parts = renderMarkdown("```python\nprint(1)", false)
    const body = parts[parts.length - 1]
    expect(body.kind).toBe("code-body")
    expect(body.codeOpen).toBe(true)
    const rows = partsToRows(parts)
    expect(rows.map((r) => txt(r))).toEqual(["print(1)"])
    expect(rows[0][0].style).toBe("md-code-text")
    expect(rows[0][0].codeBg).toBe(true)
  })

  it("blank-line separation renders an empty row between paragraphs", () => {
    const rows = markdownRows("para1\n\npara2", true)
    expect(rows.map((r) => txt(r))).toEqual(["para1", "", "para2"])
  })
})

/* ---------------------------------------------------------------- checkpointer */

describe("MarkdownCheckpointer", () => {
  it("push flushes only the closed prefix; tail = the open paragraph", () => {
    const cp = new MarkdownCheckpointer()
    const { closed, tail } = cp.push("para1\n\npara2")
    expect(closed.map((p) => p.kind)).toEqual(["paragraph", "blank"])
    expect(closed[0].runs[0].text).toBe("para1")
    expect(tail?.kind).toBe("paragraph")
    expect(tail?.runs[0].text).toBe("para2")
    // finish() closes the tail
    const rest = cp.finish()
    expect(rest.map((p) => p.kind)).toEqual(["paragraph"])
    expect(rest[0].runs[0].text).toBe("para2")
  })

  it("two pushes: closed prefix advances across the boundary", () => {
    const cp = new MarkdownCheckpointer()
    const first = cp.push("para1\n\n")
    expect(first.closed.map((p) => p.kind)).toEqual(["paragraph"])
    expect(first.tail?.kind).toBe("blank")
    const second = cp.push("para2")
    expect(second.closed.map((p) => p.kind)).toEqual(["blank"])
    expect(second.tail?.runs[0].text).toBe("para2")
  })

  it("code fence: open tail plain → closed emits highlighted body", () => {
    const cp = new MarkdownCheckpointer()
    const open = cp.push("```python\nprint(1)")
    expect(open.closed.map((p) => p.kind)).toEqual(["code-open"])
    expect(open.tail?.kind).toBe("code-body")
    expect(open.tail?.codeOpen).toBe(true)
    const closed = cp.push("\n```")
    expect(closed.closed.map((p) => p.kind)).toEqual(["code-body", "code-close"])
    expect(closed.closed[0].codeOpen).not.toBe(true)
    const rows = partsToRows(closed.closed)
    expect(rows[0].some((r) => r.style === "md-code")).toBe(true) // highlight on closure
    expect(closed.tail).toBeUndefined()
  })

  it("trailing blank separator strips on finish()", () => {
    const cp = new MarkdownCheckpointer()
    cp.push("x\n\n")
    expect(cp.finish()).toEqual([])
  })
})

/* ---------------------------------------------------------------- regression */

describe("plain-text regression (exact plainRows shape)", () => {
  it("markdownRows('hello world') is exactly today's rows", () => {
    expect(markdownRows("hello world", true)).toEqual([
      [{ text: "hello world", style: "text" }],
    ])
  })

  it("multi-line plain text stays plain; empty text keeps the reserve row", () => {
    expect(markdownRows("line1\nline2", true)).toEqual([
      [{ text: "line1", style: "text" }],
      [{ text: "line2", style: "text" }],
    ])
    expect(markdownRows("", true)).toEqual([[{ text: "", style: "text" }]])
  })

  it("engine: plain assistant chunks render byte-identical rows", () => {
    const e = createScrollbackEngine({ width: 80 })
    e.append({ type: "assistant", text: "hello final", seq: 1, ts: 0 })
    const lines: DisplayLine[] = e.viewport(0, 10)
    expect(lines.map((l) => l.runs.map((r) => r.text).join(""))).toEqual(["hello final"])
    expect(lines[0].runs).toEqual([{ text: "hello final", style: "text" }])
  })

  it("engine: closed code fence inside a live assistant block highlights", () => {
    const e = createScrollbackEngine({ width: 80 })
    e.append({ type: "assistant", text: "hi\n\n```py\npass\n```\n", seq: 1, ts: 0 })
    const rows = e.viewport(0, 20)
    const textsOf = rows.map((l) => l.runs.map((r) => r.text).join("").replace(/\s+$/, ""))
    expect(textsOf).toEqual(["hi", "", "pass"])
    for (const r of rows[2].runs) expect(r.codeBg).toBe(true)
  })
})

/* ----------------------------------------------------------------- highlight */

describe("highlight.ts", () => {
  it("known language yields hljs-derived runs; unknown → plain code rows", () => {
    const rows = highlightCode("python", "print(1)")
    expect(rows).toHaveLength(1)
    expect(rows[0].some((r) => r.style !== "md-code-text")).toBe(true)
    const plainRows = highlightCode("tz-notreal", "print(1)")
    expect(plainRows.map((r) => txt(r))).toEqual(["print(1)"])
    expect(plainRows[0][0].style).toBe("md-code-text")
    expect(highlightCode("", "x")).toEqual(plainCodeRows("x"))
  })

  it("codeBg set on every highlight run", () => {
    for (const row of highlightCode("javascript", "const a = '42'; // note")) {
      for (const r of row) expect(r.codeBg).toBe(true)
    }
  })

  it("classToStyle map + fallbacks", () => {
    expect(classToStyle("hljs-keyword")).toBe("md-code")
    expect(classToStyle("hljs-built_in")).toBe("md-code")
    expect(classToStyle("hljs-string")).toBe("accent-model")
    expect(classToStyle("hljs-comment")).toBe("md-muted")
    expect(classToStyle("hljs-number")).toBe("accent-assistant")
    expect(classToStyle("hljs-title function_")).toBe("accent-assistant")
    expect(classToStyle("hljs-unknown-class")).toBe("md-code-text")
    expect(classToStyle("")).toBe("md-code-text")
  })

  it("blank code body lines stay rows", () => {
    const rows = highlightCode("python", "a\n\nb")
    expect(rows.map((r) => txt(r))).toEqual(["a", "", "b"])
  })
})
