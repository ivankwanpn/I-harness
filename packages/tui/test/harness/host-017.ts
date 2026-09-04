// M39 G1: PTY host for case-017 — the M37b interaction matrix at REAL-PTY level.
// ONE deterministic run ("017", 46x24) driving all five M37b interactions
// through the production-shaped wiring (host-013 discipline):
//   1. permission freeform reject — a REAL createApprovalBridge fake service
//      surfaces an approval → `5 (○) No, reject (type to add feedback)`;
//      pty types "dont trust" (freeform gutter, see GAP below), then `5` →
//      decision-1.json = { verdict:"reject", approved:false, feedback:"dont trust" }
//      + the bridge's answerApproval round-trip resolves the parked promise
//      (marker "approval-no") + overlay closes.
//   2. question — the SAME bridge's provider.ask surfaces a question →
//      rows `1 (○) Apple`, `2 (●) Banana`; pty `1` → decision-2.json
//      { mode:"option", index:0, value:"Apple" } + overlay closes.
//   3. /btw — pty "/btw why" + Enter → real submit → the fake backend drives
//      the btw pane answering → done (marker "btw-done") → host closes it.
//   4. session picker — pty Ctrl-S → the wired listSessions (3 sessions) →
//      j (clamp) / k (cursor 1) → Enter → backend.open("s-2") recorded
//      (record-open.json + marker "opened") + picker closes.
//   5. history — pty CSI Up (empty prompt, 2-entry history) → history panel →
//      lone Esc (40ms drain) → dismiss.
//   The test then requests the exit gate (fs marker "request-exit") —
//   interactions 4/5 are pure app-side; the host would otherwise stay alive.
//
// ELECTION "017" details (how the five interact):
//   - The approval/question surfaces come from createApprovalBridge over a
//     fake SessionService ctx (the SAME fake the unit harness uses), so the
//     overlay seam path is production-shaped (host-013 built the surface by
//     hand; THIS host consumes the bridge stream like a real host would).
//   - FREE-FORM INPUT GAP (LOUD): the loop's onInput routes printable chars to
//     the PROMPT only when no non-dropdown overlay is open, and keys.ts
//     overlayKeys has NO printable-char case for permission — typed rejection
//     feedback can never reach PermissionState.freeformText through the
//     production key path. The host covers the gap with an input ADAPTER
//     ("freeform gutter" — wireInput already parses real pty bytes here): while
//     a permission overlay with the freeform row is open, printable chars
//     (except row keys 1-9 / j / k) are appended to the seam's state and
//     repainted through the REAL dispatch("none") → renderPermission path.
//     Production-loop fix (overlay freeform-text capture) is a known gap, not
//     adapted in src/ (untouchable this wheel).
//
// Errors: any throw → best-effort marker "host-failed" + message → exit 3.

import { execSync } from "node:child_process"
import { existsSync, writeFileSync, writeSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import {
  createRenderer,
  createTerminal,
  createUnknownCapabilities,
  makeGlyphs,
  resolvePalette,
  InputParser,
} from "@i-harness/tui-core"
import type { InputEvent, TerminalCapabilityContext } from "@i-harness/tui-core"
import { createContext } from "@i-harness/core-plugin"
import type { ApprovalRequest } from "@i-harness/interaction"
import type { SessionAssembly } from "@i-harness/session-executor"
import {
  TuiApp,
  bindPermissionOverlay,
  bindQuestionOverlay,
  createApprovalBridge,
  createScrollbackEngine,
  DECISION_MAP,
} from "../../src/index.ts"
import type { BackendClient, InputSource, PermissionState, TuiEvent } from "../../src/index.ts"
import type { BtwState } from "../../src/views/btw-overlay.ts"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const MARKER_DIR = process.argv[2] ?? ""
const m = /^(\d+)x(\d+)$/.exec(process.argv[3] ?? "")
const size = m !== null ? { cols: Number(m[1]), rows: Number(m[2]) } : { cols: 46, rows: 24 }
const TUI_FROZEN_NOW = 13_334

function marker(name: string): void {
  mkdirSync(MARKER_DIR, { recursive: true })
  writeFileSync(`${MARKER_DIR}/${name}`, `${Date.now()}`)
}

/** Host-side poll on its own markers (the fs channel in reverse: the host
 * waits for the pty-driven callbacks + the test's exit gate). */
async function pollMarker(name: string, timeoutMs = 25_000): Promise<void> {
  const t0 = Date.now()
  for (;;) {
    if (existsSync(`${MARKER_DIR}/${name}`)) return
    if (Date.now() - t0 >= timeoutMs) throw new Error(`host poll: marker "${name}" never appeared`)
    await sleep(50)
  }
}

let epipe = false
let totalBytes = 0
let totalWrites = 0

/** writeSync ledger (host-011 parity): every host stdout byte passes here;
 * <markerDir>/bytes + <markerDir>/writes feed `assert-byte-budget`. */
function out(s: string): void {
  if (epipe) return
  try {
    writeSync(1, s)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "EPIPE") epipe = true
    else throw e
  }
  totalBytes += Buffer.byteLength(s)
  totalWrites += 1
  try {
    writeFileSync(`${MARKER_DIR}/bytes`, String(totalBytes))
    writeFileSync(`${MARKER_DIR}/writes`, String(totalWrites))
  } catch {
    /* ledger is best-effort */
  }
}

