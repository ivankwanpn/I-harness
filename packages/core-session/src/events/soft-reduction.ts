import { scalarCount, scalarDigest, scalarFields, scalarId } from './attribution.ts'
import type { SeqRef } from '../managed/types.ts'
import { isStrictFactData } from '../managed/capture.ts'
export interface SoftReductionStart {
  type: 'context/soft-reduction'; version: 1; op: 'start'; seq?: number
  ownerSessionId: string; sequenceId: string; workKey: string; sourceKey: string; protectionKey: string; policyKey: string
  acceptedExchanges: number; humanTurns: number
}
export interface SoftReductionTerminal {
  type: 'context/soft-reduction'; version: 1; op: 'terminal'; seq?: number
  ownerSessionId: string; sequenceId: string; startSeq: number; workKey: string; sourceKey: string
  outcome: 'failed' | 'blocked' | 'unchanged' | 'reduced-over-target' | 'target-ready' | 'canceled'
  publication: 'none' | 'committed'; consumedBeforeKey: string; consumedAfterKey?: string
}
export type SoftReductionEvent = SoftReductionStart | SoftReductionTerminal
export type SoftReductionTerminalDraft = Omit<SoftReductionTerminal, 'seq' | 'startSeq'> & { startSeq: Extract<SeqRef<'context/soft-reduction'>, { kind: 'prior' }> }
const enumOf = (...values: unknown[]) => (v: unknown) => values.includes(v)
export function validSoftReductionEvent(value: unknown): value is SoftReductionEvent {
  if (!isStrictFactData(value)) return false
  const common = { type: enumOf('context/soft-reduction'), version: enumOf(1), ownerSessionId: scalarId, sequenceId: scalarId, workKey: scalarDigest, sourceKey: scalarDigest }
  if (scalarFields(value, { ...common, op: enumOf('start'), protectionKey: scalarDigest, policyKey: scalarDigest, acceptedExchanges: scalarCount, humanTurns: scalarCount }, { seq: scalarCount })) return true
  if (!scalarFields(value, { ...common, op: enumOf('terminal'), startSeq: scalarCount,
    outcome: enumOf('failed', 'blocked', 'unchanged', 'reduced-over-target', 'target-ready', 'canceled'), publication: enumOf('none', 'committed'), consumedBeforeKey: scalarDigest },
  { seq: scalarCount, consumedAfterKey: scalarDigest })) return false
  const event = value as SoftReductionTerminal
  return event.workKey === event.consumedBeforeKey && (event.publication === 'committed'
    ? ['reduced-over-target', 'target-ready'].includes(event.outcome) && event.consumedAfterKey !== undefined
    : !['reduced-over-target', 'target-ready'].includes(event.outcome) && event.consumedAfterKey === undefined)
}
export function validSoftTerminalDraft(value: unknown): value is SoftReductionTerminalDraft {
  if (!value || typeof value !== 'object' || !isStrictFactData(value)) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some(d => !('value' in d))) return false
  const ref = descriptors.startSeq?.value
  return scalarFields(ref, { kind: enumOf('prior'), seq: scalarCount, expectedType: enumOf('context/soft-reduction') })
    && validSoftReductionEvent({ ...value, startSeq: ref.seq }) && !Object.hasOwn(value, 'seq')
}
