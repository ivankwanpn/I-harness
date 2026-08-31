import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, join, basename } from "node:path"
import type { SessionEvent } from "@i-harness/core-session"
import type { PersistenceBackend, SessionMeta } from "@i-harness/session-persistence"
import { serializeHeader, parseHeader, parseEventLines, hasTornTail } from "./format.ts"

// C5 blank-probe cap (DSH coldBlankProbeMaxBytes parity, DSH default 1024): a
// session artifact at or under this size is read in full for the EXACT blank
// answer (no turn/start yet); a larger one is served non-blank without a read
// (honest-bounding: it may have content — never guessed blank).
const BLANK_PROBE_MAX_BYTES = 1024

export function createJsonlBackend(root: string): PersistenceBackend {
  const filePath = (id: string) => join(root, `${id}.jsonl`)
  const docPath = (key: string) => join(root, `${key}.doc.jsonl`)

  return {
    id: "jsonl",
    capabilities: { seekableRead: false, rawArtifacts: true },
    // M23: the coordinator's ownership lease defaults to the store root.
    lockRoot: root,

    async create(sessionId: string, meta: SessionMeta): Promise<void> {
      await mkdir(root, { recursive: true })
      // wx: fail if the session file already exists.
      await writeFile(filePath(sessionId), serializeHeader(meta) + "\n", { flag: "wx" })
    },

    async append(sessionId: string, events: SessionEvent[]): Promise<void> {
      const path = filePath(sessionId)
      const handle = await open(path, "r+")
      let committedBytes = 0
      try {
        committedBytes = (await handle.stat()).size
        const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n"
        await handle.write(text, committedBytes)
        await handle.sync()
      } catch (err) {
        // F01-2 rollback: truncate back to the committed byte length so a
        // clean retry never duplicates seqs.
        await handle.truncate(committedBytes).catch(() => {})
        await handle.sync().catch(() => {})
        throw err
      } finally {
        await handle.close()
      }
    },

    async read(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }> {
      const text = await readFile(filePath(sessionId), "utf-8")
      const lines = text.split("\n")
      if (lines.length === 0 || lines[0]!.trim() === "") throw new Error(`empty session file: ${sessionId}`)
      const header = parseHeader(lines[0]!)
      const events = parseEventLines(lines.slice(1))
      return { version: header.formatVersion, events, meta: header }
    },

    async list(): Promise<string[]> {
      const names = await readdir(root).catch(() => [] as string[])
      // Skip `.doc.jsonl` document sidecars — they are not sessions.
      return names
        .filter((n) => n.endsWith(".jsonl") && !n.endsWith(".doc.jsonl"))
        .map((n) => basename(n, ".jsonl"))
    },

    async repair(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }> {
      const path = filePath(sessionId)
      const text = await readFile(path, "utf-8")
      const lines = text.split("\n")
      const header = parseHeader(lines[0]!)
      const events = parseEventLines(lines.slice(1))
      const torn = hasTornTail(lines.slice(1))
      const closers = missingClosers(events)
      if (torn || closers.length > 0) {
        const handle = await open(path, "r+")
        try {
          await handle.truncate(0)
          await handle.write(serializeHeader(header) + "\n")
          for (const ev of [...events, ...closers]) await handle.write(JSON.stringify(ev) + "\n")
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      return { version: header.formatVersion, events: [...events, ...closers], meta: header }
    },

    async profile(sessionId) {
      const path = filePath(sessionId)
      // Blank probe (coldBlankProbeMaxBytes policy): a small artifact is read
      // whole for the exact answer; a big one is served non-blank.
      if ((await stat(path)).size <= BLANK_PROBE_MAX_BYTES) {
        const lines = (await readFile(path, "utf-8")).split("\n")
        return {
          meta: parseHeader(lines[0]!),
          blank: parseEventLines(lines.slice(1)).every((ev) => ev.type !== "turn/start"),
        }
      }
      return { meta: await readHeader(path), blank: false }
    },

    async updateMeta(sessionId, patch) {
      const path = filePath(sessionId)
      // Header rewrite: replace line 0 only; event lines are kept byte-exact
      // (a torn tail is preserved as-is, repair's business). Atomic temp +
      // rename (putDocument pattern) — a concurrent reader sees either the
      // old or the new file, never a truncated one.
      const text = await readFile(path, "utf-8")
      const lines = text.split("\n")
      if (lines.length === 0 || lines[0]!.trim() === "") {
        throw new Error(`empty session file: ${sessionId}`)
      }
      const merged: SessionMeta = { ...parseHeader(lines[0]!), ...patch }
      const out = lines.slice()
      out[0] = serializeHeader(merged)
      const tmp = `${path}.${randomUUID()}.tmp`
      await writeFile(tmp, out.join("\n"), { encoding: "utf-8" })
      await rename(tmp, path)
      return merged
    },

    async putDocument(key: string, data: unknown): Promise<void> {
      await mkdir(root, { recursive: true })
      const path = docPath(key)
      // Namespaced keys ("session-title/<id>") live in a subdirectory of the
      // store root — create it so nested doc keys work (top-level listings
      // stay clean: the subdir never matches `*.jsonl`).
      await mkdir(dirname(path), { recursive: true })
      // Atomic write: temp file + rename so concurrent saves never
      // interleave/truncate the sidecar. A transient `<uuid>.tmp` matches
      // neither `*.jsonl` nor `*.doc.jsonl`, so list() stays correct.
      const tmp = `${path}.${randomUUID()}.tmp`
      await writeFile(tmp, JSON.stringify(data) + "\n", { encoding: "utf-8" })
      await rename(tmp, path)
    },
    async getDocument(key: string): Promise<unknown | undefined> {
      const text = await readFile(docPath(key), "utf-8").catch(() => undefined)
      if (text === undefined) return undefined
      return JSON.parse(text) as unknown
    },
  }
}

// C5 header-only read (profile on a large artifact): the header is always
// line 0 and bounded (ids ~40 chars, titles capped at 200), so reading one
// 64 KiB window never touches the event body of a multi-megabyte log.
const HEADER_READ_MAX_BYTES = 64 * 1024

async function readHeader(path: string): Promise<SessionMeta> {
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(HEADER_READ_MAX_BYTES)
    await handle.read(buffer, 0, HEADER_READ_MAX_BYTES, 0)
    // Unread tail is zeros, so a newline found anywhere was inside the window.
    const end = buffer.indexOf(0x0a, 0) // "\n"
    const line = (end === -1 ? buffer : buffer.subarray(0, end)).toString("utf8")
    return parseHeader(line)
  } finally {
    await handle.close()
  }
}

// Track turn/step nesting; a session stopped inside either gets synthetic
// closers so deriveMessages() reconstructs normally (F01-2 commitRepair).
function missingClosers(events: SessionEvent[]): SessionEvent[] {
  let inTurn = false
  let inStep = false
  for (const ev of events) {
    if (ev.type === "turn/start") inTurn = true
    if (ev.type === "step/start") inStep = true
    if (ev.type === "step/end") inStep = false
    if (ev.type === "turn/end") inTurn = false
  }
  const closers: SessionEvent[] = []
  if (inStep) closers.push({ type: "step/end" })
  if (inTurn) closers.push({ type: "turn/end" })
  return closers
}
