// @i-harness/tui — scrollback G1 tests: engine/layout/folding/selection/search.
// Deterministic; all via the contract surface (createScrollbackEngine).

import { describe, expect, it } from "vitest"
import { clusterWidth } from "@i-harness/tui-core"
import type { DisplayLine, TuiEvent, ToolKind } from "../src/contracts.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"

// width 30 → content width = 30 - 5 = 25 (§2: accent 1 + pad 2 + pad 2).
const WIDTH = 30
const INNER = WIDTH - 5

function eng(opts: { showTimestamps?: boolean; width?: number } = {}) {
  return createScrollbackEngine({ width: opts.width ?? WIDTH, showTimestamps: opts.showTimestamps ?? false })
}

/* ------------------------------------------------------------------ helpers */

function usr(text: string, seq: number, ts = 0): TuiEvent {
  return { type: "user", text, seq, ts }
}
function edit(text: string, seq: number, ts = 0): TuiEvent {
  return { type: "user/edit", text, seq, ts }
}
function asst(text: string, seq: number, ts = 0): TuiEvent {
  return { type: "assistant", text, seq, ts }
}
function think(text: string, seq: number, ts = 0): TuiEvent {
  return { type: "thinking", text, seq, ts }
}
function toolEv(p: {
  callId: string
  name: string
  kind: ToolKind
  status: "running" | "done" | "error"
  seq: number
  ts?: number
  summary?: string
  output?: string
  error?: string
}): TuiEvent {
  return {
    type: "tool", callId: p.callId, name: p.name, kind: p.kind, status: p.status,
    seq: p.seq, ts: p.ts ?? 0, summary: p.summary ?? undefined, output: p.output ?? undefined, error: p.error ?? undefined,
  }
}

function lineText(l: DisplayLine): string {
  return l.runs.map((r) => r.text).join("")
}

function texts(lines: DisplayLine[]): string[] {
  return lines.map(lineText)
}

function lineWidth(l: DisplayLine): number {
  let w = 0
  for (const r of l.runs) {
    for (const g of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(r.text)) {
      w += clusterWidth(g.segment)
    }
  }
  return w
}

/* ------------------------------------------------------------------ tests */

describe("basic sequence", () => {
  it("renders user/thinking/assistant/tool in order with folded defaults", () => {
    const e = eng()
    e.append(usr("hi there", 1, 1000))
    e.append(think("planning…", 2, 1010))
    e.append(asst("ok here we go", 3, 1510)) // closes thinking: 0.5s duration
    e.append(toolEv({ callId: "r1", name: "read", kind: "read", status: "running", summary: "src/x.ts", seq: 4, ts: 1600 }))
    e.append(toolEv({ callId: "r1", name: "read", kind: "read", status: "done", summary: "src/x.ts", output: "line1\nline2", seq: 5, ts: 1610 }))

    expect(e.lineCount()).toBe(4)
    const vp = e.viewport(0, 10)
    expect(vp).toHaveLength(4)
    expect(texts(vp)).toEqual([
      "❯ hi there",
      "Thought for 0.5s",
      "ok here we go",
      "◆ Read src/x.ts",
    ])
    // styles
    expect(vp[0].runs[0]).toEqual({ text: "❯ ", style: "accent-user" })
    expect(vp[1].runs[0].style).toBe("muted")
    expect(vp[3].runs[0]).toEqual({ text: "◆ ", style: "dim" })
    // anchors: user = user:seq, tool = tool:callId
    expect(vp[0].anchor).toBe("user:1")
    expect(vp[3].anchor).toBe("tool:r1")
  })

  it("streams assistant chunks into one block", () => {
    const e = eng()
    e.append(asst("hello ", 1, 0))
    e.append(asst("world", 2, 0))
    expect(e.lineCount()).toBe(1)
    expect(texts(e.viewport(0, 1))).toEqual(["hello world"])
  })

  it("tool status transitions: truncated stream → done replace", () => {
    const e = eng()
    e.append(toolEv({ callId: "b1", name: "bash", kind: "execute", status: "running", summary: "node b.js", output: "o1\n", seq: 1, ts: 0 }))
    expect(e.lineCount()).toBe(2) // header + 1 output line
    e.append(toolEv({ callId: "b1", name: "bash", kind: "execute", status: "running", summary: "node b.js", output: "o2\no3\no4\no5\no6\no7\n", seq: 2, ts: 0 }))
    // appended: 7 body lines → header + first2 + " …" + last3 = 7
    expect(e.lineCount()).toBe(7)
    const mid = texts(e.viewport(0, 10))
    expect(mid).toEqual([
      "◆ Run node b.js",
      "o1", "o2", " …", "o5", "o6", "o7",
    ])
    e.append(toolEv({ callId: "b1", name: "bash", kind: "execute", status: "done", summary: "node b.js", output: "done1\ndone2", seq: 3, ts: 0 }))
    expect(e.lineCount()).toBe(3)
    expect(texts(e.viewport(0, 10))).toEqual(["◆ Run node b.js", "done1", "done2"])
  })

  it("error tool shows error row in collapsed (header-only) blocks", () => {
    const e = eng({ width: 80 })
    e.append(toolEv({ callId: "s1", name: "grep", kind: "search", status: "error", summary: "needle", output: "x:1", error: "pattern too big", seq: 1, ts: 0 }))
    expect(texts(e.viewport(0, 10))).toEqual([
      "◆ Search needle (1 matches)",
      "✗ pattern too big",
    ])
    expect(e.viewport(1, 1)[0].runs[0].style).toBe("accent-error")
  })
})

