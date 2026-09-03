// @i-harness/tui — G1 (M37b): Permission modal renderer (UI spec §3.7).
// Borderless bg_light band + `┃` accent rail; bold title (bash command /
// "Allow Edit?"); detail soft-wrapped plain (quote-aware coloring is M38's
// line-viewer business — keep simple); option rows `{n} ({●|○}) {label}` with
// labels `Always allow: {scope}` / `Never allow: {scope}` / `Yes, proceed` /
// `No, I trust it` / RejectOnce freeform `{n} (○) No, reject (type to add
// feedback)` — `{n} (●) ❯ {preview}` once text is typed; `Use ← → to choose
// permission scope` footer when more than one scope; `... Ctrl-F to expand`
// hint at the bottom of an over-long detail (the modal chrome is bg_light +
// accent rail per spec §5: `bg_light rect band` + `┃` accent rail).

import type { GlyphSet, Palette } from "@i-harness/tui-core"
import type { Rect, Style, ViewDraw } from "./agent.ts"
import { strWidth } from "./status.ts"
import { wrapPrompt } from "./prompt.ts"

// ------------------------------------------------------------------ surface

export interface PermissionSurface {
  id: string
  kind: "bash" | "edit" | "mcp" | "other"
  title: string
  detail?: string
  /** true → the RejectOnce freeform row (`No, reject (type to add feedback)`)
   * is shown; the rejection feedback is typed into it. */
  freeform: boolean
  /** Permission scopes for the Always/Never rows; `← →` cycles them. */
  scopes: string[]
}

export interface PermissionState {
  /** 0-based cursor (row index into the visible option rows). */
  cursor: number
  /** 0-based scope index (cycled by ← →; the host clamps to scopes.length). */
  scopeIndex: number
  /** RejectOnce freeform text (non-empty → the row flips to `❯ {preview}`). */
  freeformText: string
}

// ------------------------------------------------------------------ keys

/** Structural mirror of src/app/keys.ts Kbd (same group rule: views never
 * import from app/; the shape is the interop surface). */
export interface KeyLike {
  code: string
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
}

export type PermissionKeyAction =
  | "select"           // 1-9 or Enter — choose the row at cursor/index
  | "scope-left"       // ←
  | "scope-right"      // →
  | "expand"           // Ctrl-F
  | "always-approve"   // Ctrl-O
  | "cancel"           // Ctrl-C
  | "cursor-up"        // k / j-down (the host clamps cursor)
  | "cursor-down"      // j (the host clamps cursor)

export type PermissionKey = { action: PermissionKeyAction; index?: number }

/** Spec §4 Permission keys: `1`-`9`, j/k, Enter, ←/→, Ctrl-F, Ctrl-O, Ctrl-C.
 * 1-9 → select with the (1-based) index; Enter → select at cursor; j/k →
 * cursor -1/+1 (the host clamps); ←/→ → scope; Ctrl-F → expand; Ctrl-O →
 * always-approve; Ctrl-C → cancel. Returns undefined for unbound keys. */
export function permissionKeys(ev: KeyLike): PermissionKey | undefined {
  if (ev.ctrl && !ev.alt && !ev.shift) {
    switch (ev.key) {
      case "f": return { action: "expand" }
      case "o": return { action: "always-approve" }
      case "c": return { action: "cancel" }
      default: return undefined
    }
  }
  if (ev.ctrl || ev.alt) return undefined
  switch (ev.code) {
    case "Enter": return { action: "select" }
    case "Left": return { action: "scope-left" }
    case "Right": return { action: "scope-right" }
  }
  if (ev.code !== "char") return undefined
  switch (ev.key) {
    case "j": return { action: "cursor-down" }
    case "k": return { action: "cursor-up" }
  }
  if (ev.key.length === 1 && ev.key >= "1" && ev.key <= "9") {
    return { action: "select", index: Number(ev.key) - 1 }
  }
  return undefined
}

// ------------------------------------------------------------------ rows

export interface PermissionRow {
  key: string
  label: string
}

/** The visible option rows (spec §3.7). The RejectOnce freeform row carries
 * the typed preview (truncated to 40 cols per spec) when text is present. */
export function permissionRows(
  surf: PermissionSurface,
  state: PermissionState,
  glyphs: GlyphSet,
): PermissionRow[] {
  const n = surf.scopes.length
  const scope = surf.scopes[n > 0 ? state.scopeIndex % n : 0] ?? ""
  const always = n > 0 ? `Always allow: ${scope}` : "Always allow"
  const never = n > 0 ? `Never allow: ${scope}` : "Never allow"
  const rows: PermissionRow[] = [
    { key: "1", label: always },
    { key: "2", label: never },
    { key: "3", label: "Yes, proceed" },
    { key: "4", label: "No, I trust it" },
  ]
  if (surf.freeform) {
    const text = state.freeformText
    rows.push(text.length > 0
      ? { key: "5", label: `${glyphs.promptArrow.trimEnd()} ${truncateWidth(text, 40)}` }
      : { key: "5", label: "No, reject (type to add feedback)" })
  }
  return rows
}

