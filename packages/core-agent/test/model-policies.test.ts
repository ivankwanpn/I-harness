import { describe, expect, it } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createSession, deriveMessages } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import type { LLMRequest } from '@i-harness/llm-seam'
import { estimateContent } from '@i-harness/token-meter'
import { createAgentWithSummary } from './fixtures/agent.ts'
import { checkpoint, seedSummaryHistory, summaryModel } from './fixtures/summary-model.ts'

const selectedPolicy = { thresholdRatio: 0.05, retainTokens: 400 }

function pressureAgent(
  selection: { provider?: string; modelId?: string },
  globalPolicy = { thresholdRatio: 0.8, retainTokens: 0 },
  inherited = false,
) {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const groups = seedSummaryHistory(session), archive = structuredClone(session.events), summary = summaryModel()
  const requests: LLMRequest[] = []
  let effects = 0
  tools.register({ name: 'read', description: '', inputSchema: {}, async execute() { effects++; return 'unexpected replay' } })
  const metadata = { version: 1 as const, providerId: selection.provider, modelId: selection.modelId ?? 'unknown', protocol: 'custom', identityCoverage: 'partial' as const, contextWindow: 10000 }
  let binding = { identity: {}, contextWindow: 10000, contextMetadata: metadata }
  const compact = {
    contextWindow: 10000, ...globalPolicy, summarizationModel: summary.model,
    // Synthetic summary budget; local protocol/cap support remain unknown.
    summaryLimits: { contextWindow: 20000 }, prune: false as const,
    modelPolicies: { 'deepseek/deepseek-v4-pro': selectedPolicy },
  }
  const agent = createAgentWithSummary(ctx, {
    session, tools, systemPrompt: '',
    model: { async *stream(request) {
      requests.push(request)
      yield { type: 'text/chunk', text: requests.length === 1 ? 'first' : 'second' }
      yield { type: 'end' }
    } },
    contextMetadata: selection.modelId ? metadata : undefined,
    ...(inherited ? { bindingForStep: () => binding } : {}), compact,
  })
  return { agent, session, compact, groups, archive, summary, requests, effects: () => effects,
    rebind() { binding = { ...binding, identity: {}, contextMetadata: { ...binding.contextMetadata, modelId: 'deepseek-v4-pro' } } } }
}

function assertReduction(f: ReturnType<typeof pressureAgent>, requestIndex = 0, priorTasks: string[] = []) {
  const replacements = f.session.events.filter(event => event.type === 'compaction/replacement')
  expect(replacements).toHaveLength(1)
  const replacement = replacements[0]!
  // Whole balanced read groups replace the old stepless-user token arithmetic.
  expect(replacement.coverage).toEqual(f.groups.slice(0, 5).flatMap(group => group.coverage))
  expect(replacement.insertBefore).toEqual(f.groups[0]!.coverage[0]!.item)
  expect(replacement.text).toBe(checkpoint)
  expect(f.session.events.slice(0, f.archive.length)).toEqual(f.archive)
  expect(f.summary.requests).toHaveLength(1)
  const source = JSON.stringify(f.summary.requests[0]!.messages)
  for (let i = 0; i < 5; i++) expect(source).toContain(`old-${i}`)
  for (let i = 5; i < 7; i++) expect(source).not.toContain(`old-${i}`)
  expect(source).not.toContain('continue-current')

  const actual = f.requests[requestIndex]!.messages
  const original = deriveMessages({ ...f.session, events: f.archive })
  const laterExchanges = priorTasks.map(() => ({ role: 'assistant' as const, content: 'first' }))
  expect(estimateContent(original.slice(6 * 3)) + estimateContent(laterExchanges)).toBeLessThan(selectedPolicy.retainTokens)
  expect(estimateContent(original.slice(5 * 3)) + estimateContent(laterExchanges)).toBeGreaterThanOrEqual(selectedPolicy.retainTokens)
  expect(actual).toEqual([
    { role: 'user', content: checkpoint },
    ...original.slice(5 * 3),
    ...priorTasks.flatMap(content => [{ role: 'user' as const, content }, { role: 'assistant' as const, content: 'first' }]),
    { role: 'user', content: 'continue-current' },
  ])
  expect(actual.filter(message => message.content === 'continue-current')).toHaveLength(1)
  expect(actual.filter(message => message.content === checkpoint)).toHaveLength(1)
  expect(actual.filter(message => message.role === 'tool').map(message => message.toolCallId)).toEqual(['old-5', 'old-6'])
  expect(estimateContent(actual)).toBeLessThan(estimateContent([...original,
    ...priorTasks.flatMap(content => [{ role: 'user' as const, content }, { role: 'assistant' as const, content: 'first' }]),
    { role: 'user', content: 'continue-current' }]))
  expect(f.effects()).toBe(0)
  // No physical provider capacity is certified for an optional custom client.
  expect(f.agent.contextBudget!()).toMatchObject({ kind: 'ready', snapshot: { coverage: 'neutral-only', admission: 'unavailable', capSupport: 'unknown' } })
}