describe("wrap", () => {
  it("splits on grapheme clusters only; each line fits the inner width", () => {
    const e = eng()
    e.append(asst("你".repeat(13), 1, 0)) // 26 cols → 12 + 1
    e.append(asst("a👍".repeat(8), 2)) // 8×(1+2)=24 ✓ 1 line if alone
    e.append(asst("a👍" + "b", 3)) // 1+2+1+2+1 … wrapped conservatively
    e.append(asst("┃" + "━━".repeat(12) + "x", 4)) // 1 + 24 + 1 = 26 → 24/2
    e.append(asst("abc" + "你😀", 5)) // 3 + 2 + 2 = 7 ≤ 25
    const total = e.lineCount()
    const lines = e.viewport(0, total + 10)
    for (const l of lines) expect(lineWidth(l)).toBeLessThanOrEqual(INNER)
    // assistant text has no prefixes: concatenation reconstructs the source
    const joined = lines.map(lineText).join("")
    expect(joined).toBe("你".repeat(13) + "a👍".repeat(8) + ("a👍" + "b") + ("┃" + "━━".repeat(12) + "x") + ("abc" + "你😀"))
  })

  it("emits an empty line for an empty assistant chunk (spec §8 empty block)", () => {
    const e = eng()
    e.append(asst("", 1, 0))
    expect(e.lineCount()).toBe(1)
    expect(lineText(e.viewport(0, 1)[0])).toBe("")
  })
})

