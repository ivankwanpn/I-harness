// M36 G3: host app for case-010 — spawned as the child of a REAL pty (node-pty).
//
// Deterministic byte script (no live probe, no DOM; every stdout byte goes
// through writeSync so ordering with the marker files below is total):
//
//   t≈0     initSequence → draw frame1 at argv[3] (default 40x12) → flush → write
//           → marker "frame-flushed"
//   t=2500  marker "idle-end" → re-render SAME frame at argv[4] (default 30x8)
//           → write → marker "frame-flushed-2"
//   +1200   marker "idle-end-2"          (no bytes written in [frame-flushed-2, idle-end-2])
//   +700    teardownSequence → write → marker "teardown-wrote" → exit(0)
//
// The fixed-tick re-render (NOT SIGWINCH) is the deterministic resize carrier:
// the test resizes the pty before the host's 2.5s tick; a resize event may be
// observed (marker "resize-fired") but must NEVER trigger rendering itself —
// an early render would break the zero-byte idle windows this case proves.
//
// Errors: any throw → best-effort marker "host-failed" + message → exit 3.

import { execSync } from "node:child_process"
import { writeFileSync, writeSync, mkdirSync } from "node:fs"
import { DiffBuffer } from "../../src/grid/index.ts"
import type { CellBuffer } from "../../src/grid/index.ts"
import { makeGlyphs } from "../../src/glyphs/index.ts"
import type { GlyphSet } from "../../src/glyphs/index.ts"
import { clusterWidth } from "../../src/wcwidth/index.ts"
import { SgrState } from "../../src/ansi/style.ts"
import type { Style } from "../../src/ansi/style.ts"
import { CursorTracker, flushRuns } from "../../src/render/index.ts"
import { initSequence, teardownSequence } from "../../src/terminal/index.ts"
import { createUnknownCapabilities } from "../../src/types.ts"
import type { TerminalCapabilityContext } from "../../src/types.ts"
import { hexToRgb, quantizeColor, resolvePalette } from "../../src/theme/index.ts"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function parseSize(raw?: string): { cols: number; rows: number } {
  const m = /^(\d+)x(\d+)$/.exec(raw ?? "")
  if (!m) return { cols: 40, rows: 12 }
  return { cols: Number(m[1]), rows: Number(m[2]) }
}

const MARKER_DIR = process.argv[2] ?? ""
const size1 = parseSize(process.argv[3])
const size2 = parseSize(process.argv[4])

function marker(name: string): void {
  mkdirSync(MARKER_DIR, { recursive: true })
  writeFileSync(`${MARKER_DIR}/${name}`, `${Date.now()}`)
}

let epipe = false

/** writeSync wrapper: EPIPE on a dead pty is swallowed (no throw, no teardown
 * promise — the pty is gone anyway); any other error rethrows. */
function out(s: string): void {
  if (epipe) return
  try {
    writeSync(1, s)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "EPIPE") epipe = true
    else throw e
  }
}

/** Fixed capabilities — no live probe (ConPTY replies are not parsed by us). */
const cap: TerminalCapabilityContext = {
  ...createUnknownCapabilities(),
  colorLevel: "truecolor",
  dark: true,
  synchronizedOutput: false,
  mouse: true,
  bracketedPaste: true,
  focusEvents: true,
  brand: "WindowsTerminal",
  legacyConsole: false,
}

/** Draw the tiny grok-layout slice: status row, one content row, a prompt row. */
function draw(page: CellBuffer, g: GlyphSet): void {
  const pal = resolvePalette(cap)
  // Quantizer: truecolor passthrough (cap.level = "truecolor").
  const q = (hex: string) => quantizeColor(hexToRgb(hex), cap)
  // A tiny O(n) mini-setter: a string of chars is laid out left→right using
  // tui-core's clusterWidth, width-2 graphemes get their continuation cell.
  const set = (y: number, text: string, style: Style): void => {
    let x = 0
    for (const ch of text) {
      const w = clusterWidth(ch)
      page.put(x, y, { text: ch, style, width: w, continuation: false })
      x += w
    }
  }

  set(0, " branch  ~/path", { fg: q(pal.textSecondary) })
  // content row: "hello" + a wide-char pair (exercises width-2 continuation)
  set(1, "hello 世界", { fg: q(pal.textPrimary), bold: true })
  set(2, g.promptArrow + "Build anything", { fg: q(pal.accentUser) })
}

let lastCursorX = 0
let lastCursorY = 0

function renderAt(cols: number, rows: number): void {
  const g = makeGlyphs(true)
  const db = new DiffBuffer(cols, rows)
  const grid = db.front // the DISPLAYED buffer — flushRuns reads it
  // presenter() is the draw target (back); after commit() the front object
  // carries the new frame and the presenter keeps its identity as the
  // previous frame (zero-byte idle: redrawing identical content diff 0).
  const page = db.presenter()
  draw(page, g)
  const frame = db.commit()
  // Cursor carryover: the console's real cursor is wherever the PREVIOUS
  // flush left it (and ConPTY may repaint around it) — seeding the tracker
  // with the previous end position forces a leading CUP on every frame
  // (no frame may assume the cursor is at (0,0)).
  const cursor = new CursorTracker(cols, lastCursorX, lastCursorY)
  out(flushRuns(frame, grid, { sync: false, sgr: new SgrState(), cap, cursor }))
  lastCursorX = cursor.x
  lastCursorY = cursor.y
}

async function main(): Promise<void> {
  // Optional SIGWINCH observation: never triggers a render (see header).
  process.stdout.on("resize", () => {
    try {
      marker("resize-fired")
    } catch {
      /* marker already written / dir gone — non-fatal */
    }
  })

  // REAL-WORLD Windows fix: ConPTY's hidden conhost converts the wire stream
  // with the console output codepage (here: 950/Big5) unless the console is
  // switched to UTF-8 — multibyte cell text (世界) would be mangled. chcp
  // flips the console attached to this process; its own stdout is redirected
  // so no answer bytes reach the pty.
  execSync("chcp.com 65001>NUL", { stdio: "ignore" })

  out(initSequence(cap))
  renderAt(size1.cols, size1.rows)
  marker("frame-flushed")

  await sleep(2500)
  marker("idle-end")
  renderAt(size2.cols, size2.rows)
  marker("frame-flushed-2")

  await sleep(1200)
  marker("idle-end-2")

  await sleep(700)
  out(teardownSequence(cap))
  marker("teardown-wrote")
  process.exit(0)
}

main().catch((e: unknown) => {
  try {
    marker("host-failed")
    writeFileSync(`${MARKER_DIR}/host-failed-message`, String(e))
  } catch {
    /* nothing more to report */
  }
  process.exit(3)
})
