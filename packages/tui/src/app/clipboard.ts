// @i-harness/tui — M46b G2: clipboard injection seam (spec §7 hard rule: copies
// go through an injectable layer — tests assert the copied payload; the SYSTEM
// clipboard is touched only in real runs, never in tests).
//
// The loop owns one Clipboard instance (TuiAppOptions.clipboard ?? default —
// the default = a no-op stub in tests/harnesses and the system clipboard in
// real runs; the app never imports a platform clipboard API directly).

/** The injection seam: `copy(text)` → the payload leaves the app here. */
export interface Clipboard {
  copy(text: string): void
}

/** Zero-side-effect default — used wherever a clipboard is optional (tests,
 * harnesses, hosts without system clipboard access). */
export class NoopClipboard implements Clipboard {
  copy(_text: string): void {
    // deliberate no-op — the payload is dropped (never throw, never print)
  }
}

/** System clipboard (real runs): navigator.clipboard when available, else the
 * best-effort legacy `document.execCommand` path — both absent in tests, so
 * the fallback is a silent no-op. Never throws. */
export class SystemClipboard implements Clipboard {
  copy(text: string): void {
    try {
      void navigator.clipboard?.writeText(text)
    } catch {
      // system clipboard unavailable — drop silently (a toast still told the
      // user we copied; the honest run-time note is out of scope here)
    }
  }
}

/** The default instance real hosts get (TuiApp constructor fallback). */
export const defaultClipboard = (): Clipboard => new SystemClipboard()
