// M49 Task 10 — the block viewer (spec §3.12: fullscreen modal, gutter line
// numbers, rendered/raw modes, search next/prev, scrolling, selection, copy
// through the injected adapter) + the one-active-modal input ownership rules
// (modal.ts): clipboard failures render the error and NEVER claim "Copied!",
// and hit slots exist only when the corresponding callback is present.
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { TextDiff } from "@i-harness/text-diff"
import type { TuiToolEvent } from "../src/contracts.ts"
import type { ToolPresentation } from "../src/tool-presentation/index.ts"
import { presentTool } from "../src/tool-presentation/index.ts"
import { createBlockViewer } from "../src/views/block-viewer.ts"
import { createFileViewer, ModalOwner } from "../src/views/modal.ts"
import { createEventMapState, mapSessionEvent } from "../src/backend/embedded.ts"

/** Fixture contract: a literal ToolPresentation containing one TextDiff with
 * `-old line` / `+new line` and the raw payload (the raw view's content). */
function diffPresentation(): ToolPresentation {
  const diff: TextDiff = {
    path: "a.ts",
    added: 1,
    deleted: 1,
    truncated: false,
    hunks: [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: [
        { kind: "delete", text: "old line", oldLine: 1 },
        { kind: "add", text: "new line", newLine: 1 },
      ],
    }],
  }
  return {
    title: "Edit a.ts",
    summary: "(+1/-1)",
    body: [{ kind: "diff", value: diff }],
    raw: {
      ok: true,
      path: "a.ts",
      change: diff,
      rawPatch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old line\n+new line\n",
      apiKey: "sk-block-viewer-secret",
    },
  }
}

describe("createBlockViewer — rendered/raw, search, scroll, selection, copy", () => {
  it("opens raw diff view, searches, and copies through the host adapter", async () => {
    const copied: string[] = []
    const viewer = createBlockViewer(diffPresentation(), { copy: async (text) => { copied.push(text) } })
    viewer.setRaw(true)
    viewer.search("new line")
    await viewer.copy()
    expect(copied[0]).toContain("+new line")
  })

  it("rendered mode: the diff body rows carry the +/- lines; raw toggle flips them", () => {
    const viewer = createBlockViewer(diffPresentation(), {})
    const rendered = viewer.rows().map((r) => r.text).join("\n")
    expect(rendered).toContain("Edit a.ts")
    expect(rendered).toContain("-old line")
    expect(rendered).toContain("+new line")
    viewer.setRaw(true)
    const raw = viewer.rows().map((r) => r.text).join("\n")
    expect(raw).toContain(`"rawPatch"`)
    expect(raw).toContain(`"apiKey"`) // the raw payload is the redacted JSON — fields visible
    viewer.setRaw(false)
    expect(viewer.rows().map((r) => r.text).join("\n")).toContain("-old line")
  })

  it("search counts matches; next/prev cycle through the match rows", () => {
    const viewer = createBlockViewer(diffPresentation(), {})
    // the rendered diff rows carry -old line + +new line → 2 matches
    expect(viewer.search("line")).toBe(2)
    expect(viewer.matchRow()).toBeGreaterThanOrEqual(0)
    const before = viewer.matchRow()
    viewer.searchNext()
    expect(viewer.matchRow()).not.toBe(before)
    viewer.searchNext() // wraps
    viewer.searchPrev()
    expect(viewer.matchRow()).not.toBe(before)
    viewer.search("")
    expect(viewer.matches()).toEqual([])
    expect(viewer.search("no-such-thing")).toBe(0)
    // the raw view searches the redacted JSON too (rawPatch carries both lines)
    viewer.setRaw(true)
    expect(viewer.search("rawPatch")).toBe(1)
  })

  it("scrolling: move/page clamp to the row bounds", () => {
    const viewer = createBlockViewer(diffPresentation(), {})
    viewer.move(-100)
    expect(viewer.scroll).toBe(0)
    viewer.move(100)
    expect(viewer.scroll).toBe(Math.max(0, viewer.rowCount() - viewer.visibleCount()))
    expect(viewer.scroll).toBe(0) // the rendered surface is shorter than the window
    viewer.setRaw(true)
    viewer.move(1000)
    expect(viewer.scroll).toBe(Math.max(0, viewer.rowCount() - viewer.visibleCount()))
    expect(viewer.scroll).toBeGreaterThan(0)
  })

  it("copy: the selected rows only (selection is set before copy)", async () => {
    const copied: string[] = []
    const viewer = createBlockViewer(diffPresentation(), { copy: async (text) => { copied.push(text) } })
    const del = viewer.rows().findIndex((r) => r.text === "-old line")
    viewer.setSelection(del, del)
    await viewer.copy()
    expect(copied[0]).toBe("-old line")
  })

  it("clipboard failure renders the error — never claims 'Copied!'", async () => {
    const viewer = createBlockViewer(diffPresentation(), {
      copy: async () => { throw new Error("system clipboard unavailable") },
    })
    await viewer.copy()
    expect(viewer.copyFeedback).toMatchObject({ ok: false })
    expect(viewer.copyFeedback!.text).not.toContain("Copied!")
    expect(viewer.copyFeedback!.text).toContain("system clipboard unavailable")
  })

  it("successful copy renders the 'Copied!' feedback truthfully", async () => {
    const viewer = createBlockViewer(diffPresentation(), { copy: async () => {} })
    await viewer.copy()
    expect(viewer.copyFeedback).toEqual({ ok: true, text: "Copied!" })
  })

  it("raw view never exposes an un-redacted secret key value", async () => {
    const copied: string[] = []
    const viewer = createBlockViewer(diffPresentation(), { copy: async (text) => { copied.push(text) } })
    viewer.setRaw(true)
    expect(viewer.rows().map((r) => r.text).join("\n")).not.toContain("sk-block-viewer-secret")
    await viewer.copy()
    expect(copied.join("\n")).not.toContain("sk-block-viewer-secret")
  })

  it("hit slots: the copy/close action exists ONLY when the callback is wired", () => {
    const withCopy = createBlockViewer(diffPresentation(), { copy: async () => {}, onClose: () => {} })
    expect(withCopy.slot("copy")?.action).toBeTypeOf("function")
    expect(withCopy.slot("close")?.action).toBeTypeOf("function")
    const bare = createBlockViewer(diffPresentation(), {})
    expect(bare.slot("copy")?.action).toBeUndefined()
    expect(bare.slot("close")?.action).toBeUndefined()
  })

  it("review F1: a secret-carrying RESULT is masked in the rendered text body, the copy, AND the raw view", async () => {
    // the REAL mapper choke point: the presentation `output` string is the
    // mapper's REDACTED text; the raw `result` keeps the honest payload.
    const mapped = mapSessionEvent({
      type: "tool/result",
      callId: "m1",
      // M59: a non-execute tool — execute results render their stdout stream,
      // so the JSON-envelope redaction path is the generic one.
      name: "custom_tool",
      output: { stdout: "out", token: "sc-view-1", headers: { authorization: "Bearer sc-view-2" } },
      seq: 5,
    }, createEventMapState()) as TuiToolEvent
    const copied: string[] = []
    const viewer = createBlockViewer(presentTool(mapped), { copy: async (text) => { copied.push(text) } })
    // rendered text body — the mapper's redacted output string
    const rendered = viewer.rows().map((r) => r.text).join("\n")
    expect(rendered).toContain('"token": "***"')
    expect(rendered).not.toContain("sc-view-1")
    expect(rendered).not.toContain("sc-view-2")
    // the copied payload (rerendered rows) is clean
    await viewer.copy()
    expect(copied.join("\n")).not.toContain("sc-view-1")
    // the raw view shows the masked value — never the secret
    viewer.setRaw(true)
    const raw = viewer.rows().map((r) => r.text).join("\n")
    expect(raw).toContain('"token": "***"')
    expect(raw).not.toContain("sc-view-1")
  })
})

