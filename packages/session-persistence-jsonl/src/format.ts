import type { SessionEvent } from "@i-harness/core-session"
import type { SessionMeta, SessionModelSelection } from "@i-harness/session-persistence"

export function serializeHeader(meta: SessionMeta): string {
  return JSON.stringify(meta)
}

// C5: parseHeader passthrough — a repair/read rewrites the header line and
// must never strip a session's selected model (the title/workspaceId rule).
// Provider/model may be any non-empty string; a structurally invalid value is
// DROPPED — absent → the resolution chain falls through honestly.
function parseModelSelection(raw: unknown): SessionModelSelection | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.provider !== "string" || rec.provider === ""
    || typeof rec.model !== "string" || rec.model === "") return undefined
  return {
    provider: rec.provider,
    model: rec.model,
    ...(typeof rec.reasoningEffort === "string" && rec.reasoningEffort !== ""
      ? { reasoningEffort: rec.reasoningEffort }
      : {}),
  }
}

export function parseHeader(line: string): SessionMeta {
  const h = JSON.parse(line) as Partial<SessionMeta>
  if (typeof h.formatVersion !== "number") throw new Error("invalid session header: missing formatVersion")
  if (typeof h.sessionId !== "string") throw new Error("invalid session header: missing sessionId")
  const modelSelection = parseModelSelection(h.modelSelection)
  return {
    formatVersion: h.formatVersion,
    sessionId: h.sessionId,
    createdAt: typeof h.createdAt === "string" ? h.createdAt : "",
    ...(typeof h.parentSession === "string" ? { parentSession: h.parentSession } : {}),
    ...(typeof h.seedLength === "number" ? { seedLength: h.seedLength } : {}),
    ...(typeof h.delegationDepth === "number" ? { delegationDepth: h.delegationDepth } : {}),
    ...(typeof h.origin === "string" ? { origin: h.origin } : {}),
    // C5 workspace grouping: keep workspaceId through read AND repair — a
    // repair must never strip the session's workspace membership silently.
    ...(typeof h.workspaceId === "string" ? { workspaceId: h.workspaceId } : {}),
    // C5 session title: same passthrough rule — a repair never strips it.
    ...(typeof h.title === "string" ? { title: h.title } : {}),
    ...(modelSelection !== undefined ? { modelSelection } : {}),
  }
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
  if (nonEmpty.length === 0) return false
  const last = nonEmpty[nonEmpty.length - 1]!
  try { JSON.parse(last); return false } catch { return true }
}
