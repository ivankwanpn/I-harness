import { committedFactSeqs, type CapturedSettlementFact, type ProducerFactOutcome } from '@i-harness/core-session'
import { TOOL_ABORTED_BEFORE_DISPATCH } from '@i-harness/core-tools'
import type { BatchCall } from '../tool-batch/types.ts'
import type { AgentDeps } from './types.ts'
import { savingFailure } from './saving-failure.ts'

/** Own completed call references until the real batch source takes them. */
export function createUnstartedCallSettlement(deps: Pick<AgentDeps, 'registerFactSource'> & ({session:AgentDeps['session'];readOriginalCall?:never}|{session?:never;readOriginalCall(call:BatchCall):Extract<import('@i-harness/core-session').SessionEventView,{type:'tool/call'}>})) {
  if (!deps.registerFactSource) throw Object.assign(new Error('Unstarted calls require their original source'), { code: 'FACT_OWNER_UNSUPPORTED' })
  type Call = { callId: string; name: string; eventSeq: number }
  type Pending = { handle: CapturedSettlementFact<ProducerFactOutcome>; outcome?: ProducerFactOutcome }
  let calls: Call[] = [], pending: Pending[] | undefined, fault: unknown, hasFault = false, handedOff = false
  let lease: import('./request-context.ts').RequestContextPin | undefined
  let untransferredCleanup: (() => Promise<void>) | undefined
  const source = deps.registerFactSource(drain)
  const hold = () => source.holdRecovery()
  const failCapture = (error: unknown): never => {
    fault = error; hasFault = true
    source.requireRecovery(); hold()
    throw error
  }
  async function drain() {
    if (hasFault) throw fault
    if (handedOff) return
    if (!pending) {
      try {
        pending = calls.map(call => ({ handle: source.tools.captureResult({ type: 'tool/result', callId: call.callId, name: call.name, isError: true,
          output: { code: TOOL_ABORTED_BEFORE_DISPATCH, error: 'Original response did not hand this call to tool execution' } }) }))
      } catch (error) { return failCapture(error) }
    }
    for (const entry of pending) {
      try {
        entry.outcome = await entry.handle.observe()
        if (entry.outcome.kind === 'not-issued' && !['FACT_INVALID_GROUP', 'FACT_CAPTURE_FAILED', 'FACT_CLOSED', 'FACT_CANCELLED'].includes(entry.outcome.code)) {
          // The document may have gated this original required capture behind
          // an uncertain acceptance frame. It has never physically issued.
          entry.outcome = await entry.handle.admit()
        } else if (entry.outcome.kind === 'unknown' || entry.outcome.kind === 'conflict' || entry.outcome.kind === 'recovery-required') {
          entry.outcome = await entry.handle.reconcile()
        }
        if (entry.outcome.kind === 'not-issued' && ['FACT_INVALID_GROUP', 'FACT_CAPTURE_FAILED'].includes(entry.outcome.code)) source.requireRecovery()
        committedFactSeqs(entry.outcome)
      } catch (error) { hold(); throw error }
    }
    if (lease) {
      try { await lease.release(); lease = undefined }
      catch (error) { hold(); throw error }
    }
    if (untransferredCleanup) {
      try { await untransferredCleanup(); untransferredCleanup = undefined }
      catch (error) { hold(); throw error }
    }
    calls = []; pending = undefined
  }
  return {
    capture(batch: readonly BatchCall[], continuation?: import('./request-context.ts').RequestContextPin) {
      source.assertHeld()
      lease = continuation
      if (calls.length || pending || handedOff) throw new Error('Original call batch is already owned')
      const seen = new Set<number>()
      calls = batch.map(call => {
        const seq = call.eventSeq, event = deps.readOriginalCall?deps.readOriginalCall(call):seq === undefined ? undefined : deps.session.events[seq]
        if (seq === undefined || !Number.isSafeInteger(seq) || seen.has(seq) || event?.type !== 'tool/call' || event.seq !== seq || event.callId !== call.callId || event.name !== call.name) {
          return failCapture(Object.assign(new Error('Original tool call reference is unavailable'), { code: 'FACT_CAPTURE_FAILED' }))
        }
        seen.add(seq)
        return { callId: event.callId, name: event.name, eventSeq: seq }
      })
    },
    close: () => source.close(),
    async handoff(operation: (takeOwnership: () => import('./request-context.ts').RequestContextPin | undefined) => Promise<void>, afterUntransferred?: () => Promise<void>) {
      if (untransferredCleanup) throw new Error('Original untransferred cleanup is already owned')
      // Attach before close/setup can fail: the same source retries this only
      // after its original results and context lease have genuinely settled.
      untransferredCleanup = afterUntransferred
      source.assertHeld()
      let primary: unknown, failed = false
      let closing: Promise<void> | undefined
      try {
        await operation(() => {
          // Called synchronously only after executeToolCalls registers its
          // genuine source, before any preparation/effect await.
          handedOff = true; calls = []; pending = undefined
          untransferredCleanup = undefined
          const moved = lease; lease = undefined
          closing = source.close()
          // This close is joined below even if execution rejects first.
          void closing.catch(() => {})
          return moved
        })
        if (!handedOff) throw Object.assign(new Error('Tool execution did not take its original batch'), { code: 'FACT_RECOVERY_REQUIRED' })
      } catch (error) { primary = error; failed = true }
      try { await (closing ?? source.close()) }
      catch (saving) {
        if (failed) throw savingFailure(primary, [saving], 'Unstarted tool result settlement failed')
        throw saving
      }
      if (failed) throw primary
    },
  }
}
