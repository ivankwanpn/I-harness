import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { projectConversation, renderConversation, decodeFactBatch } from '@i-harness/core-session'
import { captureContextSnapshot } from '@i-harness/context-engine'
import { reductionGroups } from '../../context-engine/src/reduction/selection.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createRuntimeContext } from '../../runtime-context/src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createAnthropicClient } from '../../llm-anthropic/src/index.ts'
import { createAgent } from '../src/index.ts'
import { createLoopbackProvider, writeSplitSse } from './helpers/provider-loopback.ts'

it('explicit source-boundary publisher sends the owned current prefix once through the managed Agent across tools, skills-only and clear', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-c12-main-'))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const done = async (response: Parameters<typeof writeSplitSse>[0]) => writeSplitSse(response, [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
  ])
  const server = await createLoopbackProvider('/v1/messages', [async response => writeSplitSse(response, [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'controlled native thought' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'CONTROLLED_NATIVE_SIGNATURE' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'read-one', name: 'read', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 1 }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }, { type: 'message_stop' },
  ]), done, done, done])
  const ctx = createContext(), tools = createToolRegistry(ctx)
  let effects = 0, instructions = 'EXACT_CURRENT_RULE', skills = 'EXACT_SKILLS'
  tools.register({ name: 'read', description: 'Controlled read', inputSchema: { type: 'object' }, isReadOnly: true, execute: async () => { effects++; return 'completed tool data' } })
  const service = createRuntimeContext(document.view, signal => document.beginAction(signal))
  service.registerSection('instructions', () => instructions); service.registerSection('skills', () => skills)
  const model = createAnthropicClient({ apiKey: 'controlled-loopback', baseUrl: server.baseUrl, model: 'controlled', executionIdentity: { version: 1, runtimeId: 'controlled-runtime', bindingLifetimeId: 'controlled-binding', authEpoch: 'controlled-auth', scope: 'binding-credential', coldCompatible: false } })
  const agent = createAgent(ctx, { session: document.view, factOwner: document, sessionId: id, tools, model, systemPrompt: 'static baseline', generationFactory: action => createGenerationLifecycle(document.view, id, action) })
  try {
    // This low-level publisher is explicit at source updates; shipping logical
    // admission is covered by session-executor's actual assembly controls.
    await service.render()
    expect((await agent.run('human request')).finalText).toBe('done')
    expect(effects).toBe(1)
    expect(document.view.events.filter(event => event.type === 'runtime/context')).toHaveLength(1)
    for (const request of server.requests) {
      const text = JSON.stringify(request.body)
      expect(text.split('EXACT_CURRENT_RULE')).toHaveLength(2)
      expect(text.split('EXACT_SKILLS')).toHaveLength(2)
    }
    const second = JSON.stringify(server.requests[1]!.body.messages)
    expect(second).toContain('CONTROLLED_NATIVE_SIGNATURE')
    expect(second.indexOf('tool_use')).toBeLessThan(second.indexOf('tool_result'))
    expect(second).toContain('completed tool data')
    const snapshot = captureContextSnapshot(document.view, { ownerSessionId: id, surface: { systemPrompt: 'static baseline', tools: tools.schemas() } })
    if (snapshot.kind !== 'captured') throw Error('real snapshot required')
    expect(reductionGroups(snapshot.snapshot).filter(group => group.items.some(item => item.kind === 'exchange')).every(group => !group.protected)).toBe(true)
    expect(snapshot.snapshot.protection.sourceIds).toContain(snapshot.snapshot.conversation.current!.source.id)
    instructions = ''
    await service.render()
    await agent.followup('skills only')
    expect(JSON.stringify(server.requests[2]!.body)).not.toContain('EXACT_CURRENT_RULE')
    expect(JSON.stringify(server.requests[2]!.body)).not.toContain('CONTROLLED_NATIVE_SIGNATURE')
    expect(JSON.stringify(server.requests[2]!.body).split('EXACT_SKILLS')).toHaveLength(2)
    skills = ''
    await service.render()
    const feedback = document.beginAction()
    await feedback.facts.agent.feedback({ type: 'user/message', text: 'ordinary plugin feedback', source: { kind: 'plugin', plugin: 'other-plugin' }, internal: true }); feedback.finish()
    await agent.followup('cleared')
    expect(JSON.stringify(server.requests[3]!.body)).not.toContain('EXACT_SKILLS')
    expect(JSON.stringify(server.requests[3]!.body)).toContain('ordinary plugin feedback')
    expect(renderConversation(projectConversation(document.view)).some(message => String(message.content).includes('EXACT_CURRENT_RULE'))).toBe(false)
    expect((await backend.read(id)).events.filter(event => event.type === 'runtime/context')).toHaveLength(3)
    expect(server.errors).toEqual([])
  } finally { await service.close(); await coordinator.close(); await server.close(); await rm(root, { recursive: true, force: true }) }
})

it('retains the exact issued current capture after lost response and joins reconciliation before close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-c12-unknown-'))
  const backend = createJsonlBackend(root), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const actual = backend.appendOwnedBatch!, actualReconcile = backend.reconcileOwnedBatch!
  let issued = 0, captures = 0, blocked = true, originalKey: unknown
  backend.appendOwnedBatch = async (...args) => {
    const result = await actual(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'runtime/context')) { issued++; originalKey = args[3].key; return { kind: 'unknown', key: args[3].key } }
    return result
  }
  backend.reconcileOwnedBatch = async (...args) => { expect(args[3].key).toEqual(originalKey); return blocked ? { kind: 'unknown', key: args[3].key } : actualReconcile(...args) }
  const service = createRuntimeContext(document.view, signal => {
    const action = document.beginAction(signal)
    return { finish: action.finish, captureRuntimeContext(record, check) { captures++; return action.captureRuntimeContext(record, check) } }
  })
  service.registerSection('instructions', () => 'retained original')
  try {
    await expect(service.render()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    await expect(service.render()).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect([issued, captures]).toEqual([1, 1])
    await expect(service.close()).rejects.toThrow()
    blocked = false
    await service.close()
    expect([issued, captures]).toEqual([1, 1])
    expect(projectConversation(document.view).current?.sections[0]?.text).toBe('retained original')
    await expect(service.render()).rejects.toThrow('closed')
  } finally { blocked = false; await service.close(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
