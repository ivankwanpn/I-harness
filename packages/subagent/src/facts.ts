import { createNondurableFactOwner, isManagedFactOwner, isNondurableSession, type FactOwner, type SessionView } from '@i-harness/core-session'

export function subagentFactOwner(session: SessionView, supplied?: FactOwner): FactOwner {
  if (supplied?.view === session && (isNondurableSession(session) || isManagedFactOwner(session, supplied))) return supplied
  if (!supplied && isNondurableSession(session)) return createNondurableFactOwner(session)
  throw Object.assign(new Error('Subagent requires matching owned facts'), { code: 'FACT_OWNER_UNSUPPORTED' })
}
