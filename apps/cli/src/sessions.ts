// M61: `i-harness sessions` — the CLI face of the durable session store.
//
//   i-harness sessions [list] [--session-dir DIR] [--json]
//   i-harness sessions show <id> [--session-dir DIR] [--last N] [--json]
//
// WHY this exists: the store has been growing since the TUI became durable by
// default, but nothing outside the TUI could READ it — `--resume` needed an id
// the user had no way to discover, and a headless run could not tell whether a
// conversation had survived. The root defaults to `<harness home>/sessions`
// (the SAME root the TUI writes), so this shows what the TUI actually stored.
//
// Read-only: the listing never adopts ownership and never writes (a session
// live in another process is still listed — the row just carries what the
// header says).
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { deriveMessages, type Session, type SessionEvent } from "@i-harness/core-session"
import {
  createSessionCoordinator,
  resolveSessionStoreRoot,
  type SessionCoordinator,
} from "@i-harness/session-persistence"
import { createJsonlBackend } from "@i-harness/session-persistence-jsonl"
import { diagnosticsFor } from "@i-harness/diagnostics"

// W6 T5: one module-scope handle — both sites report this file's own subject,
// the durable session store (phase `session`).
const d = diagnosticsFor("session")

/** One listed session. Fields are absent when the store cannot prove them. */
export interface StoredSessionRow {
  id: string
  title?: string
  /** Artifact mtime, createdAt fallback. */
  updatedAt?: number
  /** turn/start count from a full-log read; absent when the read failed. */
  turnCount?: number
  /** M3 §3.4: the LAST `operator/run-end` in the log. Absent for a session
   * older than the record — the cell renders `—`, never a fabricated success. */
  lastRun?: { exitCode: number; durationMs: number; error?: string }
  /** Set when the read failed — the row is still listed, honestly labelled. */
  problem?: string
}

export interface SessionsCommandOptions {
  /** `--session-dir` override; absent → the shared default root. */
  sessionDir?: string
  json?: boolean
  /** `show`: how many trailing entries to print (default 20). */
  last?: number
}

export function parseSessionsArgs(args: string[]): { subcommand: "list" | "show" | "help"; id?: string; options: SessionsCommandOptions } {
  const rest = args.slice(1) // drop the `sessions` token
  const options: SessionsCommandOptions = {}
  let subcommand: "list" | "show" | "help" = "list"
  let id: string | undefined
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!
    if (token === "--json") { options.json = true; continue }
    if (token === "--session-dir") { options.sessionDir = rest[++i]; continue }
    if (token === "--last") {
      const value = Number(rest[++i])
      if (Number.isFinite(value) && value > 0) options.last = Math.floor(value)
      continue
    }
    if (token === "--help" || token === "-h" || token === "help") { subcommand = "help"; continue }
    if (token === "show") { subcommand = "show"; continue }
    if (token === "list") { subcommand = "list"; continue }
    if (!token.startsWith("-") && subcommand === "show" && id === undefined) { id = token; continue }
  }
  return { subcommand, ...(id !== undefined ? { id } : {}), options }
}

/** The store listing — one settled row per session id (a single unreadable
 * file never fails the whole list; its row carries `problem`). */
