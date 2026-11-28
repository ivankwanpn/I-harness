import { validateDeliveryFrame } from '../conversation/delivery.ts'
import { validateSubagentHeader } from "../events/header.ts"
import { CURRENT_FORMAT_VERSION } from "../events/types.ts"
import type { Session, SessionEvent, SessionHeader } from "../events/types.ts"
import { isContextEventType, validContextEvent } from "../events/context.ts"
import { validateConversationHistory } from "../conversation/validation.ts"
import { validateNativeWitness } from '../projection/native-witness.ts'
import { assertLegacyJournalEvent, encodeFactBatch, legacyPrefixDigest, readFactJournal, validJournalMetadata } from './fact-journal.ts'
import type { JournalMetadata } from '../managed/types.ts'
import { stringifyJsonData } from './json-data.ts'

const supportedVersion = (version: number) => Number.isSafeInteger(version) && version >= 1 && version <= CURRENT_FORMAT_VERSION
const firstJournalVersion = 6

function legacyHeader(eventCount: number, body: string): JournalMetadata {
  const bytes = Buffer.from(body)
  return { version: 1, legacyBodyBytes: bytes.length, legacyEventCount: eventCount, legacyPrefixDigest: legacyPrefixDigest(eventCount, bytes), separatorBytes: 0 }
}

function legacyBody(events: import('../managed/types.ts').SessionView['events']): string {
  return events.map(event => {
    assertLegacyJournalEvent(event)
    return stringifyJsonData(event) + '\n'
  }).join('')
}

export function toJSONL(session: import('../managed/types.ts').SessionView): string {
  validateSubagentHeader(session.header)
  if (!supportedVersion(session.formatVersion)) throw new Error('unsupported source format version')
  const { journal: sourceJournal, formatVersion: _sourceFormat, ...metadata } = session.header as (SessionHeader & { formatVersion?: number }) ?? {}
  if (session.formatVersion >= firstJournalVersion) {
    if (sourceJournal && (!validJournalMetadata(sourceJournal) || sourceJournal.legacyEventCount > session.events.length)) throw new TypeError('Invalid source journal header')
    const legacyCount = sourceJournal?.legacyEventCount ?? 0
    const prefix = legacyCount ? legacyBody(session.events.slice(0, legacyCount)) : ''
    const staged = legacyCount ? session.events.slice(legacyCount) : session.events
    if (staged.length && staged[0]!.seq !== legacyCount) throw new TypeError('Invalid fact journal sequence')
    validateDeliveryFrame(staged,session.formatVersion)
    validateConversationHistory(session.events, session.formatVersion, session.header)
    const journal = legacyHeader(legacyCount, prefix)
    const header = stringifyJsonData({ formatVersion: session.formatVersion, ...metadata, journal })! + '\n'
    return header + prefix + (staged.length ? Buffer.from(encodeFactBatch('structural-export', journal.legacyPrefixDigest, staged).bytes).toString('utf8') : '')
  }
  const lines = [JSON.stringify({ formatVersion: session.formatVersion, ...metadata })]
  for (const event of session.events) {
    validateNativeWitness(event, session.formatVersion)
    lines.push(JSON.stringify(event))
  }
  return lines.join('\n') + '\n'
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
  const end = text.indexOf('\n')
  const header = JSON.parse(end < 0 ? text : text.slice(0,end)) as SessionHeader & { formatVersion?: number; sessionId?: string }
  validateSubagentHeader(header)
  if (typeof header.formatVersion !== 'number' || !supportedVersion(header.formatVersion)) {
    throw new Error(`session format version ${header.formatVersion} not supported`)
  }
  const framed = header.formatVersion >= firstJournalVersion
  if (framed && !validJournalMetadata(header.journal)) throw new TypeError('Invalid fact journal header')
  const body = end < 0 ? '' : text.slice(end + 1)
  const events = framed
    ? readFactJournal(Buffer.from(body), header.journal!, header.formatVersion, header).events
    : body.split('\n').filter(line => line.trim()).map((line) => JSON.parse(line) as SessionEvent)
  validateConversationHistory(events, header.formatVersion, header)
  for (const event of events) if (isContextEventType(event.type) && (header.formatVersion < 2 || !validContextEvent(event))) throw new Error("unsupported operational context payload or format")
  const { formatVersion: _format, ...metadata } = header
  if (!framed) {
    events.forEach(assertLegacyJournalEvent)
    delete metadata.journal
    if (events.length) metadata.journal = legacyHeader(events.length, body)
  }
  return { formatVersion: CURRENT_FORMAT_VERSION, events, ...(Object.keys(metadata).length ? { header: metadata } : {}) }
}

export function migrate(session: Session, targetVersion: number): Session {
  validateSubagentHeader(session.header)
  if (targetVersion !== CURRENT_FORMAT_VERSION) {
    throw new Error(`no migration path to format version ${targetVersion}`)
  }
  if (!supportedVersion(session.formatVersion)) throw new Error("unsupported source format version")
  validateConversationHistory(session.events, session.formatVersion, session.header)
  if (session.formatVersion < firstJournalVersion && session.events.length) {
    const journal = legacyHeader(session.events.length, legacyBody(session.events))
    return { ...session, formatVersion: targetVersion, header: { ...session.header, journal } }
  }
  return { ...session, formatVersion: targetVersion }
}
