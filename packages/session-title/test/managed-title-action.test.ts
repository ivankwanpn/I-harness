import { createTitleGenerationContext } from '../../session-executor/src/lifecycle/title-generation.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { maybeAutoTitle } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(prefix: string, options?: Parameters<typeof createJsonlBackend>[1]) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const backend = createJsonlBackend(root, options)
  const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  return { backend, coordinator }
}

it.each(['unknown', 'source-fault', 'revoked', 'missing-action', 'wrong-view'] as const)('refuses title inference before preparation under %s', async mode => {
  let uncertain = false
  let key: BatchKey | undefined
  const { coordinator } = await fixture('ih-f1-title-fence-', {
    wrapOwnedBatch: append => async (...args) => {
      const outcome = await append(...args)
      if (uncertain && outcome.kind === 'committed') {
        key = args[3].key
        return { kind: 'unknown', key }
      }
      return outcome
    },
  })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  await document.inputs.start(undefined, { type: 'user/message', text: 'Original human prompt' })
  const action = document.beginAction(), context = { view: mode === 'wrong-view' ? createSession() : document.view, signal: action.signal, assertOpen: action.assertOpen, facts: { metadata: action.facts.metadata } }
  let sends = 0
  if (mode === 'unknown') {
    uncertain = true
    await document.metadata.admit({ type: 'plan/mode', mode: 'off' })
  } else if (mode === 'source-fault') action.registerSettlementSource(async () => {}).requireRecovery()
  else if (mode === 'revoked') document.revokeNewWork()
  try {
    await expect(maybeAutoTitle({ session: document.view, metadata: action.facts.metadata, ...(mode === 'missing-action' ? {} : { action: context }), model: { async *stream() { sends++; yield { type: 'text/chunk', text: 'New title' }; yield { type: 'end' } } } })).rejects.toThrow()
    expect(sends).toBe(0)
    expect(document.view.events.some(event => event.type === 'session/title')).toBe(false)
  } finally { action.finish(); if (key) await document.reconcile(key); await coordinator.close().catch(() => {}) }
})

it('carries the original title signal through held actual reservation with zero sends after Stop', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const { coordinator } = await fixture('ih-f4-title-prepare-', {
    wrapOwnedBatch: append => async (...args) => {
      if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'context/attempt' && event.op === 'reserve')) {
        entered.resolve()
        await release.promise
      }
      return append(...args)
    },
  })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  await document.inputs.start(undefined, { type: 'user/message', text: 'Original prompt', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } })
  const controller = new AbortController(), action = document.beginAction(controller.signal)
  let sends = 0
  vi.stubGlobal('fetch', async () => { sends++; throw new Error('Unexpected network destination') })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'title', baseUrl: 'https://title.fixture.invalid' })
  const generation = createTitleGenerationContext(document, id, action, { selectedClient: () => model })
  const running = maybeAutoTitle({ session: document.view, metadata: action.facts.metadata, action: { view: document.view, signal: action.signal, assertOpen: action.assertOpen, facts: { metadata: action.facts.metadata }, openGeneration: generation.open }, model })
  void running.catch(() => {})
  try {
    await entered.promise
    controller.abort(new Error('Stop during title reservation'))
    release.resolve()
    await expect(running).rejects.toThrow()
    expect(sends).toBe(0)
    expect(document.view.events.some(event => event.type === 'session/title')).toBe(false)
  } finally { release.resolve(); await running.catch(() => {}); await generation.drain(); action.finish(); await coordinator.close(); vi.unstubAllGlobals() }
})
