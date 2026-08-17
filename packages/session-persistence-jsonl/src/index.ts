import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises"
import { join, basename } from "node:path"
import type { SessionEvent } from "@i-harness/core-session"
import type { PersistenceBackend, SessionMeta } from "@i-harness/session-persistence"
import { serializeHeader, parseHeader, parseEventLines, hasTornTail } from "./format.ts"

export function createJsonlBackend(root: string): PersistenceBackend {
  const filePath = (id: string) => join(root, `${id}.jsonl`)

  return {
    id: "jsonl",
    capabilities: { seekableRead: false, rawArtifacts: true },

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

    async read(sessionId: string): Promise<{ version: number; events: SessionEvent[] }> {
      const text = await readFile(filePath(sessionId), "utf-8")
      const lines = text.split("\n")
      if (lines.length === 0 || lines[0]!.trim() === "") throw new Error(`empty session file: ${sessionId}`)
      const header = parseHeader(lines[0]!)
      const events = parseEventLines(lines.slice(1))
      return { version: header.formatVersion, events }
    },

    async list(): Promise<string[]> {
      const names = await readdir(root).catch(() => [] as string[])
      return names.filter((n) => n.endsWith(".jsonl")).map((n) => basename(n, ".jsonl"))
    },

    async repair(sessionId: string): Promise<{ version: number; events: SessionEvent[] }> {
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
      return { version: header.formatVersion, events: [...events, ...closers] }
    },
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
