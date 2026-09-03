// M37b G2: panes (todo/tasks/queue/btw) — ROW-CAPTURE style, direct view
// draws into the renderer buffer (no commit needed; cells hold what we put).
// Assert text + the semantic styles (fg hex via the groknight palette).

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { makeDraw } from "../src/app/present.ts"
import { renderTodoPane } from "../src/views/todo-pane.ts"
import { renderTasksPane } from "../src/views/tasks-pane.ts"
import type { TaskGroup } from "../src/views/tasks-pane.ts"
import { renderQueuePane } from "../src/views/queue-pane.ts"
import type { QueueRow } from "../src/views/queue-pane.ts"
import { renderBtwOverlay } from "../src/views/btw-overlay.ts"
import type { BtwState } from "../src/views/btw-overlay.ts"
import type { TodoItem } from "../src/contracts.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

/** Visible text of one drawn row (reads the pre-commit buffer). */
const rowText = (r: Renderer, y: number): string => {
  const cells = r.buffer.cells
  const w = r.buffer.width
  let out = ""
  for (let x = 0; x < w; x++) out += cells[y * w + x].text
  return out
}

const cellAt = (r: Renderer, x: number, y: number) => r.buffer.cells[y * r.buffer.width + x]

const rgb = (hex: string): { r: number; g: number; b: number } => {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) }
}

/** Style-fg matcher: { fg: rgb } (ViewDraw styles carry fg, not raw rgb). */
const fg = (hex: string): { fg: { r: number; g: number; b: number } } => ({ fg: rgb(hex) })

const draw = (r: Renderer, fn: (view: ReturnType<typeof makeDraw>) => void): void => {
  fn(makeDraw(r.buffer, palette))
}

// ------------------------------------------------------------------ todo

describe("todo pane (spec §3.12)", () => {
  const items: TodoItem[] = [
    { id: "1", text: "fix bug", status: "pending" },
    { id: "2", text: "write tests", status: "in_progress" },
    { id: "3", text: "commit", status: "completed" },
    { id: "4", text: "skip", status: "cancelled" },
  ]

  it("renders □/▶/✓/✗ glyphs per status with the spec colors", () => {
    const r = make(60, 20)
    draw(r, (view) => renderTodoPane({ x: 0, y: 0, w: 60, h: 20 }, items, view, palette, GLYPHS))
    expect(rowText(r, 0)).toContain("□ fix bug")
    expect(rowText(r, 1)).toContain("▶ write tests")
    expect(rowText(r, 2)).toContain("✓ commit")
    expect(rowText(r, 3)).toContain("✗ skip")
    // colors: pending text_primary; in_progress warning + bold glyph;
    // completed accent_success; cancelled accent_error.
    expect(cellAt(r, 0, 0).style).toMatchObject(fg(palette.textPrimary))
    expect(cellAt(r, 0, 1).style).toMatchObject({ ...fg(palette.warning), bold: true })
    expect(cellAt(r, 0, 2).style).toMatchObject({ ...fg(palette.accentSuccess), dim: true })
    expect(cellAt(r, 0, 3).style).toMatchObject({ ...fg(palette.accentError), dim: true })
    // cancelled label carries the strikethrough (accent_error crossed-out).
    const labelStyle = cellAt(r, 2, 3).style
    expect(labelStyle.fg).toMatchObject(rgb(palette.accentError))
    expect(labelStyle.strikethrough).toBe(true)
  })

  it("caps at 10 rows and shows the summary empties", () => {
    const many: TodoItem[] = Array.from({ length: 12 }, (_v, i) => ({
      id: String(i), text: `item ${i}`, status: i < 11 ? "pending" : "completed",
    }))
    const r = make(60, 20)
    draw(r, (view) => renderTodoPane({ x: 0, y: 0, w: 60, h: 20 }, many, view, palette, GLYPHS))
    expect(rowText(r, 9)).toContain("item 9")
    expect(rowText(r, 10).trim()).toBe("") // cap: item 10/11 not drawn

    const r2 = make(60, 20)
    draw(r2, (view) => renderTodoPane({ x: 2, y: 1, w: 40, h: 5 }, [], view, palette, GLYPHS))
    expect(rowText(r2, 1)).toContain("No todo items.")

    const r3 = make(60, 20)
    const allDone = items.filter((i) => i.status === "completed")
    draw(r3, (view) => renderTodoPane({ x: 0, y: 0, w: 60, h: 5 }, allDone, view, palette, GLYPHS))
    expect(rowText(r3, 0)).toContain("All done.")

    const r4 = make(60, 20)
    const mixed = [
      { id: "a", text: "a", status: "completed" as const },
      { id: "b", text: "b", status: "completed" as const },
      { id: "c", text: "c", status: "cancelled" as const },
    ]
    draw(r4, (view) => renderTodoPane({ x: 0, y: 0, w: 60, h: 5 }, mixed, view, palette, GLYPHS))
    expect(rowText(r4, 0)).toContain("2 done. 1 cancelled.")

    const r5 = make(60, 20)
    draw(r5, (view) => renderTodoPane(
      { x: 0, y: 0, w: 60, h: 5 },
      [{ id: "x", text: "x", status: "cancelled" }, { id: "y", text: "y", status: "cancelled" }],
      view, palette, GLYPHS,
    ))
    expect(rowText(r5, 0)).toContain("2 cancelled.")
  })
})

