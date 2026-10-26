import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { createSession, append, type SessionEvent } from '@i-harness/core-session'
import type { LLMRequest, ModelClient } from '@i-harness/llm-seam'
import { createSessionCoordinator, createForkSessionController, createForkOperation } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionAssembly } from '../src/assembly.ts'
import { createCliForkHost } from '../src/lifecycle/fork-handoff.ts'
import { controlledModel } from './controlled-model.ts'

const sentinel = 'PASSIVE-PRIVATE-SENTINEL'
function sourceEvents(shape: 'code-only' | 'summary-tail', passive: boolean): SessionEvent[] {
  const source = createSession()
  if (shape === 'summary-tail') {
    append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'old' }); append(source, { type: 'step/start' })
    append(source, { type: 'tool/call', callId: 'read', name: 'read', args: {} }); append(source, { type: 'assistant/message', text: '' })
    append(source, { type: 'tool/dispatch', callId: 'read', eventSeq: 3 }); append(source, { type: 'tool/result', callId: 'read', name: 'read', output: 'CONSUMED-PROOF-ONLY' + 'x'.repeat(4096) })
    append(source, { type: 'step/end' }); append(source, { type: 'turn/end' })
    append(source, { type: 'compaction/replacement', version: 1, replacementId: 'summary', text: 'summary twelve', coverage: [
      { item: { kind: 'input', at: { seq: 1, part: 'message' } }, sources: [{ seq: 1, part: 'message' }] },
      { item: { kind: 'exchange', at: { seq: 3, part: 'call' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'call' }, { seq: 4, part: 'message' }, { seq: 5, part: 'dispatch' }, { seq: 6, part: 'result' }] },
    ], insertBefore: { kind: 'input', at: { seq: 1, part: 'message' } } })
  }
  append(source, { type: 'turn/start' })
  if (shape === 'summary-tail') { append(source, { type: 'user/message', text: 'typed tail' }); append(source, { type: 'assistant/message', text: 'tail answer' }) }
  if (passive) {
    append(source, { type: 'code/store', version: 1, cellId: 'committed', sessionId: 'source', writes: [['private', { sentinel, payload: 'large\n"\\'.repeat(16384) }]] })
    append(source, { type: 'code/cell', cellId: 'committed', sessionId: 'source', state: 'completed' })
  }
  append(source, { type: 'turn/end' })
  return source.events
}

