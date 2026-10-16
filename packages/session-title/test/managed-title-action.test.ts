import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { maybeAutoTitle } from '../src/index.ts'

it.each(['unknown', 'source-fault', 'revoked', 'missing-action', 'wrong-view'] as const)('refuses title inference before preparation under %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-title-fence-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  await document.inputs.start(undefined, { type: 'user/message', text: 'Original human prompt' })
  const action = document.beginAction(), context = { view: mode === 'wrong-view' ? createSession() : document.view, signal: action.signal, assertOpen: action.assertOpen, facts: { metadata: action.facts.metadata } }
  let sends = 0, key: BatchKey | undefined
  if (mode === 'unknown') {
    const append = backend.appendOwnedBatch!
    backend.appendOwnedBatch = async (...args) => { await append(...args); key = args[3].key; return { kind: 'unknown', key } }
    await document.metadata.admit({ type: 'plan/mode', mode: 'off' })
  } else if (mode === 'source-fault') action.registerSettlementSource(async () => {}).requireRecovery()
  else if (mode === 'revoked') document.revokeNewWork()
  try {
    await expect(maybeAutoTitle({ session: document.view, metadata: action.facts.metadata, ...(mode === 'missing-action' ? {} : { action: context }), model: { async *stream() { sends++; yield { type: 'text/chunk', text: 'New title' }; yield { type: 'end' } } } })).rejects.toThrow()
    expect(sends).toBe(0)
    expect(document.view.events.some(event => event.type === 'session/title')).toBe(false)
  } finally { action.finish(); if (key) await document.reconcile(key); await coordinator.close().catch(() => {}) }
})

it('carries the original title signal and immediate send assertion across actual model preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-title-prepare-')), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  await document.inputs.start(undefined, { type: 'user/message', text: 'Original prompt' })
  const controller = new AbortController(), action = document.beginAction(controller.signal), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let sends = 0
  const running = maybeAutoTitle({ session: document.view, metadata: action.facts.metadata, action: { view: document.view, signal: action.signal, assertOpen: action.assertOpen, facts: { metadata: action.facts.metadata } }, model: { async *stream(request) {
    entered.resolve(); await release.promise
    request.signal?.throwIfAborted(); request.validateBeforeTransport?.()
    sends++; yield { type: 'text/chunk', text: 'Unexpected late title' }; yield { type: 'end' }
  } } })
  void running.catch(() => {})
  try {
    await entered.promise
    controller.abort(new Error('Stop during title preparation'))
    release.resolve()
    await expect(running).rejects.toThrow()
    expect(sends).toBe(0)
    expect(document.view.events.some(event => event.type === 'session/title')).toBe(false)
  } finally { release.resolve(); await running.catch(() => {}); action.finish(); await coordinator.close() }
})
