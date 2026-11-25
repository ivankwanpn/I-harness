import { validateSubagentHeader } from "@i-harness/core-session"
import { CURRENT_FORMAT_VERSION, isContextEventType, validContextEvent, validateConversationHistory, validateConversationEventShape, type Session, type SessionEvent } from "@i-harness/core-session"
import type { SessionMeta } from "../coordinator/types.ts"
import { upgrades, isKnownEventType, SessionFormatUnsupportedError } from "./registry.ts"

export async function migrate(version: number, events: SessionEvent[], header?: Pick<SessionMeta, 'sessionId' | 'parentSession' | 'seedLength' | 'semanticSeed'>): Promise<SessionEvent[]> {
  let v = version
  let result = events
  while (v < CURRENT_FORMAT_VERSION) {
    const up = upgrades.get(v)
    if (!up) throw new SessionFormatUnsupportedError(`no upgrade path from format version ${v} to ${CURRENT_FORMAT_VERSION}`)
    result = up(result)
    v += 1
  }
  if (v > CURRENT_FORMAT_VERSION) {
    throw new SessionFormatUnsupportedError(`format version ${v} is newer than this build (upgrade the harness)`)
  }
  preflightSessionFormat(CURRENT_FORMAT_VERSION, result, header)
  return result
}

// F01-7: refuse unsupported versions BEFORE the backend's repair can
// structurally decode + rewrite a foreign-version file. Read is
// non-destructive (torn-tail tolerant, never mutates); repair may truncate
// + rewrite, so it is only reached once the version gate has passed.
export function assertVersionSupported(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) throw new SessionFormatUnsupportedError("invalid session format version")
  if (version > CURRENT_FORMAT_VERSION) {
    throw new SessionFormatUnsupportedError(`format version ${version} is newer than this build (upgrade the harness)`)
  }
  let v = version
  while (v < CURRENT_FORMAT_VERSION) {
    if (!upgrades.has(v)) {
      throw new SessionFormatUnsupportedError(`no upgrade path from format version ${v} to ${CURRENT_FORMAT_VERSION}`)
    }
    v += 1
  }
}

/** Validate the committed prefix before any structural repair, and again under ownership. */
export function preflightSessionFormat(version: number, events: SessionEvent[], header?: Pick<SessionMeta, 'sessionId' | 'parentSession' | 'seedLength' | 'semanticSeed'>): void {
  preflightBatchShape(version, events)
  try { validateConversationHistory(events, version, header) }
  catch (cause) { throw new SessionFormatUnsupportedError("unsupported conversation history", { cause }) }
}

/** A batch may name earlier durable records. References are checked by the writer's prefix index. */
export function preflightBatchShape(version: number, events: readonly SessionEvent[]): void {
  preflightEventPayloads(version, events, true)
}

/** Call only after readFactJournal has validated each shape and the full conversation. */
export function preflightDecodedFactHistory(version: number, events: readonly SessionEvent[]): void {
  preflightEventPayloads(version, events, false)
}

function preflightEventPayloads(version: number, events: readonly SessionEvent[], checkConversationShape: boolean): void {
  assertVersionSupported(version)
  for (const event of events) isRegisteredEvent(event)
  for (const event of events) {
    if (checkConversationShape) {
      try { validateConversationEventShape(event, version) }
      catch (cause) { throw new SessionFormatUnsupportedError("unsupported conversation payload", { cause }) }
    }
    if (isContextEventType(event.type) && (version < 2 || !validContextEvent(event))) {
      throw new SessionFormatUnsupportedError(`unsupported operational payload or format for '${event.type}'`)
    }
  }
}

function isRegisteredEvent(event: SessionEvent): boolean {
  if (isKnownEventType(event.type)) return true
  if ((event as { ignorable?: true }).ignorable === true) return false
  throw new SessionFormatUnsupportedError(`unknown event type '${event.type}' without ignorable marker`)
}

export function guardIgnorable(events: SessionEvent[], retainIgnorable = false): SessionEvent[] {
  const kept: SessionEvent[] = []
  for (const event of events) if (isRegisteredEvent(event) || retainIgnorable) kept.push(event)
  return kept
}

export function buildSession(meta: SessionMeta | undefined, events: SessionEvent[]): Session {
  validateSubagentHeader(meta)
  const session: Session = { formatVersion: CURRENT_FORMAT_VERSION, events }
  if (meta && (meta.parentSession !== undefined || meta.seedLength !== undefined || meta.semanticSeed !== undefined
    || meta.delegationDepth !== undefined || meta.subagentTaskId !== undefined || meta.subagentAgentPath !== undefined || meta.origin !== undefined
    || meta.archived !== undefined || meta.forkPublication !== undefined)) {
    session.header = {
      ...(meta.parentSession !== undefined ? { parentSession: meta.parentSession } : {}),
      ...(meta.seedLength !== undefined ? { seedLength: meta.seedLength } : {}),
      ...(meta.semanticSeed !== undefined ? { semanticSeed: meta.semanticSeed } : {}),
      ...(meta.subagentProtocolVersion === 1 ? { subagentProtocolVersion: 1 as const } : {}),
      ...(meta.subagentTaskId !== undefined ? { subagentTaskId: meta.subagentTaskId } : {}),
      ...(meta.subagentAgentPath !== undefined ? { subagentAgentPath: meta.subagentAgentPath } : {}),
      ...(meta.delegationDepth !== undefined ? { delegationDepth: meta.delegationDepth } : {}),
      ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
      ...(meta.archived !== undefined ? { archived: meta.archived } : {}),
      ...(meta.forkPublication !== undefined ? { forkPublication: meta.forkPublication } : {}),
    }
  }
  return session
}
