// G1 (M37b): permission modal — row-golden assertions on the drawn cell grid
// (present.test.ts row-capture approach over a direct view render + commit),
// plus the spec §4 key table and the RejectOnce freeform preview.

import { describe, expect, it } from "vitest"
import { createRenderer, createUnknownCapabilities, GLYPHS, resolvePalette } from "@i-harness/tui-core"
import type { Renderer, TerminalCapabilityContext } from "@i-harness/tui-core"
import { makeDraw } from "../src/app/present.ts"
import { cancelTurnKeys, renderCancelTurn } from "../src/views/cancel-turn.ts"
import { permissionKeys, permissionRows, renderPermission } from "../src/views/permission.ts"
import type { KeyLike, PermissionSurface, PermissionState } from "../src/views/permission.ts"

const cap: TerminalCapabilityContext = { ...createUnknownCapabilities(), colorLevel: "truecolor", dark: true }
const palette = resolvePalette(cap, "groknight")

const make = (cols: number, rows: number): Renderer => createRenderer({ cols, rows, cap })

/** Visible text of one drawn row (reads the committed front frame). */
const rowText = (r: Renderer, y: number): string => {
  const inner = r as unknown as { db: { front: { cells: Array<{ text: string; style: unknown }>; width: number } } }
  const { cells, width } = inner.db.front
  let out = ""
  for (let x = 0; x < width; x++) out += cells[y * width + x].text
  return out
}

const drawPermission = (r: Renderer, surf: PermissionSurface, state: PermissionState): void => {
  renderPermission({ x: 2, y: 2, w: 60, h: 12 }, surf, state, makeDraw(r.buffer, palette), palette, GLYPHS)
  r.commit() // swap drawn frame → front (what flush() and rowText read)
  r.flush(() => {})
}

const kbd = (partial: Partial<KeyLike>): KeyLike => ({
  code: "char",
  key: "",
  ctrl: false,
  alt: false,
  shift: false,
  ...partial,
})
const letter = (key: string): KeyLike => kbd({ code: "char", key })
const ctrlKey = (key: string): KeyLike => kbd({ code: "char", key, ctrl: true })

const bashSurf = (): PermissionSurface => ({
  id: "a1",
  kind: "bash",
  title: "rm -rf ./node_modules",
  detail: "dangerous command requires approval",
  freeform: true,
  scopes: ["rm -rf ./node_modules", "rm"],
})