// ------------------------------------------------------------------ tasks

describe("tasks pane (spec §3.12)", () => {
  const groups: TaskGroup[] = [
    {
      label: "Subagents",
      entries: [
        { status: "running", label: "search repo", elapsed: "2m10s", model: "mock", count: 2, action: "cancel" },
        { status: "done", label: "find api", elapsed: "1m02s", action: "expand" },
        { status: "error", label: "fail", elapsed: "3s" },
      ],
    },
    { label: "Background", entries: [{ status: "running", label: "compile", elapsed: "5m" }] },
  ]

  it("draws ▾ headers with counts, rows with glyph/elapsed/label/(N)/model and [✗]/[↗]", () => {
    const r = make(80, 24)
    draw(r, (view) => renderTasksPane({ x: 0, y: 0, w: 80, h: 24 }, { groups }, view, palette, GLYPHS))
    expect(rowText(r, 0)).toContain("▾ Subagents 3")
    expect(rowText(r, 1)).toContain("⠋ 2m10s search repo (2) mock")
    expect(rowText(r, 1)).toContain("[✗]")
    expect(rowText(r, 2)).toContain("✓ 1m02s find api")
    expect(rowText(r, 2)).toContain("[↗]")
    expect(rowText(r, 3)).toContain("✗ 3s fail")
    expect(rowText(r, 4)).toContain("▾ Background 1")
    expect(rowText(r, 5)).toContain("⠋ 5m compile")
    // running glyph colored accent_running (cyan).
    expect(cellAt(r, 0, 1).style).toMatchObject(fg(palette.running))
    expect(cellAt(r, 0, 3).style).toMatchObject(fg(palette.accentError))
  })

  it("collapsed groups use ▸; empty state text", () => {
    const r = make(80, 24)
    draw(r, (view) => renderTasksPane({ x: 0, y: 0, w: 80, h: 24 }, {
      groups: [{ label: "Schedule", entries: [], collapsed: true }, { label: "Schedule", entries: [] }],
    }, view, palette, GLYPHS))
    expect(rowText(r, 0)).toContain("▸ Schedule 0")
    expect(rowText(r, 1)).toContain("▾ Schedule 0")

    const r2 = make(80, 24)
    draw(r2, (view) => renderTasksPane({ x: 2, y: 3, w: 40, h: 4 }, { groups: [] }, view, palette, GLYPHS))
    expect(rowText(r2, 3)).toContain("No tasks or agents.")
  })

  it("overflow arrows ▲/▼ when rows exceed the rect", () => {
    const big: TaskGroup = { label: "Subagents", entries: Array.from({ length: 6 }, (_v, i) => ({
      status: "running", label: `task ${i}`, elapsed: "1m",
    })) }
    const r = make(80, 24)
    draw(r, (view) => renderTasksPane({ x: 0, y: 0, w: 80, h: 4 }, { groups: [big] }, view, palette, GLYPHS))
    expect(rowText(r, 0)).toContain("▾ Subagents 6")
    expect(rowText(r, 3)).toContain("▼") // more below
    expect(rowText(r, 3)).toContain("task 2")

    // middle window: ▲ on the first visible row + ▼ on the last.
    const r2 = make(80, 24)
    draw(r2, (view) => renderTasksPane({ x: 0, y: 0, w: 80, h: 3 }, { groups: [big], offset: 2 }, view, palette, GLYPHS))
    expect(rowText(r2, 0)).toContain("▲")
    expect(rowText(r2, 2)).toContain("▼")
  })
})