describe("verb-group folding", () => {
  const group = (e: ReturnType<typeof eng>) => {
    e.append(usr("run reads", 1, 0))
    e.append(toolEv({ callId: "g1a", name: "read", kind: "read", status: "done", summary: "a.txt", output: "a1", seq: 2, ts: 0 }))
    e.append(toolEv({ callId: "g1b", name: "read", kind: "read", status: "done", summary: "b.txt", output: "b1\nb2", seq: 3, ts: 0 }))
    e.append(toolEv({ callId: "g1c", name: "read", kind: "read", status: "done", summary: "c.txt", output: "c1", seq: 4, ts: 0 }))
    e.append(toolEv({ callId: "g1d", name: "grep", kind: "search", status: "done", summary: "findMe", output: "a.txt:1\nb.txt:2", seq: 5, ts: 0 }))
    e.append(toolEv({ callId: "g1e", name: "websearch", kind: "websearch", status: "done", summary: "north star", output: "s1\ns2", seq: 6, ts: 0 }))
  }

  it("folds 3 reads + grep + websearch into one header row", () => {
    const e = eng({ width: 80 })
    group(e)
    expect(e.lineCount()).toBe(2) // user + group header
    const hdr = e.viewport(0, 8)[1]
    expect(lineText(hdr)).toBe("◈ Read 3 files, Searched 1 pattern, Searched 1 web query")
    expect(hdr.collapsed).toBe(true)
    expect(hdr.anchor).toBe("group:1")
    // count runs are BOLD
    const bolds = hdr.runs.filter((r) => r.style === "bold")
    expect(bolds.map((r) => r.text)).toEqual(["3", "1", "1"])
    // lineBlock on the group header returns its summary
    expect(e.lineBlock(1)?.title).toBe("◈ Read 3 files, Searched 1 pattern, Searched 1 web query")
  })

  it("expands/collapses as a unit", () => {
    const e = eng({ width: 80 })
    group(e)
    e.toggleFoldAt(1) // expand group → members at own (collapsed) defaults
    expect(e.lineCount()).toBe(6)
    expect(texts(e.viewport(0, 10))).toEqual([
      "❯ run reads",
      "◆ Read a.txt",
      "◆ Read b.txt",
      "◆ Read c.txt",
      "◆ Search findMe (2 matches)",
      "◆ Search web for north star",
    ])
    e.toggleFoldAt(1) // collapse back
    expect(e.lineCount()).toBe(2)
  })

  it("member toggle inside an expanded group; group toggle still collapses all", () => {
    const e = eng()
    e.append(usr("go", 1, 0))
    e.append(toolEv({ callId: "m1", name: "read", kind: "read", status: "done", summary: "A", output: "a1", seq: 2, ts: 0 }))
    e.append(toolEv({ callId: "m2", name: "read", kind: "read", status: "done", summary: "B", output: "b1", seq: 3, ts: 0 }))
    expect(e.lineCount()).toBe(2) // user + group header
    e.toggleFoldAt(1) // expand group
    expect(e.lineCount()).toBe(3)
    e.toggleFoldAt(2) // expand member m2 (was header-only)
    expect(e.lineCount()).toBe(4)
    expect(texts(e.viewport(0, 10)).slice(1)).toEqual([
      "◆ Read A", "◆ Read B", "b1",
    ])
    e.toggleFoldAt(1) // toggle group → collapses the whole unit again
    expect(e.lineCount()).toBe(2)
  })

  it("failure suffix is accent-error", () => {
    const e = eng({ width: 60 })
    e.append(usr("go", 1, 0))
    e.append(toolEv({ callId: "f1", name: "read", kind: "read", status: "done", summary: "a.txt", output: "a1", seq: 2 }))
    e.append(toolEv({ callId: "f2", name: "read", kind: "read", status: "error", summary: "b.txt", error: "no such file", seq: 3 }))
    e.append(toolEv({ callId: "f3", name: "read", kind: "read", status: "done", summary: "c.txt", output: "c1", seq: 4 }))
    const hdr = e.viewport(0, 2)[1]
    expect(lineText(hdr)).toBe("◈ Read 3 files · 1 failed")
    expect(hdr.runs[hdr.runs.length - 1].style).toBe("accent-error")
  })
})

describe("1000-block append", () => {
  it("has correct counts and O(rendered) viewports over the whole range", () => {
    const e = eng()
    e.append(usr("go", 1, 0))
    const N = 999
    for (let i = 0; i < N; i++) {
      e.append(toolEv({
        callId: `t${i}`, name: "bash", kind: "execute", status: "done",
        summary: `task ${i}`, output: "", seq: 2 + i, ts: 0,
      }))
    }
    expect(e.lineCount()).toBe(1 + N)
    // nav offsets (first/middle/last) read via offset-0 slices — a nonzero
    // offset past the user pins the sticky prompt header instead (below).
    const all = e.viewport(0, 1 + N)
    expect(texts(all)[0]).toBe("❯ go")
    expect(texts(all)[10]).toBe("◆ Run task 9")
    expect(texts(all)[500]).toBe("◆ Run task 499")
    expect(texts(all)[N]).toBe("◆ Run task 998")
    // O(rendered): only the requested lines are returned. offset 100 is past
    // the sticky user → the returned view starts with the pinned prompt and
    // then the 6 real lines at 100..105.
    expect(e.viewport(100, 7)).toHaveLength(7)
    expect(texts(e.viewport(100, 7))).toEqual([
      "❯ go", "◆ Run task 99", "◆ Run task 100", "◆ Run task 101",
      "◆ Run task 102", "◆ Run task 103", "◆ Run task 104",
    ])
    // direct offset past the last user line → sticky overlay (1 line: "go")
    expect(texts(e.viewport(10, 1))).toEqual(["❯ go"])
    expect(e.viewport(10, 1)[0].sticky).toBe(true)
    // out-of-range viewport without a user block is empty; with the sticky
    // user the overflow pins its collapsed header instead (1 line: "go")
    const e2 = eng()
    expect(e2.viewport(999, 5)).toEqual([])
    const over = e.viewport(1_000_000, 2)
    expect(over).toHaveLength(1)
    expect(over[0].sticky).toBe(true)
    expect(lineText(over[0])).toBe("❯ go")
  })
})