export async function listStoredSessions(coordinator: SessionCoordinator, storeRoot: string): Promise<StoredSessionRow[]> {
  const ids = await coordinator.list()
  const rows: StoredSessionRow[] = []
  for (const id of ids) {
    try {
      const { meta } = await coordinator.profile(id)
      const row: StoredSessionRow = { id, ...(meta.title !== undefined ? { title: meta.title } : {}) }
      const artifact = await stat(join(storeRoot, `${id}.jsonl`)).then((s) => s.mtimeMs).catch(() => undefined)
      const created = Date.parse(meta.createdAt)
      const updatedAt = artifact ?? (Number.isNaN(created) ? undefined : created)
      if (updatedAt !== undefined) row.updatedAt = updatedAt
      try {
        const { session } = await coordinator.load(id)
        row.turnCount = session.events.filter((ev) => ev.type === "turn/start").length
        // M3 §3.4: the durable run-end record rides the full-log read the turn
        // count already pays for. The LAST one wins — a run whose success
        // `flush` rejected carries TWO records (exit 0 appended before the
        // flush, exit 1 appended by the failure catch) and the later one is the
        // exit that actually happened.
        const runEnd = session.events.filter((ev) => ev.type === "operator/run-end").at(-1)
        if (runEnd !== undefined) {
          row.lastRun = {
            exitCode: runEnd.exitCode,
            durationMs: runEnd.durationMs,
            ...(runEnd.error !== undefined ? { error: runEnd.error } : {}),
          }
        }
      } catch (error) {
        row.problem = `log unreadable: ${error instanceof Error ? error.message : String(error)}`
      }
      rows.push(row)
    } catch (error) {
      rows.push({ id, problem: `profile unreadable: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  // Newest first — the order a picker wants.
  return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

/** Coarse recency buckets (`just now` / `5m` / `3h` / `2d`) — the column does
 * not churn at second granularity. */
export function formatAge(ms: number | undefined, now = Date.now()): string {
  if (ms === undefined) return "—"
  const secs = Math.max(0, Math.floor((now - ms) / 1000))
  if (secs < 60) return "just now"
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** The run-end record in one cell — `ok 1.2s` / `failed exit 1 0.4s`. A session
 * with no record (older than M3 §3.4) renders an honest `—`. */
export function formatLastRun(lastRun: StoredSessionRow["lastRun"]): string {
  if (lastRun === undefined) return "—"
  return `${lastRun.exitCode === 0 ? "ok" : `failed exit ${lastRun.exitCode}`} ${(lastRun.durationMs / 1000).toFixed(1)}s`
}

/** Aligned `ID · TITLE · TURNS · UPDATED · LAST RUN` table (headers included;
 * no rows → an honest "no sessions" line, never an empty screen). */
export function renderSessionTable(rows: StoredSessionRow[], now = Date.now()): string {
  if (rows.length === 0) return "no sessions in this store"
  const titleOf = (row: StoredSessionRow): string => row.problem !== undefined ? `(${row.problem})` : row.title ?? "(untitled)"
  const turnsOf = (row: StoredSessionRow): string => row.turnCount === undefined ? "?" : String(row.turnCount)
  const ageOf = (row: StoredSessionRow): string => formatAge(row.updatedAt, now)
  const idW = Math.max(2, ...rows.map((r) => r.id.length))
  const titleW = Math.min(48, Math.max(5, ...rows.map((r) => titleOf(r).length)))
  // UPDATED still ends with LAST RUN after it, so it pads like the interior
  // columns do (the widest age, never narrower than the header).
  const ageW = Math.max(7, ...rows.map((r) => ageOf(r).length))
  const lines = [`${"ID".padEnd(idW)}  ${"TITLE".padEnd(titleW)}  ${"TURNS".padStart(5)}  ${"UPDATED".padEnd(ageW)}  LAST RUN`]
  for (const row of rows) {
    const title = titleOf(row)
    lines.push(
      `${row.id.padEnd(idW)}  ${(title.length > titleW ? `${title.slice(0, titleW - 1)}…` : title).padEnd(titleW)}  ${turnsOf(row).padStart(5)}  ${ageOf(row).padEnd(ageW)}  ${formatLastRun(row.lastRun)}`,
    )
  }
  return lines.join("\n")
}

/** A compact transcript: turn markers, user prompts, assistant text and
 * one-line tool summaries — the `show` payload. */
export function renderTranscript(session: Session, last: number): string {
  const lines: string[] = []
  for (const ev of session.events) {
    const line = transcriptLine(ev)
    if (line !== undefined) lines.push(line)
  }
  const shown = lines.slice(Math.max(0, lines.length - last))
  if (lines.length > shown.length) shown.unshift(`… ${lines.length - shown.length} earlier line(s)`)
  return shown.join("\n")
}

function transcriptLine(ev: SessionEvent): string | undefined {
  switch (ev.type) {
    case "turn/start": return "─── turn"
    case "user/message": {
      // The runtime-context snapshot is model-visible bookkeeping, not a turn
      // the user typed — keep it out of the transcript.
      if (ev.internal === true) return undefined
      return `❯ ${ev.text}`
    }
    case "assistant/message": return ev.text
    case "tool/call": return `  ◆ ${ev.name} ${oneLine(ev.args)}`
    case "tool/result": return `  → ${oneLine(ev.output).slice(0, 200)}`
    // M3 §3.4: the durable run-end record, in the transcript `show` prints.
    case "operator/run-end":
      return `── run end: exit ${ev.exitCode} · ${(ev.durationMs / 1000).toFixed(1)}s${ev.error !== undefined ? ` — ${ev.error}` : ""}`
    default: return undefined
  }
}

function oneLine(value: unknown): string {
  if (value === undefined) return ""
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim()
  try {
    return JSON.stringify(value).replace(/\s+/g, " ").trim()
  } catch {
    return String(value)
  }
}

const SESSIONS_USAGE =
  "usage: i-harness sessions [list] [--session-dir DIR] [--json]\n" +
  "       i-harness sessions show <id> [--session-dir DIR] [--last N]"

/** The command. Read-only: no ownership adoption, no writes. Returns the
 * process exit code. */
export async function runSessionsCommand(args: string[]): Promise<number> {
  const { subcommand, id, options } = parseSessionsArgs(args)
  if (subcommand === "help") {
    console.log(SESSIONS_USAGE)
    return 0
  }
  const storeRoot = options.sessionDir ?? resolveSessionStoreRoot()
  const coordinator = createSessionCoordinator(createJsonlBackend(storeRoot), { lock: { enabled: false } })
  try {
    if (subcommand === "show") {
      if (id === undefined) {
        d.error(SESSIONS_USAGE)
        return 2
      }
      let session: Session
      try {
        session = (await coordinator.load(id)).session
      } catch (error) {
        d.error(`session not found: ${id} (${error instanceof Error ? error.message : String(error)})`)
        return 1
      }
      if (options.json === true) {
        console.log(JSON.stringify({ sessionId: id, events: session.events }, null, 2))
        return 0
      }
      console.log(renderTranscript(session, options.last ?? 20))
      return 0
    }
    const rows = await listStoredSessions(coordinator, storeRoot)
    if (options.json === true) {
      console.log(JSON.stringify({ storeRoot, sessions: rows }, null, 2))
      return 0
    }
    console.log(renderSessionTable(rows))
    return 0
  } finally {
    await coordinator.close().catch(() => {})
  }
}

/** The `show` transcript's derived-message count — exported for tests to pin
 * that images/context never leak into the printed text. */
export function messageCount(session: Session): number {
  return deriveMessages(session).length
}
