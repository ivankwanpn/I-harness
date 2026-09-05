// G2 terminal init/teardown — pure byte-sequence generation, no I/O.
//
// initSequence enables the TUI surface in a fixed order: synchronized output
// (when capable), alt screen 1049, clear, hide cursor, bracketed paste 2004,
// mouse capture — the FIVE-mode set in crossterm's order (the sequence
// crossterm 0.28.1 `EnableMouseCapture` emits: 1000h 1002h 1003h 1015h 1006h;
// 1015 is harmless-on, we already decode 1015; 1003 = all-motion, the hover
// engine's lifeblood) — then focus events 1004 (when capable), optional cursor
// color (OSC 12, M36 stub param).
//
// teardownSequence is the canonical reset: reverse-ish, and always emitted in
// the SAME byte order regardless of cap so TeardownGuard is a pure one-shot
// flag — disabling modes that were never enabled is harmless. The mouse
// disables follow grok's canonical `RESTORE_SEQ` order (1000l 1002l 1003l
// 1015l 1006l — the xai-crash-handler terminal table), NOT crossterm's own
// reverse order; the panic/teardown path must agree with the byte stream the
// process may have crashed in, and grok's pinned table is our source of truth
// (spec §1 teardown row).
//
// TeardownGuard: the one-shot that resolves the M36 "teardown may be called
// from several paths (SIGINT handler, exit hook, error path)" duplication.
import type { TerminalCapabilityContext } from "../types.ts"

/** The five-mode mouse enable set, in crossterm 0.28.1's `EnableMouseCapture`
 * order (1000 → 1002 → 1003 → 1015 → 1006). Appended after 2004h when
 * `cap.mouse` (the SGR 1006 + any-event 1002 pair the pre-M46b surface
 * enabled is a strict subset). M46b G1: spec §1 — init 五模. */
export const MOUSE_ENABLE_SEQ = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1015h\x1b[?1006h"
/** The five-mode mouse disable set, in grok's canonical RESTORE_SEQ order
 * (1000l → 1002l → 1003l → 1015l → 1006l); the teardown emits it verbatim. */
export const MOUSE_DISABLE_SEQ = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1015l\x1b[?1006l"

export function initSequence(cap: TerminalCapabilityContext, cursorColorRgb?: string): string {
  let out = ""
  if (cap.synchronizedOutput) out += "\x1b[?2026h"
  out += "\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l"
  if (cap.bracketedPaste) out += "\x1b[?2004h"
  if (cap.mouse) out += MOUSE_ENABLE_SEQ
  if (cap.focusEvents) out += "\x1b[?1004h"
  if (cursorColorRgb !== undefined && cursorColorRgb !== "") out += `\x1b]12;rgb:${cursorColorRgb}\x07`
  return out
}

export function teardownSequence(_cap: TerminalCapabilityContext): string {
  return "\x1b[?2026l\x1b[0m\x1b[?25h" + MOUSE_DISABLE_SEQ + "\x1b[?2004l\x1b[?1004l\x1b[?1049l"
}

export class TeardownGuard {
  private readonly seq: string
  private fired = false

  constructor(seq: string) {
    this.seq = seq
  }

  /** The exact bytes pushed on the first invoke — never mutated. */
  get sequence(): string {
    return this.seq
  }

  /** One-shot: first call returns true (caller then writes `sequence`);
   * every later call returns false and nothing is written. */
  invoke(): boolean {
    if (this.fired) return false
    this.fired = true
    return true
  }

  /** Registers the one-shot with registrar callbacks (e.g. process.once("exit"), driver hooks). */
  install(registry: Array<(fn: () => void) => void>): void {
    for (const register of registry) {
      register((): void => {
        this.invoke()
      })
    }
  }
}
