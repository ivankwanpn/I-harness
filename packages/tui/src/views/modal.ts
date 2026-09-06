// @i-harness/tui — M49 Task 10: THE ONE ACTIVE MODAL/VIEWER UNION.
//
// `activeModal` is a single-owner union { block-viewer | line-viewer } — the
// app opens at most one; the ModalOwner routes ALL keyboard input to it
// BEFORE panes→prompt→scrollback (input ownership: while a modal is open the
// prompt and the scrollback do not see keys), and the renderer draws it
// fullscreen (present.ts).
//
// The LINE VIEWER reads the REAL file (node fs) and positions the cursor at
// the exact 1-based line the caller asked for; an unreadable file renders the
// honest error (never fabricated lines). The BLOCK VIEWER is the typed tool
// block surface (views/block-viewer.ts).
import { readFile } from "node:fs/promises"
import type { Kbd } from "../app/keys.ts"
import type { BlockViewerRow } from "./block-viewer.ts"
import { blockViewerKey } from "./block-viewer.ts"
import type { BlockViewerState, BlockViewerCopyFeedback } from "./block-viewer.ts"
import type { Rect } from "./agent.ts"

/* ------------------------------------------------------------------ file viewer */

export interface FileViewerOptions {
  /** 1-based line to position the cursor on (clamped). */
  line?: number
  copy?: (text: string) => void | Promise<void>
  height?: number
}

export interface FileViewerState {
  file: string
  /** The honest failure text when the file cannot be read — lines stay []. */
  error?: string
  lines: string[]
  /** 0-based cursor == the caller's 1-based line (clamped; content-based). */
  cursor: number
  scroll: number
  selection?: { a: number; b: number }
  copyFeedback?: BlockViewerCopyFeedback
  lineAtCursor(): string | undefined
  rowCount(): number
  rows(): BlockViewerRow[]
  visibleCount(): number
  move(delta: number): void
  page(delta: number): void
  setSelection(a?: number, b?: number): void
  copy(): Promise<void>
  copyAll(): Promise<void>
}

/** Read the REAL file and build the line-viewer state — exact lines, exact
 * 1-based positioning (the cursor is `line-1` clamped to the content). */
