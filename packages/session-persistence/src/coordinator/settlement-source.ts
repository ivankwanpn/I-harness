import { validSettlementEvent, type SettlementEventKind, type BatchKey, type CapturedFactGroup, type FactGroupDraft, type FactOutcome, type SettlementFacts } from '@i-harness/core-session'
import { retainSettlementCapture } from './settlement-fact.ts'
import { createSourceFacts } from './source-facts.ts'

/** An already-registered real source retains its drain and capture handles
 * through failure. Successful release removes completed outcome retention. */
export function createSettlementSource(drain: () => Promise<void>, operations: {
  assertHeld(): void
  admitCaptured(group: CapturedFactGroup): Promise<FactOutcome>
  reconcile(key: BatchKey): Promise<FactOutcome>
  status(group: CapturedFactGroup): FactOutcome | undefined
  quarantineCapture(): void
}, released: () => void, reconcilePending?: () => Promise<void>): SettlementFacts {
  let active = true, closing: Promise<void> | undefined
  const assertHeld = () => {
    operations.assertHeld()
    if (!active) throw Object.assign(new Error('Settlement source is closed'), { code: 'FACT_CLOSED' })
  }
  const retained = { assertHeld, admit: operations.admitCaptured, reconcile: operations.reconcile, status: operations.status, quarantineCapture: operations.quarantineCapture }
  const records = createSourceFacts(retained)
  const capture = (kind: SettlementEventKind, event: unknown, group: FactGroupDraft) => {
    assertHeld()
    return validSettlementEvent(kind, event) ? records.capture(group)
      : records.retain(retainSettlementCapture({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' }, retained))
  }
  const close = () => {
    if (!active) return Promise.resolve()
    if (closing) return closing
    const pending = (async () => {
      const errors: unknown[] = []
      assertHeld()
      try { await reconcilePending?.(); assertHeld() } catch (error) { errors.push(error) }
      try { await records.drain() } catch (error) { errors.push(error) }
      // A producer may depend on the unresolved original record. Preserve it
      // and return recovery before joining that dependent producer.
      if (errors.length) throw Object.assign(new AggregateError(errors, 'Required source pre-drain needs recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
      try { await drain() } catch (error) { errors.push(error) }
      try { await records.drain() } catch (error) { errors.push(error) }
      if (errors.length) throw Object.assign(new AggregateError(errors, 'Required source drain needs recovery'), { code: 'FACT_RECOVERY_REQUIRED' })
      active = false
      released()
    })()
    closing = pending
    void pending.catch(() => { if (closing === pending) closing = undefined })
    return pending
  }
  return {
    assertHeld,
    close,
    requireRecovery() { assertHeld(); operations.quarantineCapture() },
    rewind: { capture: event => capture('rewind', event, { kind: 'legacy-compaction', events: [event] }) },
    retention: { capture: event => capture('retention', event, { kind: 'result-reference', event }) },
    tools: {
      result: event => capture('tool-result', event, { kind: 'tool', event }).admit(),
      captureResult: event => capture('tool-result', event, { kind: 'tool', event }),
    },
    code: {
      record: event => capture('code', event, { kind: 'code', event }).admit(),
      capture: event => capture('code', event, { kind: 'code', event }),
    },
    delivery: {
      record: event => capture('delivery', event, { kind: 'delivery', event }).admit(),
      capture: event => capture('delivery', event, { kind: 'delivery', event }),
    },
    lifecycle: {
      usage: event => capture('usage', event, { kind: 'usage', event }).admit(),
      auditAssistant: event => capture('assistant-audit', event, { kind: 'assistant-audit', assistant: event }).admit(),
      lifecycle: event => capture('lifecycle', event, { kind: 'lifecycle', event }).admit(),
    },
  }
}
