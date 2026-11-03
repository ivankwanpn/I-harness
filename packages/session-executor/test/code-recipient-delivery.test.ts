import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService, createDurableSessionLoader } from '../src/index.ts'

it.each(['wake', 'queued user', 'steer', 'Stop', 'foreground'] as const)('published service handles Code with %s through the same lane', async mode => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'code-service-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'parent' })
  const document = await coordinator.openManagedDocument('parent')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let bodyCalls = 0
  const rounds = Array.from({ length: 4 }, (_, i) => async (response: import('node:http').ServerResponse) => {
    const delta = i === 0 ? { tool_calls: [{ index: 0, id: 'original-code', type: 'function', function: { name: 'code_exec', arguments: JSON.stringify({ code: 'await tools.pause({});text("retained output")', yield_time_ms: mode === 'foreground' ? 60000 : 0 }) } }] } : { content: 'done' }
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: i === 0 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  const server = await createLoopbackProvider('/v1/chat/completions', rounds)
  const model = createOpenAICompatibleClient({ apiKey: 'loopback', model: 'fixture', baseUrl: server.baseUrl })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), model, modelPolicy: 'test-mock', approveAll: true, sandbox: 'danger-full-access', codeMode: { mode: 'mixed' }, contextWindow: 100000, additionalTools: [{ name: 'pause', description: 'hold original Worker', inputSchema: { type: 'object' }, async execute() { bodyCalls++; entered.resolve(); await release.promise; return 'released' } }] })
  try {
    const running = service.submit('parent', 'run code', new AbortController().signal)
    await Promise.race([entered.promise, running.then(() => { throw Error('Code did not enter Worker') })])
    if (mode === 'foreground') {
      release.resolve()
      await running
      expect(document.view.events.filter(e => e.type === 'code/end')).toHaveLength(1)
      expect(document.view.events.filter(e => e.type === 'agent/delivery-handoff' && e.kind === 'code')).toHaveLength(0)
      expect(document.view.events.filter(e => e.type === 'agent/delivery-received' && e.key.kind === 'code')).toHaveLength(0)
      expect(bodyCalls).toBe(1)
      expect(server.requests).toHaveLength(2)
      return
    }
    await running
    expect(document.view.events.filter(e => e.type === 'agent/delivery-handoff' && e.kind === 'code')).toHaveLength(1)
    if (mode === 'Stop') {
      service.cancelRunning!('parent')
      const stopped = service.awaitDeliveryStop('parent')
      release.resolve()
      await stopped
      expect(document.view.events.filter(e => e.type === 'agent/delivery-received' && e.key.kind === 'code')).toHaveLength(0)
      expect(bodyCalls).toBe(1)
      expect(server.requests).toHaveLength(2)
      return
    }
    if (mode === 'steer') {
      const assembly = await service.assemblyFor('parent')
      await assembly.inbox.admit({ inputId: 'user-steer', text: 'another user input while Code is running', delivery: 'steer', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } })
    }
    const next = mode === 'queued user' ? service.submit('parent', 'another user input while Code is running', new AbortController().signal)
      : mode === 'steer' ? service.submit('parent', 'another user input while Code is running', new AbortController().signal, { admittedInputId: 'user-steer' }) : undefined
    if (next) {
      if (mode === 'steer' || mode === 'queued user') {
        await vi.waitFor(() => expect(JSON.stringify(server.requests)).toContain('another user input while Code is running'), { timeout: 5000 })
      }
    }
    expect(document.view.events.filter(e => e.type === 'code/end')).toHaveLength(0)
    release.resolve()
    await next
    await vi.waitFor(() => expect(document.view.events.filter(e => e.type === 'agent/delivery-received' && e.key.kind === 'code')).toHaveLength(1), { timeout: 5000 })
    await vi.waitFor(() => expect(server.requests).toHaveLength(mode === 'wake' ? 3 : 4), { timeout: 5000 })
    const receipt = document.view.events.find(e => e.type === 'agent/delivery-received' && e.key.kind === 'code')!
    if (receipt.type !== 'agent/delivery-received') throw Error('Missing Code receipt')
    await vi.waitFor(() => expect(document.view.events.filter(e => e.type === 'agent/input/promoted' && e.inputId === receipt.inputId)).toHaveLength(1), { timeout: 5000 })
    const assembly = await service.assemblyFor('parent')
    const adapter = (await import('../src/lifecycle/received-inputs.ts')).receivedInputsFor(assembly.factOwner, 'parent').delivery
    expect(await adapter.admitCode({ kind: 'code', sourceSeq: receipt.sourceSeq, terminalSeq: receipt.terminalSeq })).toMatchObject({ inputId: receipt.inputId, disposition: 'claimed' })
    expect(document.view.events.filter(e => e.type === 'agent/delivery-received' && e.key.kind === 'code')).toHaveLength(1)
    if (mode === 'steer') expect(document.view.events.filter(e => e.type === 'agent/input/admitted' && e.inputId === 'user-steer')).toHaveLength(1)
    const end = document.view.events.find(e => e.type === 'code/end')
    expect(bodyCalls).toBe(1)
    expect(document.view.events.filter(e => e.type === 'code/end')).toHaveLength(1)
    if (!end || end.type !== 'code/end' || !('result' in end) || end.result.kind !== 'artifact') throw Error('Missing original Code artifact')
    const page = await service.readResultPage!('parent', { ref: end.result.ref, maxBytes: 32768 })
    expect(page).toMatchObject({ header: { cellId: end.cellId }, eof: true })
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(32768)
  } finally { release.resolve(); await service.close(); await coordinator.close(); await server.close() }
}, 30000)