describe("createFileViewer — the line viewer reads the REAL file with exact lines", () => {
  it("positions the cursor at the exact 1-based line and exposes the real content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ih-tui-fileviewer-"))
    const path = join(dir, "sample.txt")
    writeFileSync(path, "l1\nl2\nl3\nl4\nl5\nl6\n", "utf8")
    const viewer = await createFileViewer(path, { line: 4 })
    expect(viewer.error).toBeUndefined()
    expect(viewer.lines).toEqual(["l1", "l2", "l3", "l4", "l5", "l6"])
    expect(viewer.cursor).toBe(3) // 0-based == the exact 1-based line asked
    expect(viewer.lineAtCursor()).toBe("l4")
  })

  it("a missing file renders the honest error, never fabricated lines", async () => {
    const viewer = await createFileViewer(join(tmpdir(), "no-such-file.txt"), { line: 1 })
    expect(viewer.error).toMatch(/ENOENT|no such/i)
    expect(viewer.lines).toEqual([])
  })

  it("the file viewer copy picks the selection or the whole content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ih-tui-fileviewer-"))
    const path = join(dir, "b.txt")
    writeFileSync(path, "x\ny\nz\n", "utf8")
    const copied: string[] = []
    const viewer = await createFileViewer(path, { line: 2, copy: async (text) => { copied.push(text) } })
    viewer.setSelection(0, 1)
    await viewer.copy()
    expect(copied[0]).toBe("x\ny")
    await viewer.copyAll()
    expect(copied[1]).toBe("x\ny\nz")
  })
})

describe("ModalOwner — one active modal owns input before panes→prompt→scrollback", () => {
  it("keyed input routes to the modal while open, nothing when closed", () => {
    const owner = new ModalOwner()
    expect(owner.active()).toBe(false)
    owner.open({ kind: "block-viewer", viewer: createBlockViewer(diffPresentation(), {}) })
    expect(owner.active()).toBe(true)
    // chars start the modal's search input — never the prompt
    expect(owner.key({ code: "char", key: "a", ctrl: false, alt: false, shift: false })).toBe(true)
    // escape closes
    expect(owner.key({ code: "Esc", key: "", ctrl: false, alt: false, shift: false })).toBe(true)
    expect(owner.active()).toBe(false)
  })

  it("only one modal is open at a time — opening a second replaces the first", () => {
    const owner = new ModalOwner()
    owner.open({ kind: "block-viewer", viewer: createBlockViewer(diffPresentation(), {}) })
    owner.open({ kind: "block-viewer", viewer: createBlockViewer(diffPresentation(), {}) })
    expect(owner.active()).toBe(true)
  })
})