/** Fixed caps (host-011 parity — no live probe under a pty). */
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

// ------------------------------------------------------------------ bridge fake (approval.test.ts parity)

/** Fake SessionService: fires one assembly immediately (a live assembly exists)
 * and exposes its real plugin ctx — the SAME shape approval.test.ts uses. */
interface FakeService {
  ctx: ReturnType<typeof createContext>
  onAssembly: (hook: (a: SessionAssembly) => void) => () => void
  assemblyFor: (id: string) => Promise<SessionAssembly>
}

function fakeService(): FakeService {
  const ctx = createContext()
  return {
    ctx,
    onAssembly: (hook) => {
      hook({ ctx } as unknown as SessionAssembly)
      return () => {}
    },
    assemblyFor: async () => ({ ctx } as unknown as SessionAssembly),
  }
}

const answererOf = (ctx: ReturnType<typeof createContext>) =>
  ctx.services.get<(req: { name: string; reason: string }) => Promise<boolean>>("approval/answerer")

const providerOf = (ctx: ReturnType<typeof createContext>) =>
  ctx.services.get<{ ask(q: { id: string; prompt: string; options?: string[] }): Promise<string> }>("questions/provider")

const approvalReq = (): ApprovalRequest => ({
  name: "bash",
  reason: "dangerous command requires approval: rm -rf node_modules",
  command: "rm -rf node_modules",
  argv: ["rm", "-rf", "node_modules"],
})

// ------------------------------------------------------------------ freeform gutter (the GAP adapter — see header)

interface GutterCtx {
  state: PermissionState
}

let gutter: GutterCtx | undefined

/** Per-key decision while a permission overlay is open: printable chars that
 * keys.ts does NOT route (digits 1-9 = row select, j/k = nav stay routed) are
 * appended to the seam's freeform text + a real repaint. Everything else
 * passes through to the app (its production keymap). */
function captureFreeform(ev: InputEvent, app: TuiApp): boolean {
  if (gutter === undefined || app.state().overlay?.kind !== "permission") return false
  if (ev.type !== "key") return false
  if (ev.code === "Backspace") {
    gutter.state.freeformText = gutter.state.freeformText.slice(0, -1)
    app.dispatch("none")
    return true
  }
  if (ev.code !== "char" || ev.ctrl || ev.alt) return false
  const k = ev.key
  if (k.length !== 1 || k < " ") return false
  if (k >= "1" && k <= "9") return false // row select
  if (k === "j" || k === "k") return false // cursor nav
  gutter.state.freeformText += k
  app.dispatch("none")
  return true
}

// ------------------------------------------------------------------ input

/** Host-012 parity: raw stdin → REAL tui-core InputParser → queue (+40ms
 * lone-ESC drain); TuiApp.input pump consumes it. The freeform gutter wraps
 * the source (see header). */
