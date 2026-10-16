import { CURRENT_FORMAT_VERSION } from "../events/types.ts"
import type { Session, SessionEvent } from "../events/types.ts"
import { isContextEventType, validContextEvent } from "../events/context.ts"
import { validateConversationHistory } from "../conversation/validation.ts"
import { validateNativeWitness } from '../projection/native-witness.ts'
import { encodeFactBatch, legacyPrefixDigest, readFactJournal, validJournalMetadata } from './fact-journal.ts'
import type { JournalMetadata } from '../managed/types.ts'
import { stringifyJsonData } from './json-data.ts'

export function toJSONL(session: import('../managed/types.ts').SessionView): string {
  if (session.formatVersion === 6 || session.formatVersion === 7) {
    validateConversationHistory(session.events, session.formatVersion)
    const journal: JournalMetadata = { version: 1, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 }
    const header = stringifyJsonData({ ...session.header, formatVersion: session.formatVersion, journal })! + '\n'
    return header + (session.events.length ? Buffer.from(encodeFactBatch('structural-export', journal.legacyPrefixDigest, session.events).bytes).toString('utf8') : '')
  }
  const lines: string[] = [JSON.stringify({ formatVersion: session.formatVersion })]
  for (const ev of session.events) { validateNativeWitness(ev, session.formatVersion); lines.push(JSON.stringify(ev)) }
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
  const lines = text.split("\n")
  const header = JSON.parse(lines[0]!) as { formatVersion?: number; journal?: JournalMetadata }
  if (typeof header.formatVersion !== 'number' || ![1, 2, 3, 4, 5, 6, CURRENT_FORMAT_VERSION].includes(header.formatVersion)) {
    throw new Error(`session format version ${header.formatVersion} not supported`)
  }
  if ([6, 7].includes(header.formatVersion) && !validJournalMetadata(header.journal)) throw new TypeError('Invalid fact journal header')
  const events = [6, 7].includes(header.formatVersion)
    ? readFactJournal(Buffer.from(lines.slice(1).join('\n')), header.journal!, header.formatVersion).events
    : lines.slice(1).filter(line => line.trim()).map((l) => JSON.parse(l) as SessionEvent)
  validateConversationHistory(events, header.formatVersion)
  for (const event of events) if (isContextEventType(event.type) && (header.formatVersion < 2 || !validContextEvent(event))) throw new Error("unsupported operational context payload or format")
  const { formatVersion: _format, ...metadata } = header
  return { formatVersion: CURRENT_FORMAT_VERSION, events, ...(Object.keys(metadata).length ? { header: metadata } : {}) }
}

export function migrate(session: Session, targetVersion: number): Session {
  if (targetVersion !== CURRENT_FORMAT_VERSION) {
    throw new Error(`no migration path to format version ${targetVersion}`)
  }
  if (![1, 2, 3, 4, 5, 6, CURRENT_FORMAT_VERSION].includes(session.formatVersion)) throw new Error("unsupported source format version")
  validateConversationHistory(session.events, session.formatVersion)
  return { ...session, formatVersion: targetVersion }
}
