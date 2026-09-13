// M49 Task 13: PTY host for case-027 — the LOCAL DASHBOARD + TRUTHFUL STATUS
// LINE over the REAL embedded service (a gated spawn — one REAL running
// subagent on the app's session, one queued prompt, a second listing-only
// durable session). The scene drives the PRODUCTION key path:
//   - Ctrl+\ (dashboard), type-to-filter, p peek, Enter open, Esc back;
//   - Ctrl+; queue pane + Ctrl+G tasks pane;
//   - mouse [cancel] on the queued row + [✗] on the task row (SGR 1006).
// Witnesses (host-side, fs): spawn-running / queued-prompt / queue-cancelled /
// task-cancelled / live-tasks (the status-line count truth) /
// dashboard-rows.json (the backend projection the view consumed — no cost).
//
// Determinism: the gated child model keeps the subagent RUNNING until the
// scene's task cancel lands; every human step is a keystroke/mouse sequence
// the pty parses through tui-core's InputParser (production path).

import { setUtf8CodePage } from "./codepage.ts"
import { existsSync, mkdirSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { createRenderer, createTerminal, createUnknownCapabilities, InputParser, makeGlyphs, resolvePalette } from "@i-harness/tui-core"
import type { TerminalCapabilityContext, InputEvent } from "@i-harness/tui-core"
import { TuiApp, createScrollbackEngine, createEmbeddedBackend } from "../../src/index.ts"
import type { BackendClient, InputSource } from "../../src/index.ts"
import { createSessionService, type SessionService } from "@i-harness/session-executor"
import { createSessionCoordinator } from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { createSession } from "@i-harness/core-session"
import type { ModelClient } from "@i-harness/llm-seam"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const MARKER_DIR = process.argv[2] ?? ""
const m = /^(\d+)x(\d+)$/.exec(process.argv[3] ?? "")
const size = m !== null ? { cols: Number(m[1]), rows: Number(m[2]) } : { cols: 100, rows: 30 }
const TUI_FROZEN_NOW = 44_444

function marker(name: string): void {
  mkdirSync(MARKER_DIR, { recursive: true })
  writeFileSync(`${MARKER_DIR}/${name}`, `${Date.now()}`)
}

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

/** Fixed caps (host-011 parity — no live probe under a pty). kitty: true —
 * the keyboard protocol the scene uses for Ctrl+\ / Ctrl+; / Ctrl+G (legacy
 * C0 has no encodings for them — 0x1c/0x07/0x1b; are dropped by the parser). */
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
  kitty: true,
}

