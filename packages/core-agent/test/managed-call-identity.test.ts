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

it.each([true, false])('dispatches the actual committed call graph after producer mutation (managed=%s)', async managed => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-call-identity-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const session = managed ? document.view : createSession(), ctx = createContext(), tools = createToolRegistry(ctx)
  const args = { value: 'original' }, call = { id: 'original-call', name: 'effect', args }
  let sends = 0, bodies = 0, observed: unknown
  tools.register({ name: 'effect', description: '', inputSchema: { type: 'object' }, execute: async input => { bodies++; observed = input; return 'one original effect' } })
  const agent = createAgent(ctx, { session, ...(managed ? { factOwner: document } : {}), sessionId: id, tools, systemPrompt: '', model: { async *stream() {
    if (++sends === 1) { yield { type: 'tool_call', call }; args.value = 'changed after call receipt'; call.name = 'changed-name'; yield { type: 'end' } }
    else { yield { type: 'text/chunk', text: 'done' }; yield { type: 'end' } }
  } } })
  try {
    expect((await agent.run('perform original operation')).finalText).toBe('done')
    const recorded = session.events.find(event => event.type === 'tool/call')!
    expect(recorded).toMatchObject({ name: 'effect', callId: 'original-call', args: { value: 'original' } })
    expect(observed).toEqual({ value: 'original' })
    expect([sends, bodies]).toEqual([2, 1])
    expect(session.events.filter(event => event.type === 'tool/result')).toEqual([expect.objectContaining({ name: 'effect', callId: 'original-call', output: 'one original effect' })])
  } finally { await coordinator.close() }
})
