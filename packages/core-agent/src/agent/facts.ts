import { createNondurableFactOwner, isNondurableSession, committedFactSeqs } from '@i-harness/core-session'
import type { FactPorts, ProducerFactOutcome } from '@i-harness/core-session'
import type { AgentDeps } from './types.ts'

const memory = new WeakMap<object, FactPorts<ProducerFactOutcome>>()
export function agentFacts(deps: {session?:AgentDeps['session'];facts?:AgentDeps['facts']}): FactPorts<ProducerFactOutcome> {
  if (deps.facts) return deps.facts
  if (!deps.session||!isNondurableSession(deps.session)) throw Object.assign(new Error('Managed Agent requires owned fact ports'), { code: 'FACT_OWNER_UNSUPPORTED' })
  let facts = memory.get(deps.session)
  if (!facts) { facts = createNondurableFactOwner(deps.session).beginAction().facts; memory.set(deps.session, facts) }
  return facts
}
export { committedFactSeqs }
