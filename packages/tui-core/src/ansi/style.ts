// M36: ANSI SGR style model + minimal-diff emission (pure string emission).
// SgrState records what is currently written to the terminal, so repeated
// emits produce only changed attributes; the inverse-off path uses a full
// reset (\x1b[0m) because SGR 27 is unreliable on legacy terminals.

export type RgbOrIndex = { r: number; g: number; b: number } | { idx: number }

export interface Style {
  fg?: RgbOrIndex
  bg?: RgbOrIndex
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
  invert?: boolean
}

function colorEq(a?: RgbOrIndex, b?: RgbOrIndex): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if ("r" in a) {
    if (!("r" in b)) return false
    return a.r === b.r && a.g === b.g && a.b === b.b
  }
  return "idx" in b && a.idx === b.idx
}

export function styleEquals(a: Style, b: Style): boolean {
  return (
    colorEq(a.fg, b.fg) &&
    colorEq(a.bg, b.bg) &&
    (a.bold ?? false) === (b.bold ?? false) &&
    (a.dim ?? false) === (b.dim ?? false) &&
    (a.italic ?? false) === (b.italic ?? false) &&
    (a.underline ?? false) === (b.underline ?? false) &&
    (a.strikethrough ?? false) === (b.strikethrough ?? false) &&
    (a.invert ?? false) === (b.invert ?? false)
  )
}

export class SgrState {
  fg?: RgbOrIndex
  bg?: RgbOrIndex
  bold = false
  dim = false
  italic = false
  underline = false
  strikethrough = false
  invert = false
  /** True once any SGR sequence has been sent since the last reset. */
  emitted = false

  matches(target: Style): boolean {
    return (
      colorEq(this.fg, target.fg) &&
      colorEq(this.bg, target.bg) &&
      this.bold === (target.bold ?? false) &&
      this.dim === (target.dim ?? false) &&
      this.italic === (target.italic ?? false) &&
      this.underline === (target.underline ?? false) &&
      this.strikethrough === (target.strikethrough ?? false) &&
      this.invert === (target.invert ?? false)
    )
  }

  set(target: Style): void {
    this.fg = target.fg
    this.bg = target.bg
    this.bold = target.bold ?? false
    this.dim = target.dim ?? false
    this.italic = target.italic ?? false
    this.underline = target.underline ?? false
    this.strikethrough = target.strikethrough ?? false
    this.invert = target.invert ?? false
  }

  reset(): void {
    this.fg = undefined
    this.bg = undefined
    this.bold = false
    this.dim = false
    this.italic = false
    this.underline = false
    this.strikethrough = false
    this.invert = false
    this.emitted = false
  }
}

const fgCode = (c: RgbOrIndex): string =>
  "r" in c
    ? `38;2;${c.r};${c.g};${c.b}`
    : c.idx < 16
      ? c.idx < 8
        ? `3${c.idx}`
        : `9${c.idx - 8}`
      : `38;5;${c.idx}`

const bgCode = (c: RgbOrIndex): string =>
  "r" in c
    ? `48;2;${c.r};${c.g};${c.b}`
    : c.idx < 16
      ? c.idx < 8
        ? `4${c.idx}`
        : `10${c.idx - 8}`
      : `48;5;${c.idx}`

const hasStyle = (t: Style): boolean =>
  t.fg !== undefined ||
  t.bg !== undefined ||
  t.bold === true ||
  t.dim === true ||
  t.italic === true ||
  t.underline === true ||
  t.strikethrough === true ||
  t.invert === true

/** Full SGR reset sequence. */
export function emitReset(): string {
  return "\x1b[0m"
}

/** Minimal SGR transition from `state` (mutated in place) to `target`. */
export function emitSgrChange(state: SgrState, target: Style): string {
  if (state.matches(target)) return ""
  const seq: string[] = []
  const targetInvert = target.invert ?? false

  // Turning inverse OFF is the "wrong ordering" case: a full reset + full
  // re-apply is deterministic, and works around dodgy SGR 27 on ConHost.
  if (state.emitted && state.invert && !targetInvert) {
    seq.push("\x1b[0m")
    if (target.fg !== undefined) seq.push(`\x1b[${fgCode(target.fg)}m`)
    if (target.bg !== undefined) seq.push(`\x1b[${bgCode(target.bg)}m`)
    if (target.bold === true) seq.push("\x1b[1m")
    if (target.dim === true) seq.push("\x1b[2m")
    if (target.italic === true) seq.push("\x1b[3m")
    if (target.underline === true) seq.push("\x1b[4m")
    if (target.strikethrough === true) seq.push("\x1b[9m")
    state.set(target)
    state.emitted = hasStyle(target)
    return seq.join("")
  }

  if (state.invert !== targetInvert) seq.push(state.invert ? "\x1b[27m" : "\x1b[7m")
  // SGR 22 clears bold AND dim — emit bold before dim so a shared off repairs.
  if (state.bold !== (target.bold ?? false)) seq.push(state.bold ? "\x1b[22m" : "\x1b[1m")
  if (state.dim !== (target.dim ?? false)) seq.push(state.dim ? "\x1b[22m" : "\x1b[2m")
  if (state.italic !== (target.italic ?? false)) seq.push(state.italic ? "\x1b[23m" : "\x1b[3m")
  if (state.underline !== (target.underline ?? false)) seq.push(state.underline ? "\x1b[24m" : "\x1b[4m")
  if (state.strikethrough !== (target.strikethrough ?? false)) seq.push(state.strikethrough ? "\x1b[29m" : "\x1b[9m")
  if (!colorEq(state.fg, target.fg)) {
    if (target.fg !== undefined) seq.push(`\x1b[${fgCode(target.fg)}m`)
    else seq.push("\x1b[39m")
  }
  if (!colorEq(state.bg, target.bg)) {
    if (target.bg !== undefined) seq.push(`\x1b[${bgCode(target.bg)}m`)
    else seq.push("\x1b[49m")
  }
  state.set(target)
  state.emitted = true
  return seq.join("")
}