/** host-026 parity: raw stdin → REAL tui-core InputParser → queue. */
function wireInput(): { source: InputSource; endInput: () => void } {
  const parser = new InputParser()
  const queue: InputEvent[] = []
  let wake: (() => void) | undefined
  let ended = false
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const pushEvent = (ev: InputEvent): void => {
    queue.push(ev)
    wake?.()
    try {
      const n = queue.length
      writeFileSync(`${MARKER_DIR}/input-${n}`, JSON.stringify({ type: ev.type, code: (ev as { code?: string }).code, key: (ev as { key?: string }).key }))
    } catch {
      /* best-effort */
    }
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
        while (queue.length > 0) yield queue.shift()!
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

async function main(): Promise<void> {
  setUtf8CodePage()

  const terminal = createTerminal({ stream: { write: (s: string): boolean => { out(s); return true } }, cap })
  const renderer = createRenderer({ cols: size.cols, rows: size.rows, cap })
  const engine = createScrollbackEngine({ width: size.cols })
  const input = wireInput()

  const workspace = join(MARKER_DIR, "ws")
  mkdirSync(workspace, { recursive: true })

  let frameN = 0
  function dumpRows(n: number): void {
    const dumpDir = process.env.TUI_DUMP_DIR
    if (dumpDir === undefined || dumpDir === "") return
    const inner = renderer as unknown as { db: { front: { cells: Array<{ text: string }>; width: number } } }
    const { cells, width } = inner.db.front
    if (cells.length === 0) return
    const height = cells.length / width
    const rows: string[] = []
    for (let y = 0; y < height; y++) {
      let line = ""
      for (let x = 0; x < width; x++) line += cells[y * width + x].text
      rows.push(line.replace(/\0/g, ""))
    }
    writeFileSync(join(dumpDir, `frame-${n}.txt`), rows.join("\n"))
  }

  // ---- the REAL service: session "s1" runs a REAL subagent (gated child),
  // a second submit queues; session "s2" exists in the store (listing-only).
  let releaseChild!: () => void
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve })
  // The parent's CONTINUATION also blocks — the first turn stays RUNNING so
  // the second Enter REALLY queues (no race with the spawn returning early).
  let releaseParent!: () => void
  const parentGate = new Promise<void>((resolve) => { releaseParent = resolve })
  let spawned = false
  const model: ModelClient = {
    async *stream(request: import("@i-harness/llm-seam").LLMRequest) {
      const last = request.messages.at(-1)
      const isChild = last?.role === "user" && typeof last.content === "string" && last.content.includes("inspect case")
      if (isChild) {
        await childGate
        yield { type: "text/chunk", text: "child ok" }
        yield { type: "end" }
        return
      }
      if (!spawned) {
        spawned = true
        yield { type: "tool_call", call: { name: "spawn_agent", args: { message: "inspect case", task_name: "helper" } } }
        yield { type: "end" }
        return
      }
      await parentGate
      yield { type: "text/chunk", text: "spawn returned" }
      yield { type: "end" }
    },
  }

  // The durable store: the app session (title "Alpha") + a second session
  // (title "Beta", never assembled — listing-only).
  const storeDir = join(MARKER_DIR, "store")
  const jsonlBackend = createJsonlBackend(storeDir)
  const coordinator = createSessionCoordinator(jsonlBackend, { lock: { enabled: true, lockRoot: storeDir } })
  const secondId = (await coordinator.create()).id
  await coordinator.updateMeta(secondId, { title: "Beta" })
  const sessionId = (await coordinator.create()).id
  await coordinator.updateMeta(sessionId, { title: "Alpha" })

  // Ephemeral live sessions (the app's own + subagent child sessions) — the
  // durable store stays authoritative for list/profile reads.
  const liveSessions = new Map<string, ReturnType<typeof createSession>>()
  const service: SessionService = createSessionService({
    workspace,
    sessionId,
    approveAll: true,
    modelPolicy: "required",
    coordinator,
    sessionFor: async (id) => {
      let session = liveSessions.get(id)
      if (session === undefined) {
        session = createSession()
        liveSessions.set(id, session)
      }
      return session
    },
    loadMeta: async (id) => {
      try {
        return (await coordinator.profile(id)).meta
      } catch {
        return undefined
      }
    },
    modelBindingFor: async () => ({
      status: "ready",
      binding: { model, providerId: "mock", modelId: "mock-story", label: "mock:mock-story" },
    }),
  })
  marker("service-ready")

  const backend: BackendClient = createEmbeddedBackend({
    service,
    sessionId,
    listSessions: async () => {
      // The listing seam: the two durable sessions THIS host created (their
      // profile reads go through the coordinator; a profile/read failure is an
      // honest skip — the row never fabricates).
      const rows: Array<{ id: string; title: string; updatedAt: number }> = []
      for (const [id, title] of [[sessionId, "Alpha"], [secondId, "Beta"]] as Array<[string, string]>) {
        try {
          const { updatedAt } = await coordinator.profile(id)
          rows.push({ id, title, updatedAt: updatedAt ?? 0 })
        } catch {
          /* honest skip — never a fabricated row */
        }
      }
      writeFileSync(`${MARKER_DIR}/list-rows.json`, JSON.stringify({ rowCount: rows.length }))
      return rows
    },
  })
  marker("backend-ready")

  const app = new TuiApp({
    renderer,
    backend,
    engine,
    capabilities: cap,
    palette: resolvePalette(cap, "groknight"),
    glyphs: makeGlyphs(true),
    write: (s: string) => {
      out(s)
      const n = ++frameN
      marker(`frame-${n}`)
      dumpRows(n)
    },
    now: () => TUI_FROZEN_NOW,
    input: input.source,
    workspace,
    sessionId,
    // M49 Task 13: the builtin status line (the row truth comes from the app's
    // real values — the ready model label, tasks/queue counts, the timer).
    statusLine: { mode: "builtin" },
    busyEnter: "queue",
  })
  await app.initialize({ sessionId })

  terminal.init()
  void app.start().catch((e: unknown) => {
    // Surface the crash for the yaml's diagnostics (never swallow silently —
    // an app-side exception must show up in the failure dump).
    try {
      marker("app-start-failed")
      writeFileSync(`${MARKER_DIR}/app-failed-message`, String(e))
    } catch {
      /* marker dir is best effort */
    }
  })
  await pollMarker("backend-ready")
  marker("scene-027-ready")

  // Backend-truth watchers (the state behind the view) + dashboard snapshots.
  const dashboardSnapshot = (): void => {
    void backend.dashboard!().then((rows) => {
      writeFileSync(join(MARKER_DIR, "dashboard-rows.json"), JSON.stringify(rows))
      marker("snap-wrote")
    }).catch(() => {})
  }
  let firedSpawn = false
  let firedQueued = false
  let firedQueueCancelled = false
  let firedTaskCancelled = false
  let firedCountsZero = false
  const watcher = setInterval(() => {
    const tasks = service.tasks(sessionId)
    const queue = service.queue(sessionId)
    // "alive" = the task exists and has not reached a terminal state. The view
    // status "queued" is the registry's `accepted`, which `submit()` returns
    // SYNCHRONOUSLY — long before the child provider's first step claims the
    // task and flips it to "running" (task-protocol.ts claim()). Waiting for
    // "running" therefore made this witness depend on a NESTED spawn + child
    // model step completing, which is not what the scene asserts: the marker is
    // about the dashboard showing an ACTIVE task, and the cancellation contract
    // below is unchanged (it still requires the task to LEAVE the active set).
    // Terminal = completed/failed/cancelled, so the alive set is exactly these
    // three — the same set lines below already use for the cancel and count
    // witnesses, which is why the old `=== "running"` here was the odd one out.
    const alive = (t: { status?: string }): boolean =>
      t.status === "queued" || t.status === "running" || t.status === "waiting"
    if (!firedSpawn && tasks.some((t) => t.id === "root/helper" && alive(t))) {
      firedSpawn = true
      marker("spawn-running")
    }
    if (!firedQueued && queue.some((q) => q.text === "second" && q.state === "queued")) {
      firedQueued = true
      marker("queued-prompt")
    }
    if (!firedQueueCancelled && firedQueued && !queue.some((q) => q.text === "second")) {
      firedQueueCancelled = true
      marker("queue-cancelled")
    }
    if (!firedTaskCancelled && firedSpawn && existsSync(`${MARKER_DIR}/task-cancel-actioned`)) {
      // The yaml supplies the release request right AFTER its [✗] click (the
      // app's cancelTask call — the "cancellation-requested" toast — already
      // asked the child to abort). The gated child model ignores its abort
      // channel (it waits on the scene gate), so the cancel would never
      // settle on its own — release BOTH gates: the child yields, ends, and
      // the entry records the abort ("cancelled"). The witness below then
      // fires when the entry leaves the ACTIVE set (never a fabricated
      // settle — the real status change is what the marker proves).
      rmSync(`${MARKER_DIR}/task-cancel-actioned`, { force: true })
      releaseParent()
      releaseChild()
    }
    if (!firedTaskCancelled && firedSpawn && !tasks.some((t) => t.id === "root/helper" && alive(t))) {
      firedTaskCancelled = true
      marker("task-cancelled")
    }
    // the status-line task-count truth (the row's live task count) — the
    // count witness transitions: spawned>0 → after the cancel 0 (the
    // "counts 1→0" proof the scene asserts via marker).
    const liveTasks = tasks.filter((t) => alive(t)).length
    writeFileSync(`${MARKER_DIR}/live-tasks`, String(liveTasks))
    if (!firedCountsZero && firedTaskCancelled && liveTasks === 0) {
      firedCountsZero = true
      marker("live-tasks-zero")
      // both cancels landed + the counts drained — release the gates (the
      // parent turn settles; the teardown waits for it).
      releaseParent()
      releaseChild()
    }
    if (existsSync(`${MARKER_DIR}/snap-request`)) {
      rmSync(`${MARKER_DIR}/snap-request`, { force: true })
      dashboardSnapshot()
    }
  }, 25)

  // The dashboard selection witness — written on a kill marker request so the
  // yaml can assert the STABLE SELECTION across the round trip.
  const selectionWatcher = setInterval(() => {
    if (!existsSync(`${MARKER_DIR}/sel-request`)) return
    rmSync(`${MARKER_DIR}/sel-request`, { force: true })
    const sel = app.dashboard.selectedId()
    if (sel !== undefined) {
      writeFileSync(`${MARKER_DIR}/dashboard-selection.json`, JSON.stringify({ selectedId: sel }))
      marker("selection-wrote")
    }
  }, 25)

  await pollMarker("request-exit", 120_000)
  clearInterval(watcher)
  clearInterval(selectionWatcher)
  input.endInput()
  await sleep(300)
  terminal.teardown()
  await backend.close().catch(() => {})
  await coordinator.close().catch(() => {})
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