function wireInput(
  gate: (ev: InputEvent) => boolean,
): { source: InputSource; endInput: () => void } {
  const parser = new InputParser()
  const queue: InputEvent[] = []
  let wake: (() => void) | undefined
  let ended = false
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const pushEvent = (ev: InputEvent): void => {
    queue.push(ev)
    wake?.()
  }
  process.stdin.setRawMode?.(true)
  process.stdin.on("data", (chunk: unknown) => {
    const data: Uint8Array | string =
      typeof chunk === "string" ? chunk
      : chunk instanceof Uint8Array ? chunk
      : new Uint8Array(0)
    for (const ev of parser.push(data, cap)) pushEvent(ev)
    if (drainTimer !== undefined) clearTimeout(drainTimer)
    drainTimer = setTimeout(() => {
      drainTimer = undefined
      for (const ev of parser.drain()) pushEvent(ev)
    }, 40)
  })
  const source: InputSource = {
    async *next(): AsyncIterable<InputEvent> {
      for (;;) {
        while (queue.length > 0) {
          const ev = queue.shift()!
          if (gate(ev)) continue
          yield ev
        }
        if (ended) return
        await new Promise<void>((res) => { wake = res })
      }
    },
  }
  const endInput = (): void => {
    ended = true
    wake?.()
    wake = undefined
  }
  return { source, endInput }
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  execSync("chcp.com 65001>NUL", { stdio: "ignore" })

  const terminal = createTerminal({
    stream: { write: (s: string): boolean => { out(s); return true } },
    cap,
  })
  const renderer = createRenderer({ cols: size.cols, rows: size.rows, cap })
  const engine = createScrollbackEngine({ width: size.cols })

  // A fake backend (quiet events; the bridge streams carry the surfaces) —
  // the interaction 3 btw lifecycle + interaction 4 open record live here.
  let btwStateSeq = 0
  const fakeBackend = (appRef: () => TuiApp | undefined): BackendClient => ({
    async *events(): AsyncIterable<TuiEvent> {
      await new Promise<void>(() => {}) // never yields — pump stays alive
    },
    listSessions: async () => [
      { id: "s-1", title: "build a game", updatedAt: 0, turnCount: 3 },
      { id: "s-2", title: "debug tokens", updatedAt: 0, turnCount: 5 },
      { id: "s-3", title: "plan the notes", updatedAt: 0, turnCount: 1 },
    ],
    open: async (id: string) => {
      writeFileSync(`${MARKER_DIR}/record-open.json`, JSON.stringify({ sessionId: id }))
      marker("opened")
    },
    submit: async (text: string) => {
      // /btw: the pane lifecycle is host-visible (no TuiEvent carries it) —
      // the fake backend drives paneData.btw like a real /btw answerer would.
      writeFileSync(`${MARKER_DIR}/record-submit.json`, JSON.stringify({ text }))
      marker("btw-submitted")
      const q = text.replace(/^\/btw\s*/, "").trim() || "why"
      const set = (s: BtwState | undefined): void => {
        const app = appRef()
        if (app === undefined) return
        btwStateSeq++
        const p = app.state().paneData
        app.state().paneData = s === undefined ? { ...(p ?? {}), btw: undefined } : { ...(p ?? {}), btw: s }
        app.dispatch("none")
      }
      set({ question: q, state: "answering", nowMs: 0 })
      setTimeout(() => {
        set({ question: q, state: "done", text: "the files are already committed" })
        marker("btw-done")
      }, 400)
      setTimeout(() => {
        set(undefined) // host-side close (production: backend btw event)
      }, 900)
    },
    steer: async () => {},
    cancel: async () => {},
    seqCursor: () => -1,
    replay: async () => [],
    status: () => ({ running: false, queued: 0 }),
    close: async () => {},
  })

  /** Dev aid: TUI_DUMP_DIR=<dir> writes <frame-N>.txt rows for the yaml authors. */
  let frameN = 0
  function dumpRows(n: number): void {
    const dumpDir = process.env.TUI_DUMP_DIR
    if (dumpDir === undefined || dumpDir === "") return
    const inner = renderer as unknown as { db: { front: { cells: Array<{ text: string }>; width: number } } }
    const { cells, width } = inner.db.front
    const height = cells.length / width
    const rows: string[] = []
    for (let y = 0; y < height; y++) {
      let line = ""
      for (let x = 0; x < width; x++) line += cells[y * width + x].text
      rows.push(line.replace(/\0/g, ""))
    }
    writeFileSync(join(dumpDir, `frame-${n}.txt`), rows.join("\n"))
  }

  let appRef: TuiApp | undefined
  const input = wireInput((ev) => appRef !== undefined && captureFreeform(ev, appRef))
  const backend = fakeBackend(() => appRef)
  const app = new TuiApp({
    renderer,
    backend,
    engine,
    capabilities: cap,
    palette: resolvePalette(cap),
    glyphs: makeGlyphs(true),
    write: (s: string) => {
      out(s)
      const n = ++frameN
      marker(`frame-${n}`)
      dumpRows(n)
    },
    input: input.source,
    now: () => TUI_FROZEN_NOW,
    slashCommands: [], // no slash registry — "/" never opens the dropdown
    listSessions: backend.listSessions, // the picker's loader seam
  })
  appRef = app
  // Seeded 2-entry history: interaction 3's submit appends "/btw why".
  app.state().history = ["build a game"]
  app.state().historyIndex = 1

  // Safety net: a stalled scene exits 4 (the test's wait-exit expects 0).
  const stall = setTimeout(() => {
    try { marker("host-stalled") } catch { /* best effort */ }
    process.exit(4)
  }, 150_000)

  terminal.init()
  void app.start()
  await sleep(300) // settle

  // ------------------------------------------------------------------ interaction 1: permission via the REAL bridge
  const service = fakeService()
  const bridge = createApprovalBridge(service)
  const answerer = answererOf(service.ctx)
  const approvalP = answerer(approvalReq())
  void approvalP.then((approved) => marker(approved ? "approval-ok" : "approval-no"))
  const approvalsIt = bridge.approvals()[Symbol.asyncIterator]()
  const surf = (await Promise.race([
    approvalsIt.next(),
    sleep(10_000).then(() => { throw new Error("approval surface never streamed") }),
  ])).value

  const pstate: PermissionState = { cursor: 0, scopeIndex: 0, freeformText: "" }
  gutter = { state: pstate }
  app.state().overlay = bindPermissionOverlay(surf, pstate, {
    onDecision: (d) => {
      // Host record + the REAL bridge round-trip (boolean seam).
      writeFileSync(`${MARKER_DIR}/decision-1.json`, JSON.stringify(d))
      marker("answered-1")
      void bridge.answerApproval(surf.id, DECISION_MAP[d.verdict](), {
        scope: d.scope,
        feedback: d.feedback,
      })
    },
    onClose: () => {
      gutter = undefined
      app.state().overlay = undefined
      app.dispatch("none")
    },
  })
  marker("overlay-p1")
  app.dispatch("none") // draw the modal (frame 1)

  await pollMarker("answered-1")
  await sleep(250) // hold the modal-gone frame for the step pin

  // ------------------------------------------------------------------ interaction 2: question via the SAME bridge
  const provider = providerOf(service.ctx)
  const questionP = provider.ask({ id: "q1", prompt: "Pick a fruit\n\nchoose one", options: ["Apple", "Banana"] })
  void questionP.then((value) => marker(`question-answer:${value.replace(/\s+/g, "-")}`))
  const questionsIt = bridge.questions()[Symbol.asyncIterator]()
  const q = (await Promise.race([
    questionsIt.next(),
    sleep(10_000).then(() => { throw new Error("question surface never streamed") }),
  ])).value

  const qstate = { page: 1, pages: 1, cursor: 1, selected: [], freeformFocused: false, freeformText: "" }
  app.state().overlay = bindQuestionOverlay(q, qstate, {
    onDecision: (d) => {
      writeFileSync(`${MARKER_DIR}/decision-2.json`, JSON.stringify(d))
      marker("answered-q1")
      void bridge.answerQuestion(q.id, { value: d.value })
    },
    onClose: () => {
      app.state().overlay = undefined
      app.dispatch("none")
    },
  })
  marker("overlay-q1")
  app.dispatch("none") // draw the question modal

  await pollMarker("answered-q1")
  await sleep(250) // modal-gone hold

  // ------------------------------------------------------------------ interactions 3-5: pty-driven (submit / Ctrl-S / Up-Esc)
  await pollMarker("btw-submitted") // the test's "/btw why" Enter → submit
  await pollMarker("btw-done")
  await pollMarker("opened") // the test's picker Enter → backend.open("s-2")
  await pollMarker("request-exit") // the test's exit gate (fs channel)
  await sleep(300)
  terminal.teardown()
  marker("teardown-wrote")
  clearTimeout(stall)
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
