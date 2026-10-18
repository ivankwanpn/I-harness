import { captureContextSnapshot, captureContextPayload, type ReductionGroup } from '../../../context-engine/src/index.ts'
import { createSession, type LLMMessage } from '@i-harness/core-session'
import type { ModelClient, ToolSchema } from '@i-harness/llm-seam'
import { generateSelectedSummary } from '../../src/summary/generate.ts'
import type { SummaryLimits } from '../../src/prepared-summary.ts'

/** Literal typed source fixture; group boundaries are authored independently. */
export function summarySource(messages: readonly LLMMessage[], surface = { systemPrompt: '', tools: [] as ToolSchema[] }) {
  const capture = captureContextSnapshot(createSession(), { ownerSessionId: 'summary-fixture', surface })
  if (capture.kind !== 'captured') throw Error('Fixture capture failed')
  const bundles: LLMMessage[][] = []
  for (let index = 0; index < messages.length;) {
    const first = messages[index++]!, bundle = [first]
    if (first.role === 'assistant' && first.toolCalls?.length) while (messages[index]?.role === 'tool') bundle.push(messages[index++]!)
    bundles.push(bundle)
  }
  const groups: ReductionGroup[] = bundles.map((bundle, index) => ({ id: `literal-${index}`, complete: true, protected: false, tokens: 0, coverage: [], items: [{
    id: `item-${index}`, kind: bundle[0]?.role === 'user' ? 'input' : 'exchange', messages: captureContextPayload(bundle), sources: [],
    provenance: { kind: bundle[0]?.role === 'user' ? 'human' : 'model', authority: bundle[0]?.role === 'user' ? 'request' : 'observation', scope: 'turn', evidence: [] },
  }] }))
  return { snapshot: capture.snapshot, groups, coverage: [], attempts: { count: 0, staleRebuilds: 0 }, current: () => true }
}
/** The C1 acceptance corpus drives the production selected-source generator. */
export async function summarizeFixture(model: ModelClient, text: string, maxTokens: number, previous?: string, instructions?: string, minimum = 500,
  tracker?: { count: number }, prefix?: { systemPrompt: string; tools: ToolSchema[]; messages: LLMMessage[] }, limits: SummaryLimits = {}) {
  const messages = [...(previous ? [{ role: 'user' as const, content: `[derived prior selected summary]\n${previous}` }] : []), ...(prefix?.messages ?? [{ role: 'user' as const, content: text }])]
  const source = summarySource(messages, prefix), attempts = tracker ?? { count: 0 }, before = attempts.count
  source.attempts = Object.defineProperties({ count: 0, staleRebuilds: 0 }, { count: { get: () => attempts.count, set: (value: number) => { attempts.count = value } } })
  const result = await generateSelectedSummary(model, { ...source, instructions, signal: limits.signal, maxCalls: limits.maxSummaryCalls }, { maxTokens, minSummaryChars: minimum, inherited: !!prefix }, limits)
  return { text: result.text, attempts: attempts.count - before }
}
