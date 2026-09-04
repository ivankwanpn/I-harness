// M37a G4 (adapted from packages/tui-core/test/harness/referee.ts — M36 G3):
// minimal YAML scene executor — runs a declarative scenario against the real
// pty (runner.ts) + the real VT parser (virtual.ts).
//
// Determinism: marker files (fs) and pty byte delivery are two independent
// channels with no ordering guarantee. Zero-byte idle is proven by
// `assert-byte-budget` — host-side cumulative byte/write ledgers vs the
// pty-facing numbers — because COUNTS are invariant under pty delivery
// chunking; TIME-WINDOW sampling (`assert-idle-bytes`) stays available but is
// flaky on Windows where ConPTY's delivery chunk gaps span seconds (M37a
// empirical finding: 3-byte and 166-byte "idle-window" hits that the strict
// budget check exonerated). Prefer budgets; keep windows only as smoke.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { awaitMarker } from "./runner.ts"
import type { HostPty } from "./runner.ts"
import type { VirtualTerminal } from "./virtual.ts"

export interface Scene {
  name: string
  host: string
  size: [number, number]
  steps: Array<Record<string, unknown>>
}

export interface SceneResult {
  ok: boolean
  error?: string
}

export interface SceneCtx {
  runner: HostPty
  virtual: VirtualTerminal
  markerDir: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Escape decoder for `write-pty` data strings. The YAML DOUBLE-QUOTED form
 * (`data: "\x1b"`) arrives already decoded — pass-through; the LITERAL form
 * (single quotes) arrives with backslash sequences — decode `\xNN` hex and
 * the `\r` `\n` `\t` `\\` letter escapes here. */
function decodePtyEscapes(s: string): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (c !== "\\" || i + 1 >= s.length) {
      out += c
      continue
    }
    const n = s[i + 1]!
    if (n === "r") { out += "\r"; i++; continue }
    if (n === "n") { out += "\n"; i++; continue }
    if (n === "t") { out += "\t"; i++; continue }
    if (n === "\\") { out += "\\"; i++; continue }
    const hex = s.slice(i + 2, i + 4)
    if (n === "x" && /^[0-9a-fA-F]{2}$/.test(hex)) {
      out += String.fromCharCode(parseInt(hex, 16))
      i += 3
      continue
    }
    out += c
  }
  return out
}

/** Wait until NO pty data event has arrived for `ms` (bail after ms+15s). */
async function awaitQuiescent(runner: HostPty, ms: number): Promise<void> {
  let last = Date.now()
  const unsub = runner.onData(() => {
    last = Date.now()
  })
  try {
    const bail = Date.now() + ms + 15000
    for (;;) {
      if (Date.now() - last >= ms) return
      if (Date.now() >= bail) {
        throw new Error(`pty never quiescent: no ${ms}ms silence within ${ms + 15000}ms`)
      }
      await sleep(25)
    }
  } finally {
    unsub()
  }
}

function assertRowsMatch(virtual: VirtualTerminal, expected: string[], startRow: number): string[] {
  const errors: string[] = []
  for (let i = 0; i < expected.length; i++) {
    const y = startRow + i
    const actual = virtual.rowText(y)
    // Right-trimmed compare: terminals pad lines to the grid width — xterm's
    // translateToString keeps SPACE cells (only truly blank cells trim), and
    // the renderer's post-resize full-paint writes trailing spaces (the
    // diff path does not). Cell CONTENT is what these screens pin.
    if (actual.trimEnd() !== expected[i].trimEnd()) {
      errors.push(`row ${y}: expected ${JSON.stringify(expected[i])} got ${JSON.stringify(actual)}`)
    }
  }
  return errors
}

/** Per-spec cell color checks on the virtual terminal. Each spec: row/col
 * (0-based) + any of the optional fg/bg/bold/text keys. */
