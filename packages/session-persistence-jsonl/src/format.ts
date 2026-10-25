import type { SessionEvent } from "@i-harness/core-session"
import { canonicalJsonData, isStrictFactData, validJournalMetadata, validateSubagentHeader } from '@i-harness/core-session'
import type { SessionMeta, SessionModelSelection } from "@i-harness/session-persistence"
// The closed set is settings' — imported, never copied (a local list of the
// five names would be a second place to edit one enum).
import { PROVIDER_PROTOCOLS, type SettingsProviderProtocol } from "@i-harness/settings"

export function serializeHeader(meta: SessionMeta): string {
  validateSubagentHeader(meta)
  return JSON.stringify(meta)
}

/** Public metadata edits cannot mint or change a semantic birth reservation.
 * Inspect protected descriptors before the later merge/serializer can read them;
 * the preserved body (including a torn tail) is deliberately not parsed here. */
function protectedMetadataKeys(previous: SessionMeta): string[] {
  return ['formatVersion', 'journal', 'semanticSeed', ...(previous.semanticSeed === undefined ? []
    : ['seedLength', 'parentSession', 'origin', 'delegationDepth', 'subagentProtocolVersion', 'sessionId', 'createdAt'])]
}
function protectedMetadataError(key: string): Error {
  return new Error(key === 'formatVersion' ? 'format changes require durable upgrade; downgrade refused'
    : key === 'journal' ? 'Journal metadata changes require fenced recovery' : 'Protected session metadata changes require a qualified owner')
}
function assertMetadataUpdate(previous: SessionMeta, patch: Partial<SessionMeta>, protectedKeys: readonly string[]): void {
  for (const key of protectedKeys) {
    const field = Object.getOwnPropertyDescriptor(patch, key)
    if (!field) continue
    if (!field.enumerable || !('value' in field) || !isStrictFactData(field.value)) throw new TypeError('Invalid protected session metadata')
    const old = (previous as unknown as Record<string, unknown>)[key], next = field.value
    const equal = Object.is(old, next) || old !== undefined && next !== undefined && canonicalJsonData(old) === canonicalJsonData(next)
    if (!equal) throw protectedMetadataError(key)
  }
}

/** Bind the exact final serialized header to expectations captured before any
 * ordinary getter/toJSON callback. No caller-owned aliases or callbacks remain
 * after the final comparison; the writer uses this line and detached data. */
export function snapshotMetadataUpdate(previous: SessionMeta, patch: Partial<SessionMeta>): { line: string; meta: SessionMeta } {
  const keys = protectedMetadataKeys(previous), old = previous as unknown as Record<string, unknown>
  const expected = keys.map(key => ({ key, present: Object.hasOwn(previous, key), encoded: canonicalJsonData(old[key]) }))
  assertMetadataUpdate(previous, patch, keys)
  const line = serializeHeader({ ...previous, ...patch })
  if (typeof line !== 'string') throw new TypeError('Invalid session metadata snapshot')
  const meta = JSON.parse(line) as SessionMeta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new TypeError('Invalid session metadata snapshot')
  const actual = meta as unknown as Record<string, unknown>
  for (const field of expected) if (Object.hasOwn(meta, field.key) !== field.present || canonicalJsonData(actual[field.key]) !== field.encoded) throw protectedMetadataError(field.key)
  validateSubagentHeader(meta)
  return { line, meta }
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
  if ([6, 7, 8, 9, 10, 11, 12, 13].includes(h.formatVersion) && !validJournalMetadata(h.journal)) throw new Error('invalid session journal metadata')
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