it.each(['code-only', 'summary-tail'] as const)('keeps actual no-query model message bytes identical for V1 and passive V2 (%s)', async shape => {
  const root = await mkdtemp(join(tmpdir(), 'ih-passive-provider-')), store = join(root, 'sessions'), settings = join(root, 'settings.json')
  await writeFile(settings, JSON.stringify({ contextSubsystems: { contextOutput: { enabled: true } } }))
  const results: { messages: LLMRequest['messages']; tools: LLMRequest['tools']; bytes: Buffer; inputBytes: Buffer; wireMessages: Buffer; wireBody: Buffer; query?: unknown; groups: number }[] = []
  try {
    for (const passive of [false, true]) {
      await mkdir(store, { recursive: true })
      let coordinator = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } })
      const controller = createForkSessionController(coordinator, createCliForkHost({ workspace: root, coordinator, contextOutputSettingsPath: settings }))
      try {
        await coordinator.create({ sessionId: 'source' }); await coordinator.append('source', sourceEvents(shape, passive))
        const prepared = await controller.prepare({ version: 1, sourceSessionId: 'source' })
        if (prepared.kind !== 'prepared') throw Error(JSON.stringify(prepared))
        const operation = createForkOperation(prepared.prepared, { operationId: 'provider-comparison', targetSessionId: 'target', createdAt: '2026-10-27T00:00:00.000Z' })
        expect((await controller.execute({ operation, mode: 'begin' })).kind).toBe('ready')
        const snapshot = (await coordinator.snapshot!('target')).session, header = snapshot.header!.semanticSeed!
        expect(header.version).toBe(passive ? 2 : 1)
        if (shape === 'code-only') expect(header.groupCount).toBe(0)
        expect(JSON.stringify(snapshot.events)).not.toContain('CONSUMED-PROOF-ONLY')
        await controller.close(); await coordinator.close()
        coordinator = createSessionCoordinator(createJsonlBackend(store), { lock: { enabled: true } })
        const requests: { messages: LLMRequest['messages']; tools: LLMRequest['tools']; bytes: Buffer; inputBytes: Buffer }[] = []
        const model: ModelClient = controlledModel(async function* (request) {
          const bytes = Buffer.from(JSON.stringify(request.messages))
          const inputBytes = Buffer.from(JSON.stringify({ messages: request.messages, tools: request.tools, systemPrompt: request.systemPrompt,
            model: request.model, reasoningEffort: request.reasoningEffort, promptCache: request.promptCache, maxOutputTokens: request.maxOutputTokens }))
          requests.push({ messages: JSON.parse(bytes.toString()), tools: JSON.parse(JSON.stringify(request.tools)), bytes, inputBytes })
          yield { type: 'text/chunk', text: 'ready' }; yield { type: 'end' }
        })
        const transport = vi.spyOn(globalThis, 'fetch')
        const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: 'target', model, modelPolicy: 'test-mock', sandbox: 'danger-full-access',
          contextOutputSettingsPath: settings, codeMode: { mode: 'only' }, additionalSystemPrompt: () => 'Fixed passive provider isolation fixture.' })
        try {
          await assembly.agent.run('provider byte probe')
          expect(requests).toHaveLength(1)
          expect(transport).toHaveBeenCalledTimes(1)
          const wireBody = Buffer.from(String(transport.mock.calls[0]![1]!.body)), wireMessages = Buffer.from(JSON.stringify(JSON.parse(wireBody.toString()).messages))
          const captured = requests[0]!
          expect(captured.bytes.toString()).not.toContain(sentinel)
          expect(captured.bytes.toString()).not.toContain('CONSUMED-PROOF-ONLY')
          expect(captured.inputBytes.toString()).not.toContain(sentinel)
          expect(wireBody.toString()).not.toContain(sentinel)
          const query = passive ? (await assembly.tools.execute({ name: 'code_exec', args: { code: 'text(load("private").sentinel);text(load("private").payload.length);' } })).output : undefined
          if (passive) expect(query).toMatchObject({ status: 'completed', text: sentinel + '\n' + String('large\n"\\'.repeat(16384).length) })
          expect(requests).toHaveLength(1); expect(requests[0]!.bytes).toEqual(captured.bytes)
          expect(transport).toHaveBeenCalledTimes(1)
          results.push({ ...captured, wireBody, wireMessages, query, groups: header.groupCount })
        } finally { transport.mockRestore(); await assembly.dispose() }
      } finally { await controller.close(); await coordinator.close() }
      // Both cold assemblies use the exact same session ID, workspace, settings
      // and storage namespace. Only this fixture-owned child tree is reset.
      if (!resolve(store).startsWith(resolve(root) + sep)) throw Error('Fixture store escaped root')
      await rm(store, { recursive: true, force: true })
    }
    expect(Buffer.from(JSON.stringify(results[1]!.messages))).toEqual(Buffer.from(JSON.stringify(results[0]!.messages)))
    expect(results[1]!.tools).toEqual(results[0]!.tools)
    expect(results[1]!.inputBytes).toEqual(results[0]!.inputBytes)
    expect(results[1]!.wireMessages).toEqual(results[0]!.wireMessages)
    expect(results[1]!.wireBody).toEqual(results[0]!.wireBody)
    expect(results[1]!.bytes.toString()).not.toContain(sentinel)
    console.log(JSON.stringify({ control: 'actual ModelClient messages', shape, messageBytes: results[0]!.bytes.length, providerInputBytes: results[0]!.inputBytes.length,
      equal: results[0]!.bytes.equals(results[1]!.bytes), providerInputEqual: results[0]!.inputBytes.equals(results[1]!.inputBytes), wireMessageBytes: results[0]!.wireMessages.length,
      wireBodyBytes: results[0]!.wireBody.length, wireBodyEqual: results[0]!.wireBody.equals(results[1]!.wireBody), sends: 1, groups: results.map(result => result.groups), explicitQuery: (results[1]!.query as { text?: string })?.text }))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