function cellColorErrors(
  virtual: VirtualTerminal,
  specs: Array<Record<string, unknown>>,
): string[] {
  const errors: string[] = []
  for (const spec of specs) {
    const y = Number(spec["row"])
    const x = Number(spec["col"])
    if (!Number.isInteger(y) || !Number.isInteger(x)) {
      errors.push(`invalid spec row=${y} col=${x}`)
      continue
    }
    const got = virtual.cellColor(y, x)
    if (got === undefined) {
      errors.push(`row ${y} col ${x}: no cell`)
      continue
    }
    if (spec["text"] !== undefined) {
      // Text anchored at the cell's column: concatenate head-cell chars
      // (continuation cells of width-2 glyphs contribute nothing). Enough
      // columns for the expected text + room for a width-2 grapheme.
      const want = String(spec["text"])
      const row = virtual.getRow(y)
      let seen = ""
      let limit = x + want.length * 2 + 1
      for (let cx = x; cx < limit && cx < virtual.cols; cx++) {
        if (row.cells[cx].text !== "") seen += row.cells[cx].text
        if (seen.length >= want.length) break
      }
      if (seen !== want) {
        errors.push(`row ${y} col ${x}: text expected ${JSON.stringify(want)} got ${JSON.stringify(seen)}`)
      }
    }
    if (spec["fg"] !== undefined && got.fg !== String(spec["fg"])) {
      errors.push(`row ${y} col ${x}: fg expected ${spec["fg"]} got ${got.fg}`)
    }
    if (spec["bg"] !== undefined && got.bg !== String(spec["bg"])) {
      errors.push(`row ${y} col ${x}: bg expected ${spec["bg"]} got ${got.bg}`)
    }
    if (spec["bold"] !== undefined && got.bold !== (spec["bold"] === true)) {
      errors.push(`row ${y} col ${x}: bold expected ${spec["bold"] === true} got ${got.bold}`)
    }
  }
  return errors
}

/** Walk every row: widths must exactly sum to cols, width-2 heads must be
 * followed by a continuation (width 0, empty text), no orphan continuations,
 * and no control chars inside cell text. */
function glyphIntegrityErrors(virtual: VirtualTerminal): string[] {
  const errors: string[] = []
  const cols = virtual.cols
  for (let y = 0; y < virtual.rows; y++) {
    const widths = virtual.cellWidths(y)
    const row = virtual.getRow(y)
    let sum = 0
    for (let x = 0; x < cols; x++) {
      const w = widths[x]
      const text = row.cells[x].text
      sum += w
      if (/[\x00-\x1f\x7f\x9b-\x9f]/.test(text)) {
        errors.push(`row ${y} col ${x}: control byte in cell text ${JSON.stringify(text)}`)
      }
      if (w === 2) {
        if (x + 1 >= cols) {
          errors.push(`row ${y} col ${x}: width-2 cell at last column (no continuation slot)`)
        } else if (widths[x + 1] !== 0 || row.cells[x + 1].text !== "") {
          errors.push(`row ${y} col ${x}: width-2 cell followed by non-continuation cell`)
        }
      } else if (w === 0) {
        if (x === 0 || widths[x - 1] !== 2) {
          errors.push(`row ${y} col ${x}: orphan continuation (width 0, no width-2 head at x-1)`)
        }
      } else if (w > 2 || w < 0) {
        errors.push(`row ${y} col ${x}: unexpected cell width ${w}`)
      }
    }
    if (sum !== cols) {
      errors.push(`row ${y}: sum(widths)=${sum} !== cols=${cols}`)
    }
  }
  return errors
}

