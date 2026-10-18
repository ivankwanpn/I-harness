import type { LLMUsage, PreparedModelRequest } from '@i-harness/llm-seam'
import type { SummaryLimits } from '../prepared-summary.ts'
import { SummaryBlockedError } from '../summary-errors.ts'
import { summaryPieceCollector, type SummaryPieceObservation } from '../summary-observation.ts'
export interface SummaryStreamResult {
  readonly text: string
  readonly chars: number
  readonly overflow: boolean
  readonly observation?: SummaryPieceObservation
}
/** Keep a bounded exact prefix, deferring whitespace until it becomes interior.
 * Counts are JavaScript code units; trailing whitespace never causes overflow. */
function retainedText(ceiling: number) {
  let text = '', chars = 0, pending = '', pendingChars = 0, started = false
  const add = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b)
  const keep = (value: string) => { text += value.slice(0, Math.max(0, ceiling + 1 - text.length)) }
  return {
    push(chunk: string) {
      if (!started) chunk = chunk.trimStart()
      if (!chunk) return
      const content = chunk.trimEnd(), trailing = chunk.length - content.length
      if (content) {
        started = true
        chars = add(add(chars, pendingChars), content.length)
        keep(pending); keep(content)
        pending = ''; pendingChars = 0
      }
      pendingChars = add(pendingChars, trailing)
      pending += chunk.slice(content.length, content.length + Math.max(0, ceiling + 1 - text.length - pending.length))
    },
    result: () => ({ text, chars, overflow: chars > ceiling }),
  }
}
function recordUsage(usage: LLMUsage, next: LLMUsage): void {
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) {
    const value = next[field]
    if (typeof value === 'number' && Number.isFinite(value)) usage[field] = value
  }
  if (next.inputTokenSemantics === 'includes-cache' || next.inputTokenSemantics === 'excludes-cache') usage.inputTokenSemantics = next.inputTokenSemantics
}
/** Drain one actual prepared stream, preserving failed-attempt usage once. */
export async function readSummaryStream(candidate: PreparedModelRequest,
  limits: Pick<SummaryLimits, 'signal' | 'validateBeforeTransport' | 'onUsage'> & { maxRetainedChars: number },
): Promise<SummaryStreamResult> {
  if (!Number.isSafeInteger(limits.maxRetainedChars) || limits.maxRetainedChars < 0) throw new RangeError('Invalid retained checkpoint ceiling')
  const retained = retainedText(limits.maxRetainedChars), usage: LLMUsage = {}, collector = summaryPieceCollector(candidate)
  let ended = false, refused = false, truncated = false, tool = false, fingerprint: string | undefined
  let failed = false, failure: unknown
  const check = () => { limits.signal?.throwIfAborted(); limits.validateBeforeTransport?.() }
  try {
    limits.signal?.throwIfAborted()
    for await (const event of candidate.stream({ signal: limits.signal, validateBeforeTransport: check, confirmExecution: c => collector.confirm(c) })) {
      limits.signal?.throwIfAborted()
      if (ended && ['text/chunk', 'reasoning', 'tool_call'].includes(event.type)) throw Error('Summary produced content after completion')
      if (event.type === 'text/chunk') retained.push(event.text)
      else if (event.type === 'tool_call') tool = true
      else if (event.type === 'error') throw event.error
      else if (event.type === 'usage') recordUsage(usage, event.usage)
      else if (event.type === 'end') {
        const next = JSON.stringify(event)
        if (ended && fingerprint !== next) throw Error('Conflicting summary completion records')
        fingerprint = next; ended = true; refused = event.refused === true; truncated = event.truncated === true
      }
    }
    limits.signal?.throwIfAborted()
    if (tool) throw new SummaryBlockedError('tool-output')
    if (refused) throw new SummaryBlockedError('refused')
    if (truncated) throw new SummaryBlockedError('truncated')
    if (!ended) throw new SummaryBlockedError('incomplete')
  } catch (error) { failed = true; failure = error }
  finally {
    collector.close()
    try { if (Object.keys(usage).length) await limits.onUsage?.(usage) }
    catch (error) {
      throw new AggregateError(failed ? [failure, error] : [error], 'Summary usage observation failed', { cause: failed ? failure : error })
    }
  }
  if (failed) throw failure
  return { ...retained.result(), observation: collector.accepted() }
}
