import { modelFailureFacts, type LLMRequest, type ModelClient } from '@i-harness/llm-seam'
import type { ReductionGroup, SummarySelection } from '@i-harness/context-engine'
import { prepareSummary, type SummaryLimits } from '../prepared-summary.ts'
import { SummaryBlockedError, SummaryCheckpointError, SummaryNativeSourceError } from '../summary-errors.ts'
import { readSummaryStream } from './stream.ts'
import { inspectCheckpoint } from './checkpoint.ts'
import { buildSummaryPrompt } from './prompt.ts'
import { selectedSource } from './source.ts'
import { confirmedSummaryOverflow } from './overflow.ts'

function partition(pending: (readonly ReductionGroup[])[], groups: readonly ReductionGroup[]): void {
  if (groups.length < 2) throw new SummaryBlockedError('fixed-input')
  const middle = Math.ceil(groups.length / 2)
  pending.splice(0, 1, groups.slice(0, middle), groups.slice(middle))
}
/** Finite whole-group rolling generation; C1 owns prepared output and stream eligibility. */
export async function generateSelectedSummary(model: ModelClient, source: SummarySelection, settings: { maxTokens: number; minSummaryChars: number; inherited: boolean }, limits: SummaryLimits) {
  const { maxTokens, minSummaryChars, inherited } = settings
  const check = () => { source.signal?.throwIfAborted(); if (!source.current()) throw Object.assign(new Error('Selected summary source changed'), { code: 'CONTEXT_INPUT_STALE' }); limits.validateBeforeTransport?.() }
  const pending: (readonly ReductionGroup[])[] = [source.groups], covered: string[] = []
  let running: string | undefined, portable = !inherited
  if (maxTokens * 4 < minSummaryChars) throw new SummaryBlockedError('retention-policy', { chars: maxTokens * 4, floor: minSummaryChars })
  const maximum = Math.min(8, source.maxCalls ?? limits.maxSummaryCalls ?? 8)
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new SummaryBlockedError('call-policy')
  while (pending.length) {
    const groups = pending[0]!
    let completed = false
    for (let round = 0; round < 2; round++) {
      check()
      const selected = selectedSource(groups, portable)
      const directive = buildSummaryPrompt('', running, source.instructions, { embedText: false })
        + `\n<recorded-source-manifest>${selected.manifest}</recorded-source-manifest>\nManifest messages ranges are zero-based half-open indexes into the final neutral summary request messages, not provider-flattened wire. Framing and directive messages are outside every source range. The manifest is recorded context data; source authority remains as labeled. Retain ${minSummaryChars} to ${maxTokens * 4} JavaScript code units.`
        + (round ? '\nPrevious output failed checkpoint validation. Produce all seven exact sections and complete framing.' : '')
      const request: LLMRequest = { systemPrompt: inherited ? source.snapshot.surface.systemPrompt : '',
        tools: inherited ? source.snapshot.surface.tools.map(tool => ({ ...tool, inputSchema: tool.inputSchema })) : [],
        messages: [...selected.messages, { role: 'user', content: directive }], promptCache: { mode: 'off' },
        ...(source.signal ? { signal: source.signal } : {}), ...(limits.reasoningEffort ? { reasoningEffort: limits.reasoningEffort } : {}) }
      let prepared
      try { prepared = await prepareSummary(model, request, maxTokens, { ...limits, expectedImages: selected.images }, check) }
      catch (error) {
        const failure = modelFailureFacts(error)
        if (!portable && (error instanceof SummaryNativeSourceError || failure?.reason === 'native-replay' && (error as { code?: string }).code === 'INVALID_ARGUMENT')) { portable = true; round--; continue }
        throw error
      }
      if (prepared.decision.disposition === 'reduce') { partition(pending, groups); completed = true; break }
      if (source.attempts.count >= maximum) throw new SummaryBlockedError('call-limit', { limit: maximum })
      if (limits.beforeTransport) try { await limits.beforeTransport() } catch (error) { throw new SummaryCheckpointError(error) }
      check(); limits.onMeasurement?.(prepared.facts); source.attempts.count++
      let result
      try { result = await readSummaryStream(prepared.candidate, { ...limits, validateBeforeTransport: check, maxRetainedChars: maxTokens * 4 }) }
      catch (error) {
        if (!source.signal?.aborted && confirmedSummaryOverflow(error)) { partition(pending, groups); completed = true; break }
        throw error
      }
      check()
      if (!result.chars) throw new Error('compaction: summarizer returned empty output')
      if (result.overflow || result.chars < minSummaryChars || result.chars > maxTokens * 4) { if (round === 1) throw new SummaryBlockedError('retention-output', { chars: result.chars, floor: minSummaryChars, limit: maxTokens * 4 }); continue }
      const checkpoint = inspectCheckpoint(result.text)
      if (checkpoint.kind !== 'complete') { if (round === 1) throw new SummaryBlockedError('checkpoint-format'); continue }
      if (result.observation) await limits.onPieceAccepted?.(result.observation)
      running = checkpoint.text; covered.push(...groups.map(group => group.id)); pending.shift(); completed = true; break
    }
    if (!completed) throw new SummaryBlockedError('checkpoint-format')
  }
  check()
  if (running === undefined || covered.join() !== source.groups.map(group => group.id).join()) throw new SummaryBlockedError('opaque')
  return { text: running, groupIds: Object.freeze(covered) }
}