export async function createFileViewer(file: string, opts: FileViewerOptions = {}): Promise<FileViewerState> {
  const height = Math.max(4, opts.height ?? 24)
  let lines: string[] = []
  let error: string | undefined
  try {
    const text = await readFile(file, "utf8")
    // the trailing-newline boundary is dropped (a "x\ny\n" file has 2 lines);
    // an EMPTY file renders one empty row (the row exists in the editor too).
    lines = text.split("\n")
    if (lines[lines.length - 1] === "") lines = lines.slice(0, -1)
    if (text === "") lines = [""]
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const cursor0 = error === undefined && lines.length > 0
    ? Math.max(0, Math.min((opts.line ?? 1) - 1, lines.length - 1))
    : 0
  let cursor = cursor0
  let scroll = 0
  let selection: { a: number; b: number } | undefined
  let copyFeedback: BlockViewerCopyFeedback | undefined

  const rows = (): BlockViewerRow[] => {
    if (error !== undefined) {
      return [
        { text: file, style: "bold" },
        { text: `error: ${error}`, style: "accent-error" },
      ]
    }
    return lines.map((ln, i): BlockViewerRow => ({
      text: ln,
      style: i === cursor ? "bold" : "text",
    }))
  }
  const rowCount = (): number => rows().length
  const visibleCount = (): number => height
  const clamp = (): void => {
    const max = Math.max(0, rowCount() - height)
    scroll = Math.max(0, Math.min(scroll, max))
    cursor = Math.max(0, Math.min(cursor, Math.max(0, rowCount() - 1)))
  }

  const doCopy = async (text: string): Promise<void> => {
    if (opts.copy === undefined) {
      copyFeedback = { ok: false, text: "copy unavailable: no clipboard adapter" }
      return
    }
    try {
      await opts.copy(text)
      copyFeedback = { ok: true, text: "Copied!" }
    } catch (e) {
      copyFeedback = { ok: false, text: `copy failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  return {
    file,
    get error() { return error },
    get lines() { return lines },
    get cursor() { return cursor },
    get scroll() { return scroll },
    get selection() { return selection },
    get copyFeedback() { return copyFeedback },
    lineAtCursor() { return lines[cursor] },
    rowCount,
    rows,
    visibleCount,
    move(delta: number) {
      cursor += delta
      if (cursor < scroll) scroll = cursor
      else if (cursor >= scroll + height) scroll = cursor - height + 1
      clamp()
    },
    page(delta: number) {
      cursor += delta * height
      scroll += delta * height
      clamp()
    },
    setSelection(a?: number, b?: number) {
      if (a === undefined || b === undefined) { selection = undefined; return }
      const lo = Math.max(0, Math.min(a, rowCount() - 1))
      const hi = Math.max(lo, Math.min(b, rowCount() - 1))
      selection = { a: lo, b: hi }
    },
    async copy() {
      if (selection === undefined) {
        await doCopy(lines[cursor] ?? "")
        return
      }
      await doCopy(lines.slice(selection.a, selection.b + 1).join("\n"))
    },
    async copyAll() {
      await doCopy(lines.join("\n"))
    },
  }
}

/* ------------------------------------------------------------------ union + owner */

export type ActiveModal =
  | { kind: "block-viewer"; viewer: BlockViewerState }
  | { kind: "line-viewer"; view: FileViewerState }

interface ModalOwnerInit {
  /** Called when the owner closed the modal by key (Esc) — the app clears
   * `app.modal` (the owner is state-only; the app owns the state). */
  onClose?: () => void
}

/** THE one-active-modal input owner: `app.modal` is the ONLY modal; every key
 * routes here while open (panes→prompt→scrollback never see the key). */
export class ModalOwner {
  private current: ActiveModal | undefined
  private readonly onClose: (() => void) | undefined

  constructor(init: ModalOwnerInit = {}) {
    this.onClose = init.onClose
  }

  active(): boolean {
    return this.current !== undefined
  }

  modal(): ActiveModal | undefined {
    return this.current
  }

  open(modal: ActiveModal): void {
    this.current = modal
  }

  /** Idempotent close: clears the current modal and notifies the owner (the
   * app clears app.modal + repaints — key AND programmatic paths alike). */
  close(): void {
    const was = this.current
    this.current = undefined
    if (was !== undefined) this.onClose?.()
  }

  /** Key handling — returns TRUE when the modal consumed the event. */
  key(kbd: Kbd): boolean {
    const m = this.current
    if (m === undefined) return false
    if (m.kind === "block-viewer") {
      if (kbd.code === "Esc" && m.viewer.searchInput === undefined) {
        this.close()
        return true
      }
      return blockViewerKey(m.viewer, kbd)
    }
    // line viewer: navigation + copy (no raw mode)
    switch (kbd.code) {
      case "Esc": this.close(); return true
      case "Down": m.view.move(1); return true
      case "Up": m.view.move(-1); return true
      case "PageDown": m.view.page(1); return true
      case "PageUp": m.view.page(-1); return true
      default: break
    }
    // Ctrl+Q always quits (global escape hatch — block-viewer parity).
    if (kbd.code === "char" && kbd.ctrl && !kbd.alt && kbd.key === "q") return false
    if (kbd.code === "char" && !kbd.ctrl && !kbd.alt) {
      switch (kbd.key) {
        case "j": m.view.move(1); return true
        case "k": m.view.move(-1); return true
        case "y": { void m.view.copy(); return true }
        default: break
      }
    }
    // the modal is the INPUT OWNER — any other key is consumed too (Ctrl+Q
    // quits through the escape hatch above).
    return true
  }
}

/* ------------------------------------------------------------------ hit targets */

export interface ModalHitTarget {
  id: "copy" | "close"
  rect: Rect
  action?: () => void
}

/** THE modal geometry (shared by the renderer and the mouse router — no
 * drift): the copy slot sits at the footer row's right end and the close slot
 * at the header row's far right. A target is emitted ONLY when its action
 * really exists (hit areas exist only when the corresponding callback does):
 * copy needs the adapter; close goes through the owner (Esc parity).
 * `footer` label positions are documented by the renderer in present.ts. */
export function modalHitTargets(owner: ModalOwner, rect: Rect): ModalHitTarget[] {
  const modal = owner.modal()
  if (modal === undefined) return []
  const out: ModalHitTarget[] = []
  const footer = rect.y + rect.h - 1
  const copy = modal.kind === "block-viewer" ? modal.viewer.slot("copy") : undefined
  if (copy?.action !== undefined) {
    out.push({ id: "copy", rect: { x: rect.x + rect.w - 7, y: footer, w: 7, h: 1 }, action: copy.action })
  }
  out.push({ id: "close", rect: { x: rect.x + rect.w - 4, y: rect.y, w: 4, h: 1 }, action: () => owner.close() })
  return out
}
