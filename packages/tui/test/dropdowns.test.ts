// M37b G2: dropdowns (slash/completion/history/file-search) + the session
// picker — ROW-CAPTURE style, direct view draws into the renderer buffer.

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { makeDraw } from "../src/app/present.ts"
import { renderSlashDropdown } from "../src/views/slash-dropdown.ts"
import type { SlashEntry } from "../src/views/slash-dropdown.ts"
import { renderCompletionDropdown } from "../src/views/completion-dropdown.ts"
import { renderHistoryPanel } from "../src/views/history-panel.ts"
import { renderFileSearch, fmtSearchCount } from "../src/views/file-search.ts"
import { renderSessionPicker } from "../src/views/session-picker.ts"
import type { SessionPickerState } from "../src/views/session-picker.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

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

/** Style-fg matcher: { fg: rgb }. */
const fg = (hex: string): { fg: { r: number; g: number; b: number } } => ({ fg: rgb(hex) })

const draw = (r: Renderer, fn: (view: ReturnType<typeof makeDraw>) => void): void => {
  fn(makeDraw(r.buffer, palette))
}

// ------------------------------------------------------------------ slash

describe("slash dropdown (spec §3.6)", () => {
  const entries: SlashEntry[] = [
    { command: "help", description: "Shows help for built-in commands", fuzzyHit: [0, 1] },
    { command: "compact", description: "Compacts the conversation" },
  ]

  it("renders `❯ /command  desc` with accent BOLD fuzzy hits and gray desc", () => {
    const r = make(80, 12)
    draw(r, (view) => renderSlashDropdown({ x: 0, y: 0, w: 80, h: 8 }, { entries, cursor: 0 }, view, palette, GLYPHS))
    const row0 = rowText(r, 0)
    expect(row0).toContain("❯ /help")
    expect(row0).toContain("Shows help for built-in commands")
    // fuzzy hit letters (command indices 0,1 → 'h','e') bold accent_system.
    expect(cellAt(r, 3, 0).style).toMatchObject({ ...fg(palette.accentSystem), bold: true })
    expect(cellAt(r, 4, 0).style).toMatchObject({ ...fg(palette.accentSystem), bold: true })
    // desc gray on the same row.
    const descCol = row0.indexOf("Shows")
    expect(cellAt(r, descCol, 0).style).toMatchObject(fg(palette.gray))
    // non-cursor row: no ❯, letters not bold.
    const row1 = rowText(r, 1)
    expect(row1).toContain("/compact")
    expect(row1.slice(0, 2)).toBe("  ")
    expect(cellAt(r, 3, 1).style).toMatchObject(fg(palette.textPrimary))
  })

  it("wraps the desc with an indented continuation under the command", () => {
    const r = make(24, 10)
    draw(r, (view) => renderSlashDropdown({ x: 0, y: 0, w: 24, h: 6 }, { entries, cursor: 0 }, view, palette, GLYPHS))
    // width 24: `❯ /help  Shows` then continuation rows indented to col 2.
    const row1 = rowText(r, 1).trimEnd()
    expect(row1.slice(0, 2)).toBe("  ")
    expect(row1.trim()).not.toBe("")
  })

  it("caps at 8 rows with a 1-col scrollbar; ghost row below the list", () => {
    const many: SlashEntry[] = Array.from({ length: 9 }, (_v, i) => ({ command: `c${i}`, description: "d" }))
    const r = make(80, 12)
    draw(r, (view) => renderSlashDropdown(
      { x: 0, y: 0, w: 80, h: 12 },
      { entries: many, cursor: 0, ghost: { command: "c0", args: "arg" } },
      view, palette, GLYPHS,
    ))
    expect(rowText(r, 7)).toContain("c7")
    expect(rowText(r, 8).trim()).toBe("") // 8-row cap; ghost needs a free row (list fills) — none
    // scrollbar thumb on top (cursor 0), track below.
    expect(cellAt(r, 79, 0).style).toMatchObject({ bg: rgb(palette.scrollbarFg) })
    expect(cellAt(r, 79, 7).style).toMatchObject({ bg: rgb(palette.scrollbarBg) })
  })

  it("draws the ghost continuation row when the list has room", () => {
    const r = make(80, 12)
    draw(r, (view) => renderSlashDropdown(
      { x: 0, y: 0, w: 80, h: 8 },
      { entries: entries.slice(0, 1), cursor: 0, ghost: { command: "help", args: "patterns" } },
      view, palette, GLYPHS,
    ))
    expect(rowText(r, 1)).toContain("help patterns")
  })
})

