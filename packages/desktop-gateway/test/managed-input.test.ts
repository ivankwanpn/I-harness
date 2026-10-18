import { expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '@i-harness/session-executor'
import { createDesktopInput } from '../src/input.ts'

it('Gateway saves received input through source-local failure but cannot promote or invoke the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-gateway-input-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  let requests = 0
  const service = createSessionService({ workspace: root, coordinator, codeMode: { mode: 'off' }, model: { async *stream() { requests++; yield { type: 'end' } } } })
  const input = createDesktopInput(coordinator, service)
  try {
    await service.assemblyFor(id)
    const document = await coordinator.openManagedDocument(id), action = document.beginAction()
    const failed = action.registerSettlementSource(async () => { throw new Error('Retained source outcome') })
    action.finish(); failed.requireRecovery()
    const admitted = await input.admit(id, { text: 'received Gateway instruction', delivery: 'queue', start: false })
    expect(admitted.accepted).toBe(true)
    expect((await input.state(id)).items).toEqual([expect.objectContaining({ id: admitted.inputId, text: 'received Gateway instruction', state: 'queued' })])
    await expect(input.resume(id)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' }); await input.drain()
    expect(requests).toBe(0)
    expect((await backend.read(id)).events.find(event => event.type === 'agent/input/admitted')).toMatchObject({ text: 'received Gateway instruction', provenance: { kind: 'human', authority: 'request', producer: 'desktop.input' } })
    expect(document.view.events.some(event => event.type === 'agent/input/promoted')).toBe(false)
  } finally { await input.close(); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('Gateway retries an unknown received input only by the original capture and acknowledges the exact reconciled receipt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-gateway-unknown-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'required' })
  const input = createDesktopInput(coordinator, service)
  let writes = 0, key: BatchKey | undefined
  const actual = backend.appendOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    const result = await actual(...args)
    if (decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/input/admitted')) { writes++; key = args[3].key; return { kind: 'unknown', key } }
    return result
  }
  const raw = { text: 'retain original input', delivery: 'queue' as const, start: false, clientToken: 'stable-managed-token' }
  try {
    await expect(input.admit(id, raw)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    const document = await coordinator.openManagedDocument(id)
    expect(document.view.events).toEqual([])
    await expect(input.admit(id, raw)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(writes).toBe(1)
    expect(key).toBeDefined()
    await document.reconcile(key!)
    const accepted = await input.admit(id, raw)
    expect(accepted.accepted).toBe(true)
    expect(writes).toBe(1)
    expect((await backend.read(id)).events.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
  } finally { await input.close(); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})