describe("folding toggle / expandAll / sticky", () => {
  const seeded = (e: ReturnType<typeof eng>) => {
    e.append(usr("L0\nL1\nL2\nL3\nL4", 1, 0)) // 5 rows → auto collapsed (3 rows + …)
    e.append(asst("a done thing", 2, 0))
    e.append(toolEv({
      callId: "b1", name: "bash", kind: "execute", status: "running", summary: "node b.js",
      output: "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8", seq: 3, ts: 0,
    }))
  }

  it("auto-collapses a >3-line user message to 3 lines + …", () => {
    const e = eng()
    seeded(e)
    expect(texts(e.viewport(0, 3))).toEqual(["❯ L0", "  L1", "  L2 …"])
  })

  it("toggleFoldAt flips collapsed tool → expanded full output", () => {
    const e = eng()
    seeded(e)
    expect(e.lineCount()).toBe(3 + 1 + 7)
    e.toggleExpandAll()
    expect(e.lineCount()).toBe(5 + 1 + 9) // user 5, assistant 1, tool 9
    expect(texts(e.viewport(0, 20))[4]).toBe("  L4")
    expect(texts(e.viewport(0, 20)).length).toBe(15)
  })

  it("toggleExpandAll sets everything expanded; collapse back via toggle", () => {
    const e = eng()
    seeded(e)
    e.toggleExpandAll()
    expect(texts(e.viewport(0, 20)).slice(5)).toEqual(
      ["a done thing", "◆ Run node b.js", "l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"],
    )
  })

  it("sticky collapsed prompt header appears when scrolled past the last user block", () => {
    const e = eng()
    seeded(e)
    // bottom of the scrollback (total 11 lines) — the user block scrolled away
    const vp = e.viewport(11 - 3, 3)
    expect(vp).toHaveLength(3)
    expect(vp[0].sticky).toBe(true)
    expect(vp[1].sticky).toBe(true)
    expect(vp[2].sticky).toBe(true)
    expect(texts(vp)).toEqual(["❯ L0", "  L1", "  L2 …"])
    // top of the scrollback: no sticky (user block itself is on screen)
    const top = e.viewport(0, 3)
    expect(top[0].sticky).toBeUndefined()
    expect(texts(top)).toEqual(["❯ L0", "  L1", "  L2 …"])
  })

  it("thinking expands to full text on toggle", () => {
    const e = eng()
    e.append(think("secret plan", 1, 0))
    expect(e.lineCount()).toBe(1)
    e.toggleFoldAt(0)
    expect(e.lineCount()).toBe(2)
    expect(texts(e.viewport(0, 3))).toEqual(["Thinking…", "secret plan"])
  })

  it("edit renders diff-expanded by default with delta fold header", () => {
    const e = eng()
    e.append(toolEv({
      callId: "e1", name: "apply_patch", kind: "edit", status: "done", summary: "src/app.ts",
      output: "+a\n-b\n@@ -1,3 +1,3 @@\n context\n+c", seq: 1, ts: 0,
    }))
    expect(e.lineCount()).toBe(6)
    const vp = e.viewport(0, 10)
    expect(texts(vp)).toEqual([
      "◆ Edit src/app.ts", "+a", "-b", "@@ -1,3 +1,3 @@", " context", "+c",
    ])
    expect(vp[1].runs[0].style).toBe("diff-add")
    expect(vp[2].runs[0].style).toBe("diff-del")
    expect(vp[4].runs[0].style).toBe("text")
    e.toggleFoldAt(0)
    expect(e.lineCount()).toBe(1)
    expect(texts(e.viewport(0, 2))).toEqual(["◆ Edit src/app.ts (+2/-1)"])
  })
})

