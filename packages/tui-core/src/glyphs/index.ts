// M36: visual constant table — 1:1 from docs/research/2026-09-03-tui-grok-ui-spec.md §6.
// makeGlyphs(fancy=false) yields the legacy fallbacks (exact pairs per spec §6);
// GLYPHS is the frozen fancy default with no side effects.

export interface GlyphSet {
  promptArrow: string
  recordDotFilled: string
  recordDotEmpty: string
  collapsedAccent: string
  ballotX: string
  checkMark: string
  enlarge: string
  copyIcon: string
  tokenArrow: string
  monitorFrames: readonly string[]
  diamonds: readonly string[]
  accentBar: string
  timelineUp: string
  timelineDown: string
  timelineBold: string
  timelineThin: string
  filledDot: string
  selectionBar: string
  chevronRight: string
  chevronLeft: string
  chevronDown: string
  disclosureOpen: string
  disclosureClosed: string
  buttonClose: string
  buttonEnlarge: string
  brailleSpinner: readonly string[]
  dotSpinner: readonly string[]
  progressBlocks: readonly string[]
  todoPending: string
  todoInProgress: string
  todoDone: string
  todoCancelled: string
}

export function makeGlyphs(fancy: boolean): GlyphSet {
  const g = fancy
  return {
    promptArrow: g ? "❯ " : "> ",
    recordDotFilled: g ? "◉" : "*",
    recordDotEmpty: g ? "◎" : "o",
    collapsedAccent: g ? "❙" : "|",
    ballotX: g ? "✗" : "x",
    checkMark: g ? "✓" : "√",
    enlarge: g ? "↗" : "o",
    copyIcon: g ? "⧉" : "c",
    tokenArrow: g ? "⇣" : "↓",
    monitorFrames: g ? ["○", "◎", "◉", "◎"] : ["·", "○", "•", "○"],
    diamonds: g ? ["◆", "◇", "◈"] : ["♦", "○", "♦"],
    accentBar: g ? "┃" : "│",
    timelineUp: g ? "▴" : "▲",
    timelineDown: g ? "▾" : "▼",
    timelineBold: g ? "━━" : "══",
    timelineThin: g ? "──" : "─",
    filledDot: g ? "●" : "•",
    selectionBar: g ? "▏" : "│",
    chevronRight: g ? "›" : ">",
    chevronLeft: g ? "‹" : "<",
    chevronDown: g ? "⌄" : "v",
    disclosureOpen: g ? "▾" : "v",
    disclosureClosed: g ? "▸" : ">",
    buttonClose: g ? "[✗]" : "[x]",
    buttonEnlarge: g ? "[↗]" : "[o]",
    brailleSpinner: g
      ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"]
      : ["|", "/", "-", "\\"],
    dotSpinner: g ? ["⋅", " :", "⸬", "⁙"] : [" ", ".", "·", ":"],
    progressBlocks: ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"],
    todoPending: "□",
    todoInProgress: "▶",
    todoDone: "✓",
    todoCancelled: "✗",
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const v = value as Record<string, unknown>
    for (const key of Object.keys(v)) deepFreeze(v[key])
    return Object.freeze(value) as T
  }
  return value
}

/** Frozen fancy glyph set (default theme). */
export const GLYPHS: GlyphSet = deepFreeze(makeGlyphs(true))
