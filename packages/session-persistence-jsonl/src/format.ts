import type { SessionEvent } from "@i-harness/core-session"
import type { SessionMeta } from "@i-harness/session-persistence"

export function serializeHeader(meta: SessionMeta): string {
  return JSON.stringify(meta)
}

export function parseHeader(line: string): SessionMeta {
  const h = JSON.parse(line) as Partial<SessionMeta>
  if (typeof h.formatVersion !== "number") throw new Error("invalid session header: missing formatVersion")
  if (typeof h.sessionId !== "string") throw new Error("invalid session header: missing sessionId")
  return { formatVersion: h.formatVersion, sessionId: h.sessionId, createdAt: typeof h.createdAt === "string" ? h.createdAt : "" }
}

// Parse event lines up to the first torn/invalid record — the contiguous
// committed prefix (F01-2). A torn tail is a crash mid-write.
export function parseEventLines(lines: string[]): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const line of lines) {
    if (line.trim() === "") continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { break }
    events.push(parsed as SessionEvent)
  }
  return events
}

// True if the final non-empty line is not valid JSON (a torn tail exists).
export function hasTornTail(lines: string[]): boolean {
  const nonEmpty = lines.filter((l) => l.trim() !== "")
  if (nonEmpty.length <= 1) return false
  const last = nonEmpty[nonEmpty.length - 1]!
  try { JSON.parse(last); return false } catch { return true }
}
