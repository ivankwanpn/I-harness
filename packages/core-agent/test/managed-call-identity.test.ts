import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession } from '@i-harness/core-session'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createAgent } from '../src/index.ts'
import { createMockClient } from '@i-harness/llm-mock'
import { observeModelClient } from '@i-harness/llm-seam'
import { localTestGeneration } from './fixtures/generation.ts'

it.each([true, false])('dispatches the actual committed call graph after producer mutation (managed=%s)', async managed => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-call-identity-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const session = managed ? document.view : createSession(), ctx = createContext(), tools = createToolRegistry(ctx)
  const args = { value: 'original' }, call = { id: 'original-call', name: 'effect', args }
  let sends = 0, bodies = 0, observed: unknown
  tools.register({ name: 'effect', description: '', inputSchema: { type: 'object' }, execute: async input => { bodies++; observed = input; return 'one original effect' } })
  const model = observeModelClient(createMockClient([{ role: 'assistant', toolCalls: [call] }, { role: 'assistant', text: 'done' }]), {
    start() { sends++ }, event(_state, event) { if (sends === 1 && event.type === 'end') { args.value = 'changed after call receipt'; call.name = 'changed-name' } }, finish() {},
  })
  const agent = createAgent(ctx, { session, ...(managed ? { factOwner: document, generationFactory: localTestGeneration(document, id, model) } : {}), sessionId: id, tools, systemPrompt: '', model })
  try {
    expect((await agent.run('perform original operation')).finalText).toBe('done')
    const recorded = session.events.find(event => event.type === 'tool/call')!
    expect(recorded).toMatchObject({ name: 'effect', callId: 'original-call', args: { value: 'original' } })
    expect(observed).toEqual({ value: 'original' })
    expect([sends, bodies]).toEqual([2, 1])
    expect(session.events.filter(event => event.type === 'tool/result')).toEqual([expect.objectContaining({ name: 'effect', callId: 'original-call', output: 'one original effect' })])
  } finally { await coordinator.close() }
})