// ------------------------------------------------------------------ completion

describe("completion dropdown (spec §3.6)", () => {
  const entries = Array.from({ length: 7 }, (_v, i) => ({ label: `label-${i}`, desc: `desc ${i}` }))

  it("max 6 rows; selected bg_visual BOLD, normal bg_light, desc gray", () => {
    const r = make(60, 10)
    draw(r, (view) => renderCompletionDropdown(
      { x: 0, y: 0, w: 60, h: 8 },
      { entries, cursor: 1 },
      view, palette, GLYPHS,
    ))
    expect(rowText(r, 0)).toContain("❯ label-0")
    expect(rowText(r, 0)).toContain("desc 0")
    expect(rowText(r, 5)).toContain("label-5")
    expect(rowText(r, 6).trim()).toBe("") // 6-row cap
    // row 0 (normal) bg_light; row 1 (selected) bg_visual + bold label
    // (col 30 is inside the row fill, off the text and the bar).
    expect(cellAt(r, 30, 0).style).toMatchObject({ bg: rgb(palette.bgLight) })
    expect(cellAt(r, 30, 1).style).toMatchObject({ bg: rgb(palette.bgVisual) })
    expect(cellAt(r, 3, 1).style).toMatchObject({ ...fg(palette.textPrimary), bold: true })
    // scrollbar column at x=59 (cursor 1 → thumb sits below the top row).
    expect(cellAt(r, 59, 1).style).toMatchObject({ bg: rgb(palette.scrollbarFg) })
    expect(cellAt(r, 59, 0).style).toMatchObject({ bg: rgb(palette.scrollbarBg) })
  })

  it("hover row bg_hover", () => {
    const r = make(60, 10)
    draw(r, (view) => renderCompletionDropdown(
      { x: 0, y: 0, w: 60, h: 8 },
      { entries: entries.slice(0, 2), cursor: 0, hover: 1 },
      view, palette, GLYPHS,
    ))
    expect(cellAt(r, 30, 1).style).toMatchObject({ bg: rgb(palette.bgHover) })
  })
})

// ------------------------------------------------------------------ history

describe("history panel (spec §3.6)", () => {
  it("` history ` label + count top-right, ❯ rows, match chars accent_user, `…` tail", () => {
    const r = make(50, 10)
    draw(r, (view) => renderHistoryPanel({ x: 0, y: 0, w: 50, h: 7 }, {
      entries: [
        { text: "fix bug now", highlight: [0, 3] },
        { text: "lorem ipsum ".repeat(8), highlight: [] },
      ],
      cursor: 0,
    }, view, palette, GLYPHS))
    const top = rowText(r, 0)
    expect(top).toContain(" history ")
    expect(top).toContain("2")
    expect(top).toContain("╮")
    const row1 = rowText(r, 1)
    expect(row1).toContain("❯ fix bug now")
    // `│ ❯ ` = cols 1-3 → text starts at x=3; index 0 ('f') is a match.
    expect(cellAt(r, 3, 1).style).toMatchObject({ ...fg(palette.accentUser), bold: true })
    expect(cellAt(r, 4, 1).style).toMatchObject(fg(palette.textPrimary)) // 'i' not matched
    const row2 = rowText(r, 2)
    expect(row2).toContain("…") // truncated tail
  })

  it("empty states: `  Loading...` when loading, `  no matching history` otherwise", () => {
    const r = make(50, 10)
    draw(r, (view) => renderHistoryPanel({ x: 0, y: 0, w: 50, h: 6 }, { entries: [], cursor: 0, loading: true }, view, palette, GLYPHS))
    expect(rowText(r, 1)).toContain("  Loading...")
    const r2 = make(50, 10)
    draw(r2, (view) => renderHistoryPanel({ x: 0, y: 0, w: 50, h: 6 }, { entries: [], cursor: 0 }, view, palette, GLYPHS))
    expect(rowText(r2, 1)).toContain("  no matching history")
  })
})

// ------------------------------------------------------------------ file search

