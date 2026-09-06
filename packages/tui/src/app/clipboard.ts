// @i-harness/tui — M46b G2: clipboard injection seam (spec §7 hard rule: copies
// go through an injectable layer — tests assert the copied payload; the SYSTEM
// clipboard is touched only in real runs, never in tests).
//
// The loop owns one Clipboard instance (TuiAppOptions.clipboard ?? default —
// the default = a no-op stub in tests/harnesses and the system clipboard in
// real runs; the app never imports a platform clipboard API directly).
//
// M49 Task 10: the CHECKED copy — `copyChecked` returns the real verdict so
// the UI can render the failure (never a claim of "Copied!" the clipboard did
// not earn). Adapters that cannot fail keep the plain `copy` (checkedCopy
// reports ok for them).

/** The injection seam: `copy(text)` → the payload leaves the app here. */
export interface Clipboard {
  copy(text: string): void
  /** M49 Task 10: the checked copy verdict — ok ONLY when the payload truly
   * left through the platform; anything else is the honest error. Absent ⇒
   * checkedCopy reports ok (single-shot adapters cannot fail). */
  copyChecked?(text: string): Promise<CopyResult>
}

export type CopyResult = { ok: true } | { ok: false; error: string }

/** Zero-side-effect default — used wherever a clipboard is optional (tests,
 * harnesses, hosts without system clipboard access). */
export class NoopClipboard implements Clipboard {
  copy(_text: string): void {
    // deliberate no-op — the payload is dropped (never throw, never print)
  }

  async copyChecked(text: string): Promise<CopyResult> {
    this.copy(text)
    return { ok: true }
  }
}

/** System clipboard (real runs): navigator.clipboard when available, else the
 * best-effort legacy `document.execCommand` path — both absent in tests, so
 * the honest verdict is the error (the UI renders it — never the fake copy). */
export class SystemClipboard implements Clipboard {
  copy(text: string): void {
    // legacy fire-and-forget callers keep working; the CHECKED verdict is the
    // newer path the modal viewer uses.
    void this.copyChecked(text)
  }

  async copyChecked(text: string): Promise<CopyResult> {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(text)
        return { ok: true }
      }
      // legacy execCommand path — the classic hidden-textarea copy.
      if (typeof document === "undefined" || typeof document.execCommand !== "function") {
        return { ok: false, error: "clipboard unavailable: no platform clipboard (navigator.clipboard missing)" }
      }
      const textarea = document.createElement("textarea")
      textarea.value = text
      textarea.setAttribute("readonly", "")
      textarea.style.position = "absolute"
      textarea.style.left = "-9999px"
      document.body.appendChild(textarea)
      const ok = document.execCommand("copy")
      textarea.remove()
      if (!ok) return { ok: false, error: "clipboard unavailable: execCommand copy rejected" }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** The default instance real hosts get (TuiApp constructor fallback). */
export const defaultClipboard = (): Clipboard => new SystemClipboard()

/** The checked wrapper: resolves the verdict through copyChecked when the
 * adapter has it; otherwise fire the plain copy and report ok. */
export async function checkedCopy(clipboard: Clipboard, text: string): Promise<CopyResult> {
  if (clipboard.copyChecked !== undefined) return clipboard.copyChecked(text)
  clipboard.copy(text)
  return { ok: true }
}