// ------------------------------------------------------------------ queue

describe("queue pane (spec §3.12)", () => {
  const rows: QueueRow[] = [
    { n: 1, kind: "shell", text: "pnpm test", extraLines: 2, action: "send" },
    { n: 2, kind: "prompt", text: "/compact now", action: "cancel" },
    { n: 3, kind: "cron", text: "regen every 5m" },
  ]

  it("renders #N prefixes, kind styles, (+N lines) and right [cancel]/[Send now]", () => {
    const r = make(80, 24)
    draw(r, (view) => renderQueuePane({ x: 0, y: 0, w: 80, h: 24 }, { rows }, view, palette, GLYPHS))
    expect(rowText(r, 0)).toContain("#1")
    expect(rowText(r, 0)).toContain("! pnpm test")
    expect(rowText(r, 0)).toContain("(+2 lines)")
    expect(rowText(r, 0)).toContain("[Send now]")
    expect(rowText(r, 1)).toContain("#2 /compact now")
    expect(rowText(r, 1)).toContain("[cancel]")
    expect(rowText(r, 2)).toContain("#3 ↻ regen every 5m")
    // shell body yellow (command), prompt body magenta (accent_assistant).
    expect(cellAt(r, 3, 0).style).toMatchObject(fg(palette.command)) // `!` after `#1 `
    const promptBody = rowText(r, 1).indexOf("/compact")
    expect(cellAt(r, promptBody + 1, 1).style).toMatchObject(fg(palette.accentAssistant))
  })

  it("caps at 3 rows; empty state 'Queue is empty.'", () => {
    const many: QueueRow[] = Array.from({ length: 5 }, (_v, i) => ({ n: i + 1, kind: "prompt", text: `q${i + 1}` }))
    const r = make(80, 24)
    draw(r, (view) => renderQueuePane({ x: 0, y: 0, w: 80, h: 24 }, { rows: many }, view, palette, GLYPHS))
    expect(rowText(r, 2)).toContain("#3")
    expect(rowText(r, 3).trim()).toBe("")

    const r2 = make(80, 24)
    draw(r2, (view) => renderQueuePane({ x: 1, y: 0, w: 30, h: 3 }, { rows: [] }, view, palette, GLYPHS))
    expect(rowText(r2, 0)).toContain("Queue is empty.")
  })
})

// ------------------------------------------------------------------ /btw

describe("btw overlay (spec §3.12)", () => {
  const base: BtwState = { question: "why?", state: "answering", pos: { from: 1, to: 3, total: 10 } }

  it("renders the rounded box, ` /btw {question} ` title bold accent_user + right hint", () => {
    const r = make(80, 24)
    draw(r, (view) => renderBtwOverlay({ x: 2, y: 4, w: 40, h: 8 }, base, view, palette, GLYPHS))
    const top = rowText(r, 4)
    expect(top.slice(2, 3)).toBe("╭") // title replaces dashes after the corner
    expect(top.slice(3, 14)).toBe(" /btw why? ")
    expect(cellAt(r, 4, 4).style).toMatchObject(fg(palette.accentUser))
    expect(top).toContain("1-3/10  ↑↓  [Esc]")
    expect(rowText(r, 5)).toContain("⠋ Answering…")
    expect(rowText(r, 11)).toContain("╰")
  })

  it("done state renders the body capped at 12 rows; error state accent_error", () => {
    const body = "line1\n" + Array.from({ length: 15 }, (_v, i) => `line ${i + 2}`).join("\n")
    const r = make(60, 30)
    draw(r, (view) => renderBtwOverlay({ x: 0, y: 0, w: 60, h: 20 }, {
      question: "q", state: "done", text: body,
    }, view, palette, GLYPHS))
    expect(rowText(r, 12)).toContain("line 12") // body rows y=1..12 (12-row cap)
    expect(rowText(r, 13)).not.toContain("line 13") // cap: no line 13

    const r2 = make(60, 20)
    draw(r2, (view) => renderBtwOverlay({ x: 0, y: 0, w: 60, h: 6 }, {
      question: "q", state: "error", text: "boom",
    }, view, palette, GLYPHS))
    expect(rowText(r2, 1)).toContain("boom")
    expect(cellAt(r2, 2, 1).style).toMatchObject(fg(palette.accentError))
  })
})