describe("selection", () => {
  it("holds undefined until set, clamps to the scrollback, keeps order", () => {
    const e = eng()
    expect(e.selection()).toBeUndefined()
    e.append(usr("one", 1, 0))
    e.append(asst("two", 2, 0))
    e.setSelection(0, 1)
    expect(e.selection()).toEqual({ a: 0, b: 1 })
    e.setSelection(9, 20) // clamp to [0, 1]
    expect(e.selection()).toEqual({ a: 1, b: 1 })
    e.setSelection(1, 0) // direction preserved
    expect(e.selection()).toEqual({ a: 1, b: 0 })
    e.setSelection(5, 5)
    expect(e.selection()).toEqual({ a: 1, b: 1 })
  })
})

describe("search", () => {
  const seeded = (e: ReturnType<typeof eng>) => {
    e.append(usr("hello world", 1, 0))
    e.append(asst("hello final", 2, 0))
    e.append(toolEv({ callId: "r1", name: "read", kind: "read", status: "done", summary: "hello.txt", seq: 3, ts: 0 }))
  }

  it("reports match line numbers and cycles next/prev with wrap-around", () => {
    const e = eng()
    seeded(e)
    expect(e.search("hello")).toBe(3)
    expect(e.matches()).toEqual([0, 1, 2])
    expect(e.nextMatch(0)).toBe(1)
    expect(e.nextMatch(1)).toBe(2)
    expect(e.nextMatch(2)).toBe(0) // wraps
    expect(e.prevMatch(0)).toBe(2) // wraps
    expect(e.prevMatch(2)).toBe(1)
    expect(e.prevMatch(1)).toBe(0)
  })

  it("bad pattern → -1 and clears; no-match → 0; clearSearch clears", () => {
    const e = eng()
    seeded(e)
    expect(e.search("(")).toBe(-1)
    expect(e.matches()).toEqual([])
    expect(e.search("zzz-no-hit")).toBe(0)
    expect(e.matches()).toEqual([])
    expect(e.nextMatch(0)).toBe(-1)
    e.search("hello")
    expect(e.matches()).toEqual([0, 1, 2])
    e.clearSearch()
    expect(e.matches()).toEqual([])
  })

  it("recomputes matches lazily after append (search stays active)", () => {
    const e = eng()
    seeded(e)
    expect(e.search("hello")).toBe(3)
    e.append(asst("hello more", 4, 0))
    expect(e.matches()).toEqual([0, 1, 2, 3])
    expect(e.nextMatch(2)).toBe(3)
  })
})

describe("resize", () => {
  it("setWidth re-wraps everything; prefix sums stay contiguous", () => {
    const e = eng()
    const text = "the quick brown fox jumps over the lazy dog"
    e.append(asst(text, 1, 0))
    const before = e.lineCount()
    const wide = e.viewport(0, before + 5).map(lineText).join("")
    expect(wide).toBe(text)
    e.setWidth(12) // inner 7
    const after = e.lineCount()
    expect(after).toBeGreaterThan(before)
    const all = e.viewport(0, after + 10)
    expect(all.map(lineText).join("")).toBe(text)
    for (const l of all) expect(lineWidth(l)).toBeLessThanOrEqual(12 - 5)
    // spot-check: individual 1-line viewports equal the full-viewport slices
    const full = e.viewport(0, after)
    expect(texts(e.viewport(0, 1))).toEqual([texts(full)[0]])
    expect(texts(e.viewport(Math.floor(after / 2), 1))).toEqual([texts(full)[Math.floor(after / 2)]])
    expect(texts(e.viewport(after - 1, 1))).toEqual([texts(full)[after - 1]])
  })
})

