import { append, createSession, type Session } from '@i-harness/core-session'
import type { LLMRequest, ModelClient } from '@i-harness/llm-seam'
import { prepareTextFixture, checkpointOfLength } from './checkpoint.ts'

export function history(count = 8, chars = 2000) {
  const session = createSession()
  for (let i = 0; i < count; i++) append(session, { type: 'user/message', text: `segment-${i} ${'x'.repeat(chars)}` })
  return session
}
export function closedExchange(session: Session, label: string, chars = 2000, tool = false) {
  append(session, { type: 'step/start' })
  if (tool) append(session, { type: 'tool/call', callId: label, name: 'read', args: { path: `${label}.ts` } })
  append(session, { type: 'assistant/message', text: `${label} ${'x'.repeat(chars)}` })
  if (tool) append(session, { type: 'tool/result', callId: label, name: 'read', output: `${label}-done ${'z'.repeat(chars)}` })
  append(session, { type: 'step/end' })
}
export function spyModel(text = checkpointOfLength(600)) {
  const requests: LLMRequest[] = []
  const model: ModelClient = { prepare: prepareTextFixture, async *stream(request) { requests.push(request); yield { type: 'text/chunk', text }; yield { type: 'end' } } }
  return { model, requests }
}
export const autoConfig = { contextWindow: 20000, thresholdRatio: .8, minTurnsBeforeRecompact: 0, prune: false as const }
export const autoCap = 15500
