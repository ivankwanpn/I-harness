import { CURRENT_FORMAT_VERSION } from "../events/types.ts"
import type { Session, SessionEvent } from "../events/types.ts"
import { isContextEventType, validContextEvent } from "../events/context.ts"
import { validateConversationHistory } from "../conversation/validation.ts"

export function toJSONL(session: Session): string {
  const lines: string[] = [JSON.stringify({ formatVersion: session.formatVersion })]
  for (const ev of session.events) lines.push(JSON.stringify(ev))
  return lines.join("\n") + "\n"
}

export function assertVersion(session: Session, expected: number): number {
  if (session.formatVersion !== expected) {
    throw new Error(`session format version ${session.formatVersion} not supported (expected ${expected})`)
  }
  return session.formatVersion
}

export function fromJSONL(text: string): Session {
  if (text.trim().length === 0) {
    throw new Error("session log is empty")
  }
  const lines = text.trim().split("\n")
  const header = JSON.parse(lines[0]!) as { formatVersion?: number }
  if (header.formatVersion !== 1 && header.formatVersion !== 2 && header.formatVersion !== 3 && header.formatVersion !== CURRENT_FORMAT_VERSION) {
    throw new Error(`session format version ${header.formatVersion} not supported`)
  }
  const events = lines.slice(1).map((l) => JSON.parse(l) as SessionEvent)
  validateConversationHistory(events, header.formatVersion)
  for (const event of events) if (isContextEventType(event.type) && (header.formatVersion < 2 || !validContextEvent(event))) throw new Error("unsupported operational context payload or format")
  return { formatVersion: CURRENT_FORMAT_VERSION, events }
}

export function migrate(session: Session, targetVersion: number): Session {
  if (targetVersion !== CURRENT_FORMAT_VERSION) {
    throw new Error(`no migration path to format version ${targetVersion}`)
  }
  if (![1, 2, 3, CURRENT_FORMAT_VERSION].includes(session.formatVersion)) throw new Error("unsupported source format version")
  validateConversationHistory(session.events, session.formatVersion)
  return { ...session, formatVersion: targetVersion }
}