/** Column-width truncate at the START (keeps the head, appends nothing). */
function truncateWidth(s: string, width: number): string {
  let out = ""
  let w = 0
  for (const ch of s) {
    const cw = strWidth(ch)
    if (w + cw > width) break
    out += ch
    w += cw
  }
  return out
}

// ------------------------------------------------------------------ render

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const v = hex.startsWith("#") ? hex.slice(1) : hex
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  }
}

export const PERMISSION_SCOPE_HINT = "Use ← → to choose permission scope"
export const PERMISSION_EXPAND_HINT = "... Ctrl-F to expand"

/**
 * Draw the permission modal (spec §3.7) into `ctx` via the ViewDraw surface.
 * Layout: title (bold) → wrapped detail (plain, quote-aware syntax coloring
 * deliberately not attempted) → option rows → footer scope hint at the last
 * row. The whole band is bg_light; the cursor row is bg_visual; the left
 * accent rail `┃` is accent_user for the band height. The Ctrl-F expand hint
 * replaces the trailing part of the detail when it is longer than the box.
 */
export function renderPermission(
  ctx: Rect,
  surf: PermissionSurface,
  state: PermissionState,
  draw: ViewDraw,
  palette: Palette,
  glyphs: GlyphSet,
): void {
  const x0 = ctx.x
  const x1 = ctx.x + ctx.w - 1
  const y0 = ctx.y
  const y1 = ctx.y + ctx.h - 1
  const contentX = x0 + 2 // rail (1) + pad (1)
  const contentW = Math.max(1, ctx.w - 3) // two left columns + 1 right pad
  const limitX = x1

  const bgLight = hexToRgb(palette.bgLight)
  const bgVisual = hexToRgb(palette.bgVisual)
  const band = (rowBg: { r: number; g: number; b: number }): Style => ({ bg: rowBg })
  const withBg = (style: Style, hover: boolean): Style => ({ ...style, bg: hover ? bgVisual : bgLight })

  // Band fill + accent rail (cursor-row bg override happens at row level).
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) draw.cell(x, y, { text: " ", style: band(bgLight), width: 1, continuation: false })
    draw.cell(x0, y, { text: glyphs.accentBar, style: draw.color(palette.accentUser), width: 1, continuation: false })
  }

  const rows = permissionRows(surf, state, glyphs)
  const hasScopeHint = surf.scopes.length > 1
  const footerH = hasScopeHint ? 1 : 0

  // Title row.
  draw.text(contentX, y0, surf.title, withBg(draw.color(palette.textPrimary, { bold: true }), false), limitX)
  let y = y0 + 1

  // Detail rows (soft-wrapped plain); if the wrapped text is longer than the
  // box, cap it and pin the Ctrl-F expand hint at the end of the last row.
  const detailMax = Math.max(0, y1 - y - rows.length - footerH - 1) // -1: gap row
  if (surf.detail !== undefined && surf.detail.length > 0 && detailMax > 0) {
    const lines = wrapPrompt(surf.detail, contentW)
    const capped = lines.length > detailMax
    const shown = capped ? lines.slice(0, detailMax) : lines
    for (let i = 0; i < shown.length && y < y1; i++, y++) {
      let line = shown[i]!
      if (capped && i === shown.length - 1) line = PERMISSION_EXPAND_HINT
      draw.text(contentX, y, line, withBg(draw.color(palette.textPrimary), false), limitX)
    }
  }

  // Gap row where space allows.
  if (y < y1 - rows.length - footerH) y++

  // Option rows (skip rows that cannot fit; the host sizes the rect).
  for (const row of rows) {
    if (y > y1 - footerH) break
    const isCursor = Number(row.key) - 1 === state.cursor
    const marker = isCursor ? glyphs.filledDot : "○"
    const rowStyle = withBg(draw.color(palette.textPrimary), isCursor)
    const keyStyle = withBg(draw.color(palette.accentUser, { bold: true }), isCursor)
    let rx = contentX
    rx = draw.text(rx, y, `${row.key} (${marker}) `, keyStyle, limitX)
    draw.text(rx, y, row.label, rowStyle, limitX)
    y++
  }

  // Footer scope hint (bottom row; dim).
  if (hasScopeHint && y1 >= y0) {
    draw.text(contentX, y1, PERMISSION_SCOPE_HINT, withBg(draw.color(palette.grayDim), false), limitX)
  }
}
