import { CURRENT_FORMAT_VERSION, isContextEventType, validContextEvent, validateConversationHistory, validateConversationEventShape, type Session, type SessionEvent } from "@i-harness/core-session"
import type { SessionMeta } from "../coordinator/types.ts"
import { upgrades, isKnownEventType, SessionFormatUnsupportedError } from "./registry.ts"

export async function migrate(version: number, events: SessionEvent[], header?: Pick<SessionMeta, 'sessionId' | 'parentSession' | 'seedLength'>): Promise<SessionEvent[]> {
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
export function preflightSessionFormat(version: number, events: SessionEvent[], header?: Pick<SessionMeta, 'sessionId' | 'parentSession' | 'seedLength'>): void {
  preflightBatchShape(version, events)
  try { validateConversationHistory(events, version, header) }
  catch (cause) { throw new SessionFormatUnsupportedError("unsupported conversation history", { cause }) }
}

/** A batch may name earlier durable records. References are checked by the writer's prefix index. */
export function preflightBatchShape(version: number, events: readonly SessionEvent[]): void {
  assertVersionSupported(version)
  guardIgnorable([...events], true)
  for (const event of events) {
    try { validateConversationEventShape(event, version) }
    catch (cause) { throw new SessionFormatUnsupportedError("unsupported conversation payload", { cause }) }
    if (isContextEventType(event.type) && (version < 2 || !validContextEvent(event))) {
      throw new SessionFormatUnsupportedError(`unsupported operational payload or format for '${event.type}'`)
    }
  }
}

export function guardIgnorable(events: SessionEvent[], retainIgnorable = false): SessionEvent[] {
  const kept: SessionEvent[] = []
  for (const ev of events) {
    if (isKnownEventType(ev.type)) { kept.push(ev); continue }
    if ((ev as { ignorable?: true }).ignorable === true) {
      if (retainIgnorable) kept.push(ev)
      continue
    }
    throw new SessionFormatUnsupportedError(`unknown event type '${ev.type}' without ignorable marker`)
  }
  return kept
}

export function buildSession(meta: SessionMeta | undefined, events: SessionEvent[]): Session {
  const session: Session = { formatVersion: CURRENT_FORMAT_VERSION, events }
  if (meta && (meta.parentSession !== undefined || meta.seedLength !== undefined
    || meta.delegationDepth !== undefined || meta.origin !== undefined)) {
    session.header = {
      ...(meta.parentSession !== undefined ? { parentSession: meta.parentSession } : {}),
      ...(meta.seedLength !== undefined ? { seedLength: meta.seedLength } : {}),
      ...(meta.delegationDepth !== undefined ? { delegationDepth: meta.delegationDepth } : {}),
      ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
    }
  }
  return session
}