describe("renderPermission — spec §3.7 rows", () => {
  it("draws the rail + `1 (●) Always allow: {scope}` … rows + scope footer hint", () => {
    const r = make(80, 24)
    drawPermission(r, bashSurf(), { cursor: 0, scopeIndex: 0, freeformText: "" })
    // accent rail on the band's left column (cell x=2)
    expect(rowText(r, 2)[2]).toBe("┃")
    expect(rowText(r, 6)[2]).toBe("┃")
    // title row — bold bash command
    expect(rowText(r, 2)).toContain("rm -rf ./node_modules")
    expect(rowText(r, 3)).toContain("dangerous command requires approval")
    // rows in option order
    expect(rowText(r, 5)).toContain("1 (●) Always allow: rm -rf ./node_modules")
    expect(rowText(r, 6)).toContain("2 (○) Never allow: rm -rf ./node_modules")
    expect(rowText(r, 7)).toContain("3 (○) Yes, proceed")
    expect(rowText(r, 8)).toContain("4 (○) No, I trust it")
    expect(rowText(r, 9)).toContain("5 (○) No, reject (type to add feedback)")
    // footer scope hint (last band row)
    expect(rowText(r, 13)).toContain("Use ← → to choose permission scope")
  })

  it("scope cycling: ←→ scopeIndex swaps the Always/Never scope label", () => {
    const r = make(80, 24)
    drawPermission(r, bashSurf(), { cursor: 0, scopeIndex: 1, freeformText: "" })
    expect(rowText(r, 5)).toContain("1 (●) Always allow: rm")
    expect(rowText(r, 6)).toContain("2 (○) Never allow: rm")
  })

  it("no scope hint when there is a single scope", () => {
    const r = make(80, 24)
    const surf = { ...bashSurf(), scopes: ["rm -rf ./node_modules"] }
    drawPermission(r, surf, { cursor: 0, scopeIndex: 0, freeformText: "" })
    expect(rowText(r, 13)).not.toContain("scope")
  })

  it("freeform row flips to `❯ {preview}` with a 40-col truncated preview", () => {
    const r = make(80, 24)
    drawPermission(r, bashSurf(), { cursor: 4, scopeIndex: 0, freeformText: "x".repeat(50) })
    const row = rowText(r, 9).slice(2)
    expect(row).toContain("5 (●) ❯ " + "x".repeat(40))
    expect(row).not.toContain("x".repeat(41))
    // markers: the cursor row is filled, pending approval rows stay empty
    expect(rowText(r, 5)).toContain("1 (○) Always allow")
  })

  it("detail soft-wraps (58 chars > 57-col content) and pushes option rows down", () => {
    const r = make(80, 24)
    drawPermission(r, { ...bashSurf(), detail: "dangerous command requires approval: rm -rf ./node_modules" },
      { cursor: 0, scopeIndex: 0, freeformText: "" })
    // line 1 head — 57-col fill, the trailing `s` of node_modules wraps
    expect(rowText(r, 3)).toContain("dangerous command requires approval: rm -rf ./node_module")
    expect(rowText(r, 4)).toContain("s")
    expect(rowText(r, 6)).toContain("1 (●) Always allow: rm -rf ./node_modules") // shifted start
    expect(rowText(r, 10)).toContain("5 (○) No, reject (type to add feedback)")
  })

  it("long detail caps at the box and pins the `... Ctrl-F to expand` hint", () => {
    const r = make(80, 24)
    const surf = { ...bashSurf(), detail: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") }
    drawPermission(r, surf, { cursor: 0, scopeIndex: 0, freeformText: "" })
    // box: y0=2 title; available detail rows = 13 - 3 - 5 - 1 - 1 = 3
    expect(rowText(r, 5)).toContain("... Ctrl-F to expand")
  })
})

describe("permissionRows — pure row builder", () => {
  it("builds the five spec rows with scopes", () => {
    const rows = permissionRows(bashSurf(), { cursor: 0, scopeIndex: 0, freeformText: "" }, GLYPHS)
    expect(rows.map((row) => row.label)).toEqual([
      "Always allow: rm -rf ./node_modules",
      "Never allow: rm -rf ./node_modules",
      "Yes, proceed",
      "No, I trust it",
      "No, reject (type to add feedback)",
    ])
  })

  it("freeform row carries the typed preview", () => {
    const rows = permissionRows(bashSurf(), { cursor: 4, scopeIndex: 0, freeformText: "bad idea" }, GLYPHS)
    expect(rows[4]).toEqual({ key: "5", label: "❯ bad idea" })
  })

  it("no freeform row when surf.freeform is false", () => {
    const rows = permissionRows({ ...bashSurf(), freeform: false }, { cursor: 0, scopeIndex: 0, freeformText: "" }, GLYPHS)
    expect(rows).toHaveLength(4)
  })
})

describe("permissionKeys — spec §4", () => {
  it("1-9 select by index; Enter selects at cursor", () => {
    expect(permissionKeys(letter("1"))).toEqual({ action: "select", index: 0 })
    expect(permissionKeys(letter("5"))).toEqual({ action: "select", index: 4 })
    expect(permissionKeys(kbd({ code: "Enter", key: "Enter" }))).toEqual({ action: "select" })
  })

  it("j/k cursor ±1", () => {
    expect(permissionKeys(letter("j"))).toEqual({ action: "cursor-down" })
    expect(permissionKeys(letter("k"))).toEqual({ action: "cursor-up" })
  })

  it("← → scope; Ctrl-F expand; Ctrl-O always-approve; Ctrl-C cancel", () => {
    expect(permissionKeys(kbd({ code: "Left", key: "ArrowLeft" }))).toEqual({ action: "scope-left" })
    expect(permissionKeys(kbd({ code: "Right", key: "ArrowRight" }))).toEqual({ action: "scope-right" })
    expect(permissionKeys(ctrlKey("f"))).toEqual({ action: "expand" })
    expect(permissionKeys(ctrlKey("o"))).toEqual({ action: "always-approve" })
    expect(permissionKeys(ctrlKey("c"))).toEqual({ action: "cancel" })
  })

  it("unbound keys → undefined", () => {
    expect(permissionKeys(letter("q"))).toBeUndefined()
    expect(permissionKeys(ctrlKey("x"))).toBeUndefined()
  })
})

describe("renderCancelTurn — spec §3.11", () => {
  it("warning rail + title + `{N} subagent running(s)` + radio rows 1-4 + hint", () => {
    const r = make(80, 24)
    renderCancelTurn({ x: 2, y: 2, w: 70, h: 8 }, { count: 2, cursor: 1 },
      makeDraw(r.buffer, palette), palette, GLYPHS)
    r.commit()
    r.flush(() => {})
    expect(rowText(r, 2)).toContain("Subagents are still running. Stop them?")
    expect(rowText(r, 3)).toContain("2 subagent running(s)")
    expect(rowText(r, 4)).toContain("1 (○) Stop running")
    expect(rowText(r, 5)).toContain("2 (●) Continue to run") // cursor row filled
    expect(rowText(r, 6)).toContain("3 (○) Always stop")
    expect(rowText(r, 7)).toContain("4 (○) Always continue")
    expect(rowText(r, 9)).toContain("1-4 select · enter confirm · esc keep running · tab scrollback")
  })

  it("cancelTurnKeys: 1-4 select, Enter confirm, Esc keep running", () => {
    expect(cancelTurnKeys(letter("1"))).toEqual({ action: "select", index: 0 })
    expect(cancelTurnKeys(letter("4"))).toEqual({ action: "select", index: 3 })
    expect(cancelTurnKeys(kbd({ code: "Enter", key: "Enter" }))).toEqual({ action: "confirm" })
    expect(cancelTurnKeys(kbd({ code: "Esc", key: "Esc" }))).toEqual({ action: "keep-running" })
    expect(cancelTurnKeys(letter("5"))).toBeUndefined()
  })
})