export async function runScenario(scene: Scene, ctx: SceneCtx): Promise<SceneResult> {
  const { runner, virtual, markerDir } = ctx

  for (let i = 0; i < scene.steps.length; i++) {
    const step = scene.steps[i]
    const names = Object.keys(step)
    if (names.length !== 1) {
      return { ok: false, error: `step ${i}: expected exactly one action key, got ${names.join(",")}` }
    }
    const name = names[0]
    const args = step[name] as Record<string, unknown>

    try {
      switch (name) {
        case "await-marker": {
          const m = String(args["name"] ?? "")
          // `dir` (optional) — a SECOND marker dir (the relaunch child's);
          // the default is the run's own marker dir.
          const dir = args["dir"] !== undefined ? String(args["dir"]) : markerDir
          await awaitMarker(dir, m)
          break
        }
        case "request-marker": {
          // Test → host fs channel: writes <markerDir>/<name> (e.g. the
          // relaunch-gate; the host polls it and reacts once).
          const m = String(args["name"] ?? "")
          writeFileSync(`${markerDir}/${m}`, `${Date.now()}`)
          break
        }
        case "assert-screen": {
          const rows = (args["rows"] as string[] | undefined) ?? []
          const startRow = Number(((args["region"] as Record<string, unknown> | undefined)?.["startRow"]) ?? 0)
          await virtual.drained()
          const errors = assertRowsMatch(virtual, rows, startRow)
          if (errors.length > 0) {
            return {
              ok: false,
              error: `step ${i} (assert-screen): ${errors.slice(0, 3).join("; ")}`,
            }
          }
          break
        }
        case "wait-screen": {
          // Poll-until-match: pty byte delivery lags the fs marker (two
          // channels — a marker can be visible while the frame bytes are
          // still in flight to the virtual terminal). A bounded wait, not a
          // fist-pump: matching STALE content is impossible when the awaited
          // frame changes rows (the yamls pair every wait with rows that
          // differ from the previous frame).
          const rows = (args["rows"] as string[] | undefined) ?? []
          const startRow = Number(((args["region"] as Record<string, unknown> | undefined)?.["startRow"]) ?? 0)
          const timeoutMs = Number(args["timeoutMs"] ?? 2500)
          const deadline = Date.now() + timeoutMs
          let firstErrors: string[] = []
          for (;;) {
            await virtual.drained()
            const errors = assertRowsMatch(virtual, rows, startRow)
            if (errors.length === 0) break
            if (firstErrors.length === 0) firstErrors = errors
            if (Date.now() >= deadline) {
              return {
                ok: false,
                error:
                  `step ${i} (wait-screen): rows never matched within ${timeoutMs}ms: ` +
                  `${errors.slice(0, 2).join("; ")} // FIRST poll was: ${firstErrors.slice(0, 2).join("; ")}`,
              }
            }
            await sleep(50)
          }
          break
        }
        case "assert-glyph-integrity": {
          await virtual.drained()
          const errors = glyphIntegrityErrors(virtual)
          if (errors.length > 0) {
            return {
              ok: false,
              error: `step ${i} (assert-glyph-integrity): ${errors.slice(0, 3).join("; ")}`,
            }
          }
          break
        }
        case "assert-scrollback": {
          // NORMAL-buffer assert (M38a G3, minimal mode): the terminal's own
          // no-alt-screen buffer IS the print-once ledger — committed content
          // rows + the live region rows, in the native buffer after the real
          // VT parser. `lines` are compared (right-trimmed) against normal
          // buffer rows starting at `from` (absolute 0-based index); when
          // `from` is omitted the LAST len(lines) rows are the window (the
          // canonical "tail" of the whole buffer). baseY (scrollback depth)
          // pins the exact scroll amount; fromEnd is an alternate absolute
          // start from the bottom (negative index into normalLine()).
          const lines = (args["lines"] as string[] | undefined) ?? []
          const baseYArg = args["baseY"] as number | undefined
          const fromArg = args["from"] as number | undefined
          const fromEnd = args["fromEnd"] as number | undefined
          await virtual.drained()
          const errors: string[] = []
          if (baseYArg !== undefined && virtual.normalBaseY() !== baseYArg) {
            errors.push(`baseY: expected ${baseYArg} got ${virtual.normalBaseY()}`)
          }
          let start = -1
          if (fromArg !== undefined) start = fromArg
          else if (fromEnd !== undefined) start = virtual.normalLength() - fromEnd - lines.length
          else start = virtual.normalLength() - lines.length
          const len = virtual.normalLength()
          for (let j = 0; j < lines.length; j++) {
            const actual = virtual.normalLine(start + j)
            if (actual.trimEnd() !== lines[j]!.trimEnd()) {
              errors.push(
                `row ${start + j}: expected ${JSON.stringify(lines[j])} got ${JSON.stringify(actual)}`,
              )
            }
          }
          if (errors.length > 0) {
            return {
              ok: false,
              error:
                `step ${i} (assert-scrollback): ${errors.slice(0, 3).join("; ")}` +
                ` (len=${len}, baseY=${virtual.normalBaseY()})`,
            }
          }
          break
        }
        case "assert-cell-colors": {
          // M38b G3: cell-level color proof on the RENDERED virtual — the
          // markdown SGR assertions (md_code fg/bg, hljs bold/keyword).
          // Poll-until-match (the marker and the pty bytes are two channels —
          // the row text may match while the closure's SGR bytes are still in
          // flight; a code-body row's TEXT does not change across fence
          // closure, only its colors). `cells` entries: { row, col } plus any
          // of { fg, bg, bold, text } to check (all provided keys must match).
          const cells = (args["cells"] as Array<Record<string, unknown>> | undefined) ?? []
          const timeoutMs = Number(args["timeoutMs"] ?? 2500)
          const deadline = Date.now() + timeoutMs
          let firstErrors: string[] = []
          for (;;) {
            await virtual.drained()
            const errors = cellColorErrors(virtual, cells)
            if (errors.length === 0) break
            if (firstErrors.length === 0) firstErrors = errors
            if (Date.now() >= deadline) {
              return {
                ok: false,
                error:
                  `step ${i} (assert-cell-colors): cells never matched within ${timeoutMs}ms: ` +
                  `${errors.slice(0, 3).join("; ")} // FIRST poll was: ${firstErrors.slice(0, 3).join("; ")}`,
              }
            }
            await sleep(50)
          }
          break
        }
        case "await-quiescent": {
          await awaitQuiescent(runner, Number(args["ms"] ?? 400))
          await virtual.drained()
          break
        }
        case "assert-byte-budget": {
          // THE deterministic zero-idle proof — the host's cumulative ledger
          // (written at EVERY host write) checked against the pty-facing one.
          // Byte/write COUNTS are invariant under pty delivery chunking — no
          // time-window race (ConPTY's chunk gaps span seconds; window-based
          // sampling is unreliable on Windows). Two modes:
          //  - exact (default): observed bytes === host ledger bytes. Proves
          //    NOTHING (app or console) emitted extras — used by no-resize runs.
          //  - writes: N — the app emitted EXACTLY N writes (init + F frames +
          //    teardown). A resize makes ConPTY inject its own replay bytes
          //    into the master stream (cannot be filtered from the host side),
          //    so the 014 run uses write-count (app-discipline) + the exact
          //    byte budget of the no-resize 011 run.
          await awaitQuiescent(runner, 300)
          const writesArg = args["writes"] as number | undefined
          let bytes = Number.NaN
          let writes = Number.NaN
          try {
            bytes = Number(readFileSync(`${ctx.markerDir}/bytes`, "utf8"))
            writes = Number(readFileSync(`${ctx.markerDir}/writes`, "utf8"))
          } catch {
            /* NaN → no ledger */
          }
          if (!Number.isFinite(bytes) || !Number.isFinite(writes)) {
            return { ok: false, error: `step ${i} (assert-byte-budget): no ledger file` }
          }
          const observed = runner.writtenBytes()
          if (writesArg !== undefined && Number.isFinite(writesArg) && writes !== writesArg) {
            return {
              ok: false,
              error:
                `step ${i} (assert-byte-budget): app wrote ${writes} times, ` +
                `expected ${writesArg} (init+frames+teardown) — an extra frame was emitted`,
            }
          }
          if (writesArg === undefined && observed !== bytes) {
            return {
              ok: false,
              error:
                `step ${i} (assert-byte-budget): observed ${observed} bytes, ` +
                `host ledger says ${bytes} — idle frames were NOT zero-byte`,
            }
          }
          break
        }
        case "write-pty": {
          // Drive the child's KEYBOARD: byte-looking data (escapes decoded —
          // sent as-is for already-decoded values). The child's stdin flips
          // into raw mode on the host side (its own concern); the CONSOLE and
          // the APP never see real keys — the bytes are the keys.
          runner.write(decodePtyEscapes(String(args["data"] ?? "")))
          break
        }
        case "assert-file": {
          // Marker-file CONTENT check (markers themselves assert existence):
          // the host writes a JSON/text file; `contains` is a substring check.
          const name = String(args["name"] ?? "")
          const contains = args["contains"] as string | undefined
          const dir = args["dir"] !== undefined ? String(args["dir"]) : markerDir
          const path = `${dir}/${name}`
          if (!existsSync(path)) {
            return { ok: false, error: `step ${i} (assert-file): ${path} not found` }
          }
          const content = readFileSync(path, "utf8")
          if (contains !== undefined && !content.includes(contains)) {
            return {
              ok: false,
              error:
                `step ${i} (assert-file): ${path} does not contain ${JSON.stringify(contains)} ` +
                `(content: ${JSON.stringify(content.slice(0, 120))})`,
            }
          }
          break
        }
        case "assert-idle-bytes": {
          // Closed time window (see header). expected must be 0 — any pty byte
          // inside the window fails the zero-byte idle invariant. The window
          // OPENS after a short quiescence so ConPTY's chunked delivery of the
          // previous frame's tail settles BEFORE b0 is sampled (M37a: a 3-byte
          // late chunk of the prior frame must not masquerade as an idle write).
          const expected = Number(args["expected"] ?? 0)
          const windowMs = Number(args["windowMs"] ?? 500)
          if (expected !== 0) {
            return {
              ok: false,
              error: `step ${i} (assert-idle-bytes): expected=${expected} unsupported (only 0)`,
            }
          }
          await awaitQuiescent(runner, 250)
          let recent = false
          const unsub = runner.onData(() => {
            recent = true
          })
          const b0 = runner.writtenBytes()
          try {
            await sleep(windowMs)
            const b1 = runner.writtenBytes()
            if (recent || b1 !== b0) {
              return {
                ok: false,
                error:
                  `step ${i} (assert-idle-bytes): host wrote ${b1 - b0} bytes ` +
                  `(${recent ? "data seen in window; " : ""}b0=${b0} b1=${b1}) ` +
                  `during a ${windowMs}ms idle window — zero-byte idle violated`,
              }
            }
          } finally {
            unsub()
          }
          break
        }
        case "resize": {
          const cols = Number(args["cols"])
          const rows = Number(args["rows"])
          if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
            return { ok: false, error: `step ${i} (resize): invalid cols/rows ${cols}/${rows}` }
          }
          // ConPTY injects a RESIZE REPLAY when the window resizes: a
          // SetWindowSize sequence (ESC[8;r;c t — IGNORED by @xterm/headless)
          // plus a painted copy of the console's current screen with CR line
          // terminators. Parsed at the OLD width + reflowed, it leaves
          // beyond-width residue in xterm's line buffer — so: soak the
          // replay, reflow, then BURN the buffer with a clear; the following
          // full-paint frame repaints from a clean state. The 2J+start also
          // makes the crop deterministic even when the replay races the step.
          runner.resize(cols, rows)
          await sleep(200)
          await virtual.drained()
          virtual.resize(cols, rows)
          virtual.write("\x1b[2J\x1b[H")
          await sleep(150)
          await virtual.drained()
          break
        }
        case "app-resize": {
          // M38a G3: minimal-mode resize — the CHILD-driven app resize (the
          // ConPTY master resize path is unobservable to the child under this
          // node-pty pairing — see host-015.ts; and the master's inject-replay
          // would BURN the minimal buffer). The test requests the resize via an
          // fs marker, waits for the host's app.setSize ack, then reflows the
          // virtual terminal to the same size (xterm's own resize/reflow does
          // the "terminal" work). NO 2J burn here: minimal-mode committed rows
          // are native-buffer content the app never repaints (the burn step of
          // the pty `resize` step is fullscreen-discipline).
          const cols = Number(args["cols"])
          const rows = Number(args["rows"])
          if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
            return { ok: false, error: `step ${i} (app-resize): invalid cols/rows ${cols}/${rows}` }
          }
          writeFileSync(`${markerDir}/req-resize-${cols}x${rows}`, `${Date.now()}`)
          await awaitMarker(markerDir, `host-ack-${cols}x${rows}`)
          await sleep(200)
          virtual.resize(cols, rows)
          await sleep(150)
          await virtual.drained()
          break
        }
        case "wait-exit": {
          const code = Number(args["code"] ?? 0)
          const actual = await runner.waitExit(15000)
          if (actual !== code) {
            return { ok: false, error: `step ${i} (wait-exit): expected ${code} got ${actual}` }
          }
          break
        }
        default:
          return { ok: false, error: `step ${i}: unknown action "${name}"` }
      }
    } catch (e) {
      return { ok: false, error: `step ${i} (${name}): ${String(e)}` }
    }
  }

  return { ok: true }
}
