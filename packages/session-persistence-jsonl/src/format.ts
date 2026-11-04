import type { SessionEvent } from "@i-harness/core-session"
import { validJournalMetadata, validateSubagentHeader } from '@i-harness/core-session'
import type { SessionMeta, SessionModelSelection } from "@i-harness/session-persistence"
// The closed set is settings' — imported, never copied (a local list of the
// five names would be a second place to edit one enum).
import { PROVIDER_PROTOCOLS, type SettingsProviderProtocol } from "@i-harness/settings"

export function serializeHeader(meta: SessionMeta): string {
  validateSubagentHeader(meta)
  if (meta.semanticSeed?.version === 3) throw new TypeError('Legacy header writer cannot install selected results')
  return JSON.stringify(meta)
}

import { captureMetadataUpdate } from './backend/metadata-snapshot.ts'

export function snapshotMetadataUpdate(previous: SessionMeta, patch: Partial<SessionMeta>): { line: string; meta: SessionMeta } {
  return captureMetadataUpdate(previous, patch, serializeHeader)
}

// C5: parseHeader passthrough — a repair/read rewrites the header line and
// must never strip a session's selected model (the title/workspaceId rule).
// Provider/model may be any non-empty string; a structurally invalid value is
// DROPPED — absent → the resolution chain falls through honestly. The protocol
// joins this passthrough for the same reason (updateMeta rewrites line 0 from
// parseHeader's output, so an unlisted field is silently deleted) and follows
// the same rule: a value outside the five settings validates is DROPPED, never
// passed through — a session must not persist a wire nobody can send on.
function parseModelSelection(raw: unknown): SessionModelSelection | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const rec = raw as Record<string, unknown>
  if (typeof rec.provider !== "string" || rec.provider === ""
    || typeof rec.model !== "string" || rec.model === "") return undefined
  return {
    provider: rec.provider,
    model: rec.model,
    ...(typeof rec.protocol === "string" && (PROVIDER_PROTOCOLS as readonly string[]).includes(rec.protocol)
      ? { protocol: rec.protocol as SettingsProviderProtocol }
      : {}),
    ...(typeof rec.reasoningEffort === "string" && rec.reasoningEffort !== ""
      ? { reasoningEffort: rec.reasoningEffort }
      : {}),
  }
}

export function parseHeader(line: string): SessionMeta {
  const h = JSON.parse(line) as Partial<SessionMeta>
  validateSubagentHeader(h)
  if (typeof h.formatVersion !== "number") throw new Error("invalid session header: missing formatVersion")
  if (typeof h.sessionId !== "string") throw new Error("invalid session header: missing sessionId")
  if ([6, 7, 8, 9, 10, 11, 12, 13, 14].includes(h.formatVersion) && !validJournalMetadata(h.journal)) throw new Error('invalid session journal metadata')
  const modelSelection = parseModelSelection(h.modelSelection)
  return {
    formatVersion: h.formatVersion,
    sessionId: h.sessionId,
    createdAt: typeof h.createdAt === "string" ? h.createdAt : "",
    ...(h.journal !== undefined ? { journal: h.journal } : {}),
    ...(typeof h.parentSession === "string" ? { parentSession: h.parentSession } : {}),
    ...(typeof h.seedLength === "number" ? { seedLength: h.seedLength } : {}),
    ...(h.semanticSeed !== undefined ? { semanticSeed: h.semanticSeed } : {}),
    ...(h.subagentProtocolVersion === 1 ? { subagentProtocolVersion: 1 as const } : {}),
    ...(typeof h.delegationDepth === "number" ? { delegationDepth: h.delegationDepth } : {}),
    ...(typeof h.origin === "string" ? { origin: h.origin } : {}),
    // C5 workspace grouping: keep workspaceId through read AND repair — a
    // repair must never strip the session's workspace membership silently.
    ...(typeof h.workspaceId === "string" ? { workspaceId: h.workspaceId } : {}),
    // C5 session title: same passthrough rule — a repair never strips it.
    ...(typeof h.title === "string" ? { title: h.title } : {}),
    ...(typeof h.archived === "boolean" ? { archived: h.archived } : {}),
    ...(modelSelection !== undefined ? { modelSelection } : {}),
  }
}

// Parse event lines up to the first torn/invalid record — the contiguous
// committed prefix (F01-2). A torn tail is a crash mid-write.
//
// ONLY the final non-empty record may be torn. An unparseable record anywhere
// earlier is corruption, not a tail: returning the prefix for it used to make
// `repair()` rewrite the file without every turn after the damage, turning a
// recoverable bit-flip into permanent data loss.
export function parseEventLines(lines: string[]): SessionEvent[] {
  let lastNonEmpty = -1
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.trim() !== "") { lastNonEmpty = index; break }
  }
  const events: SessionEvent[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim() === "") continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch {
      if (index === lastNonEmpty) break
      throw new Error(`session record ${index + 1} is not valid JSON; refusing to truncate the history silently`)
    }
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