describe('createAgent per-model compaction policies', () => {
  it('applies the resolved provider/model threshold and retention when the agent runs', async () => {
    const f = pressureAgent({ provider: 'deepseek', modelId: 'deepseek-v4-pro' })
    expect((await f.agent.run('continue-current')).finalText).toBe('first')
    assertReduction(f)
  })

  it('compacts the same fixture with the equivalent global threshold and retention', async () => {
    const f = pressureAgent({}, selectedPolicy)
    expect((await f.agent.run('continue-current')).finalText).toBe('first')
    assertReduction(f)
  })

  it('refreshes the policy key on a direct metadata rebind', async () => {
    const f = pressureAgent({ provider: 'deepseek', modelId: 'unlisted' })
    expect((await f.agent.run('before-rebind')).finalText).toBe('first')
    expect(f.summary.requests).toHaveLength(0)
    expect(f.session.events.some(event => event.type === 'compaction/replacement')).toBe(false)
    f.agent.updateContext!({ compact: f.compact, contextMetadata: { version: 1, providerId: 'deepseek', modelId: 'deepseek-v4-pro', protocol: 'custom', contextWindow: 10000, identityCoverage: 'partial' } })
    expect((await f.agent.followup('continue-current')).finalText).toBe('second')
    assertReduction(f, 1, ['before-rebind'])
  })

  it('refreshes the inherited policy descriptor before the next logical step', async () => {
    const f = pressureAgent({ provider: 'deepseek', modelId: 'unlisted' }, undefined, true)
    expect((await f.agent.run('before-rebind')).finalText).toBe('first')
    expect(f.summary.requests).toHaveLength(0)
    expect(f.session.events.some(event => event.type === 'compaction/replacement')).toBe(false)
    f.rebind()
    expect((await f.agent.followup('continue-current')).finalText).toBe('second')
    assertReduction(f, 1, ['before-rebind'])
  })

  it.each([
    {}, { provider: 'deepseek' }, { modelId: 'deepseek-v4-pro' }, { provider: 'deepseek', modelId: 'unlisted' },
  ])('keeps global behavior for absent or unlisted selection: %j', async selection => {
    const f = pressureAgent(selection)
    expect((await f.agent.run('continue-current')).finalText).toBe('first')
    expect(f.session.events.some(event => event.type.startsWith('compaction/'))).toBe(false)
    expect(f.summary.preparations).toHaveLength(0)
    expect(f.requests[0]!.messages).toEqual([...deriveMessages({ ...f.session, events: f.archive }), { role: 'user', content: 'continue-current' }])
    expect(deriveMessages(f.session)).toHaveLength(7 * 3 + 2)
    expect(f.effects()).toBe(0)
  })
})