describe("file-search panel (spec §3.6)", () => {
  it("counter `{k}/{n}` top-right on the border", () => {
    const r = make(60, 10)
    draw(r, (view) => renderFileSearch({ x: 0, y: 0, w: 60, h: 8 }, {
      files: [{ path: "src/a.ts", preview: "const a" }, { path: "src/b.ts" }, { path: "src/c.ts" }],
      cursor: 1,
    }, view, palette, GLYPHS))
    const top = rowText(r, 0)
    expect(top).toContain("2/3")
    expect(rowText(r, 1)).toContain("src/a.ts")
    expect(rowText(r, 1)).toContain("const a")
    expect(rowText(r, 2)).toContain("src/b.ts")
  })

  it("counter uses `1k+/n` when k ≥ 1000", () => {
    expect(fmtSearchCount(1200)).toBe("1k+")
    expect(fmtSearchCount(400)).toBe("400")
    const r = make(60, 10)
    draw(r, (view) => renderFileSearch({ x: 0, y: 0, w: 60, h: 8 }, {
      files: Array.from({ length: 1500 }, (_v, i) => ({ path: `f/${i}` })),
      cursor: 1200,
    }, view, palette, GLYPHS))
    expect(rowText(r, 0)).toContain("1k+/1500")
  })

  it("empty + loading states", () => {
    const r = make(60, 10)
    draw(r, (view) => renderFileSearch({ x: 0, y: 0, w: 60, h: 8 }, { files: [], cursor: 0, loading: true }, view, palette, GLYPHS))
    expect(rowText(r, 1)).toContain("Searching")
    const r2 = make(60, 10)
    draw(r2, (view) => renderFileSearch({ x: 0, y: 0, w: 60, h: 8 }, { files: [], cursor: 0 }, view, palette, GLYPHS))
    expect(rowText(r2, 1)).toContain("no matches")
  })
})

// ------------------------------------------------------------------ session picker

describe("session picker (spec §3.12)", () => {
  const now = Date.now()
  const state: SessionPickerState = {
    groups: [
      { repo: "i-harness", sessions: [
        { id: "abc123", title: "fix the tui", updatedAt: now - 30_000, turnCount: 12, model: "mock" },
        { id: "def456", title: "add panes", updatedAt: now - 2 * 3_600_000, turnCount: 3 },
      ] },
      { repo: "oc", sessions: [
        { id: "789abc", title: "docs", updatedAt: now - 3 * 86_400_000, turnCount: 1 },
      ] },
    ],
    cursor: 0,
    now,
  }

  it("group headers repo_name, rows label + relative-time right labels", () => {
    const r = make(70, 12)
    draw(r, (view) => renderSessionPicker({ x: 0, y: 0, w: 70, h: 12 }, state, view, palette, GLYPHS))
    const row0 = rowText(r, 0)
    expect(row0).toContain("╭ sessions ")
    expect(rowText(r, 1)).toContain("i-harness")
    expect(rowText(r, 2)).toContain("fix the tui")
    expect(rowText(r, 2)).toContain("just now")
    expect(rowText(r, 3)).toContain("add panes")
    expect(rowText(r, 3)).toContain("2h ago")
    expect(rowText(r, 4)).toContain("oc")
    expect(rowText(r, 5)).toContain("docs")
    expect(rowText(r, 5)).toContain("3d ago")
    // fields row (bottom) — cursor row's metadata.
    expect(rowText(r, 10)).toContain("abc123")
    expect(rowText(r, 10)).toContain("Turns 12")
  })

  it("loading state: `⠸ Searching session content…`", () => {
    const r = make(70, 12)
    draw(r, (view) => renderSessionPicker({ x: 0, y: 0, w: 70, h: 12 }, { groups: [], cursor: 0, loading: true, now }, view, palette, GLYPHS))
    expect(rowText(r, 1)).toContain("Searching session content")
  })

  it("relative time formatting", () => {
    const r = make(44, 4)
    draw(r, (view) => renderSessionPicker({ x: 0, y: 0, w: 24, h: 4 }, {
      groups: [{ repo: "x", sessions: [
        { id: "1", title: "t", updatedAt: now - 50 * 86_400_000, turnCount: 0 },
      ] }],
      cursor: 0,
      now,
    }, view, palette, GLYPHS))
    expect(rowText(r, 2)).toContain("1mo ago")
  })
})
