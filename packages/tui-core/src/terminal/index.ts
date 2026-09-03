// G2 terminal init/teardown — pure byte-sequence generation, no I/O.
//
// initSequence enables the TUI surface in a fixed order: synchronized output
// (when capable), alt screen 1049, clear, hide cursor, bracketed paste 2004,
// SGR mouse 1006+any-event 1002 (when capable), focus events 1004 (when
// capable), optional cursor color (OSC 12, M36 stub param).
//
// teardownSequence is the canonical reset: reverse-ish, and always emitted in
// the SAME byte order regardless of cap so TeardownGuard is a pure one-shot
// flag — disabling modes that were never enabled is harmless.
//
// TeardownGuard: the one-shot that resolves the M36 "teardown may be called
// from several paths (SIGINT handler, exit hook, error path)" duplication.
import type { TerminalCapabilityContext } from "../types.ts"

export function initSequence(cap: TerminalCapabilityContext, cursorColorRgb?: string): string {
  let out = ""
  if (cap.synchronizedOutput) out += "\x1b[?2026h"
  out += "\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l"
  if (cap.bracketedPaste) out += "\x1b[?2004h"
  if (cap.mouse) out += "\x1b[?1006h\x1b[?1002h"
  if (cap.focusEvents) out += "\x1b[?1004h"
  if (cursorColorRgb !== undefined && cursorColorRgb !== "") out += `\x1b]12;rgb:${cursorColorRgb}\x07`
  return out
}

export function teardownSequence(_cap: TerminalCapabilityContext): string {
  return "\x1b[?2026l\x1b[0m\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?25h\x1b[?1002l\x1b[?1049l"
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