describe("timestamps", () => {
  it("defaults off; right-aligned ts text present on first lines when on", () => {
    const off = eng()
    off.append(usr("hi", 1, 0))
    expect(off.viewport(0, 1)[0].timestamp).toBeUndefined()

    const t = new Date(2026, 0, 2, 15, 35).getTime()
    const e = eng({ showTimestamps: true })
    e.append(usr("hi", 1, t))
    e.append(asst("fine", 2, t + 1000))
    e.append(toolEv({ callId: "r1", name: "read", kind: "read", status: "done", summary: "a.txt", seq: 3, ts: t + 2000 }))
    const vp = e.viewport(0, 10)
    expect(vp[0].timestamp).toMatch(/^\s{1,5}\d{1,2}:\d{2} (AM|PM)$/)
    expect(vp[0].timestamp).toContain("3:35 PM")
    expect(vp[1].timestamp).toBeDefined()
    expect(vp[2].timestamp).toBeDefined()
    // content width of line 0 reserves the ts column (11 chars + gap)
    expect(lineWidth(vp[0])).toBeLessThanOrEqual(INNER)
  })
})

describe("every event type", () => {
  it("handles the full TuiEvent surface without throwing; title/plan add no lines", () => {
    const e = eng()
    e.append(edit("edit me", 1, 0))
    e.append({ type: "system", text: "system note", seq: 2, ts: 0 })
    e.append(toolEv({ callId: "t0", name: "subagent", kind: "subagent", status: "running", summary: "helper job", seq: 3, ts: 0 }))
    e.append({
      type: "todo", seq: 4, ts: 0,
      items: [
        { id: "1", text: "task a", status: "pending" },
        { id: "2", text: "task b", status: "completed" },
      ],
    })
    e.append({ type: "goal", label: "Ship it", state: "Planning", seq: 5, ts: 0 })
    const beforeTitle = e.lineCount()
    e.append({ type: "title", title: "My Session", seq: 6, ts: 0 })
    e.append({ type: "plan", phase: "on", seq: 7, ts: 0 })
    expect(e.lineCount()).toBe(beforeTitle) // title/plan are state-only
    e.append({ type: "turn", phase: "start", seq: 8, ts: 0 })
    e.append({ type: "turn", phase: "end", seq: 9, ts: 0 })
    e.append({ type: "compaction", phase: "start", seq: 10, ts: 0 })
    e.append({ type: "compaction", phase: "end", seq: 11, ts: 0 })
    e.append(think("secret", 12, 0))
    e.append(asst("final", 13, 100))
    const vp = texts(e.viewport(0, 100))
    expect(vp).toEqual([
      "❯ edit me",
      "system note",
      "◆ Started helper job",
      "□ task a",
      "✓ task b",
      "◆ Ship it — Planning",
      "───",
      "─── compacting ───",
      "─── compaction done ───",
      "Thought for 0.1s",
      "final",
    ])
    expect(e.lineCount()).toBe(vp.length)
  })
})

describe("contract surface", () => {
  it("viewports on the empty engine are empty; duplicates by seq are ignored", () => {
    const e = eng()
    expect(e.lineCount()).toBe(0)
    expect(e.viewport(0, 10)).toEqual([])
    e.append(usr("once", 1, 0))
    e.append(usr("once", 1, 0)) // dup seq → ignored
    expect(e.lineCount()).toBe(1)
    expect(texts(e.viewport(0, 5))).toEqual(["❯ once"])
  })

  it("lineBlock returns undefined out of range and block titles in range", () => {
    const e = eng()
    expect(e.lineBlock(0)).toBeUndefined()
    e.append(usr("hello", 1, 0))
    e.append(asst("fine", 2, 0))
    expect(e.lineBlock(0)?.title).toBe("User")
    expect(e.lineBlock(1)?.title).toBe("Assistant")
    expect(e.lineBlock(2)).toBeUndefined()
    expect(e.lineBlock(-1)).toBeUndefined()
  })
})
