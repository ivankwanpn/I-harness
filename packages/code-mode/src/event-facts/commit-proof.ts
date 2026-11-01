import type { ProducerFactOutcome, CapturedActionFact, SettlementFacts } from '@i-harness/core-session'
import type { Pending } from './state.ts'
const originals = new WeakMap<object, Readonly<{ event: NonNullable<Pending['originalEvent']>; outcome: ProducerFactOutcome; fact: CapturedActionFact<ProducerFactOutcome>; source: SettlementFacts<ProducerFactOutcome> }>>()
/** Queue-constructor plumbing only; no public/model capture endpoint. */
export function bindOriginalCodeCommit(record: Pending, outcome: ProducerFactOutcome) {
  if (!record.originalEvent || !record.fact || !record.source) return
  const existing = originals.get(record)
  if (existing && (existing.fact !== record.fact || existing.outcome !== outcome || existing.source !== record.source)) throw new Error('Original Code commit changed')
  originals.set(record, Object.freeze({ event: record.originalEvent, outcome, fact: record.fact, source: record.source }))
}
export function originalCodeCommit(record: object) {
  const proof = originals.get(record)
  if (!proof) throw new Error('Original Code queue commit required')
  return proof
}
