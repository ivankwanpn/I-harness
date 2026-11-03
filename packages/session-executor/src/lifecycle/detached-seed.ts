import { captureLegacyFact, type Session, type SessionView } from '@i-harness/core-session'
import { remapConversationSeed } from '@i-harness/session-persistence'

/** Compile only semantic seed content. New derived-input links require a target
 * whose seed header was already established by its create owner. */
export function compileDetachedSeed(source: Session) {
  const captured = captureLegacyFact(source)
  if (captured.kind !== 'captured') throw Object.assign(new Error('Detached session capture failed'), { code: 'FACT_CAPTURE_FAILED' })
  const value = captured.value
  const events = remapConversationSeed({ source: value.events, retained: value.events, sourceFormat: value.formatVersion, sourceHeader: value.header })
  const sourceId = value.header && Object.getOwnPropertyDescriptor(value.header, 'sessionId')?.value
  return { events, assertTarget(target: SessionView) {
    if (target.events.length) throw new Error('Detached import requires an empty owned document')
    if (events.some(event => event.type === 'user/message' && event.seedInputContext)
      && (typeof sourceId !== 'string' || !sourceId || target.header?.parentSession !== sourceId || target.header.seedLength !== events.length)) {
      throw Object.assign(new Error('Prepared semantic detached import requires a predeclared exact seed prefix and source lineage'), { code: 'FACT_OWNER_UNSUPPORTED' })
    }
  } }
}
