import { captureFactGroup, type BatchKey, type CapturedFactGroup, type CapturedSettlementFact, type FactGroupDraft, type FactOutcome } from '@i-harness/core-session'

/** Source retains this once-lowered capture with its real outcome slot. The
 * serialized handle consumes success and never treats uncertainty as absence. */
export function captureSettlementFact(draft: FactGroupDraft, operations: {
  assertHeld(): void
  admit(group: CapturedFactGroup): Promise<FactOutcome>
  reconcile(key: BatchKey): Promise<FactOutcome>
  status(group: CapturedFactGroup): FactOutcome | undefined
  quarantineCapture(): void
}): CapturedSettlementFact {
  return retainSettlementCapture(captureFactGroup(draft), operations)
}
export function retainSettlementCapture(capture: ReturnType<typeof captureFactGroup>, operations: Parameters<typeof captureSettlementFact>[1]): CapturedSettlementFact {
  if (capture.kind !== 'captured') operations.quarantineCapture()
  let latest: FactOutcome | undefined, serial = Promise.resolve()
  const track = (work: () => Promise<FactOutcome>): Promise<FactOutcome> => {
    const result = serial.then(work)
    serial = result.then(() => {}, () => {})
    return result
  }
  const admit = async () => {
    operations.assertHeld()
    if (capture.kind !== 'captured') return capture
    latest = operations.status(capture.group) ?? latest
    if (latest && latest.kind !== 'not-issued') return latest
    latest = await operations.admit(capture.group)
    return latest
  }
  return {
    observe: () => track(async () => {
      operations.assertHeld()
      if (capture.kind !== 'captured') return capture
      latest = operations.status(capture.group) ?? latest
      return latest ?? { kind: 'not-issued', code: 'FACT_RECOVERY_REQUIRED' }
    }),
    admit: () => track(admit),
    reconcile: () => track(async () => {
      operations.assertHeld()
      if (capture.kind === 'captured') latest = operations.status(capture.group) ?? latest
      if (!latest || latest.kind === 'not-issued') return admit()
      if (latest.kind === 'committed' || latest.kind === 'absent') return latest
      const key = latest.kind === 'recovery-required' ? latest.receipt.key : latest.key
      latest = await operations.reconcile(key)
      return latest
    }),
    retryAbsent: () => track(async () => {
      operations.assertHeld()
      if (capture.kind !== 'captured') return capture
      if (latest?.kind !== 'absent') return latest ?? { kind: 'not-issued', code: 'FACT_INVALID_GROUP' }
      latest = await operations.admit(capture.group)
      return latest
    }),
  }
}
