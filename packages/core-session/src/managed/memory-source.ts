import type { Session } from '../events/types.ts'
import type { FactGroupDraft } from './groups.ts'
import type { NondurableFactOutcome, SettlementFacts } from './ports.ts'
import { validSettlementEvent, type SettlementEventKind } from './settlement-event.ts'
import { captureMemoryFact, rejectedMemoryCapture } from './memory-capture.ts'
import { validGenerationEvent } from '../events/generation.ts'
import { validInputPreparationEvent } from '../events/input-preparation.ts'

/** Required standalone outcomes share the closed constructors and local source
 * lifetime, while remaining explicitly nondurable. */
export function createMemorySettlementSource(session: Session, drain: () => Promise<void>, reconcilePending?: () => Promise<void>): SettlementFacts<NondurableFactOutcome> {
  let active = true, closing: Promise<void> | undefined
  const assertHeld = () => {
    if (!active) throw Object.assign(new Error('FACT_CLOSED'), { code: 'FACT_CLOSED' })
  }
  const close = () => {
    if (!active) return Promise.resolve()
    if (closing) return closing
    const pending = Promise.resolve().then(async () => {
      assertHeld()
      await reconcilePending?.()
      assertHeld()
    }).then(drain).then(() => { active = false })
    closing = pending
    void pending.catch(() => { if (closing === pending) closing = undefined })
    return pending
  }
  const capture = (kind: SettlementEventKind, event: unknown, draft: FactGroupDraft) => {
    assertHeld()
    return validSettlementEvent(kind, event) ? captureMemoryFact(session, draft, assertHeld) : rejectedMemoryCapture()
  }
  return {
    inputPreparation: { capture(event) {
      assertHeld()
      return validInputPreparationEvent(event) && (event.op === 'completed' || event.op === 'failed')
        ? captureMemoryFact(session, { kind: 'input-preparation', event }, assertHeld) : rejectedMemoryCapture()
    } },
    generation: { capture(event) {
      assertHeld()
      return validGenerationEvent(event) && (event.type === 'context/attempt' && event.op === 'settle' || event.type === 'context/action' && (event.op === 'close' || event.op === 'local-settle'))
        ? captureMemoryFact(session, { kind: 'generation', events: [event] }, assertHeld) : rejectedMemoryCapture()
    } },
    assertHeld, close, requireRecovery() { assertHeld() },
    retention: { capture: event => capture('retention', event, { kind: 'result-reference', event }) },
    rewind: { capture: event => capture('rewind', event, { kind: 'legacy-compaction', events: [event] }) },
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
      lifecycle: event => capture('lifecycle', event, { kind: 'lifecycle', event }).admit(),
      usage: event => capture('usage', event, { kind: 'usage', event }).admit(),
      auditAssistant: event => capture('assistant-audit', event, { kind: 'assistant-audit', assistant: event }).admit(),
    },
  }
}
