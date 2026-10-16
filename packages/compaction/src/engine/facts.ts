import { createNondurableFactOwner, isNondurableSession, type LegacyCompactionFacts, type ProducerFactOutcome, type SessionView } from '@i-harness/core-session'

/** Existing summary/prune/reset policy publishes ordinary groups. This port
 * does not qualify selection/target policy or activate replacement records. */
export function ordinaryCompactionFacts(session: SessionView, supplied?: () => LegacyCompactionFacts<ProducerFactOutcome>) {
  if (supplied) return supplied()
  if (!isNondurableSession(session)) throw Object.assign(new Error('Managed compaction requires owned fact ports'), { code: 'FACT_OWNER_UNSUPPORTED' })
  return createNondurableFactOwner(session).beginAction().facts.compaction
}
