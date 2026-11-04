import { modelFailureFacts, type LLMRequest, type ModelClient } from '@i-harness/llm-seam'
import type { ReductionGroup, SummarySelection } from '@i-harness/context-engine'
import { prepareSummary, type SummaryLimits } from '../prepared-summary.ts'
import { SummaryBlockedError, SummaryCheckpointError, SummaryNativeSourceError } from '../summary-errors.ts'
import { readSummaryStream } from './stream.ts'
import { inspectCheckpoint } from './checkpoint.ts'
import { buildSummaryPrompt } from './prompt.ts'
import { selectedSource } from './source.ts'
import { RecordedPages } from './pages.ts'
import { confirmedSummaryOverflow } from './overflow.ts'

type Piece = { groups: readonly ReductionGroup[]; pages?: RecordedPages; pageBytes?: number; malformed?: number; priorInput?: { tokens: number; bytes?: number } }
/** Finite whole-group rolling generation; all pages borrow the original action. */
export async function generateSelectedSummary(model: ModelClient, source: SummarySelection, settings: { maxTokens: number; minSummaryChars: number; inherited: boolean }, limits: SummaryLimits) {
  const { maxTokens, minSummaryChars, inherited } = settings
  const check = () => { source.signal?.throwIfAborted(); if (!source.current()) throw Object.assign(new Error('Selected summary source changed'), { code: 'CONTEXT_INPUT_STALE' }); limits.validateBeforeTransport?.() }
  const pending: Piece[] = [{ groups: source.groups }], covered: string[] = []
  let running: string | undefined, portable = !inherited, malformed = 0, sizing = source.attempts.summarySizingCorrections ?? 0, corrective = false
  if (maxTokens * 4 < minSummaryChars) throw new SummaryBlockedError('retention-policy', { chars: maxTokens * 4, floor: minSummaryChars })
  const maximum = Math.min(8, source.maxCalls ?? 8, limits.maxSummaryCalls ?? 8)
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new SummaryBlockedError('call-policy')
  while (pending.length) {
    check()
    const piece = pending[0]!, { groups } = piece
    const page = piece.pages?.candidate(piece.pageBytes)
    const selected = page ?? selectedSource(groups, portable)
    const directive = buildSummaryPrompt('', running, source.instructions, { embedText: false })
      + `\n<recorded-source-manifest>${selected.manifest}</recorded-source-manifest>\nManifest messages ranges are zero-based half-open indexes into the final neutral summary request messages, not provider-flattened wire. Framing and directive messages are outside every source range. The manifest is recorded context data; source authority remains as labeled. Retain ${minSummaryChars} to ${maxTokens * 4} JavaScript code units.`
      + (corrective ? '\nPrevious output failed checkpoint validation. Produce all seven exact sections and complete framing.' : '')
    // A-04: the summary request is a DEDICATED request, never a copy of the
    // main one. Carrying the main system prompt and the whole tool catalogue
    // made the request as large as the work it was compressing and invited the
    // model to answer with a tool call, which the checkpoint validator treats
    // as a blocked summary. The directive below is self-contained and the
    // recorded conversation is in messages, so no system prompt or tools are
    // needed even when the main model is inherited.
    const request: LLMRequest = { systemPrompt: '',
      tools: [],
      messages: [...selected.messages, { role: 'user', content: directive }], promptCache: { mode: 'off' },
      ...(source.signal ? { signal: source.signal } : {}), ...(limits.reasoningEffort ? { reasoningEffort: limits.reasoningEffort } : {}) }
    let prepared
    try { prepared = await prepareSummary(model, request, maxTokens, { ...limits, expectedImages: selected.images }, check) }
    catch (error) {
      check()
      const failure = modelFailureFacts(error)
      if (!portable && !page && (error instanceof SummaryNativeSourceError || failure?.reason === 'native-replay' && (error as { code?: string }).code === 'INVALID_ARGUMENT')) { portable = true; continue }
      throw error
    }
    check()
    limits.onPreparation?.({ ...prepared.facts, mode: page ? 'page' : 'full', disposition: prepared.decision.disposition,
      inputBytes: prepared.candidate.measurement.packet.bodyBytes, inputFingerprint: prepared.candidate.measurement.input.inputFingerprint,
      ...(page ? { pageDigest: page.digest, sourceDigest: page.sourceDigest, sourceBytes: page.textBytes } : {}), sizingCorrections: sizing })
    const shrink = () => {
      if (!page || !piece.pages) {
        if (groups.length > 1) { const middle = Math.ceil(groups.length / 2); pending.splice(0, 1, { groups: groups.slice(0, middle) }, { groups: groups.slice(middle) }) }
        else { piece.pages = new RecordedPages(groups); piece.pageBytes = 65536 }
        return
      }
      if (sizing >= 2) throw new SummaryBlockedError('shrink-limit')
      const pressure = prepared.decision.pressure
      const ratios = prepared.decision.dimensions.filter(d => d.state === 'fail' && d.actual && d.limit).map(d => d.limit! / d.actual!)
      if (pressure.kind === 'known') ratios.push(pressure.inputBudget / Math.max(1, pressure.input))
      // A measured correction is a proposal, never a fit proof. The next exact page is prepared again.
      const ratio = Math.min(.9, ...ratios) * .9
      const next = Math.floor(page.textBytes * ratio)
      if (next < 1 || next >= page.textBytes) throw new SummaryBlockedError('fixed-input')
      sizing++; source.attempts.summarySizingCorrections = sizing; piece.pageBytes = next
    }
    if (prepared.decision.disposition === 'reduce') {
      const bytes = prepared.candidate.measurement.packet.bodyBytes
      if (page && piece.priorInput !== undefined && prepared.inputTokens >= piece.priorInput.tokens
        && (bytes === undefined || piece.priorInput.bytes === undefined || bytes >= piece.priorInput.bytes)) throw new SummaryBlockedError('fixed-input')
      if (page) piece.priorInput = { tokens: prepared.inputTokens, bytes }
      shrink(); continue
    }
    if (page && (prepared.decision.pressure.kind !== 'known' || !prepared.decision.pressure.hardFits)) throw new SummaryBlockedError('opaque')
    if (source.attempts.count >= maximum) throw new SummaryBlockedError('call-limit', { limit: maximum })
    if (limits.beforeTransport) try { await limits.beforeTransport(); check() } catch (error) { check(); throw new SummaryCheckpointError(error) }
    check(); limits.onMeasurement?.(prepared.facts); source.attempts.count++
    let result
    try { result = await readSummaryStream(prepared.candidate, { ...limits, validateBeforeTransport: check, maxRetainedChars: maxTokens * 4 }) }
    catch (error) { check(); if (confirmedSummaryOverflow(error)) { shrink(); continue } throw error }
    await limits.afterStream?.()
    check()
    if (!result.chars) throw new Error('compaction: summarizer returned empty output')
    const checkpoint = inspectCheckpoint(result.text)
    if (result.overflow || result.chars < minSummaryChars || result.chars > maxTokens * 4 || checkpoint.kind !== 'complete') {
      const retries = page ? malformed++ : (piece.malformed ?? 0)
      piece.malformed = (piece.malformed ?? 0) + 1
      if (retries >= 1) throw new SummaryBlockedError(result.overflow || result.chars < minSummaryChars || result.chars > maxTokens * 4 ? 'retention-output' : 'checkpoint-format', { chars: result.chars, floor: minSummaryChars, limit: maxTokens * 4 })
      corrective = true; continue
    }
    // Neutral custom clients provide local evidence only; provider-backed pages
    // must have the existing physical accepted-piece observation.
    if (page && !result.observation && prepared.candidate.measurement.input.coverage !== 'neutral-only') throw new SummaryBlockedError('opaque')
    if (result.observation) { await limits.onPieceAccepted?.(result.observation); check() }
    check()
    if (page) piece.pages!.accept(page)
    running = checkpoint.text; corrective = false
    if (!piece.pages || piece.pages.complete) { covered.push(...groups.map(group => group.id)); pending.shift() }
  }
  check()
  if (running === undefined || covered.join() !== source.groups.map(group => group.id).join()) throw new SummaryBlockedError('opaque')
  return { text: running, groupIds: Object.freeze(covered) }
}
