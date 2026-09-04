// M40 G2 (C12): mermaid Unicode diagram art — flowchart/graph subset goldens,
// the box fallbacks (unknown / too wide / too deep / unparseable) and the
// scrollback-markdown integration (a closed mermaid fence → art rows in plain
// "text" style, NO codeBg).

import { describe, expect, it } from "vitest"
import { renderMermaidArt } from "../src/render/mermaid.ts"
import { markdownRows } from "../src/render/markdown.ts"
import { createScrollbackEngine } from "../src/scrollback/engine.ts"

describe("renderMermaidArt — flowchart subset goldens", () => {
  it("basic: A --> B — one row, two-column ladder", () => {
    expect(renderMermaidArt("flowchart LR\nA --> B", 40)).toEqual({
      kind: "art",
      lines: ["╭ A ─╮──→ ╭ B ─╮"],
    })
  })

  it("graph header with a direction word + comments/blank lines", () => {
    expect(renderMermaidArt("graph TD\n%% generated\nA --- B\n%% trailing", 40)).toEqual({
      kind: "art",
      lines: ["╭ A ─╮──→ ╭ B ─╮"],
    })
  })

  it("inline node shapes ride the edge (A[text] --> B((t)))", () => {
    expect(renderMermaidArt("flowchart LR\nA[hello world] --> B((circle))\nA --> C(round)", 40)).toEqual({
      kind: "art",
      lines: [
        "╭ hello world ─╮──→ ╭ circle ─╮",
        "                └──→ ╭ round ─╮",
      ],
    })
  })

  it("serpent: A --> B --> C — the loop-back row ` ←──┘`", () => {
    expect(renderMermaidArt("flowchart LR\nA --> B --> C", 40)).toEqual({
      kind: "art",
      lines: [
        "╭ A ─╮──→ ╭ B ─╮",
        "╭ C ─╮ ←──┘",
      ],
    })
  })

  it("plain node ids become the text; first definition wins", () => {
    expect(renderMermaidArt("graph LR\none --> two\none --> three", 40)).toEqual({
      kind: "art",
      lines: [
        "╭ one ─╮──→ ╭ two ─╮",
        "        └──→ ╭ three ─╮",
      ],
    })
  })

  it("node text clips to maxWidth-6 with a … tail (single-node ladder)", () => {
    const r = renderMermaidArt("flowchart LR\nA[abcdefghijklmnopqrstuvwxyz0123]", 24)
    expect(r.kind).toBe("art")
    // text limit = 24-6 = 18 → 17 chars + …; box width 18+5 = 23 ≤ 24
    expect(r.lines[0]).toBe("╭ abcdefghijklmnopq… ─╮")
  })
})

describe("renderMermaidArt — box fallbacks (spec: ╭ mermaid: <word> ─╮ + hint)", () => {
  it("unknown diagram type (sequenceDiagram) → box + one-line hint", () => {
    expect(renderMermaidArt("sequenceDiagram\nAlice -> Bob: hi", 40)).toEqual({
      kind: "box",
      lines: [
        "╭ mermaid: sequenceDiagram ─╮",
        "unsupported diagram type",
      ],
    })
  })

  it("too wide → box + hint naming the need", () => {
    expect(renderMermaidArt("flowchart LR\nA[aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa] --> B[bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb]", 40)).toEqual({
      kind: "box",
      lines: [
        "╭ mermaid: flowchart ─╮",
        "diagram needs 78 cols, limit 40",
      ],
    })
  })

  it("too deep (rank > 2: A --> B --> C --> D) → box + hint", () => {
    expect(renderMermaidArt("flowchart TD\nA --> B --> C --> D", 40)).toEqual({
      kind: "box",
      lines: [
        "╭ mermaid: flowchart ─╮",
        "cycle or too deep for two columns",
      ],
    })
  })

  it("unparseable body → box + hint", () => {
    expect(renderMermaidArt("flowchart LR\nA --> |label| B", 40)).toEqual({
      kind: "box",
      lines: [
        "╭ mermaid: flowchart ─╮",
        "no parseable nodes",
      ],
    })
  })

  it("empty body → box + hint (never throws)", () => {
    expect(renderMermaidArt("flowchart LR", 40)).toEqual({
      kind: "box",
      lines: [
        "╭ mermaid: flowchart ─╮",
        "no parseable nodes",
      ],
    })
  })
})

describe("mermaid × markdown integration (closed fence → art rows)", () => {
  it("a closed mermaid fence renders the art in PLAIN text style — no codeBg", () => {
    const rows = markdownRows("```mermaid\nflowchart LR\nA --> B\n```", true, 30)
    expect(rows.map((r) => r.map((x) => x.text).join(""))).toEqual(["╭ A ─╮──→ ╭ B ─╮"])
    expect(rows[0]![0]!.style).toBe("text")
    expect(rows[0]![0]!.codeBg).toBeUndefined()
    expect(rows.map((r) => r.map((x) => x.text).join("")).join("").includes("```")).toBe(false)
  })

  it("streaming: an OPEN mermaid fence stays plain code (art lands on close)", () => {
    const open = markdownRows("```mermaid\nflowchart LR\nA --> B\n", false, 30)
    expect(open[0]![0]!.style).toBe("md-code-text")
    expect(open[0]![0]!.codeBg).toBe(true)
    const closed = markdownRows("```mermaid\nflowchart LR\nA --> B\n```", false, 30)
    expect(closed[0]![0]!.style).toBe("text")
  })

  it("scrollback engine: the fence rows reach the viewport (width-safe at 46 cols)", () => {
    const engine = createScrollbackEngine({ width: 46 })
    engine.append({ type: "assistant", text: "```mermaid\nflowchart LR\nA[plan] --> B[done]\n```", seq: 1, ts: 0 })
    engine.append({ type: "turn", phase: "end", seq: 2, ts: 0 }) // finished flag
    const lines = engine.viewport(0, 10)
    const text = lines.map((l) => l.runs.map((r) => r.text).join("")).join("|")
    expect(text).toBe("╭ plan ─╮──→ ╭ done ─╮")
    // art rows are plain text — md-code-text/codeBg never reaches them
    const runs = lines.flatMap((l) => l.runs)
    expect(runs.every((r) => r.style === "text")).toBe(true)
    expect(runs.every((r) => r.codeBg !== true)).toBe(true)
  })
})
